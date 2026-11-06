/**
 * Story validation: a port of Crit's `internal/story/ingest.go` (MIT).
 *
 * Hunks are `(path, oldStart)`, 0 for a new file. A file the diff lists with
 * no hunks at all (binary, a pure rename, a mode change) is one hunk with id
 * 0, so it too has to be placed somewhere.
 *
 * The order is Crit's: shape, then drift (`scopeFingerprint`, checked by the
 * caller), then duplicates (rejected), then
 * missing hunks, which are repaired into `support` when at least half the
 * diff was placed and rejected below that floor.
 */
import { createHash } from "node:crypto";

import type { DiffFile } from "../shared/review";
import type { Chapter, Coverage, StoryDraft } from "../shared/story";

export const PLACED_FLOOR = 0.5;
export const MAX_TITLE_CHARS = 48;
export const AUTO_REPAIRED = "auto-repaired";

export interface HunkId {
  path: string;
  oldStart: number;
}

export function hunkKey(hunk: HunkId): string {
  return `(${hunk.path}, ${hunk.oldStart})`;
}

/** Every hunk of the diff, in diff order. */
export function hunkIndex(files: readonly DiffFile[]): HunkId[] {
  const seen = new Set<string>();
  const out: HunkId[] = [];
  for (const file of files) {
    const starts = file.hunks.length === 0 ? [0] : file.hunks.map((hunk) => hunk.oldStart);
    for (const oldStart of starts) {
      const id = { path: file.path, oldStart };
      if (seen.has(hunkKey(id))) continue;
      seen.add(hunkKey(id));
      out.push(id);
    }
  }
  return out;
}

/**
 * The scope fingerprint: sha256 over every hunk's full shape (path, oldStart,
 * oldLines, newStart, newLines), sorted, NUL-separated. Crit hashes only the
 * ids; the counts are included here so that a story whose hunks grew or
 * shrank under further edits reads as stale, not only one whose hunks moved.
 */
export function scopeFingerprint(files: readonly DiffFile[]): string {
  const keys: string[] = [];
  for (const file of files) {
    if (file.hunks.length === 0) keys.push(`${file.path}\0 0,0,0,0`);
    for (const hunk of file.hunks) keys.push(`${file.path}\0${hunk.oldStart},${hunk.oldLines},${hunk.newStart},${hunk.newLines}`);
  }
  const hash = createHash("sha256");
  for (const key of keys.sort()) {
    hash.update(key);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class StoryRejected extends Error {
  constructor(
    message: string,
    readonly coverage: Coverage,
  ) {
    super(message);
    this.name = "StoryRejected";
  }
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return text.trim();
  return `${chars.slice(0, max - 3).join("")}...`;
}

function slug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base === "" ? "chapter" : base;
}

const CHAPTER_ID = /^[A-Za-z0-9_-]+$/;

/** A draft as validated: titles trimmed and capped, every chapter given a unique id. */
export type ShapedDraft = Omit<StoryDraft, "chapters"> & { chapters: Chapter[] };

/** Crit's `ValidateShape` and `normalizeStory`; generates ids for chapters that have none. */
export function shapeDraft(draft: StoryDraft): ShapedDraft {
  const empty: Coverage = { indexed: 0, placed: 0, missing: [], duplicated: [], autoRepaired: 0 };
  const prologue = { ...draft.prologue, title: truncate(draft.prologue.title, MAX_TITLE_CHARS) };
  const hasBullet = (items: readonly string[]) => items.some((item) => item.trim() !== "");
  if (prologue.title === "" || prologue.overview.trim() === "" || !hasBullet(prologue.keyChanges) || !hasBullet(prologue.risks)) {
    throw new StoryRejected("The prologue needs a title, an overview, and at least one key change and one risk.", empty);
  }
  const taken = new Set<string>(draft.chapters.map((chapter) => chapter.id).filter((id): id is string => id !== undefined));
  const ids = new Set<string>();
  const chapters: Chapter[] = draft.chapters.map((chapter) => {
    let id = chapter.id;
    if (id === undefined) {
      const base = slug(chapter.title);
      id = base;
      for (let n = 2; taken.has(id) || ids.has(id); n += 1) id = `${base}-${n}`;
    }
    if (!CHAPTER_ID.test(id) || id === "overview" || id === "support" || ids.has(id)) {
      throw new StoryRejected(`Chapter id "${id}" must be a unique URL-safe name other than overview or support.`, empty);
    }
    ids.add(id);
    return { ...chapter, id, title: truncate(chapter.title, MAX_TITLE_CHARS) };
  });
  return { ...draft, prologue, chapters };
}

export interface CoverageResult {
  support: StoryDraft["support"];
  coverage: Coverage;
}

/**
 * Crit's `Run` after the shape and drift checks: tallies every placement,
 * rejects duplicates, repairs missing hunks into `support` above the floor.
 * References to hunks the diff does not have are tolerated and not counted.
 */
export function checkCoverage(draft: ShapedDraft, indexed: readonly HunkId[]): CoverageResult {
  const byPath = new Map<string, number[]>();
  for (const hunk of indexed) byPath.set(hunk.path, [...(byPath.get(hunk.path) ?? []), hunk.oldStart]);
  const known = new Set(indexed.map(hunkKey));
  const counts = new Map<string, number>();
  const place = (path: string, hunks: readonly number[] | undefined) => {
    for (const oldStart of hunks ?? byPath.get(path) ?? []) {
      const key = hunkKey({ path, oldStart });
      if (known.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };
  for (const chapter of draft.chapters) for (const file of chapter.files) place(file.path, file.hunks);
  for (const entry of draft.support) place(entry.path, entry.hunks);

  const duplicated = indexed.filter((hunk) => (counts.get(hunkKey(hunk)) ?? 0) > 1);
  const missing = indexed.filter((hunk) => !counts.has(hunkKey(hunk)));
  const coverage: Coverage = {
    indexed: indexed.length,
    placed: counts.size,
    missing: missing.map((hunk) => ({ ...hunk })),
    duplicated: duplicated.map((hunk) => ({ ...hunk })),
    autoRepaired: 0,
  };
  if (duplicated.length > 0) {
    throw new StoryRejected(`The story places the same hunk more than once: ${duplicated.map(hunkKey).join(", ")}.`, coverage);
  }
  if (missing.length === 0) return { support: draft.support, coverage };
  if (indexed.length === 0 || counts.size / indexed.length < PLACED_FLOOR) {
    throw new StoryRejected(
      `The story places fewer than half of the diff's hunks (${counts.size} of ${indexed.length}). Place every hunk once, in a chapter or in support.`,
      coverage,
    );
  }
  const repaired = new Map<string, number[]>();
  for (const hunk of missing) repaired.set(hunk.path, [...(repaired.get(hunk.path) ?? []), hunk.oldStart]);
  const support = [
    ...draft.support,
    ...[...repaired.entries()].map(([path, hunks]) => ({ path, hunks, reason: AUTO_REPAIRED })),
  ];
  return { support, coverage: { ...coverage, autoRepaired: missing.length } };
}
