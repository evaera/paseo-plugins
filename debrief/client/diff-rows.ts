/**
 * The native diff's rows: a unified diff of two texts, flattened into hunk
 * headers and numbered lines, with threads and the composer slotted in after
 * the line they end on. Pure, so it is tested directly.
 */
import { structuredPatch } from "diff";

import type { Comment, Side } from "../shared/review";
import type { Annotation } from "../shared/story";

export type LineType = "context" | "add" | "del";

export type DiffRow =
  | { kind: "hunk"; key: string; header: string }
  | {
      kind: "line";
      key: string;
      type: LineType;
      oldLine: number | null;
      newLine: number | null;
      text: string;
    };

const CONTEXT_LINES = 3;

export function buildDiffRows(oldText: string | null, newText: string | null): DiffRow[] {
  const patch = structuredPatch("a", "b", oldText ?? "", newText ?? "", undefined, undefined, {
    context: CONTEXT_LINES,
  });
  const rows: DiffRow[] = [];
  patch.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      kind: "hunk",
      key: `h${hunkIndex}`,
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    // An empty side starts at 0 in a patch header, and its first line is 1.
    if (hunk.oldLines === 0) oldLine += 1;
    if (hunk.newLines === 0) newLine += 1;
    hunk.lines.forEach((raw, lineIndex) => {
      const marker = raw[0];
      if (marker === "\\") return;
      const text = raw.slice(1);
      const key = `h${hunkIndex}l${lineIndex}`;
      if (marker === "+") {
        rows.push({ kind: "line", key, type: "add", oldLine: null, newLine, text });
        newLine += 1;
      } else if (marker === "-") {
        rows.push({ kind: "line", key, type: "del", oldLine, newLine: null, text });
        oldLine += 1;
      } else {
        rows.push({ kind: "line", key, type: "context", oldLine, newLine, text });
        oldLine += 1;
        newLine += 1;
      }
    });
  });
  return rows;
}

export interface ComposerAnchor {
  side: Side;
  startLine: number;
  endLine: number;
}

export type DiffItem =
  | DiffRow
  | { kind: "thread"; key: string; comment: Comment }
  | { kind: "composer"; key: string; anchor: ComposerAnchor }
  /** Story narration, drawn above its line (`story.ts` places it). */
  | { kind: "narration"; key: string; annotation: Annotation };

/** The line number a row carries on a side, or null when the row is not on it. */
export function rowLine(row: DiffRow, side: Side): number | null {
  if (row.kind !== "line") return null;
  return side === "old" ? row.oldLine : row.newLine;
}

/**
 * Rows with each thread after the row its range ends on. Threads whose line is
 * outside every hunk come back in `unplaced`, to be listed above the diff.
 */
export function interleave(
  rows: readonly DiffRow[],
  comments: readonly Comment[],
  composer: ComposerAnchor | null,
): { items: DiffItem[]; unplaced: Comment[] } {
  const placed = new Set<string>();
  const items: DiffItem[] = [];
  const endsAt = (comment: Comment) => comment.endLine ?? comment.startLine ?? 0;
  rows.forEach((row) => {
    items.push(row);
    comments.forEach((comment) => {
      if (placed.has(comment.id)) return;
      const side: Side = comment.side ?? "new";
      if (rowLine(row, side) === endsAt(comment)) {
        placed.add(comment.id);
        items.push({ kind: "thread", key: `t:${comment.id}`, comment });
      }
    });
    if (composer !== null && rowLine(row, composer.side) === composer.endLine) {
      items.push({ kind: "composer", key: "composer", anchor: composer });
    }
  });
  return { items, unplaced: comments.filter((comment) => !placed.has(comment.id)) };
}

/** The text of the lines a range covers on a side, as far as the rows show it. */
export function rangeText(rows: readonly DiffRow[], anchor: ComposerAnchor): string {
  return rows
    .filter((row) => {
      const line = rowLine(row, anchor.side);
      return line !== null && line >= anchor.startLine && line <= anchor.endLine;
    })
    .map((row) => (row.kind === "line" ? row.text : ""))
    .join("\n");
}

/** A plain file as rows: every line is context, numbered the same on both sides. */
export function plainRows(text: string): DiffRow[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, index) => ({
    kind: "line",
    key: `p${index}`,
    type: "context",
    oldLine: index + 1,
    newLine: index + 1,
    text: line,
  }));
}
