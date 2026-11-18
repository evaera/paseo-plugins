import { createHash } from "node:crypto";
import { z } from "zod";
import type { FleetCard } from "../shared/fleet";
import { serialized } from "./serialize";
import { readTextFile, writeTextFile } from "./files";
import type { PaseoAgent } from "./host-types";

const basis = z.string().regex(/^[a-f0-9]{64}$/);
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]+$/);
const paragraph = z.string().trim().min(1).max(2400);
const disposition = z.discriminatedUnion("state", [
  z.object({ basis, state: z.literal("withdrawn") }).strict(),
  z.object({ basis, state: z.literal("checkpoint"), result: paragraph, next: paragraph }).strict(),
  z.object({
    basis, state: z.enum(["review", "needs-decision"]), audience: z.enum(["visual", "product", "approval"]),
    title: line(100), context: paragraph, results: paragraph, residual: paragraph,
    recommendation: paragraph, decision: line(500), actions: z.array(line(60)).min(1).max(6),
    media: z.array(z.object({ label: line(160), src: line(1200) }).strict()).max(8).default([]),
    debrief: z.array(z.enum(["diff", "plans"])).max(2).optional(),
  }).strict(),
]);

function turnPath(id: string) {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid worker ID");
  return `state/card-turns/${id}.txt`;
}

