/**
 * Keeps new-side line comments on their code as the work tree changes.
 *
 * Re-anchoring needs the content a comment was last placed against, so the
 * review keeps a sidecar, `reviews/<workspaceId>/anchors.json`: for each file
 * with a movable comment, its text (and mtime and size, so an untouched file
 * is not even read) at the last anchoring. When the file on disk differs,
 * `server/anchor.ts` moves every comment on it and the snapshot advances.
 *
 * New-side positions are stored against the work tree in every scope: that is
 * what the agent edits and the editor saves. A comment placed in the branch
 * or staged scope is moved onto the work tree when it is created
 * (`server/comments.ts`).
 *
 * Everything here runs inside the review's queue (`mutateReview`), which is
 * also what orders writes to the sidecar.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Review } from "../shared/review";
import { isMovable, reanchorComments, reverifyComments, type Movable } from "./anchor";
import { readDiskText } from "./files";
import { readJson, reviewDir, writeAtomic } from "./store";

const SnapshotSchema = z.object({ text: z.string(), mtimeMs: z.number().nullable(), size: z.number() });
const SnapshotsSchema = z.record(z.string(), SnapshotSchema);
type Snapshots = z.infer<typeof SnapshotsSchema>;

/** The review's comments snapshot; stories keep their own (`server/story.ts`). */
export const COMMENT_SNAPSHOTS = "anchors.json";

function snapshotsPath(workspaceId: string, file: string): string {
  return join(reviewDir(workspaceId), file);
}

export async function readSnapshots(workspaceId: string, file = COMMENT_SNAPSHOTS): Promise<Snapshots> {
  const parsed = SnapshotsSchema.safeParse(await readJson(snapshotsPath(workspaceId, file)).catch(() => undefined));
  return parsed.success ? parsed.data : {};
}

export function writeSnapshots(workspaceId: string, snapshots: Snapshots, file = COMMENT_SNAPSHOTS): Promise<void> {
  return writeAtomic(snapshotsPath(workspaceId, file), `${JSON.stringify(snapshots)}\n`);
}

type Current = { kind: "text"; text: string; mtimeMs: number | null; size: number } | { kind: "gone" } | { kind: "unreadable" };

async function readCurrent(root: string, path: string): Promise<Current> {
  try {
    const disk = await readDiskText(join(root, path));
    if (disk.text !== null) return { kind: "text", text: disk.text, mtimeMs: disk.mtimeMs, size: Buffer.byteLength(disk.text) };
    return disk.mtimeMs === null ? { kind: "gone" } : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** A stat, so a file nobody touched is not read at all. */
async function unchangedSince(root: string, path: string, snapshot: { mtimeMs: number | null; size: number }): Promise<boolean> {
  try {
    const info = await stat(join(root, path));
    return info.isFile() && info.mtimeMs === snapshot.mtimeMs && info.size === snapshot.size;
  } catch {
    return false;
  }
}

function hasDrifted(comments: readonly Movable[], path: string): boolean {
  return comments.some((comment) => comment.path === path && isMovable(comment) && comment.drifted);
}

function movablePaths(comments: readonly Movable[]): Set<string> {
  return new Set(comments.filter(isMovable).map((comment) => comment.path ?? ""));
}

/**
 * Brings every movable comment in `review` up to the work tree, editing it in
 * place. `only` limits it to one path. Returns whether any comment moved or
 * changed its drift.
 */
export function reanchorReview(review: Review, root: string, only?: string): Promise<boolean> {
  return reanchorMovables(review.workspaceId, COMMENT_SNAPSHOTS, review.comments, root, only);
}

/** The same, over any movables with their own snapshot file. */
export async function reanchorMovables(
  workspaceId: string,
  file: string,
  items: Movable[],
  root: string,
  only?: string,
): Promise<boolean> {
  const snapshots = await readSnapshots(workspaceId, file);
  const paths = movablePaths(items);
  let moved = false;
  let dirty = false;

  for (const path of Object.keys(snapshots)) {
    if (!paths.has(path)) {
      delete snapshots[path];
      dirty = true;
    }
  }
  for (const path of paths) {
    if (only !== undefined && path !== only) continue;
    const snapshot = snapshots[path];
    if (snapshot !== undefined && (await unchangedSince(root, path, snapshot)) && !hasDrifted(items, path)) continue;
    const current = await readCurrent(root, path);
    if (current.kind === "unreadable") continue;
    if (snapshot === undefined) {
      // A comment from before snapshots existed, or whose snapshot was lost:
      // anchor it against what is there now.
      if (current.kind === "text") {
        snapshots[path] = { text: current.text, mtimeMs: current.mtimeMs, size: current.size };
        dirty = true;
      }
      continue;
    }
    if (current.kind === "gone") {
      if (reanchorComments(items, path, snapshot.text, null)) moved = true;
      continue;
    }
    if (current.text === snapshot.text) {
      // Back after being gone, perhaps: the positions are the snapshot's, so only drift can be stale.
      if (reverifyComments(items, path, current.text)) moved = true;
      if (current.mtimeMs !== snapshot.mtimeMs) {
        snapshots[path] = { text: current.text, mtimeMs: current.mtimeMs, size: current.size };
        dirty = true;
      }
      continue;
    }
    if (reanchorComments(items, path, snapshot.text, current.text)) moved = true;
    snapshots[path] = { text: current.text, mtimeMs: current.mtimeMs, size: current.size };
    dirty = true;
  }
  if (dirty) await writeSnapshots(workspaceId, snapshots, file);
  return moved;
}

/**
 * Before a new comment is placed on `path`: moves the existing ones up to the
 * current content and records that content as the snapshot, so the new
 * comment's lines and the snapshot agree. Returns the current text.
 */
export function prepareAnchor(review: Review, root: string, path: string): Promise<string | null> {
  return prepareMovableAnchor(review.workspaceId, COMMENT_SNAPSHOTS, review.comments, root, path);
}

export async function prepareMovableAnchor(
  workspaceId: string,
  file: string,
  items: Movable[],
  root: string,
  path: string,
): Promise<string | null> {
  await reanchorMovables(workspaceId, file, items, root, path);
  const current = await readCurrent(root, path);
  if (current.kind !== "text") return null;
  const snapshots = await readSnapshots(workspaceId, file);
  snapshots[path] = { text: current.text, mtimeMs: current.mtimeMs, size: current.size };
  await writeSnapshots(workspaceId, snapshots, file);
  return current.text;
}
