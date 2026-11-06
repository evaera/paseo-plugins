/**
 * Every change to a review's comments, for the panel's RPCs and the agent
 * tools alike. Each runs inside the review's queue and returns the saved
 * comment; telling the agent is the caller's business (`ReviewEvents`), so an
 * agent's own reply never comes back to it as a note.
 */
import type { Compare } from "../shared/compare";
import type { Author, Comment, Review, Scope, Side } from "../shared/review";
import { captureAnchor, computeLineMap, remapPosition, splitLines } from "./anchor";
import { cachedCompare, compareSources, toCompare } from "./compare";
import { cleanRelative, readGitText } from "./files";
import { repoRoot } from "./git";
import { prepareAnchor } from "./reanchor";
import { findComment, mutateReview, newCommentId, newReplyId } from "./store";

export interface NewComment {
  scope: "line" | "file" | "review";
  path?: string | undefined;
  side?: Side | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  quote?: string | undefined;
  body: string;
  /** The scope the panel showed; absent means `all`. */
  diffScope?: Scope | undefined;
  /** The compare the panel showed; wins over `diffScope`. */
  diffCompare?: Compare | undefined;
}

function now(): string {
  return new Date().toISOString();
}

interface Placed {
  startLine: number;
  endLine: number;
  anchor?: string;
  drifted: boolean;
}

/**
 * The commented lines' text, read on the side the panel showed in `compare`.
 * New-side positions are then stored on the work tree: when the panel showed
 * a commit or the index, the range is carried over with the same line map and
 * anchor check that re-anchoring uses.
 */
async function place(review: Review, root: string, path: string, side: Side, compare: Compare, start: number, end: number): Promise<Placed> {
  const inGit = (await repoRoot(root)) !== null;
  const resolved = inGit ? await cachedCompare(root, review.baseRef, compare).catch(() => null) : null;
  const sources = resolved === null ? { old: null, new: null } : compareSources(resolved);

  if (side === "old") {
    if (sources.old === null) return { startLine: start, endLine: end, drifted: false };
    const old = await readGitText(root, sources.old, path);
    const anchor = old.text === null ? undefined : captureAnchor(old.text, start, end);
    return anchor === undefined ? { startLine: start, endLine: end, drifted: false } : { startLine: start, endLine: end, anchor, drifted: false };
  }

  const work = await prepareAnchor(review, root, path);
  if (sources.new === null) {
    const anchor = work === null ? undefined : captureAnchor(work, start, end);
    return anchor === undefined ? { startLine: start, endLine: end, drifted: false } : { startLine: start, endLine: end, anchor, drifted: false };
  }
  const shown = (await readGitText(root, sources.new, path)).text;
  const anchor = shown === null ? undefined : captureAnchor(shown, start, end);
  if (shown === null || work === null) {
    return anchor === undefined ? { startLine: start, endLine: end, drifted: false } : { startLine: start, endLine: end, anchor, drifted: false };
  }
  const moved = remapPosition({ startLine: start, endLine: end, anchor }, computeLineMap(shown, work), splitLines(work));
  return anchor === undefined ? { ...moved, drifted: false } : { ...moved, anchor };
}

export async function createComment(workspaceId: string, root: string, input: NewComment, author: Author): Promise<{ review: Review; comment: Comment }> {
  const body = input.body.trim();
  if (body === "") throw new Error("A comment needs a body.");
  const path = input.scope === "review" || input.path === undefined ? undefined : cleanRelative(input.path);
  if (input.scope !== "review" && path === undefined) throw new Error(`A ${input.scope} comment needs a path.`);

  const { review, result } = await mutateReview(workspaceId, root, async (draft) => {
    const at = now();
    const comment: Comment = {
      id: newCommentId(draft),
      scope: input.scope,
      body,
      author,
      createdAt: at,
      updatedAt: at,
      resolved: false,
      drifted: false,
      replies: [],
    };
    if (path !== undefined) comment.path = path;
    if (input.scope === "line") {
      if (input.startLine === undefined) throw new Error("A line comment needs a start line.");
      const start = Math.min(input.startLine, input.endLine ?? input.startLine);
      const end = Math.max(input.startLine, input.endLine ?? input.startLine);
      const side = input.side ?? "new";
      comment.side = side;
      comment.startLine = start;
      comment.endLine = end;
      const placed = await place(draft, root, path ?? "", side, toCompare(input.diffScope, input.diffCompare), start, end);
      comment.startLine = placed.startLine;
      comment.endLine = placed.endLine;
      comment.drifted = placed.drifted;
      if (placed.anchor !== undefined) comment.anchor = placed.anchor;
      if (input.quote !== undefined && input.quote !== "") comment.quote = input.quote;
    }
    draft.comments.push(comment);
    return comment;
  });
  return { review, comment: result };
}

