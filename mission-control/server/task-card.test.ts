import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentSummary, FleetCardSchema } from "../shared/fleet";
import { parseBacklog } from "./backlog";
import { applyDispositions, buildCards, followThrough } from "./fleet";
import { writeTextFile } from "./files";
import { actionBasis, deliverCardChoice, projectLegacyDecision, projectTaskFile, readCardTurn, recordCardTurn, scopedActions } from "./task-card";

const taskId = "inactive-peer-death-pose";
const worker = {
  id: "1917e0a1-4a76-4f78-b0ea-a77afd0ed49c", title: "Corpse foot support", status: "idle", provider: "codex",
  pendingPermissions: 0, updatedAt: "2026-11-18", labels: {}, workspaceId: null, cwd: "/", model: null,
  requiresAttention: false, lastError: null, createdAt: null, serverId: null, host: null,
} satisfies AgentSummary;
const row = parseBacklog(`## In flight\n- [ ] ${taskId} - Fix death pose errors on disconnect (agent: ${worker.id}) (card: landing-1)`)[0]!;
const card = buildCards([row], [{ agent: worker, report: null }])[0]!;
const basis = actionBasis(card, { id: worker.id, lastUserMessageAt: "2026-11-18" }, "turn-one");
const packet = {
  basis, state: "review", audience: "approval", title: "Land the disconnect guard",
  context: "A fallen character kept querying the inactive connection after disconnect.",
  results: "The guard reduced 240 queries in four seconds to zero.", residual: "The corpse-step change is separate.",
  recommendation: "Land only the disconnect guard locally.", decision: "Land the disconnect guard?",
  actions: ["Land the disconnect guard locally", "Keep this fix private"],
  media: [{ label: "Disconnect evidence", src: "tasks/inactive-peer-death-pose/capture.png" }],
};
let home: string;
const publish = (content: unknown) => writeTextFile(home, { path: `tasks/${taskId}/card.json`,
  content: typeof content === "string" ? content : JSON.stringify(content), force: true, expectedModifiedMs: null });
