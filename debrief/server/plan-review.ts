/**
 * Plan review against Paseo: where plans arrive (Claude's ExitPlanMode
 * permission, the `debrief_submit_plan` tool, a Markdown file) and how a
 * verdict leaves.
 *
 * An ExitPlanMode plan is answered through `respondToPermission`, which is
 * not a note and so is never held by `Notes`. Notes Debrief sends alongside
 * (approve with notes) go through `sendOrHold`: while the permission is still
 * listed as pending they are held, and flushed once it resolves. Paseo's own
 * approve control stays live; whichever answers first wins, and a plan whose
 * permission is gone is marked answered elsewhere.
 */
import { basename } from "node:path";

import { PLAN_KIND, PLAN_VERSION, planRowId, type PlanRow, type PlanStatus } from "../shared/plan";
import type { PaseoApi, PermissionRequest, TimelineData } from "./host-types";
import type { Notes } from "./notes";
import { exportPlanFeedback, NO_CHANGES, planDenyFeedback } from "./plan-export";
import * as plans from "./plans";
import { loadReviewDoc } from "./store";
import { resolveWorkspace } from "./workspace";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plan text Claude's ExitPlanMode carries, or null for any other request. */
export function planTextOf(request: Pick<PermissionRequest, "kind" | "metadata" | "input">): string | null {
  if (request.kind !== "plan") return null;
  const fromMetadata = request.metadata?.["planText"];
  const fromInput = request.input?.["plan"];
  const text = typeof fromMetadata === "string" && fromMetadata.trim() !== "" ? fromMetadata : fromInput;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

export async function upsertPlanRow(paseo: PaseoApi, agentId: string, meta: plans.PlanMeta): Promise<void> {
  const row: PlanRow = {
    workspaceId: meta.workspaceId,
    planId: meta.id,
    title: meta.title,
    version: meta.versions,
    status: meta.status,
    answeredElsewhere: meta.answeredElsewhere,
  };
  try {
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: planRowId(meta.id),
      kind: PLAN_KIND,
      version: PLAN_VERSION,
      data: JSON.parse(JSON.stringify(row)) as TimelineData,
    });
  } catch (error) {
    console.error(`[debrief] could not update the plan card for ${meta.id}: ${describe(error)}`);
  }
}

function rowAgent(meta: plans.PlanMeta): string | null {
  return meta.source.kind === "file" ? null : meta.source.agentId;
}

export class PlanReview {
  /** Permission ids Debrief is answering itself, so their resolution is not "answered elsewhere". */
  private readonly answering = new Set<string>();

  constructor(private readonly notes: Notes) {}

  /** `agent.permission_requested`: an ExitPlanMode becomes a plan, or a new version of the agent's pending one. */
  async permissionRequested(paseo: PaseoApi, agent: { id: string; workspaceId: string | null }, request: PermissionRequest): Promise<void> {
    const markdown = planTextOf(request);
    if (markdown === null || agent.workspaceId === null) return;
    const submission = await plans.submitPlan(agent.workspaceId, {
      title: plans.planTitle(markdown, request.title ?? "Plan"),
      markdown,
      source: { kind: "exit-plan-mode", agentId: agent.id, permissionId: request.id },
    });
    await upsertPlanRow(paseo, agent.id, submission.meta);
  }

  /** `agent.permission_resolved`: a plan permission answered anywhere but here. */
  async permissionResolved(
    paseo: PaseoApi,
    agent: { id: string; workspaceId: string | null },
    requestId: string,
    behavior: "allow" | "deny" | null,
  ): Promise<void> {
    if (agent.workspaceId === null || this.answering.has(requestId)) return;
    const status: PlanStatus | null = behavior === "allow" ? "approved" : behavior === "deny" ? "changes-requested" : null;
    const meta = await plans.recordAnsweredElsewhere(agent.workspaceId, agent.id, requestId, status);
    if (meta !== null) await upsertPlanRow(paseo, agent.id, meta);
  }

  /** `debrief_submit_plan`. */
  async submitFromTool(paseo: PaseoApi, agent: { id: string; workspaceId: string }, input: { title: string; markdown: string }) {
    const submission = await plans.submitPlan(agent.workspaceId, {
      title: input.title.trim() === "" ? plans.planTitle(input.markdown, "Plan") : input.title.trim(),
      markdown: input.markdown,
      source: { kind: "tool", agentId: agent.id },
    });
    await upsertPlanRow(paseo, agent.id, submission.meta);
    return submission;
  }

  /** `debrief.plan.open-file`. */
  async openFile(workspaceId: string, path: string, markdown: string): Promise<string> {
    const submission = await plans.submitPlan(workspaceId, {
      title: plans.planTitle(markdown, basename(path)),
      markdown,
      source: { kind: "file", path },
    });
    return submission.planId;
  }

  /** Sends a plan note to whoever the plan belongs to: its agent, or for a file the review's agent. */
  private async sendNote(paseo: PaseoApi, meta: plans.PlanMeta, text: string): Promise<void> {
    if (meta.source.kind === "file") {
      const { directory } = await resolveWorkspace(paseo, meta.workspaceId);
      const review = await loadReviewDoc(meta.workspaceId, directory);
      await this.notes.deliverText(paseo, review, text);
      return;
    }
    await this.notes.sendOrHold(paseo, meta.workspaceId, meta.source.agentId, text);
  }

