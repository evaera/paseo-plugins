/**
 * Git, run the way Debrief can parse it whatever the user's configuration.
 *
 * Every call is `git -C <cwd>` with `--no-pager`, colour forced off and the
 * diff prefixes pinned to `a/` and `b/`: a user's `color.diff=always`,
 * `diff.noprefix` or `diff.mnemonicPrefix` otherwise turns the output into
 * something the parser reads as no files at all. Command-line `-c` outranks
 * every config file, so nothing of the user's is changed. Optional locks and
 * credential prompts are off, output is capped, and ANSI escapes are stripped
 * as a backstop.
 *
 * What a diff compares is resolved in `server/compare.ts`.
 */
import { spawn } from "node:child_process";

/** Git's well-known empty tree, the base of a repository with no commits. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

const HARDENING = [
  "--no-pager",
  "-c",
  "color.ui=never",
  "-c",
  "color.diff=never",
  "-c",
  "color.status=never",
  "-c",
  "color.branch=never",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "core.quotePath=false",
];

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export class GitOutputTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`git output exceeded ${limit} bytes`);
    this.name = "GitOutputTooLarge";
  }
}

export interface GitRunOptions {
  /** Exit codes other than 0 that still count as success (`diff --no-index` exits 1 on a difference). */
  okCodes?: readonly number[];
  maxBytes?: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI, "") : text;
}

/** Runs git in `cwd` and resolves with stdout as UTF-8. */
export function runGitBuffer(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...HARDENING, ...args], {
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64) err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow) {
        reject(new GitOutputTooLarge(maxBytes));
        return;
      }
      if (code === 0 || (code !== null && options.okCodes?.includes(code))) {
        resolve(Buffer.concat(out));
        return;
      }
      const message = stripAnsi(Buffer.concat(err).toString("utf8")).trim();
      reject(new GitError(message || `git ${args.join(" ")} exited with ${code}`, code));
    });
  });
}

export async function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
  return stripAnsi((await runGitBuffer(cwd, args, options)).toString("utf8"));
}

/** Trimmed output, or null when git fails. */
export async function gitOptional(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const out = (await runGit(cwd, args)).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** The repository's top level, or null when `cwd` is not inside a work tree. */
export function repoRoot(cwd: string): Promise<string | null> {
  return gitOptional(cwd, ["rev-parse", "--show-toplevel"]);
}

export function headSha(cwd: string): Promise<string | null> {
  return gitOptional(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
}

export function currentBranch(cwd: string): Promise<string | null> {
  return gitOptional(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await gitOptional(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

/** The default branch's short name, as Crit detects it. */
export async function defaultBranch(cwd: string): Promise<string> {
  const originHead = await gitOptional(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (originHead !== null && originHead.startsWith("refs/remotes/origin/")) {
    return originHead.slice("refs/remotes/origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if ((await refExists(cwd, candidate)) || (await refExists(cwd, `refs/remotes/origin/${candidate}`))) {
      return candidate;
    }
  }
  return "main";
}

export class NoUpstream extends GitError {
  constructor() {
    super("This branch has no remote branch.", null);
    this.name = "NoUpstream";
  }
}

/**
 * The current branch's remote branch: its configured upstream, else
 * `origin/<branch>` when that exists. Null on a detached HEAD or a branch
 * that was never pushed.
 */
export async function upstreamBranch(cwd: string): Promise<string | null> {
  const branch = await currentBranch(cwd);
  if (branch === null) return null;
  const configured = await gitOptional(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (configured !== null && configured !== "" && (await refExists(cwd, configured))) return configured;
  const remote = `origin/${branch}`;
  return (await refExists(cwd, `refs/remotes/${remote}`)) ? remote : null;
}

/**
 * `--relative` keeps the diff to the workspace directory and its paths
 * relative to it, for a workspace that is a subdirectory of its repository.
 */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];

/** A compare's tracked changes as a unified diff; `args` from `compareDiffArgs`. */
export function diffText(cwd: string, args: readonly string[]): Promise<string> {
  return runGit(cwd, ["diff", ...DIFF_FLAGS, ...args, "--"]);
}

/** The same diff's changed paths, `-z --name-status`, for finding a file's old path cheaply. */
export async function diffNameStatus(cwd: string, args: readonly string[]): Promise<NameStatus[]> {
  const out = await runGit(cwd, ["diff", "--no-ext-diff", "-M", "--relative", "--name-status", "-z", ...args, "--"]);
  return parseNameStatus(out);
}

export interface NameStatus {
  status: string;
  path: string;
  oldPath?: string;
}

export function parseNameStatus(out: string): NameStatus[] {
  const fields = out.split("\0");
  const entries: NameStatus[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    if (status === undefined || status === "") break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index + 1];
      const path = fields[index + 2];
      if (oldPath !== undefined && path !== undefined) entries.push({ status: status[0] ?? "R", path, oldPath });
      index += 3;
    } else {
      const path = fields[index + 1];
      if (path !== undefined) entries.push({ status: status[0] ?? "M", path });
      index += 2;
    }
  }
  return entries;
}

/** Untracked, non-ignored files, workspace-relative. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter((path) => path !== "");
}

/**
 * A blob's bytes at `rev` (`""` for the index), with `path` relative to `cwd`.
 * Null when it does not exist there. Throws `GitOutputTooLarge` past `maxBytes`.
 */
export async function showBlob(cwd: string, rev: string, path: string, maxBytes: number): Promise<Buffer | null> {
  try {
    return await runGitBuffer(cwd, ["cat-file", "blob", `${rev}:./${path}`], { maxBytes });
  } catch (error) {
    if (error instanceof GitOutputTooLarge) throw error;
    return null;
  }
}

/** `git status --porcelain=v2 -z`, the cheap part of the poll fingerprint. Paths are relative to the top level. */
export function statusPorcelain(cwd: string): Promise<string> {
  return runGit(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
}

/** The work-tree paths a porcelain v2 status names, for statting in the fingerprint. */
export function statusPaths(porcelain: string): string[] {
  const fields = porcelain.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === "") continue;
    const kind = field[0];
    if (kind === "?" || kind === "!") {
      paths.push(field.slice(2));
    } else if (kind === "1") {
      paths.push(field.split(" ").slice(8).join(" "));
    } else if (kind === "2") {
      paths.push(field.split(" ").slice(9).join(" "));
      index += 1; // the original path follows in its own field
    } else if (kind === "u") {
      paths.push(field.split(" ").slice(10).join(" "));
    }
  }
  return paths;
}
