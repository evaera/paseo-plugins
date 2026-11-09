/**
 * How much room the screen has, as one of three layouts, and the sizes each one derives from its width.
 * Pure.
 *
 * Everything here goes by the surface's own measured width and the host's `compact` flag, never by
 * device: a foldable is a phone folded and a small tablet open, and a desktop window dragged narrow is
 * the same layout as either.
 *
 * - **phone**: the host says compact. One pane at a time, tabs at the foot.
 * - **medium**: not compact, but narrower than `SPLIT_MIN_WIDTH`: an unfolded foldable, a tablet, or a
 *   desktop window with Paseo's sidebar open. One pane at a time, full width, tabs in the header.
 * - **wide**: everything wider, chat beside the board, laid out exactly as it always was.
 */
import { createContext, useContext } from "react";

export type LayoutTier = "phone" | "medium" | "wide";

/**
 * The narrowest surface the chat-beside-board split reads well at, with the chat at its default 36%
 * share: the chat needs about 480 pt for a line of prose and its composer's buttons, and the board
 * three whole 280 pt columns (two 10 pt gaps and 12 pt padding each side make 884 pt, and the 9 pt
 * resize handle sits in the board's share). 480 / 0.36 is 1334 and 893 / 0.64 is 1396, so 1400. A 1440 pt window with the
 * sidebar closed stays split; with Paseo's 320 pt sidebar open it is 1120 pt and goes to one pane,
 * where the split left the board one cut column.
 */
export const SPLIT_MIN_WIDTH = 1400;

export function layoutTier(compact: boolean, surfaceWidth: number): LayoutTier {
  if (compact) return "phone";
  // Before the first layout the width is 0: drawn wide, as before, rather than flashing one pane.
  if (surfaceWidth > 0 && surfaceWidth < SPLIT_MIN_WIDTH) return "medium";
  return "wide";
}

/** Provided by the screen; panels and anything outside the screen read `wide`, the layout they always had. */
export const LayoutTierContext = createContext<LayoutTier>("wide");

export function useLayoutTier(): LayoutTier {
  return useContext(LayoutTierContext);
}

/** The smallest a touch target may be, in points, on the layouts a finger drives. */
export const TOUCH_TARGET = 44;

export interface ColumnFit {
  /** Padding at each end of the row of columns. */
  pad: number;
  gap: number;
  foldedWidth: number;
  min: number;
  max: number;
}

export const FITTED_COLUMNS: ColumnFit = { pad: 10, gap: 10, foldedWidth: 40, min: 240, max: 340 };

/**
 * An open column's width on the medium layout: as many columns as fit at `min` share the pane after the
 * folded strips, so whole columns show and none is cut at the edge; the rest are a swipe away. Never
 * wider than `max`, never narrower than `min` unless the pane itself is.
 */
export function fittedColumnWidth(pane: number, open: number, folded: number, fit: ColumnFit = FITTED_COLUMNS): number {
  const available = pane - 2 * fit.pad - folded * (fit.foldedWidth + fit.gap);
  if (open <= 0 || available <= 0) return fit.min;
  if (available < fit.min) return Math.floor(available);
  const shown = Math.max(1, Math.min(open, Math.floor((available + fit.gap) / (fit.min + fit.gap))));
  return Math.floor(Math.min(fit.max, (available - fit.gap * (shown - 1)) / shown));
}

/** Where each column starts in the scrolled row, for snapping to a column's edge. */
export function columnOffsets(widths: readonly number[], fit: Pick<ColumnFit, "gap">): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const width of widths) {
    offsets.push(at);
    at += width + fit.gap;
  }
  return offsets;
}

/**
 * The offset the edge buttons scroll to: the next column start past `x` going right, the last one
 * before it going left. Within a couple of points counts as there, so a snapped row moves a whole
 * column per press.
 */
export function nextOffset(offsets: readonly number[], x: number, direction: 1 | -1): number {
  const near = 2;
  if (direction === 1) return offsets.find((offset) => offset > x + near) ?? offsets[offsets.length - 1] ?? 0;
  const before = offsets.filter((offset) => offset < x - near);
  return before[before.length - 1] ?? 0;
}

/** Which ends of a scrolled row have more beyond them, for the fades and buttons that say so. */
export function overflowEdges(offset: number, viewport: number, content: number): { start: boolean; end: boolean } {
  const near = 4;
  return { start: offset > near, end: offset + viewport < content - near };
}

/**
 * A composer that grows with its text: the twin's measured height, held between `minLines` and
 * `maxLines` of text. Past the cap the box scrolls. A height not measured yet is one line.
 */
export function growingHeight(measured: number | null, lineHeight: number, minLines: number, maxLines: number): number {
  const min = lineHeight * minLines;
  const max = lineHeight * maxLines;
  if (measured === null || !(measured > 0)) return min;
  return Math.round(Math.min(max, Math.max(min, measured)));
}

/**
 * The text an invisible twin lays out to size a growing box. A trailing newline is a line of its own in a
 * text box but nothing in a `Text`, and an empty `Text` has no height, so both get a character to hold
 * the line open.
 */
export function twinText(text: string): string {
  if (text === "") return " ";
  return text.endsWith("\n") ? `${text} ` : text;
}

/**
 * How far to pad a mark drawn `drawn` points across, on each side, with a matching negative margin, so
 * its touch area reaches `target` without moving or growing what is drawn. `hitSlop` would say the same,
 * but the web renderer ignores it on a plain view, and a drag handle's responder is one.
 */
export function touchPadding(drawn: number, target: number = TOUCH_TARGET): number {
  return Math.max(0, Math.ceil((target - drawn) / 2));
}