  /** Whether the agent still lists the permission; null when its snapshot cannot be read. */
  private async stillPending(paseo: PaseoApi, agentId: string, permissionId: string): Promise<boolean | null> {
    try {
      const found = await paseo.agents.ref(agentId).refresh();
      if (found === null) return false;
      return found.agent.pendingPermissions.some((request) => request.id === permissionId);
    } catch {
      return null;
    }
  }

  /**
   * Answers the ExitPlanMode permission. Returns false when it is already
   * gone; throws when it is there and the answer failed.
   */
  private async answerPermission(
    paseo: PaseoApi,
    agentId: string,
    workspaceId: string,
    permissionId: string,
    response: { behavior: "allow"; selectedActionId: string } | { behavior: "deny"; message: string },
  ): Promise<boolean> {
    if ((await this.stillPending(paseo, agentId, permissionId)) === false) return false;
    this.answering.add(permissionId);
    // The resolution event can trail the call; forget the id once it surely has arrived.
    setTimeout(() => this.answering.delete(permissionId), 60_000).unref?.();
    try {
      await paseo.agents.ref(agentId).respondToPermission({ requestId: permissionId, response });
    } catch (error) {
      if ((await this.stillPending(paseo, agentId, permissionId)) === false) return false;
      this.answering.delete(permissionId);
      throw error;
    }
    // Clears Debrief's own hold for this permission and flushes anything queued behind it.
    this.notes.permissionResolved(paseo, agentId, workspaceId, permissionId);
    return true;
  }

  async decide(
    paseo: PaseoApi,
    input: { workspaceId: string; planId: string; decision: "approve" | "approve-with-notes" | "feedback" },
  ): Promise<{ ok: true; exported: string; note?: string }> {
    const loaded = await plans.loadPlan(input.workspaceId, input.planId);
    const { meta } = loaded;
    const drafts = loaded.annotations.filter((annotation) => annotation.sentInVersion === undefined);
    const withNotes = input.decision !== "approve";
    const feedback = withNotes ? exportPlanFeedback(loaded.blocks, drafts) : "";
    const exported = feedback === NO_CHANGES && input.decision === "approve-with-notes" ? "" : feedback;
    const status: PlanStatus = input.decision === "feedback" ? "changes-requested" : "approved";
    const label = `"${meta.title}" (version ${meta.versions})`;
    let note: string | undefined;
    let answeredElsewhere: boolean | undefined;

    const approvedText =
      exported === ""
        ? `Debrief: the reviewer approved your plan ${label}. Go ahead and implement it.`
        : `Debrief: the reviewer approved your plan ${label}, with notes. Take them into account as you implement:\n\n${exported}`;

    if (meta.source.kind === "exit-plan-mode") {
      const { agentId, permissionId } = meta.source;
      const response =
        input.decision === "feedback"
          ? { behavior: "deny" as const, message: planDenyFeedback(exported) }
          : { behavior: "allow" as const, selectedActionId: "implement" };
      const answered = permissionId === null ? false : await this.answerPermission(paseo, agentId, input.workspaceId, permissionId, response);
      if (answered) {
        if (input.decision === "approve-with-notes" && exported !== "") await this.sendNote(paseo, meta, approvedText);
      } else {
        // Answered in Paseo already, or by the agent moving on: what the reviewer wrote still reaches it, as a note.
        answeredElsewhere = true;
        if (input.decision === "approve") {
          note = "This plan had already been answered outside Debrief, so there was nothing left to approve.";
        } else {
          const text =
            input.decision === "feedback"
              ? `Debrief: the reviewer has feedback on your plan ${label}. It was already answered outside Debrief, so here it is as a note:\n\n${exported}`
              : approvedText;
          await this.sendNote(paseo, meta, text);
          note = "This plan had already been answered outside Debrief; the feedback was sent to the agent as a note instead.";
        }
      }
    } else {
      const source = meta.source;
      const text =
        input.decision !== "feedback"
          ? approvedText
          : source.kind === "tool"
            ? planDenyFeedback(exported, "debrief_submit_plan")
            : `Debrief: the reviewer left feedback on the plan in ${source.path}. Revise that file to address it:\n\n${exported}`;
      await this.sendNote(paseo, meta, text);
    }

    const sentIds = withNotes && exported !== "" ? drafts.map((annotation) => annotation.id) : [];
    const decided = await plans.recordDecision(
      input.workspaceId,
      input.planId,
      answeredElsewhere === undefined ? { status, sentIds } : { status, sentIds, answeredElsewhere },
    );
    const agentId = rowAgent(decided);
    if (agentId !== null) await upsertPlanRow(paseo, agentId, decided);
    return note === undefined ? { ok: true, exported } : { ok: true, exported, note };
  }

  /** A reviewer's reply on an annotation that already went out reaches the agent live, like a code comment. */
  async replied(paseo: PaseoApi, workspaceId: string, planId: string, annotationId: string, body: string, quote: string): Promise<void> {
    try {
      const meta = (await plans.loadPlan(workspaceId, planId)).meta;
      const text =
        `Debrief: the reviewer replied on plan annotation ${annotationId} (plan "${meta.title}", ${planId})` +
        `${quote === "" ? "" : ` about "${quote.slice(0, 200)}"`}:\n\n${body}\n\n` +
        `Reply with the debrief_plan_reply tool (planId ${planId}, annotationId ${annotationId}).`;
      await this.sendNote(paseo, meta, text);
    } catch (error) {
      console.error(`[debrief] could not deliver a plan reply for ${planId}: ${describe(error)}`);
    }
  }

}
