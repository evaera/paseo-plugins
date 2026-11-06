/**
 * Which lines the editor folds away, as Crit does: every changed line with
 * three lines of context stays, as does every line carrying a thread or a
 * story annotation (with the same context); the unchanged runs between are
 * folded into a bar that expands 20 lines up, 20 down, or all at once. Pure,
 * so it is tested directly; `editor/collapse.ts` draws it.
 *
 * Both sides of a split view fold the same unchanged runs, so a pin or an
 * expansion on one side is mirrored onto the other through `mapLine`.
 */
import { diffLines, structuredPatch } from "diff";

import type { Side } from "../shared/review";
import { type Focus, type LineSpan, hiddenSpans, mergeSpans } from "./story";

export const CONTEXT_LINES = 3;
export const EXPAND_STEP = 20;
/** Runs shorter than this are shown rather than folded: a bar would hide almost nothing. */
export const MIN_FOLD = 4;

function clampSpan(span: LineSpan, total: number): LineSpan | null {
  const start = Math.max(1, span.start);
  const end = Math.min(total, span.end);
  return end >= start ? { start, end } : null;
}

/** The changed lines on each side, with `context` lines around them. */
export function changedSpans(oldText: string, newText: string, context = CONTEXT_LINES): Focus {
  const patch = structuredPatch("a", "b", oldText, newText, undefined, undefined, { context });
  const spanOf = (start: number, lines: number): LineSpan | null => {
    if (lines === 0) return start === 0 ? null : { start, end: start };
    return { start, end: start + lines - 1 };
  };
  const pick = (which: "old" | "new") =>
    mergeSpans(
      patch.hunks.flatMap((hunk) => {
        const span = which === "old" ? spanOf(hunk.oldStart, hunk.oldLines) : spanOf(hunk.newStart, hunk.newLines);
        return span === null ? [] : [span];
      }),
    );
  return { old: pick("old"), new: pick("new") };
}

/** An unchanged run: the same `length` lines starting at `oldStart` and `newStart`. */
export interface Region {
  oldStart: number;
  newStart: number;
  length: number;
}

export function unchangedRegions(oldText: string, newText: string): Region[] {
  const regions: Region[] = [];
  let oldLine = 1;
  let newLine = 1;
  diffLines(oldText, newText).forEach((change) => {
    const count = change.count ?? 0;
    if (change.added) newLine += count;
    else if (change.removed) oldLine += count;
    else {
      regions.push({ oldStart: oldLine, newStart: newLine, length: count });
      oldLine += count;
      newLine += count;
    }
  });
  return regions;
}

/** The same line on the other side, when it is inside an unchanged run; null otherwise. */
export function mapLine(regions: readonly Region[], line: number, from: Side): number | null {
  for (const region of regions) {
    const start = from === "new" ? region.newStart : region.oldStart;
    if (line >= start && line < start + region.length) {
      const offset = line - start;
      return from === "new" ? region.oldStart + offset : region.newStart + offset;
    }
  }
  return null;
}

export function mapSpan(regions: readonly Region[], span: LineSpan, from: Side): LineSpan | null {
  const lines: number[] = [];
  for (let line = span.start; line <= span.end; line += 1) {
    const mapped = mapLine(regions, line, from);
    if (mapped !== null) lines.push(mapped);
  }
  if (lines.length === 0) return null;
  return { start: Math.min(...lines), end: Math.max(...lines) };
}

/** A pinned line kept in view with context, clipped to the document. */
export function pinSpans(lines: readonly number[], total: number, context = CONTEXT_LINES): LineSpan[] {
  return mergeSpans(
    lines.flatMap((line) => {
      const span = clampSpan({ start: line - context, end: line + context }, total);
      return span === null ? [] : [span];
    }),
  );
}

/** The folded runs: everything outside `keep` and `revealed`, ignoring runs shorter than `MIN_FOLD`. */
export function foldedRuns(
  total: number,
  keep: readonly LineSpan[],
  revealed: readonly LineSpan[],
  minFold = MIN_FOLD,
): LineSpan[] {
  return hiddenSpans([...keep, ...revealed], total).filter((run) => run.end - run.start + 1 >= minFold);
}

export type ExpandDirection = "up" | "down" | "all";

/**
 * The lines one press of a fold bar reveals. "down" shows the top of the run
 * (continuing the code above it), "up" the bottom (leading into the code below).
 */
export function expandRun(run: LineSpan, direction: ExpandDirection, step = EXPAND_STEP): LineSpan {
  const length = run.end - run.start + 1;
  // A run that a step would almost empty opens whole, rather than leaving a sliver folded.
  if (direction === "all" || length <= step + MIN_FOLD) return { ...run };
  if (direction === "down") return { start: run.start, end: run.start + step - 1 };
  return { start: run.end - step + 1, end: run.end };
}

/** What each side keeps visible, before expansions. */
export function keepSpans(options: {
  base: LineSpan[];
  pins: readonly number[];
  /** Pins on the other side, mapped across where they sit in unchanged runs. */
  mirroredPins: readonly number[];
  total: number;
}): LineSpan[] {
  return mergeSpans([...options.base, ...pinSpans([...options.pins, ...options.mirroredPins], options.total)]);
}
