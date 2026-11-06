/**
 * The editor's reads and writes.
 *
 * Paths from the panel are workspace-relative and checked twice: lexically
 * (nothing absolute, nothing that normalizes above the workspace) and on disk,
 * by resolving symlinks and requiring the result to stay inside the
 * workspace's real path. Writes carry the mtime the editor loaded; a newer
 * file on disk is a conflict unless forced, checked before staging and again
 * just before the rename. Writes to one path run one at a time.
 *
 * `readAnyFile` is for go-to-definition targets, which may be anywhere
 * (`node_modules`, the standard library). Those outside the workspace are
 * read-only.
 */
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, mkdir, open, readFile as fsReadFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { MAX_EDITOR_BYTES } from "../shared/rpc";
import { compareDiffArgs, compareSources, toWorktree, type ResolvedCompare } from "./compare";
import { diffNameStatus, GitOutputTooLarge, showBlob } from "./git";
import { languageOf } from "./language";
import { serialized } from "./serialize";

const SNIFF_BYTES = 8192;

/** A panel path as a normalized workspace-relative one, or throws. */
export function cleanRelative(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (trimmed === "" || trimmed === ".") throw new Error("A file path is required.");
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) throw new Error(`"${path}" is not a path inside the workspace.`);
  const normalized = normalize(trimmed).split(sep).join("/").replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`"${path}" is outside the workspace.`);
  return normalized;
}

