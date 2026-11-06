/**
 * What a review event says to the agent, and the thread card it upserts.
 * Pure, so the wording is tested rather than eyeballed.
 */
import type { Author, Comment } from "../shared/review";
import type { ThreadRow } from "../shared/timeline";

export type NoteEvent =
  | { kind: "created"; comment: Comment }
  | { kind: "edited"; comment: Comment; replyId?: string }
  | { kind: "deleted"; comment: Comment }
  | { kind: "reply"; comment: Comment; replyId: string }
  | { kind: "resolved"; comment: Comment; resolved: boolean }
  | { kind: "approved"; note: string | null; open: number };

const EXCERPT_LINES = 8;
const EXCERPT_CHARS = 1_500;
const BODY_CHARS = 8_000;
const REPLY_CHARS = 3_000;
const MAX_REPLIES = 20;
/** The daemon's plugin row cap is 64 KiB; this leaves room for the envelope. */
const ROW_BYTES = 60 * 1024;

export function trimText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A few lines of the commented code, for a note or a card. */
export function excerpt(anchor: string | undefined, lines = EXCERPT_LINES, chars = EXCERPT_CHARS): string | null {
  if (anchor === undefined || anchor === "") return null;
  const all = anchor.split("\n");
  const kept = all.slice(0, lines).join("\n");
  const text = all.length > lines ? `${kept}\n…` : kept;
  return trimText(text, chars);
}

/** `src/a.ts lines 12-14 (new side)`, `src/a.ts`, or `the review as a whole`. */
export function location(comment: Comment): string {
  if (comment.scope === "review" || comment.path === undefined) return "the review as a whole";
  if (comment.scope === "file" || comment.startLine === undefined) return comment.path;
  const end = comment.endLine ?? comment.startLine;
  const lines = end === comment.startLine ? `line ${comment.startLine}` : `lines ${comment.startLine}-${end}`;
  return `${comment.path} ${lines} (${comment.side ?? "new"} side)`;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function anchorBlock(comment: Comment): string {
  const code = excerpt(comment.anchor);
  const parts: string[] = [];
  if (code !== null) parts.push(quoted(code));
  if (comment.quote !== undefined && comment.quote !== "") parts.push(`Selected text: "${trimText(comment.quote, 300)}"`);
  return parts.length === 0 ? "" : `${parts.join("\n")}\n\n`;
}

function replyInstruction(commentId: string): string {
  return `Act on it, then reply with the debrief_reply tool (commentId ${commentId}). Do not resolve it; the reviewer resolves.`;
}

export function noteText(event: NoteEvent): string {
  switch (event.kind) {
    case "created": {
      const { comment } = event;
      return (
        `Debrief: new review comment ${comment.id} on ${location(comment)}:\n` +
        `${anchorBlock(comment)}${trimText(comment.body, BODY_CHARS)}\n\n${replyInstruction(comment.id)}`
      );
    }
    case "edited": {
      const { comment } = event;
      const reply = event.replyId === undefined ? undefined : comment.replies.find((entry) => entry.id === event.replyId);
      if (reply !== undefined) {
        return (
          `Debrief: the reviewer edited their reply on comment ${comment.id} (${location(comment)}). It now reads:\n\n` +
          `${trimText(reply.body, BODY_CHARS)}\n\n${replyInstruction(comment.id)}`
        );
      }
      return (
        `Debrief: the reviewer edited comment ${comment.id} on ${location(comment)}. It now reads:\n` +
        `${anchorBlock(comment)}${trimText(comment.body, BODY_CHARS)}\n\n${replyInstruction(comment.id)}`
      );
    }
    case "deleted":
      return `Debrief: the reviewer deleted comment ${event.comment.id} on ${location(event.comment)}. Disregard it; no reply is needed.`;
    case "reply": {
      const { comment } = event;
      const reply = comment.replies.find((entry) => entry.id === event.replyId);
      return (
        `Debrief: the reviewer replied on comment ${comment.id} (${location(comment)}):\n\n` +
        `${trimText(reply?.body ?? "", BODY_CHARS)}\n\n` +
        `The comment was: ${trimText(comment.body, 500)}\n\n${replyInstruction(comment.id)}`
      );
    }
    case "resolved":
      return event.resolved
        ? `Debrief: the reviewer resolved comment ${event.comment.id} (${location(event.comment)}). Stop working on it.`
        : `Debrief: the reviewer reopened comment ${event.comment.id} on ${location(event.comment)}:\n${anchorBlock(event.comment)}${trimText(event.comment.body, BODY_CHARS)}\n\n${replyInstruction(event.comment.id)}`;
    case "approved": {
      const note = event.note !== null && event.note.trim() !== "" ? `\n\n${trimText(event.note.trim(), BODY_CHARS)}` : "";
      const open = event.open === 0 ? "" : ` ${event.open} comment${event.open === 1 ? " is" : "s are"} still unresolved; use debrief_list_comments to see them.`;
      return `Debrief: the reviewer approved the review.${open}${note}`;
    }
  }
}

function plainAuthor(author: Author): Author {
  return author.agentId === undefined ? { kind: author.kind, name: author.name } : { ...author };
}

/** The thread card's data, trimmed until it fits the daemon's row cap. */
export function threadRow(workspaceId: string, comment: Comment, deleted = false): ThreadRow {
  const build = (bodyChars: number, replyChars: number, replies: number, excerptLines: number): ThreadRow => ({
    workspaceId,
    commentId: comment.id,
    path: comment.path ?? null,
    startLine: comment.startLine ?? null,
    endLine: comment.endLine ?? null,
    side: comment.scope === "line" ? (comment.side ?? "new") : null,
    excerpt: excerpt(comment.anchor, excerptLines),
    body: trimText(comment.body, bodyChars),
    author: plainAuthor(comment.author),
    resolved: comment.resolved,
    replies: comment.replies.slice(-replies).map((reply) => ({
      body: trimText(reply.body, replyChars),
      author: plainAuthor(reply.author),
      createdAt: reply.createdAt,
    })),
    updatedAt: latest(comment),
    deleted,
  });
  let row = build(BODY_CHARS, REPLY_CHARS, MAX_REPLIES, EXCERPT_LINES);
  if (Buffer.byteLength(JSON.stringify(row)) > ROW_BYTES) row = build(2_000, 800, 10, 4);
  if (Buffer.byteLength(JSON.stringify(row)) > ROW_BYTES) row = build(500, 200, 5, 2);
  return row;
}

function latest(comment: Comment): string {
  return [comment.updatedAt, comment.resolvedAt, ...comment.replies.map((reply) => reply.updatedAt)]
    .filter((value): value is string => value !== undefined)
    .reduce((a, b) => (a > b ? a : b), comment.updatedAt);
}
