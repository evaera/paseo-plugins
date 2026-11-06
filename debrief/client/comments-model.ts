/**
 * The comments dropdown's rows: every thread grouped by file (review-level
 * first, then files in diff order, files with open threads ahead of the
 * rest), open threads before resolved ones, then by line. Pure, so it is
 * tested directly; fixed row heights let the list virtualize with
 * `getItemLayout`.
 */
import type { Comment } from "../shared/review";

export type CommentFilter = "open" | "all";

export type CommentListItem =
  | { kind: "file"; key: string; path: string | null; open: number; total: number }
  | { kind: "thread"; key: string; comment: Comment };

export const FILE_ROW_HEIGHT = 30;
export const THREAD_ROW_HEIGHT = 54;

export function commentListItems(
  comments: readonly Comment[],
  fileOrder: readonly string[],
  filter: CommentFilter,
): CommentListItem[] {
  const shown = filter === "open" ? comments.filter((comment) => !comment.resolved) : [...comments];
  const groups = new Map<string, Comment[]>();
  shown.forEach((comment) => {
    const key = comment.scope === "review" || comment.path === undefined ? "" : comment.path;
    const list = groups.get(key) ?? [];
    list.push(comment);
    groups.set(key, list);
  });
  const rank = new Map(fileOrder.map((path, index) => [path, index]));
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === "" || b === "") return a === "" ? -1 : 1;
    const openA = (groups.get(a) ?? []).some((comment) => !comment.resolved) ? 0 : 1;
    const openB = (groups.get(b) ?? []).some((comment) => !comment.resolved) ? 0 : 1;
    return openA - openB || (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
  });
  const items: CommentListItem[] = [];
  keys.forEach((key) => {
    const list = [...(groups.get(key) ?? [])].sort(
      (a, b) =>
        Number(a.resolved) - Number(b.resolved) ||
        (a.startLine ?? 0) - (b.startLine ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    items.push({
      kind: "file",
      key: `f:${key}`,
      path: key === "" ? null : key,
      open: list.filter((comment) => !comment.resolved).length,
      total: list.length,
    });
    list.forEach((comment) => items.push({ kind: "thread", key: `t:${comment.id}`, comment }));
  });
  return items;
}

/** Offsets for `getItemLayout`. */
export function itemOffsets(items: readonly CommentListItem[]): { length: number; offset: number }[] {
  let offset = 0;
  return items.map((item) => {
    const length = item.kind === "file" ? FILE_ROW_HEIGHT : THREAD_ROW_HEIGHT;
    const entry = { length, offset };
    offset += length;
    return entry;
  });
}

/** A thread's first non-empty body line, without Markdown marks. */
export function firstLine(body: string): string {
  const line = body.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.replace(/[#>*_`]/g, "").trim();
}
