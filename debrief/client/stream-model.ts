/**
 * The arithmetic of the continuous diff: a height estimate for a file section
 * before it has been drawn, where each section starts, which section is at a
 * scroll offset, and which sections are near enough the viewport to mount or
 * to prefetch. Pure, so it is tested directly; `diff-stream.tsx` draws it.
 */
import type { DiffFile } from "../shared/review";
import { CONTEXT_LINES } from "./collapse";

/** A section's sticky header: path, counts, actions. */
export const SECTION_HEADER_HEIGHT = 38;
/** A fold bar between hunks (`.cm-debrief-fold`). */
export const FOLD_BAR_HEIGHT = 26;
/** A thread, folded or open, on average. */
export const THREAD_ESTIMATE = 110;
/** A message in place of the editor: binary, too large, failed. */
export const MESSAGE_HEIGHT = 48;
const EDITOR_PADDING = 8;

export interface EstimateOptions {
  layout: "unified" | "split";
  lineHeight: number;
  /** Threads drawn in the file (line and file scope). */
  threads: number;
  /** The section's body is folded away by its chevron. */
  collapsed: boolean;
}

/** The lines the editor shows for a file once unchanged runs are folded. */
export function visibleLines(file: Pick<DiffFile, "hunks" | "deletions">, layout: "unified" | "split"): number {
  if (layout === "split") return file.hunks.reduce((sum, hunk) => sum + Math.max(hunk.oldLines, hunk.newLines), 0);
  // Unified shows the new side's lines (context included) and the deleted lines between them.
  return file.hunks.reduce((sum, hunk) => sum + hunk.newLines, 0) + file.deletions;
}

/** How many fold bars the file gets: one between hunks, and at either end when lines are folded there. */
export function foldBars(file: Pick<DiffFile, "hunks" | "status">): number {
  if (file.status === "added" || file.status === "untracked" || file.status === "deleted") return 0;
  if (file.hunks.length === 0) return 0;
  const first = file.hunks[0];
  const top = first !== undefined && first.newStart > CONTEXT_LINES + 1 ? 1 : 0;
  // The end of the file is unknown before it loads; most files have lines after their last hunk.
  return top + (file.hunks.length - 1) + 1;
}

export function estimateSectionHeight(file: DiffFile, options: EstimateOptions): number {
  if (options.collapsed) return SECTION_HEADER_HEIGHT;
  if (file.binary) return SECTION_HEADER_HEIGHT + MESSAGE_HEIGHT;
  const lines = Math.max(1, visibleLines(file, options.layout));
  return (
    SECTION_HEADER_HEIGHT +
    EDITOR_PADDING +
    lines * options.lineHeight +
    foldBars(file) * FOLD_BAR_HEIGHT +
    options.threads * THREAD_ESTIMATE
  );
}

/** Where each section starts, from the heights in order. */
export function sectionTops(heights: readonly number[]): number[] {
  const tops: number[] = [];
  let top = 0;
  heights.forEach((height) => {
    tops.push(top);
    top += height;
  });
  return tops;
}

/** The section containing `y` (the last one at or before it), or -1 with no sections. */
export function sectionAt(tops: readonly number[], y: number): number {
  if (tops.length === 0) return -1;
  let low = 0;
  let high = tops.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((tops[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The sections intersecting the viewport stretched by `before` screens above
 * and `after` screens below, as an inclusive index range; null with none.
 */
export function windowRange(
  tops: readonly number[],
  heights: readonly number[],
  scrollY: number,
  viewport: number,
  before: number,
  after: number,
): { first: number; last: number } | null {
  if (tops.length === 0) return null;
  const from = Math.max(0, scrollY - before * viewport);
  const to = scrollY + viewport * (1 + after);
  let first = sectionAt(tops, from);
  // `sectionAt` gives the section starting at or before `from`; when it ends before `from`, the next one is first.
  if ((tops[first] ?? 0) + (heights[first] ?? 0) <= from && first < tops.length - 1) first += 1;
  const last = Math.max(first, sectionAt(tops, Math.max(from, to - 1)));
  return { first, last };
}

/** Indices in `range`, nearest to `center` first: the order to prefetch in. */
export function nearestFirst(range: { first: number; last: number }, center: number): number[] {
  const indices: number[] = [];
  for (let index = range.first; index <= range.last; index += 1) indices.push(index);
  return indices.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
}


/**
 * The section at the top of the viewport: the one under a line just below
 * `scrollY`, measured from the first section (`offset` is whatever the list
 * draws above it). -1 with no sections.
 */
export function activeSection(tops: readonly number[], scrollY: number, offset = 0): number {
  return sectionAt(tops, Math.max(0, scrollY - offset) + ACTIVE_SLACK);
}
/** How far below the top edge a section has to reach to count as the one on top. */
export const ACTIVE_SLACK = 4;

/**
 * Which sections keep an editor: every one in `inner`, and those already
 * mounted that are still inside `outer`, so a section on the edge does not
 * mount and unmount with every pixel scrolled. `keep` (unsaved edits, the
 * section being navigated to) is always included. Keys are paths.
 */
export function nextMounted(
  keys: readonly string[],
  previous: ReadonlySet<string>,
  inner: { first: number; last: number } | null,
  outer: { first: number; last: number } | null,
  keep: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  keys.forEach((key, index) => {
    const inInner = inner !== null && index >= inner.first && index <= inner.last;
    const inOuter = outer !== null && index >= outer.first && index <= outer.last;
    if (inInner || keep.has(key) || (inOuter && previous.has(key))) next.add(key);
  });
  return next;
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  let same = true;
  a.forEach((key) => {
    if (!b.has(key)) same = false;
  });
  return same;
}

/**
 * The offset to scroll `index`'s section to the top of the viewport, clamped
 * to what the list can scroll; `within` is a distance into the section.
 */
export function scrollTarget(
  tops: readonly number[],
  index: number,
  offset: number,
  within: number,
  content: number,
  viewport: number,
): number {
  const top = (tops[index] ?? 0) + offset + within;
  return Math.max(0, Math.min(top, Math.max(0, content - viewport)));
}