export function isInside(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/**
 * The absolute path for a workspace-relative `path`, after resolving symlinks
 * of the path or, for a file about to be created, its nearest existing
 * ancestor; refuses anything that lands outside the workspace.
 */
export async function resolveInWorkspace(root: string, path: string): Promise<{ absolute: string; relative: string }> {
  const rel = cleanRelative(path);
  const realRoot = await realpath(root);
  const absolute = join(realRoot, rel);
  let existing = absolute;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (!isInside(realRoot, real)) throw new Error(`"${rel}" leads outside the workspace.`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return { absolute, relative: rel };
}

export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

async function statIfPresent(absolute: string): Promise<Stats | null> {
  try {
    return await stat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function sniff(absolute: string): Promise<boolean> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export interface SideText {
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
}

const MISSING: SideText = { text: null, binary: false, tooLarge: false };

/** A file on disk as editor text. */
export async function readDiskText(absolute: string): Promise<SideText & { mtimeMs: number | null }> {
  const info = await statIfPresent(absolute);
  if (info === null || !info.isFile()) return { ...MISSING, mtimeMs: null };
  const mtimeMs = info.mtimeMs;
  if (info.size > MAX_EDITOR_BYTES) return { text: null, binary: false, tooLarge: true, mtimeMs };
  if (await sniff(absolute)) return { text: null, binary: true, tooLarge: false, mtimeMs };
  return { text: await fsReadFile(absolute, "utf8"), binary: false, tooLarge: false, mtimeMs };
}

/** A blob from git (`rev` `""` for the index) as editor text. */
export async function readGitText(cwd: string, rev: string, path: string): Promise<SideText> {
  try {
    const bytes = await showBlob(cwd, rev, path, MAX_EDITOR_BYTES);
    if (bytes === null) return MISSING;
    if (looksBinary(bytes)) return { text: null, binary: true, tooLarge: false };
    return { text: bytes.toString("utf8"), binary: false, tooLarge: false };
  } catch (error) {
    if (error instanceof GitOutputTooLarge) return { text: null, binary: false, tooLarge: true };
    throw error;
  }
}

/** One file's two sides under a compare; `resolved` null outside git. */
export async function fileContents(root: string, resolved: ResolvedCompare | null, path: string) {
  const { absolute, relative: rel } = await resolveInWorkspace(root, path);
  const language = languageOf(rel).editor;
  if (resolved === null) {
    // Not a git repository: there is only the file itself.
    const disk = await readDiskText(absolute);
    return {
      path: rel,
      oldText: null,
      newText: disk.text,
      newEditable: !disk.binary && !disk.tooLarge,
      mtimeMs: disk.mtimeMs,
      language,
      binary: disk.binary,
      tooLarge: disk.tooLarge,
    };
  }
  const sources = compareSources(resolved);
  const args = compareDiffArgs(resolved);
  // A renamed file's old side lives under its old name.
  const entry = args === null ? undefined : (await diffNameStatus(root, args).catch(() => [])).find((candidate) => candidate.path === rel);
  const oldPath = entry?.oldPath ?? rel;
  const [oldSide, newSide, disk] = await Promise.all([
    sources.old === null || entry?.status === "A" ? Promise.resolve(MISSING) : readGitText(root, sources.old, oldPath),
    sources.new === null ? Promise.resolve(null) : readGitText(root, sources.new, rel),
    readDiskText(absolute),
  ]);
  const workTree = toWorktree(resolved);
  const next: SideText = newSide ?? disk;
  return {
    path: rel,
    oldText: oldSide.text,
    newText: next.text,
    newEditable: workTree && !next.binary && !next.tooLarge,
    mtimeMs: disk.mtimeMs,
    language,
    binary: oldSide.binary || next.binary,
    tooLarge: oldSide.tooLarge || next.tooLarge,
  };
}

/** Workspace-relative when `absolute` is inside `root`, else null. */
export async function workspaceRelative(root: string, absolute: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const real = await realpath(absolute).catch(() => resolve(absolute));
  for (const [base, target] of [
    [realRoot, real],
    [resolve(root), resolve(absolute)],
  ] as const) {
    if (!isInside(base, target)) continue;
    const rel = relative(base, target).split(sep).join("/");
    return rel === "" ? null : rel;
  }
  return null;
}

export async function readAnyFile(root: string, path: string) {
  let absolute: string;
  let rel: string | null;
  if (isAbsolute(path)) {
    absolute = resolve(path);
    rel = await workspaceRelative(root, absolute);
    if (rel !== null) absolute = (await resolveInWorkspace(root, rel)).absolute;
  } else {
    const resolved = await resolveInWorkspace(root, path);
    absolute = resolved.absolute;
    rel = resolved.relative;
  }
  const disk = await readDiskText(absolute);
  return {
    path: rel ?? absolute,
    absolutePath: absolute,
    text: disk.text,
    editable: rel !== null && !disk.binary && !disk.tooLarge,
    mtimeMs: disk.mtimeMs,
    language: languageOf(absolute).editor,
    binary: disk.binary,
    tooLarge: disk.tooLarge,
  };
}

export type WriteResult = { status: "saved"; mtimeMs: number } | { status: "conflict"; mtimeMs: number | null };

function conflicts(current: Stats | null, expected: number | null): boolean {
  if (current === null) return expected !== null;
  if (!current.isFile()) throw new Error("That path is not a file.");
  return expected === null || current.mtimeMs !== expected;
}

/** For tests: runs once the temporary file is written, before the destination is checked again. */
export interface WriteHooks {
  afterStaging?: () => Promise<void>;
}

export async function writeWorkspaceFile(
  root: string,
  input: { path: string; text: string; expectedMtimeMs: number | null; force: boolean },
  hooks: WriteHooks = {},
): Promise<WriteResult> {
  const { absolute } = await resolveInWorkspace(root, input.path);
  return serialized(`file:${absolute}`, async () => {
    const before = await statIfPresent(absolute);
    if (!input.force && conflicts(before, input.expectedMtimeMs)) return { status: "conflict", mtimeMs: before?.mtimeMs ?? null };
    const temp = join(dirname(absolute), `.${randomUUID()}.debrief.tmp`);
    await mkdir(dirname(absolute), { recursive: true });
    try {
      await writeFile(temp, input.text, "utf8");
      if (before !== null) await chmod(temp, before.mode & 0o7777);
      await hooks.afterStaging?.();
      const now = await statIfPresent(absolute);
      if (!input.force && conflicts(now, input.expectedMtimeMs)) {
        await rm(temp, { force: true });
        return { status: "conflict", mtimeMs: now?.mtimeMs ?? null };
      }
      await rename(temp, absolute);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    const saved = await stat(absolute);
    return { status: "saved", mtimeMs: saved.mtimeMs };
  });
}
