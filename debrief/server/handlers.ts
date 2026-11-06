/**
 * The panel's comment RPCs: save the change, then tell the agent. Delivery
 * is queued per workspace and not awaited, so the panel gets its answer as
 * soon as the review is saved and notes still arrive in the order the
 * reviewer acted.
 */
import type { PluginSettings } from "@getpaseo/plugin/server";

import type { Author, Review } from "../shared/review";
import type { debriefSettings } from "../shared/settings";
import * as comments from "./comments";
import type { PaseoApi } from "./host-types";
import type { NoteEvent } from "./note-text";
import type { Notes } from "./notes";
import { serialized } from "./serialize";
import { resolveWorkspace } from "./workspace";

type SettingsSchema = (typeof debriefSettings)["schema"];

export interface Deps {
  notes: Notes;
  settings: PluginSettings<SettingsSchema>;
}

export async function reviewer(deps: Pick<Deps, "settings">): Promise<Author> {
  try {
    const state = await deps.settings.read();
    const name = state.status === "ready" ? state.values.authorName.trim() : "";
    return { kind: "human", name: name === "" ? "Reviewer" : name };
  } catch {
    return { kind: "human", name: "Reviewer" };
  }
}

function deliverLater(deps: Deps, paseo: PaseoApi, review: Review, event: NoteEvent): void {
  void serialized(`deliver:${review.workspaceId}`, () => deps.notes.deliver(paseo, review, event));
}

async function root(paseo: PaseoApi, workspaceId: string): Promise<string> {
  return (await resolveWorkspace(paseo, workspaceId)).directory;
}

export async function createComment(deps: Deps, paseo: PaseoApi, input: { workspaceId: string } & comments.NewComment) {
  const { review, comment } = await comments.createComment(input.workspaceId, await root(paseo, input.workspaceId), input, await reviewer(deps));
  deliverLater(deps, paseo, review, { kind: "created", comment });
  return comment;
}

export async function replyToComment(deps: Deps, paseo: PaseoApi, input: { workspaceId: string; commentId: string; body: string }) {
  const { review, comment, replyId } = await comments.replyToComment(
    input.workspaceId,
    await root(paseo, input.workspaceId),
    input.commentId,
    input.body,
    await reviewer(deps),
  );
  deliverLater(deps, paseo, review, { kind: "reply", comment, replyId });
  return comment;
}

export async function editComment(
  deps: Deps,
  paseo: PaseoApi,
  input: { workspaceId: string; commentId: string; replyId?: string | undefined; body: string },
) {
  const { review, comment } = await comments.editComment(input.workspaceId, await root(paseo, input.workspaceId), input);
  deliverLater(deps, paseo, review, input.replyId === undefined ? { kind: "edited", comment } : { kind: "edited", comment, replyId: input.replyId });
  return comment;
}

export async function deleteComment(deps: Deps, paseo: PaseoApi, input: { workspaceId: string; commentId: string; replyId?: string | undefined }) {
  const { review, comment, removed } = await comments.deleteComment(input.workspaceId, await root(paseo, input.workspaceId), input);
  if (removed === "comment") deliverLater(deps, paseo, review, { kind: "deleted", comment });
  // A deleted reply is not worth a note, but the card should stop showing it.
  else void serialized(`deliver:${review.workspaceId}`, () => deps.notes.upsertRow(paseo, review, comment, null));
  return { ok: true as const };
}

export async function resolveComment(deps: Deps, paseo: PaseoApi, input: { workspaceId: string; commentId: string; resolved: boolean }) {
  const { review, comment } = await comments.resolveComment(input.workspaceId, await root(paseo, input.workspaceId), input.commentId, input.resolved);
  deliverLater(deps, paseo, review, { kind: "resolved", comment, resolved: input.resolved });
  return comment;
}

export async function approveReview(deps: Deps, paseo: PaseoApi, input: { workspaceId: string; note?: string | undefined }) {
  const review = await comments.approveReview(input.workspaceId, await root(paseo, input.workspaceId));
  const open = review.comments.filter((comment) => !comment.resolved).length;
  deliverLater(deps, paseo, review, { kind: "approved", note: input.note ?? null, open });
  return { ok: true as const };
}
