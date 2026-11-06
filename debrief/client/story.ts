/**
 * Pure helpers for the story view: which lines of a file a chapter shows, the
 * hidden stretches between them, the native diff's rows cut down to those
 * lines, and the order a reviewer steps through a story's files. No React, no
 * DOM, so it is tested directly.
 */
import type { DiffFile, Hunk, Side } from "../shared/review";
import type { Annotation, Story } from "../shared/story";
import type { DiffItem, DiffRow } from "./diff-rows";
import { rowLine } from "./diff-rows";

/** An inclusive, 1-based run of lines. */
export interface LineSpan {
  start: number;
  end: number;
}

/** The lines a chapter shows on each side; null shows the whole file. */
export interface Focus {
  new: LineSpan[];
  old: LineSpan[];
}

export function mergeSpans(spans: readonly LineSpan[]): LineSpan[] {
  const sorted = spans
    .filter((span) => span.end >= span.start)
    .map((span) => ({ ...span }))
    .sort((a, b) => a.start - b.start);
  const merged: LineSpan[] = [];
  sorted.forEach((span) => {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  });
  return merged;
}

function hunkSpan(start: number, lines: number): LineSpan | null {
  if (start === 0 && lines === 0) return null;
  // A side with no lines in the hunk sits after line `start`; keep that line so the change has a place.
  if (lines === 0) return { start: Math.max(1, start), end: Math.max(1, start) };
  return { start, end: start + lines - 1 };
}

/**
 * The focus for a story file: the spans of the hunks the chapter places, or
 * null when it places all of them (hunk ids omitted) or none match.
 */
export function chapterFocus(file: Pick<DiffFile, "hunks"> | undefined, hunkIds: readonly number[] | undefined): Focus | null {
  if (file === undefined || hunkIds === undefined) return null;
  const ids = new Set(hunkIds);
  const selected = file.hunks.filter((hunk) => ids.has(hunk.oldStart));
  if (selected.length === 0 || selected.length === file.hunks.length) return null;
  return focusOfHunks(selected);
}

export function focusOfHunks(hunks: readonly Hunk[]): Focus {
  const spansOn = (pick: (hunk: Hunk) => LineSpan | null) =>
    mergeSpans(hunks.flatMap((hunk) => {
      const span = pick(hunk);
      return span === null ? [] : [span];
    }));
  return {
    new: spansOn((hunk) => hunkSpan(hunk.newStart, hunk.newLines)),
    old: spansOn((hunk) => hunkSpan(hunk.oldStart, hunk.oldLines)),
  };
}

export function inSpans(spans: readonly LineSpan[], line: number): boolean {
  return spans.some((span) => line >= span.start && line <= span.end);
}

/** The runs of lines outside `spans`, in a document of `total` lines. */
export function hiddenSpans(spans: readonly LineSpan[], total: number): LineSpan[] {
  if (total <= 0) return [];
  const hidden: LineSpan[] = [];
  let next = 1;
  mergeSpans(spans).forEach((span) => {
    const start = Math.max(1, span.start);
    const end = Math.min(total, span.end);
    if (start > next) hidden.push({ start: next, end: Math.min(total, start - 1) });
    next = Math.max(next, end + 1);
  });
  if (next <= total) hidden.push({ start: next, end: total });
  return hidden;
}

/**
 * The native diff's rows cut down to a focus. A hunk header stays only when a
 * line after it does; with no focus, every row stays.
 */
export function focusRows(rows: readonly DiffRow[], focus: Focus | null): DiffRow[] {
  if (focus === null) return [...rows];
  const kept: DiffRow[] = [];
  let header: DiffRow | null = null;
  rows.forEach((row) => {
    if (row.kind === "hunk") {
      header = row;
      return;
    }
    const onNew = row.newLine !== null && inSpans(focus.new, row.newLine);
    const onOld = row.oldLine !== null && inSpans(focus.old, row.oldLine);
    if (!onNew && !onOld) return;
    if (header !== null) {
      kept.push(header);
      header = null;
    }
    kept.push(row);
  });
  return kept;
}

/**
 * Narration placed into the native diff's items, each before the row its line
 * is on. Annotations whose line is not shown come back in `unplaced`.
 */
export function insertNarration(
  items: readonly DiffItem[],
  annotations: readonly Annotation[],
): { items: DiffItem[]; unplaced: Annotation[] } {
  const placed = new Set<string>();
  const out: DiffItem[] = [];
  items.forEach((item) => {
    if (item.kind === "line") {
      annotations.forEach((annotation) => {
        if (placed.has(annotation.id)) return;
        const side: Side = annotation.side;
        if (rowLine(item, side) === annotation.line) {
          placed.add(annotation.id);
          out.push({ kind: "narration", key: `n:${annotation.id}`, annotation });
        }
      });
    }
    out.push(item);
  });
  return { items: out, unplaced: annotations.filter((annotation) => !placed.has(annotation.id)) };
}

export function annotationsOnSide(annotations: readonly Annotation[], side: Side): Annotation[] {
  return annotations.filter((annotation) => annotation.side === side).sort((a, b) => a.line - b.line);
}

/** A place in the story: the prologue, a chapter, or the support list. */
export type StoryPlace = { kind: "prologue" } | { kind: "chapter"; chapterId: string } | { kind: "support" };

export function placeKey(place: StoryPlace): string {
  return place.kind === "chapter" ? `chapter:${place.chapterId}` : place.kind;
}

export function parsePlace(key: string | null | undefined, story: Story | null): StoryPlace {
  if (key === "support") return { kind: "support" };
  if (key?.startsWith("chapter:") === true) {
    const chapterId = key.slice("chapter:".length);
    if (story === null || story.chapters.some((chapter) => chapter.id === chapterId)) return { kind: "chapter", chapterId };
  }
  return { kind: "prologue" };
}

/** Every (chapter, file) the story walks through, in reading order: what j and k step over. */
export function storySequence(story: Story): { chapterId: string; path: string }[] {
  return story.chapters.flatMap((chapter) => chapter.files.map((file) => ({ chapterId: chapter.id, path: file.path })));
}

/** The next or previous entry from `current`, without wrapping; null at either end. */
export function stepSequence<T>(
  sequence: readonly T[],
  index: number,
  direction: 1 | -1,
): T | null {
  if (sequence.length === 0) return null;
  if (index < 0) return direction === 1 ? (sequence[0] ?? null) : (sequence[sequence.length - 1] ?? null);
  return sequence[index + direction] ?? null;
}