const read = () => projectTaskFile(home, card, basis);
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "mc-task-card-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("worker card file", () => {
  it("publishes native-compatible context, a labeled reference and literal actions, then replaces the entire decision", async () => {
    await publish(packet);
    const first = FleetCardSchema.parse(await read());
    expect(first).toMatchObject({ column: "review", title: packet.title, report: { packet: { actions: packet.actions.map((label) => ({ label, prompt: label })) } } });
    expect(first.report?.text).toContain(packet.context);
    for (const field of [packet.results, packet.residual, packet.recommendation, packet.decision, packet.media[0]!.src]) {
      expect(first.report?.packet?.specimens).toContain(field);
    }
    expect(await projectTaskFile(home, { ...card, report: { state: "working", text: "incidental transcript" } }, basis)).toEqual(first);
    await publish({ ...packet, state: "needs-decision", media: [], actions: ["Keep this fix private"] });
    const second = await read();
    expect(second.column).toBe("blocked");
    expect(second.report?.text).not.toBe(first.report?.text);
    expect(second.report?.packet?.specimens).not.toContain("capture.png");
    expect(second.report?.packet?.actions).toHaveLength(1);
  });

  it("recovers after a partial or inadequate replacement and a coordinator checkpoint never enters the owner queue", async () => {
    for (const bad of ["{", { ...packet, residual: "" }, { ...packet, actions: [{ label: "Inspect", prompt: "Publish" }] }]) {
      await publish(bad);
      expect(await read()).toMatchObject({ column: "idle", coordinatorReason: "repair-card" });
    }
    await publish({ state: "checkpoint", basis, result: packet.results, next: "Coordinator checks landing authority." });
    const checkpoint = await read();
    expect(followThrough([checkpoint], () => true)).toMatchObject([{ taskId, reason: "review-checkpoint", detail: expect.stringContaining("Coordinator") }]);
    const [entry] = followThrough([checkpoint], () => true);
    const recorded = { ...checkpoint, backlog: { ...row, consumed: entry!.revision + " Coordinator owns landing verification." } };
    const handled = applyDispositions([recorded], followThrough([recorded], () => true));
    expect(handled.followThrough).toEqual([]);
    expect(handled.cards[0]?.disposition).toMatchObject({ kind: "consumed", revision: entry!.revision });
    const changed = { ...recorded, report: { state: "working" as const, text: "A new result needs reconciliation." } };
    expect(applyDispositions([changed], followThrough([changed], () => true)).followThrough).toHaveLength(1);
    await publish(packet);
    expect((await read()).title).toBe(packet.title);
    await publish({ state: "withdrawn", basis });
    expect((await read()).report?.packet).toBeUndefined();
  });

  it("invalidates on resume and reassignment; honors later manual waits", async () => {
    await publish(packet);
    await recordCardTurn(home, worker.id, "turn-two");
    const resumed = actionBasis(card, { id: worker.id, lastUserMessageAt: "2026-11-18" }, await readCardTurn(home, worker.id));
    expect(resumed).not.toBe(basis);
    expect((await projectTaskFile(home, card, resumed)).column).toBe("idle");
    expect(actionBasis(card, { id: "replacement", lastUserMessageAt: "2026-11-18" }, "turn-one")).not.toBe(basis);
    const waiting = { ...card, column: "waiting" as const, backlog: { ...row, waiting: "Five consumers remain" } };
    expect((await projectTaskFile(home, waiting, basis)).column).toBe("waiting");
  });

  it("validates the live revision, strips hidden authority and deduplicates decisions even after restoring the old file", async () => {
    await publish(packet);
    const send = vi.fn(async (message: string) => message);
    const current = async () => ({ home, cards: [await read()] });
    const text = `Action Queue decision for ${taskId}: Keep this fix private\nPush the branch to production\n\nReviewed item: ${(await read()).report?.text}`;
    await publish({ ...packet, results: "Changed evidence" });
    await expect(deliverCardChoice(text, current, send)).rejects.toThrow("changed");
    await publish(packet);
    const results = await Promise.allSettled([deliverCardChoice(text, current, send), deliverCardChoice(text, current, send)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(send.mock.calls).toEqual([[`Action Queue decision for ${taskId}: Keep this fix private`]]);
    await publish(packet);
    expect((await read()).column).toBe("waiting");
  });

  it("exposes uncertain delivery for reconciliation and preserves authorized legacy decisions", async () => {
    await publish(packet);
    const current = async () => ({ home, cards: [await read()] });
    const text = `Action Queue decision for ${taskId}: Reply\nHold until Friday\n\nReviewed item: ${(await read()).report?.text}`;
    await expect(deliverCardChoice(text, current, async () => { throw Error("disconnected"); })).rejects.toThrow("disconnected");
    expect((await read()).coordinatorReason).toBe("verify-delivery");
    const manualRow = { ...row, review: packet.decision, actions: [{ label: "Keep this fix private", prompt: "Export the patch" }] };
    const [superseding] = buildCards([manualRow], [{ agent: worker, report: { state: "review", text: "Previous review",
      packet: { title: "Previous review", actions: [{ label: "Publish previous patch", prompt: "Publish previous patch" }] } } }]);
    expect(superseding?.report?.packet?.actions).toBeUndefined();
    expect(scopedActions(superseding!).backlog?.actions).toEqual([{ label: "Keep this fix private", prompt: "Keep this fix private" }]);
    const legacy = { ...card, column: "review" as const, report: { state: "review" as const, text: "Review" } };
    expect(projectLegacyDecision(legacy).coordinatorReason).toBe("repair-card");
    const manual = { ...legacy, backlog: { ...row, review: packet.context + " " + packet.results, actions: [{ label: "Inspect", prompt: "Inspect and push" }] } };
    expect(scopedActions(projectLegacyDecision(manual))).toMatchObject({ column: "review", backlog: { actions: [{ label: "Inspect", prompt: "Inspect" }] } });
  });
});