export async function replyToComment(
  workspaceId: string,
  root: string,
  commentId: string,
  body: string,
  author: Author,
): Promise<{ review: Review; comment: Comment; replyId: string }> {
  const text = body.trim();
  if (text === "") throw new Error("A reply needs a body.");
  const { review, result } = await mutateReview(workspaceId, root, (draft) => {
    const comment = findComment(draft, commentId);
    const at = now();
    const id = newReplyId(draft);
    comment.replies.push({ id, body: text, author, createdAt: at, updatedAt: at });
    return { comment, replyId: id };
  });
  return { review, ...result };
}

export async function editComment(
  workspaceId: string,
  root: string,
  input: { commentId: string; replyId?: string | undefined; body: string },
): Promise<{ review: Review; comment: Comment }> {
  const text = input.body.trim();
  if (text === "") throw new Error("A comment needs a body.");
  const { review, result } = await mutateReview(workspaceId, root, (draft) => {
    const comment = findComment(draft, input.commentId);
    const at = now();
    if (input.replyId !== undefined) {
      const reply = comment.replies.find((entry) => entry.id === input.replyId);
      if (reply === undefined) throw new Error(`Comment ${input.commentId} has no reply ${input.replyId}.`);
      reply.body = text;
      reply.updatedAt = at;
    } else {
      comment.body = text;
      comment.updatedAt = at;
    }
    return comment;
  });
  return { review, comment: result };
}

/** Removes a comment, or one of its replies. Returns the comment as it was before a whole-comment delete. */
export async function deleteComment(
  workspaceId: string,
  root: string,
  input: { commentId: string; replyId?: string | undefined },
): Promise<{ review: Review; comment: Comment; removed: "comment" | "reply" }> {
  const { review, result } = await mutateReview(workspaceId, root, (draft) => {
    const comment = findComment(draft, input.commentId);
    if (input.replyId !== undefined) {
      const before = comment.replies.length;
      comment.replies = comment.replies.filter((entry) => entry.id !== input.replyId);
      if (comment.replies.length === before) throw new Error(`Comment ${input.commentId} has no reply ${input.replyId}.`);
      return { comment, removed: "reply" as const };
    }
    draft.comments = draft.comments.filter((entry) => entry.id !== input.commentId);
    return { comment, removed: "comment" as const };
  });
  return { review, ...result };
}

export async function resolveComment(workspaceId: string, root: string, commentId: string, resolved: boolean): Promise<{ review: Review; comment: Comment }> {
  const { review, result } = await mutateReview(workspaceId, root, (draft) => {
    const comment = findComment(draft, commentId);
    comment.resolved = resolved;
    if (resolved) comment.resolvedAt = now();
    else delete comment.resolvedAt;
    return comment;
  });
  return { review, comment: result };
}

export async function approveReview(workspaceId: string, root: string): Promise<Review> {
  const { review } = await mutateReview(workspaceId, root, (draft) => {
    draft.approvedAt = now();
  });
  return review;
}

export async function setReviewAgent(workspaceId: string, root: string, agentId: string | null): Promise<void> {
  await mutateReview(workspaceId, root, (draft) => {
    draft.agentId = agentId;
  });
}

export async function setReviewBase(workspaceId: string, root: string, baseRef: string | null): Promise<void> {
  const ref = baseRef === null || baseRef.trim() === "" ? null : baseRef.trim();
  await mutateReview(workspaceId, root, (draft) => {
    draft.baseRef = ref;
  });
}