async function optionalText(home: string, path: string) {
  try { return (await readTextFile(home, path)).content ?? ""; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recordCardTurn(home: string, id: string, turn: string) {
  await writeTextFile(home, { path: turnPath(id), content: turn, expectedModifiedMs: null, force: true });
}

export async function readCardTurn(home: string, id: string) {
  return optionalText(home, turnPath(id));
}

export function actionBasis(card: FleetCard, worker: Pick<PaseoAgent, "id" | "lastUserMessageAt">, turn: string | null) {
  const item = card.backlog;
  return createHash("sha256").update(JSON.stringify([
    item?.id, item?.cardEpoch, item?.section, item?.project, worker.id, worker.lastUserMessageAt,
    turn, item?.hold, item?.review, item?.waiting, item?.blockedBy, ...(item?.parked ? [item.parked] : []),
  ])).digest("hex");
}

function ownedByCoordinator(card: FleetCard, reason: string, result: string): FleetCard {
  return { ...card, column: card.column === "working" ? "working" : "idle", coordinatorReason: reason,
    report: { state: "working", text: result }, backlog: card.backlog && { ...card.backlog, actions: [] } };
}

/** A decision's wire-compatible prompt is derived exclusively from its visible words. */
export function scopedActions(card: FleetCard): FleetCard {
  const scope = (actions: { label: string }[]) => actions.map(({ label }) => ({ label, prompt: label }));
  const packet = card.report?.packet;
  return { ...card,
    backlog: card.backlog && { ...card.backlog, actions: scope(card.backlog.actions) },
    report: card.report && packet?.actions ? { ...card.report, packet: { ...packet, actions: scope(packet.actions) } } : card.report,
  };
}

export function projectLegacyDecision(card: FleetCard): FleetCard {
  if (card.column !== "review" && card.column !== "blocked") return card;
  if (card.agent?.pendingPermissions) return card;
  const manual = card.backlog?.review || card.backlog?.hold;
  // An explicit owner hold can simply reserve personal play, with no decision to publish.
  if (!card.backlog?.review && !card.backlog?.actions.length && (card.backlog?.hold || card.backlog?.kind === "user")) return card;
  if (!manual && card.report?.state === "blocked") {
    return ownedByCoordinator(card, "resolve-blocker", card.report.text);
  }
  const packet = card.report?.packet;
  const opening = manual || card.report?.text.trim() || "";
  // Older manual decisions can carry the complete explanation directly in their review/hold field.
  const explanation = (packet?.specimens ?? card.backlog?.specimens ?? opening).replace(/!\[[^\]]*\]\([^\n]*?\)/g, "").trim();
  const hasContext = explanation.split(/(?:[.!?](?:\s|$)|\n\s*\n)/).filter((part) => part.trim()).length >= 2;
  if (!opening || !hasContext || card.title.length > 160 || !(packet?.actions ?? card.backlog?.actions)?.length) {
    return ownedByCoordinator(card, "repair-card", "Keep the current owner disposition. Complete the decision context, results, remaining issue and scoped choices.");
  }
  return card;
}


/** Validate the queue message used by both clients against a fresh card before delivering its visible choice. */
export async function deliverCardChoice<T>(text: string, fleet: () => Promise<{ home: string; cards: FleetCard[] }>,
  send: (message: string) => Promise<T>, target?: { agentId: string; serverId: string | null }): Promise<T> {
  const match = /^Action Queue decision for ([^\r\n]+?): ([^\r\n]+)\n([\s\S]*?)\n\nReviewed item: ([\s\S]*)$/.exec(text);
  if (!match) return send(text);
  const [, task, label, reply, reviewed] = match;
  return serialized("queue-choice:" + task, async () => {
    const snapshot = await fleet();
    const current = snapshot.cards.filter((card) => (card.taskId ?? card.title) === task &&
      (card.column === "review" || card.column === "blocked") && !card.agent?.pendingPermissions &&
      (!target || (card.agent?.id === target.agentId && card.agent.serverId === target.serverId)));
    const card = current.length === 1 ? current[0] : undefined;
    const description = card?.column === "review" ? card.report?.state === "review" ? card.report.text : card.backlog?.review ?? card.report?.text :
      card?.backlog?.hold ?? card?.report?.text;
    if (!card || (description ?? card.title) !== reviewed) throw new Error("This decision changed. Open the current card.");
    const choices = card.report?.packet?.actions ?? card.backlog?.actions ?? [];
    const custom = label === "Reply" && !choices.some((choice) => choice.label === label);
    if (!custom && !choices.some((choice) => choice.label === label)) throw new Error("This choice is no longer available.");
    const choice = custom ? reply! : label!;
    const message = `Action Queue decision for ${task}: ${choice}`;
    if (!card.cardBasis || !card.backlog?.cardEpoch || card.backlog.review || card.backlog.hold) return send(message);
    const path = `state/card-answers/${card.backlog.id}.txt`;
    const save = (status: string) => writeTextFile(snapshot.home, {
      path, content: [card.cardBasis, status, choice].join("\n"), expectedModifiedMs: null, force: true,
    });
    // An interrupted delivery remains inspectable on the next wake. Replaying may duplicate the user's choice.
    await save("pending");
    const sent = await send(message);
    await save("delivered");
    return sent;
  });
}

export async function projectTaskFile(home: string, card: FleetCard, currentBasis: string, reportCurrent = true): Promise<FleetCard> {
  const item = card.backlog;
  if (!item || !/^[\w.-]{1,64}$/.test(item.id) || item.id === "." || item.id === "..") return card;
  const current = { ...card, cardBasis: currentBasis };
  // The coordinator's recorded disposition and the daemon's permissions always take precedence.
  if (item.section !== "in-flight" || item.hold || item.review || item.waiting || item.parked || item.blockedBy ||
      item.kind === "user" || card.agent?.pendingPermissions || card.column === "failed" || (reportCurrent && card.column === "parked")) return current;
  const neutral: FleetCard = { ...current, column: card.column === "working" ? "working" : "idle", report: null,
    backlog: { ...item, actions: [] } };
  if (card.agent?.serverId && card.agent.status === "idle" && !reportCurrent) return neutral;
  let raw: string | null;
  try { raw = await optionalText(home, `tasks/${item.id}/card.json`); }
  catch { return ownedByCoordinator(current, "repair-card", "The current card file could not be read."); }
  const quiet = card.agent?.status === "idle";
  const receipt = await optionalText(home, `state/card-answers/${item.id}.txt`);
  if (receipt?.startsWith(currentBasis + "\n")) {
    const [, status, ...choice] = receipt.split("\n");
    return status === "delivered"
      ? { ...current, column: "waiting", report: { state: "working", text: "Mission Control owns the submitted decision: " + choice.join("\n") }, backlog: { ...item, actions: [] } }
      : ownedByCoordinator(current, "verify-delivery", "Check delivery of the submitted decision before retrying: " + choice.join("\n"));
  }
  if (raw === null) return quiet && reportCurrent ? ownedByCoordinator(neutral, "assign-next-step", "The worker finished without a current card.") : neutral;
  let decoded;
  try { decoded = disposition.safeParse(JSON.parse(raw)); } catch { /* incomplete write */ }
  if (!decoded?.success) return quiet ? ownedByCoordinator(current, "repair-card", "Replace the incomplete card file with a complete current disposition.") : current;
  const file = decoded.data;
  if (file.basis !== currentBasis || file.state === "withdrawn") {
    return quiet && reportCurrent ? ownedByCoordinator(neutral, "assign-next-step", "The prior decision has expired or was withdrawn.") : neutral;
  }
  if (file.state === "checkpoint") return ownedByCoordinator(current, "review-checkpoint", file.result + "\n\nNext step: " + file.next);
  if (!quiet) return neutral;
  const actions = file.actions.map((label) => ({ label, prompt: label }));
  const media = file.media.map(({ label, src }) => `![${label.replace(/[[\]\\]/g, "\\$&")}](<${src.replace(/[<>\r\n]/g, encodeURIComponent)}>)`);
  const specimens = ["**Results**\n" + file.results, "**Remaining**\n" + file.residual,
    "**Recommendation**\n" + file.recommendation, "**Decision**\n" + file.decision, ...media].join("\n\n");
  if (specimens.length > 20_000) return ownedByCoordinator(current, "repair-card", "Shorten the combined text and media references to 20,000 characters.");
  const revision = createHash("sha256").update(JSON.stringify(file)).digest("hex").slice(0, 12);
  return { ...current, title: file.title, column: file.state === "review" ? "review" : "blocked",
    backlog: { ...item, actions: [] }, report: { state: file.state, text: file.context + "\n\nRevision " + revision + ".",
      packet: { title: file.title, specimens, actions, debrief: file.debrief } } };
}
