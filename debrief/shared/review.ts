/**
 * The review: what the panel shows and what the daemon keeps.
 *
 * One review per workspace, stored by the daemon under
 * `$PASEO_HOME/plugin-data/debrief/reviews/<workspaceId>/review.json`. Only the
 * daemon writes it, so nothing here is shaped for another tool to read.
 *
 * Line numbers are 1-based lines of the file on the side they name: `new` is
 * the work tree (or the index, for the staged scope), `old` is the base.
 */
import { z } from "zod";

/**
 * Which diff: `all` (base to work tree), `branch` (base to HEAD), `staged`,
 * `unstaged`, `uncommitted` (HEAD to work tree, staged and unstaged together)
 * and `unpushed` (the branch's upstream to HEAD, committed changes only).
 */
export const ScopeSchema = z.enum(["all", "branch", "staged", "unstaged", "uncommitted", "unpushed"]);
export type Scope = z.infer<typeof ScopeSchema>;

export const SideSchema = z.enum(["old", "new"]);
export type Side = z.infer<typeof SideSchema>;

export const AuthorSchema = z.object({
  kind: z.enum(["human", "agent"]),
  name: z.string(),
  agentId: z.string().optional(),
  /** An agent's provider ("claude", "codex"), shown as its harness name; absent on older comments. */
  provider: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const ReplySchema = z.object({
  id: z.string(),
  body: z.string(),
  author: AuthorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Reply = z.infer<typeof ReplySchema>;

export const CommentScopeSchema = z.enum(["line", "file", "review"]);
export type CommentScope = z.infer<typeof CommentScopeSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  scope: CommentScopeSchema,
  /** Workspace-relative, `/`-separated. Absent for a review-level comment. */
  path: z.string().optional(),
  side: SideSchema.optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** The full text of the commented lines when the comment was placed; what re-anchoring searches for. */
  anchor: z.string().optional(),
  /** A text selection inside the range, when the reviewer made one. */
  quote: z.string().optional(),
  body: z.string(),
  author: AuthorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  resolved: z.boolean(),
  resolvedAt: z.string().optional(),
  /** The anchor text is no longer where the comment points, and was not found elsewhere. */
  drifted: z.boolean(),
  replies: z.array(ReplySchema),
});
export type Comment = z.infer<typeof CommentSchema>;

/** A file marked reviewed under one compare: when, and the fingerprint of its diff at that moment. */
export const ReviewedMarkSchema = z.object({
  at: z.string(),
  fingerprint: z.string(),
});
export type ReviewedMark = z.infer<typeof ReviewedMarkSchema>;

/**
 * A file's "Reviewed" state in one compare: `reviewed` while its diff is the
 * one that was marked, `changed` once the diff moved after it was marked,
 * null when nobody marked it.
 */
export const ReviewStateSchema = z.enum(["reviewed", "changed"]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  cwd: z.string(),
  /** The agent comments are sent to; null means "the workspace's most recent agent". */
  agentId: z.string().nullable(),
  /** A base override; null means Crit's rule (merge-base with the default branch). */
  baseRef: z.string().nullable(),
  comments: z.array(CommentSchema),
  approvedAt: z.string().nullable(),
  /** Bumped on every write; the panel polls it. */
  revision: z.number().int().nonnegative(),
  /** Files marked reviewed, per `compareKey`, then per path; absent until the first mark. */
  reviewed: z.record(z.string(), z.record(z.string(), ReviewedMarkSchema)).optional(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const FileStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const HunkSchema = z.object({
  /** With `path`, the hunk's id, as in Crit: 0 for a new file. */
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  header: z.string(),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: FileStatusSchema,
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(HunkSchema),
  /** A hash of this file's diff under the loaded compare; set by `debrief.review.load` only. */
  fingerprint: z.string().optional(),
  /** Whether the reviewer marked it reviewed in this compare; set by `debrief.review.load` only. */
  reviewState: ReviewStateSchema.nullable().optional(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const AgentChoiceSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  status: z.string(),
});
export type AgentChoice = z.infer<typeof AgentChoiceSchema>;
