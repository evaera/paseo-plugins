/**
 * The plugin timeline rows Debrief appends to an agent, and the sender id its
 * notes carry. The daemon writes these rows; the client draws them.
 */
import { z } from "zod";

import { AuthorSchema } from "./review";

/** `sourceAgentId` on every note; the client's transformer recognises it. */
export const DEBRIEF_SENDER_ID = "debrief";

export const THREAD_KIND = "debrief-thread";
export const THREAD_VERSION = 1;

export const ThreadRowSchema = z.object({
  workspaceId: z.string(),
  commentId: z.string(),
  path: z.string().nullable(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  side: z.enum(["old", "new"]).nullable(),
  /** The commented code, trimmed to a few lines for the card. */
  excerpt: z.string().nullable(),
  body: z.string(),
  author: AuthorSchema,
  resolved: z.boolean(),
  replies: z.array(z.object({ body: z.string(), author: AuthorSchema, createdAt: z.string() })),
  updatedAt: z.string(),
  /** The reviewer deleted the comment; the card stays, marked as deleted. */
  deleted: z.boolean().default(false),
});
export type ThreadRow = z.infer<typeof ThreadRowSchema>;

/** Timeline row ids: one per comment, upserted in place. */
export function threadRowId(commentId: string): string {
  return `debrief:${commentId}`;
}
