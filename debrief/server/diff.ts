/**
 * A unified diff, as `server/git.ts` asks git for it, read into `DiffFile`s.
 *
 * Paths come from the `---`/`+++` lines and the rename headers first, and from
 * the `diff --git a/x b/y` line only as a fallback: that line is ambiguous for a
 * path containing ` b/`, and git does not quote it with `core.quotePath=false`.
 * Hunk lines are counted rather than trusted, so a truncated diff still parses.
 */
import type { DiffFile, FileStatus, Hunk } from "../shared/review";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

interface Draft {
  path: string | null;
  oldPath: string | null;
  headerOld: string | null;
  headerNew: string | null;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

/** Undoes git's C-style quoting of a path (`"a\tb"`), which appears only for control characters here. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = body.slice(index + 1, index + 4);
      bytes.push(parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `a/src/x.ts` -> `src/x.ts`; `/dev/null` -> null. */
function headerPath(raw: string, prefix: "a/" | "b/"): string | null {
  const trimmed = unquotePath(raw.replace(/\t.*$/, ""));
  if (trimmed === "/dev/null") return null;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

/** The `diff --git a/x b/y` fallback, splitting on the middle when both halves agree. */
function gitLinePaths(line: string): { oldPath: string; path: string } | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest);
    if (match === null) return null;
    return { oldPath: headerPath(match[1] ?? "", "a/") ?? "", path: headerPath(match[2] ?? "", "b/") ?? "" };
  }
  // Same path on both sides is the common case, and the only unambiguous split.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) return { oldPath: a.slice(2), path: b.slice(2) };
  }
  const split = rest.indexOf(" b/");
  if (split === -1) return null;
  return { oldPath: rest.slice(0, split).replace(/^a\//, ""), path: rest.slice(split + 3) };
}

function finish(draft: Draft): DiffFile | null {
  // A deleted file's `+++` is /dev/null, so its name comes from the old side.
  const path = draft.path ?? draft.headerNew ?? draft.oldPath ?? draft.headerOld;
  if (path === null || path === "") return null;
  const oldPath = draft.oldPath ?? draft.headerOld;
  const file: DiffFile = {
    path,
    status: draft.status,
    binary: draft.binary,
    additions: draft.additions,
    deletions: draft.deletions,
    hunks: draft.hunks,
  };
  if (draft.status === "renamed" && oldPath !== null && oldPath !== path) file.oldPath = oldPath;
  return file;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let draft: Draft | null = null;
  // Lines still expected in the current hunk, so a `--- ` inside one is content.
  let oldLeft = 0;
  let newLeft = 0;

  const flush = () => {
    if (draft === null) return;
    const file = finish(draft);
    if (file !== null) files.push(file);
    draft = null;
  };

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (draft !== null && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0];
      if (mark === "+") {
        draft.additions += 1;
        newLeft -= 1;
        continue;
      }
      if (mark === "-") {
        draft.deletions += 1;
        oldLeft -= 1;
        continue;
      }
      if (mark === " " || line === "") {
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (mark === "\\") continue;
      // Anything else ends the hunk early; fall through and read it as a header.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("diff --git ")) {
      flush();
      const paths = gitLinePaths(line);
      draft = {
        path: null,
        oldPath: null,
        headerOld: paths?.oldPath ?? null,
        headerNew: paths?.path ?? null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }
    if (draft === null) continue;
    const current: Draft = draft;

    if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      current.hunks.push({ oldStart, oldLines, newStart, newLines, header: (match[5] ?? "").trim() });
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) current.oldPath = unquotePath(line.slice("copy from ".length));
    else if (line.startsWith("copy to ")) {
      current.status = "added";
      current.path = unquotePath(line.slice("copy to ".length));
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
    else if (line.startsWith("--- ")) {
      const path = headerPath(line.slice(4), "a/");
      if (path === null) current.status = "added";
      else current.oldPath ??= path;
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4), "b/");
      if (path === null) current.status = "deleted";
      else current.path ??= path;
    }
  }
  flush();
  return files;
}

/** The diff entry for a file git does not track yet: one hunk adding every line. */
export function untrackedDiffFile(path: string, text: string | null): DiffFile {
  if (text === null) {
    return { path, status: "untracked", binary: true, additions: 0, deletions: 0, hunks: [] };
  }
  const lines = countLines(text);
  return {
    path,
    status: "untracked",
    binary: false,
    additions: lines,
    deletions: 0,
    hunks: lines === 0 ? [] : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines, header: "" }],
  };
}

export function countLines(text: string): number {
  if (text === "") return 0;
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return text.endsWith("\n") ? count : count + 1;
}
