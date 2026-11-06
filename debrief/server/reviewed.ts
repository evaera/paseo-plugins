/**
 * "Reviewed" marks, as GitHub's and Crit's "Viewed": a file marked reviewed
 * under a compare keeps a fingerprint of its diff at that moment, and loading
 * the review compares it with the diff now. A different fingerprint is
 * `changed`: the file moved after it was marked. Marks are kept per
 * `compareKey`, so "vs main" and "Uncommitted" track separately.
 *
 * A tracked file's fingerprint is a hash of its whole section of `git diff`
 * (the `index` line's blob ids and every hunk line); an untracked file's is a
 * hash of its text, or of its size and mtime when its text was not read.
 */
import { createHash } from "node:crypto";

import type { DiffFile, Review, ReviewState } from "../shared/review";
import { parseUnifiedDiff } from "./diff";
import { mutateReview } from "./store";

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Each file's fingerprint in a unified diff, by its path. A section starts at
 * its `diff --git` line; a hunk line always carries a `+`, `-`, space or `\`
 * first, so no content line can be mistaken for one.
 */
export function diffFingerprints(text: string): Map<string, string> {
  const fingerprints = new Map<string, string>();
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  starts.forEach((start, position) => {
    const end = starts[position + 1] ?? lines.length;
    const section = lines.slice(start, end).join("\n");
    const [file] = parseUnifiedDiff(section);
    if (file !== undefined) fingerprints.set(file.path, hash(section));
  });
  return fingerprints;
}

/** An untracked file's fingerprint: its text, or what stands in for it. */
export function untrackedFingerprint(text: string | null, stand: string): string {
  return hash(text === null ? `untracked:${stand}` : `untracked\0${text}`);
}

/** A file's state from its mark and its fingerprint now. */
export function reviewStateOf(mark: { fingerprint: string } | undefined, fingerprint: string | undefined): ReviewState | null {
  if (mark === undefined) return null;
  return fingerprint !== undefined && mark.fingerprint === fingerprint ? "reviewed" : "changed";
}

/** The files with their fingerprints and review states under `key`. */
export function withReviewStates(
  review: Pick<Review, "reviewed">,
  key: string,
  files: readonly DiffFile[],
  fingerprints: ReadonlyMap<string, string>,
): DiffFile[] {
  const marks = review.reviewed?.[key] ?? {};
  return files.map((file) => {
    const fingerprint = fingerprints.get(file.path);
    const next: DiffFile = { ...file, reviewState: reviewStateOf(marks[file.path], fingerprint) };
    if (fingerprint !== undefined) next.fingerprint = fingerprint;
    return next;
  });
}

/** How many of `files` are reviewed (a changed file is not). */
export function reviewedCount(files: readonly Pick<DiffFile, "reviewState">[]): number {
  return files.filter((file) => file.reviewState === "reviewed").length;
}

/**
 * Marks `path` reviewed with `fingerprint` under `key`, or clears its mark.
 * Clearing a mark that is not there writes nothing.
 */
export async function setReviewedMark(
  workspaceId: string,
  root: string,
  input: { key: string; path: string; reviewed: boolean; fingerprint: string | null },
): Promise<ReviewState | null> {
  const { result } = await mutateReview(
    workspaceId,
    root,
    (draft) => {
      const all = draft.reviewed ?? {};
      const marks = all[input.key] ?? {};
      if (!input.reviewed || input.fingerprint === null) {
        if (marks[input.path] === undefined) return { changed: false, state: null };
        delete marks[input.path];
        if (Object.keys(marks).length === 0) delete all[input.key];
        else all[input.key] = marks;
        draft.reviewed = all;
        return { changed: true, state: null };
      }
      marks[input.path] = { at: new Date().toISOString(), fingerprint: input.fingerprint };
      all[input.key] = marks;
      draft.reviewed = all;
      return { changed: true, state: "reviewed" as const };
    },
    { skipWriteWhen: (outcome) => !outcome.changed },
  );
  return result.state;
}
