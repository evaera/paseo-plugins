/**
 * The review documents: one per workspace, at
 * `plugin-data/debrief/reviews/<workspaceId>/review.json`.
 *
 * Only this process writes them, so an in-process queue per workspace plus a
 * temp-file-and-rename is all the locking needed. Every write bumps
 * `revision`, which the panel's poll fingerprint includes. A file that fails
 * validation is set aside as `review.json.invalid-<time>` rather than
 * overwritten, so a schema slip never silently loses comments.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ReviewSchema, type Comment, type Review } from "../shared/review";
import { dataPath } from "./data-dir";
import { serialized } from "./serialize";

/** Workspace ids become directory names, so anything that could climb out is refused. */
export function reviewDir(workspaceId: string): string {
  if (workspaceId === "" || workspaceId === "." || workspaceId === ".." || /[/\\\0]/.test(workspaceId)) {
    throw new Error(`"${workspaceId}" is not a workspace id.`);
  }
  return dataPath("reviews", workspaceId);
}

export function reviewPath(workspaceId: string): string {
  return join(reviewDir(workspaceId), "review.json");
}

export function emptyReview(workspaceId: string, cwd: string): Review {
  return { version: 1, workspaceId, cwd, agentId: null, baseRef: null, comments: [], approvedAt: null, revision: 0 };
}

/** Writes `text` to `path` through a temporary sibling, so a reader never sees half a file. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readReview(workspaceId: string, cwd: string): Promise<Review> {
  const path = reviewPath(workspaceId);
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    raw = null;
  }
  if (raw === undefined) return emptyReview(workspaceId, cwd);
  const parsed = ReviewSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error(`[debrief] ${path} is not a valid review; setting it aside.`, parsed.error);
  await rename(path, `${path}.invalid-${Date.now()}`).catch(() => {});
  return emptyReview(workspaceId, cwd);
}

/** The review as stored, or a fresh one. Does not write. */
export function loadReviewDoc(workspaceId: string, cwd: string): Promise<Review> {
  return serialized(`review:${workspaceId}`, () => readReview(workspaceId, cwd));
}

/**
 * Reads, lets `change` edit the document in place, and writes it back with
 * the revision bumped, all inside the workspace's queue. `change` returns
 * `false` to skip the write when it changed nothing.
 */
export function mutateReview<T>(
  workspaceId: string,
  cwd: string,
  change: (review: Review) => T | Promise<T>,
  options: { skipWriteWhen?: (result: T) => boolean } = {},
): Promise<{ review: Review; result: T }> {
  return serialized(`review:${workspaceId}`, async () => {
    const review = await readReview(workspaceId, cwd);
    if (cwd !== "") review.cwd = cwd;
    const result = await change(review);
    if (options.skipWriteWhen?.(result) === true) return { review, result };
    review.revision += 1;
    const valid = ReviewSchema.parse(review);
    await writeAtomic(reviewPath(workspaceId), `${JSON.stringify(valid, null, 2)}\n`);
    return { review: valid, result };
  });
}

function hexId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** `c_` plus six hex digits, unique within the review. */
export function newCommentId(review: Review): string {
  return hexId("c_", new Set(review.comments.map((comment) => comment.id)));
}

/** `rp_` plus six hex digits, unique within the review. */
export function newReplyId(review: Review): string {
  return hexId("rp_", new Set(review.comments.flatMap((comment) => comment.replies.map((reply) => reply.id))));
}

export function findComment(review: Review, commentId: string): Comment {
  const comment = review.comments.find((candidate) => candidate.id === commentId);
  if (comment === undefined) throw new Error(`There is no comment ${commentId} in this review.`);
  return comment;
}
