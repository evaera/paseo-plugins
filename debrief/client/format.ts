/**
 * Pure formatting and grouping shared by the panel, the native diff, the
 * editor's widgets and the timeline card. No React, no DOM, no host modules
 * beyond the shared schemas, so it is tested directly.
 */
import type { Author, Comment, DiffFile, FileStatus, Side } from "../shared/review";

export interface LineRange {
  startLine?: number | null | undefined;
  endLine?: number | null | undefined;
  side?: Side | null | undefined;
}

/** `L3`, `L3-5`, with `old ` in front for a comment on the base side. */
export function rangeLabel(range: LineRange): string {
  const start = range.startLine ?? null;
  if (start === null) return "";
  const end = range.endLine ?? start;
  const lines = end > start ? `L${start}-${end}` : `L${start}`;
  return range.side === "old" ? `old ${lines}` : lines;
}

/** `client/panel.tsx:3-5`, or just the path, or "Review" for a review-level comment. */
export function locationLabel(path: string | null | undefined, range: LineRange): string {
  if (!path) return "Review";
  const start = range.startLine ?? null;
  if (start === null) return path;
  const end = range.endLine ?? start;
  const lines = end > start ? `${start}-${end}` : `${start}`;
  return `${path}:${lines}${range.side === "old" ? " (old)" : ""}`;
}

const STATUS_LETTERS: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export function statusLetter(status: FileStatus): string {
  return STATUS_LETTERS[status];
}

const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  copilot: "Copilot",
  cursor: "Cursor",
  amp: "Amp",
  pi: "Pi",
};

/** The harness an agent runs in, from its provider id: "claude" is "Claude Code". */
export function harnessLabel(provider: string): string {
  const id = provider.split("/")[0]?.trim().toLowerCase() ?? "";
  return HARNESS_NAMES[id] ?? (id === "" ? "Agent" : id.charAt(0).toUpperCase() + id.slice(1));
}

/**
 * How an author is labelled: an agent by its harness ("Claude Code"), when its
 * provider is known from the comment or `providerOf`, else by its title.
 */
export function authorLabel(author: Author, providerOf?: (agentId: string) => string | undefined): string {
  if (author.kind === "agent") {
    const provider = author.provider ?? (author.agentId !== undefined ? providerOf?.(author.agentId) : undefined);
    if (provider !== undefined) return harnessLabel(provider);
  }
  const name = author.name.trim();
  if (name !== "") return name;
  return author.kind === "agent" ? "Agent" : "Reviewer";
}

export function openCount(comments: readonly Comment[]): number {
  return comments.filter((comment) => !comment.resolved).length;
}

export function visibleComments(comments: readonly Comment[], hideResolved: boolean): Comment[] {
  return hideResolved ? comments.filter((comment) => !comment.resolved) : [...comments];
}

/** Unresolved comment count per path, for the file list's badges. */
export function openCountsByPath(comments: readonly Comment[]): Map<string, number> {
  const counts = new Map<string, number>();
  comments.forEach((comment) => {
    if (comment.resolved || !comment.path) return;
    counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
  });
  return counts;
}

export interface FileThreads {
  /** Line comments on the new side, in line order. */
  newSide: Comment[];
  /** Line comments on the old side, in line order. */
  oldSide: Comment[];
  /** Comments on the file as a whole. */
  file: Comment[];
}

export function threadsForFile(comments: readonly Comment[], path: string): FileThreads {
  const forPath = comments.filter((comment) => comment.path === path);
  const lineOrder = (a: Comment, b: Comment) =>
    (a.endLine ?? a.startLine ?? 0) - (b.endLine ?? b.startLine ?? 0) || a.createdAt.localeCompare(b.createdAt);
  return {
    newSide: forPath
      .filter((comment) => comment.scope === "line" && comment.side !== "old")
      .sort(lineOrder),
    oldSide: forPath.filter((comment) => comment.scope === "line" && comment.side === "old").sort(lineOrder),
    file: forPath.filter((comment) => comment.scope === "file"),
  };
}

export function reviewLevelComments(comments: readonly Comment[]): Comment[] {
  return comments.filter((comment) => comment.scope === "review");
}

/** `main @ 1a2b3c4`, or a placeholder when there is no repository. */
export function baseLabel(base: { ref: string; sha: string } | null): string {
  if (base === null) return "no base";
  return `${base.ref} @ ${base.sha.slice(0, 7)}`;
}

export function diffStatLabel(file: Pick<DiffFile, "additions" | "deletions" | "binary">): string {
  if (file.binary) return "binary";
  return `+${file.additions} -${file.deletions}`;
}

/** The last path segment and the directory before it, for a compact file row. */
export function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { name: path, dir: "" };
  return { name: path.slice(index + 1), dir: path.slice(0, index) };
}

/** "just now", "5m", "3h", "2d", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * The next (or previous) line with a thread after `current`, wrapping round.
 * Null when there are none.
 */
export function adjacentLine(lines: readonly number[], current: number, direction: 1 | -1): number | null {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (direction === 1) return sorted.find((line) => line > current) ?? sorted[0] ?? null;
  const before = sorted.filter((line) => line < current);
  return before[before.length - 1] ?? sorted[sorted.length - 1] ?? null;
}

/** LSP's CompletionItemKind to CodeMirror's completion `type`, which picks the icon. */
export function completionType(kind: number | null): string | undefined {
  switch (kind) {
    case 2:
      return "method";
    case 3:
    case 4:
      return "function";
    case 5:
    case 10:
      return "property";
    case 6:
      return "variable";
    case 7:
    case 22:
      return "class";
    case 8:
      return "interface";
    case 9:
      return "namespace";
    case 13:
      return "enum";
    case 14:
      return "keyword";
    case 20:
    case 21:
      return "constant";
    case 25:
      return "type";
    case 1:
      return "text";
    default:
      return undefined;
  }
}

/** Splits hover Markdown into prose and fenced code, which is all a hover needs. */
export function splitFences(markdown: string): { code: boolean; text: string }[] {
  const parts: { code: boolean; text: string }[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let match = pattern.exec(markdown);
  while (match !== null) {
    const prose = markdown.slice(last, match.index).trim();
    if (prose !== "") parts.push({ code: false, text: prose });
    const code = (match[1] ?? "").replace(/\n$/, "");
    if (code !== "") parts.push({ code: true, text: code });
    last = match.index + match[0].length;
    match = pattern.exec(markdown);
  }
  const rest = markdown.slice(last).trim();
  if (rest !== "") parts.push({ code: false, text: rest });
  return parts;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
