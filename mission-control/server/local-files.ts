/**
 * Files a reply names outside the Files view's reach: an image to draw, a project file to link. The
 * daemon reads them for the app, which cannot see the disk, so this is the one place that decides
 * what the app may be sent.
 *
 * Two kinds of root, and nothing else: Mission Control's home, relative paths included, and the
 * root of every project registered in Paseo. A path is checked lexically first (normalized, `..`
 * resolved, then required to sit under a root) and then on disk (symlinks resolved, then required
 * to sit under that root's own real path), so neither `..` nor a link inside a project reaches the
 * rest of the disk. Paths are compared the platform's way, case-insensitively on Windows.
 */
import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { MAX_IMAGE_BYTES, type ImageRefusal } from "../shared/files";
import { isAbsoluteLocal, localPathOf } from "../shared/local-path";
import { resolveInHome } from "./files";
import { readImageHeader } from "./image-header";

export type LocalTarget =
  | { kind: "home"; absolute: string; relative: string }
  | { kind: "project"; absolute: string; root: string };

export type LocalRefusal = Exclude<ImageRefusal, "too-large">;

function isInside(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function fileAt(absolute: string): Promise<"file" | "missing" | "not-a-file"> {
  try {
    return (await stat(absolute)).isFile() ? "file" : "not-a-file";
  } catch {
    return "missing";
  }
}

async function inHome(home: string, rel: string): Promise<LocalTarget | { refused: LocalRefusal }> {
  let resolved: { absolute: string; relative: string };
  try {
    resolved = await resolveInHome(home, rel);
  } catch {
    return { refused: "outside" };
  }
  if (resolved.relative === "") return { refused: "not-a-file" };
  const kind = await fileAt(resolved.absolute);
  return kind === "file" ? { kind: "home", ...resolved } : { refused: kind };
}

/**
 * The file `source` names, or why it is refused. `source` is anything `localPathOf` reads: a
 * relative path is the home's; an absolute one is looked for in the home first and then in each of
 * `projectRoots`.
 */
export async function resolveLocalFile(
  home: string,
  projectRoots: readonly string[],
  source: string,
): Promise<LocalTarget | { refused: LocalRefusal }> {
  const path = localPathOf(source);
  if (path === null) return { refused: "unsupported" };
  if (!isAbsoluteLocal(path)) return inHome(home, path);
  // A drive-letter path on macOS or Linux is no path at all.
  if (!isAbsolute(path)) return { refused: "outside" };

  const absolute = resolve(path);
  const homeReal = await realOrNull(home);
  for (const base of homeReal === null ? [home] : [home, homeReal]) {
    if (isInside(base, absolute)) return inHome(home, relative(base, absolute));
  }

  const roots = projectRoots.filter((root) => root.trim() !== "" && isAbsolute(root)).map((root) => resolve(root));
  const lexical = roots.filter((root) => isInside(root, absolute));
  if (lexical.length === 0) return { refused: "outside" };
  const real = await realOrNull(absolute);
  if (real === null) return { refused: "missing" };
  for (const root of lexical) {
    const rootReal = await realOrNull(root);
    if (rootReal !== null && isInside(rootReal, real)) {
      const kind = await fileAt(real);
      return kind === "file" ? { kind: "project", absolute: real, root } : { refused: kind };
    }
  }
  return { refused: "outside" };
}

/** Only absolute paths outside the lexical home need the daemon's project directory. */
export function linkedFilesNeedProjects(home: string, candidates: readonly string[]): boolean {
  const root = resolve(home);
  return candidates.some((source) => {
    const path = localPathOf(source);
    return path !== null && isAbsolute(path) && !isInside(root, resolve(path));
  });
}

/** Each of `candidates` that is a file in the home or a project, the way `mission-control.files.find` answers. */
export async function findLinkedFiles(
  home: string,
  projectRoots: readonly string[],
  candidates: readonly string[],
): Promise<{ files: Record<string, string>; projectFiles: Record<string, string> }> {
  const targets = await Promise.all(candidates.map((candidate) => resolveLocalFile(home, projectRoots, candidate).catch(() => null)));
  const files: Record<string, string> = {};
  const projectFiles: Record<string, string> = {};
  candidates.forEach((candidate, index) => {
    const target = targets[index];
    if (target === null || target === undefined || "refused" in target) return;
    if (target.kind === "home") files[candidate] = target.relative;
    else projectFiles[candidate] = target.absolute;
  });
  return { files, projectFiles };
}

export type ImageResult =
  | { status: "ok"; mimeType: string; base64: string; width: number | null; height: number | null; size: number }
  | { status: "refused"; reason: ImageRefusal; size: number | null };

/** An image the chat draws: refused unless it is a PNG, JPEG, GIF or WebP by its bytes, and at most `MAX_IMAGE_BYTES`. */
export async function readLocalImage(home: string, projectRoots: readonly string[], source: string): Promise<ImageResult> {
  const target = await resolveLocalFile(home, projectRoots, source);
  if ("refused" in target) return { status: "refused", reason: target.refused, size: null };
  const info = await stat(target.absolute);
  if (info.size > MAX_IMAGE_BYTES) return { status: "refused", reason: "too-large", size: info.size };
  const bytes = await readFile(target.absolute);
  const header = readImageHeader(bytes);
  if (header === null) return { status: "refused", reason: "unsupported", size: info.size };
  return { status: "ok", ...header, base64: bytes.toString("base64"), size: info.size };
}

const REFUSALS: Record<LocalRefusal, string> = {
  missing: "is not there",
  outside: "is outside Mission Control's home and every Paseo project",
  "not-a-file": "is not a file",
  unsupported: "is not a local file",
};

/** The file manager's command for showing `absolute` selected, on `platform`. */
export function revealCommand(platform: NodeJS.Platform, absolute: string): { command: string; args: string[]; verbatim: boolean } {
  // Explorer parses its own command line and wants the path quoted after the comma, so the
  // argument goes verbatim rather than through Node's quoting, which would quote the whole switch.
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,"${absolute}"`], verbatim: true };
  if (platform === "darwin") return { command: "open", args: ["-R", absolute], verbatim: false };
  return { command: "xdg-open", args: [dirname(absolute)], verbatim: false };
}

/** Shows a home or project file in the daemon machine's file manager; throws a sentence for anything refused. */
export async function revealLocalFile(home: string, projectRoots: readonly string[], source: string): Promise<void> {
  const target = await resolveLocalFile(home, projectRoots, source);
  if ("refused" in target) throw new Error(`${source} ${REFUSALS[target.refused]}.`);
  const { command, args, verbatim } = revealCommand(process.platform, target.absolute);
  // Explorer exits 1 even when it opened the window, so the exit code says nothing; only a launch failure is an error.
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: verbatim });
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}
