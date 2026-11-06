/**
 * Pure helpers for plan review: the diff between two versions, finding a
 * reviewer's selection inside a block's source, and grouping annotations. No
 * React, no DOM, so it is tested directly.
 */
import { diffLines } from "diff";

import type { PlanAnnotation, PlanBlock, PlanSource, PlanStatus, QuickLabel } from "../shared/plan";

export type PlanDiffPart = {
  kind: "added" | "removed" | "same";
  text: string;
  /** Lines of the current version the part covers; absent for a removed part. */
  startLine?: number;
  endLine?: number;
};

export interface PlanDiff {
  parts: PlanDiffPart[];
  added: number;
  removed: number;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/** The previous version against the current one, line by line, as Plannotator's plan diff. */
export function planDiff(previous: string, current: string): PlanDiff {
  const parts: PlanDiffPart[] = [];
  let added = 0;
  let removed = 0;
  let line = 1;
  diffLines(previous, current).forEach((change) => {
    const count = change.count ?? lineCount(change.value);
    if (change.added) {
      added += count;
      parts.push({ kind: "added", text: change.value, startLine: line, endLine: line + count - 1 });
      line += count;
    } else if (change.removed) {
      removed += count;
      parts.push({ kind: "removed", text: change.value });
    } else {
      parts.push({ kind: "same", text: change.value, startLine: line, endLine: line + count - 1 });
      line += count;
    }
  });
  return { parts, added, removed };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a selection taken from the rendered block sits in its Markdown source.
 * Exact first; then with any run of whitespace, or Markdown punctuation around
 * words, allowed between the selected words. Null when it cannot be found.
 */
export function locateSpan(source: string, selected: string): { start: number; end: number } | null {
  const needle = selected.trim();
  if (needle === "") return null;
  const exact = source.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };
  const words = needle.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return null;
  const pattern = new RegExp(words.map(escapeRegExp).join("[\\s*_`~\\[\\]()#>-]*"));
  const match = pattern.exec(source);
  if (match === null) return null;
  return { start: match.index, end: match.index + match[0].length };
}

/** Unsent annotations: what a decision would deliver. */
export function draftAnnotations(annotations: readonly PlanAnnotation[]): PlanAnnotation[] {
  return annotations.filter((annotation) => annotation.sentInVersion === undefined);
}

export function annotationsByBlock(annotations: readonly PlanAnnotation[]): Map<string, PlanAnnotation[]> {
  const map = new Map<string, PlanAnnotation[]>();
  annotations.forEach((annotation) => {
    if (annotation.blockId === undefined) return;
    const list = map.get(annotation.blockId) ?? [];
    list.push(annotation);
    map.set(annotation.blockId, list);
  });
  return map;
}

/** Annotations in the order the plan reads: global first, then by block, then by offset. */
export function sortAnnotations(annotations: readonly PlanAnnotation[], blocks: readonly PlanBlock[]): PlanAnnotation[] {
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const rank = (annotation: PlanAnnotation) =>
    annotation.type === "global" ? -1 : (order.get(annotation.blockId ?? "") ?? annotation.startLine ?? Number.MAX_SAFE_INTEGER);
  return [...annotations].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.startOffset ?? 0) - (b.startOffset ?? 0) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function labelNames(ids: readonly string[], labels: readonly QuickLabel[]): string[] {
  return ids.map((id) => labels.find((label) => label.id === id)?.label ?? id);
}

export function sourceLabel(source: PlanSource): string {
  switch (source.kind) {
    case "exit-plan-mode":
      return "Plan mode";
    case "tool":
      return "Submitted by agent";
    case "file":
      return source.path;
  }
}

export function statusLabel(status: PlanStatus): string {
  switch (status) {
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "changes-requested":
      return "changes requested";
  }
}

/** Clips a quote for display. */
export function clip(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
