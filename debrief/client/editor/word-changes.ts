/**
 * Word-level change marks, only where a line was modified.
 *
 * @codemirror/merge's own `highlightChanges` marks every changed range, so a
 * purely added (or deleted) block is painted edge to edge on top of its line
 * tint, which makes it hard to read. Crit, like GitHub, emphasises words only
 * inside a chunk that has both an old and a new side. This draws that: the
 * merge view runs with `highlightChanges: false`, and this extension marks the
 * changes of mixed chunks on its own side.
 */
import type { Extension } from "@codemirror/state";

import type { CM } from "./cm";

export function wordChanges(cm: CM, side: "old" | "new"): Extension {
  const { Decoration, ViewPlugin } = cm.view;
  const { RangeSetBuilder } = cm.state;
  const { getChunks } = cm.merge;
  const mark = Decoration.mark({ class: side === "old" ? "cm-debrief-word-del" : "cm-debrief-word-add" });

  type View = import("@codemirror/view").EditorView;
  const build = (view: View) => {
    const builder = new RangeSetBuilder<import("@codemirror/view").Decoration>();
    const found = getChunks(view.state);
    if (found === null) return builder.finish();
    for (const [from, to] of wordChangeRanges(found.chunks, found.side === "a", view.state.doc)) {
      builder.add(from, to, mark);
    }
    return builder.finish();
  };

  return ViewPlugin.define(
    (view) => ({
      decorations: build(view),
      update(update: import("@codemirror/view").ViewUpdate) {
        // The merge view recomputes its chunks in a transaction of its own, so rebuild on every update.
        this.decorations = build(update.view);
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

/** How much of a line's text must be unchanged for its changed words to be emphasised. */
const MIN_KEPT_SHARE = 0.3;

interface ChunkLike {
  readonly fromA: number;
  readonly toA: number;
  readonly fromB: number;
  readonly toB: number;
  readonly changes: readonly { readonly fromA: number; readonly toA: number; readonly fromB: number; readonly toB: number }[];
}

/**
 * The document ranges to emphasise on one side: changed text on lines that
 * keep a fair share of unchanged text, which is a modified line. A line the
 * changes (nearly) cover was only added or removed, and shows with its line
 * tint alone, as in Crit and GitHub.
 */
export function wordChangeRanges(
  chunks: readonly ChunkLike[],
  isA: boolean,
  doc: { readonly length: number; sliceString(from: number, to: number): string },
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const chunk of chunks) {
    const start = isA ? chunk.fromA : chunk.fromB;
    const end = Math.min(isA ? chunk.toA : chunk.toB, doc.length);
    if (end <= start) continue;
    const own: Array<[number, number]> = [];
    for (const change of chunk.changes) {
      const from = start + (isA ? change.fromA : change.fromB);
      const to = Math.min(start + (isA ? change.toA : change.toB), end);
      if (to > from) own.push([from, to]);
    }
    if (own.length === 0) continue;
    // Walk the chunk line by line on this side.
    const text = doc.sliceString(start, end);
    let lineStart = start;
    for (const line of text.split("\n")) {
      const lineEnd = lineStart + line.length;
      const inLine = own
        .map(([from, to]): [number, number] => [Math.max(from, lineStart), Math.min(to, lineEnd)])
        .filter(([from, to]) => to > from);
      if (inLine.length > 0) {
        let unchanged = "";
        let at = lineStart;
        for (const [from, to] of inLine) {
          unchanged += doc.sliceString(at, from);
          at = to;
        }
        unchanged += doc.sliceString(at, lineEnd);
        // A stray bracket or semicolon the diff happened to keep doesn't make a line "modified".
        const kept = unchanged.replace(/\s/g, "").length;
        const total = line.replace(/\s/g, "").length;
        if (total > 0 && kept / total >= MIN_KEPT_SHARE) ranges.push(...inLine);
      }
      lineStart = lineEnd + 1;
    }
  }
  return ranges;
}
