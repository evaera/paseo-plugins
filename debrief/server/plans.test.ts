import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addAnnotation,
  carryAnnotations,
  listPlans,
  loadPlan,
  planDir,
  planTitle,
  recordAnsweredElsewhere,
  recordDecision,
  submitPlan,
  updateAnnotation,
} from "./plans";
import { parsePlanBlocks } from "./plan-blocks";
import { markArchived, pruneArchived, RETENTION_MS } from "./prune";
import { reviewDir, writeAtomic } from "./store";

const human = { kind: "human" as const, name: "Reviewer" };
const ws = "ws1";
let home: string;
const saved = process.env.PASEO_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "debrief-plans-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

const exitPlan = (permissionId: string) => ({ kind: "exit-plan-mode" as const, agentId: "agent-1", permissionId });

describe("plan versioning", () => {
  it("adds versions for the same agent until approved, then starts a new plan", async () => {
    const first = await submitPlan(ws, { title: "Plan", markdown: "# Plan\n\nv1\n", source: exitPlan("perm-1") });
    expect(first).toMatchObject({ created: true, changed: true, version: 1 });
    expect(await readdir(planDir(ws, first.planId))).toEqual(expect.arrayContaining(["meta.json", "v001.md", "annotations.json"]));

    await recordDecision(ws, first.planId, { status: "changes-requested", sentIds: [] });
    const second = await submitPlan(ws, { title: "Plan", markdown: "# Plan\n\nv2\n", source: exitPlan("perm-2") });
    expect(second).toMatchObject({ planId: first.planId, created: false, changed: true, version: 2 });
    expect(second.meta.status).toBe("pending");
    expect(second.meta.source).toEqual(exitPlan("perm-2"));

    const loaded = await loadPlan(ws, first.planId);
    expect(loaded.version).toBe(2);
    expect(loaded.markdown).toBe("# Plan\n\nv2\n");
    expect(loaded.previousMarkdown).toBe("# Plan\n\nv1\n");
    expect((await loadPlan(ws, first.planId, 1)).previousMarkdown).toBeNull();

    // The same text again refreshes the permission without a version.
    const same = await submitPlan(ws, { title: "Plan", markdown: "# Plan\n\nv2\n", source: exitPlan("perm-3") });
    expect(same).toMatchObject({ planId: first.planId, changed: false, version: 2 });

    await recordDecision(ws, first.planId, { status: "approved", sentIds: [] });
    const next = await submitPlan(ws, { title: "Other", markdown: "# Other\n", source: exitPlan("perm-4") });
    expect(next.created).toBe(true);
    expect(next.planId).not.toBe(first.planId);
    expect((await listPlans(ws)).map((plan) => plan.id).sort()).toEqual([next.planId, first.planId].sort());
  });

  it("keeps tool plans and file plans apart, and a file plan is always the same plan", async () => {
    const tool = await submitPlan(ws, { title: "T", markdown: "a", source: { kind: "tool", agentId: "agent-1" } });
    const exit = await submitPlan(ws, { title: "E", markdown: "a", source: exitPlan("p") });
    expect(exit.planId).not.toBe(tool.planId);
    const doc = await submitPlan(ws, { title: "F", markdown: "x", source: { kind: "file", path: "docs/plan.md" } });
    await recordDecision(ws, doc.planId, { status: "approved", sentIds: [] });
    const again = await submitPlan(ws, { title: "F", markdown: "y", source: { kind: "file", path: "docs/plan.md" } });
    expect(again).toMatchObject({ planId: doc.planId, version: 2 });
  });

  it("carries drafts onto the new version and marks sent ones", async () => {
    const { planId } = await submitPlan(ws, { title: "P", markdown: "# P\n\nKeep this line.\n\nDrop me.\n", source: exitPlan("1") });
    const keep = await addAnnotation(ws, planId, { type: "comment", blockId: "block-1", originalText: "this line", startOffset: 5, endOffset: 14, body: "why?", labels: [], inDiff: false }, human);
    const drop = await addAnnotation(ws, planId, { type: "deletion", blockId: "block-2", originalText: "Drop me.", body: "", labels: [], inDiff: false }, human);
    expect(keep.version).toBe(1);
    expect((await listPlans(ws))[0]?.drafts).toBe(2);

    await recordDecision(ws, planId, { status: "changes-requested", sentIds: [drop.id] });
    await submitPlan(ws, { title: "P", markdown: "# P\n\nIntro.\n\nKeep this line.\n", source: exitPlan("2") });
    const loaded = await loadPlan(ws, planId);
    const moved = loaded.annotations.find((annotation) => annotation.id === keep.id);
    expect(moved).toMatchObject({ blockId: "block-2", startLine: 5, startOffset: 5, endOffset: 14 });
    expect(loaded.annotations.find((annotation) => annotation.id === drop.id)).toMatchObject({ sentInVersion: 1, blockId: "block-2" });
    expect(loaded.plan.drafts).toBe(1);
  });

  it("drops the block of an annotation whose text is gone", () => {
    const blocks = parsePlanBlocks("# New\n");
    const [out] = carryAnnotations(
      [{ id: "a", type: "comment", blockId: "block-1", originalText: "vanished", body: "", labels: [], inDiff: false, author: human, createdAt: "x", replies: [], startLine: 3 }],
      blocks,
    );
    expect(out?.blockId).toBeUndefined();
    expect(out?.startLine).toBe(3);
  });

  it("records replies, edits and deletions", async () => {
    const { planId } = await submitPlan(ws, { title: "P", markdown: "x", source: { kind: "tool", agentId: "a" } });
    const note = await addAnnotation(ws, planId, { type: "global", originalText: "", body: "hm", labels: [], inDiff: false }, human);
    const replied = await updateAnnotation(ws, planId, { annotationId: note.id, reply: "ok", body: "hmm" }, human);
    expect(replied.kind === "updated" && replied.annotation).toMatchObject({ body: "hmm", replies: [{ body: "ok" }] });
    await updateAnnotation(ws, planId, { annotationId: note.id, delete: true }, human);
    expect((await loadPlan(ws, planId)).annotations).toEqual([]);
    await expect(addAnnotation(ws, planId, { type: "comment", originalText: "x", body: "y", labels: [], inDiff: false }, human)).rejects.toThrow(/block/);
  });

  it("marks a plan answered elsewhere only for its own permission", async () => {
    const { planId } = await submitPlan(ws, { title: "P", markdown: "x", source: exitPlan("perm-9") });
    expect(await recordAnsweredElsewhere(ws, "agent-1", "other", "approved")).toBeNull();
    const meta = await recordAnsweredElsewhere(ws, "agent-1", "perm-9", "approved");
    expect(meta).toMatchObject({ id: planId, status: "approved", answeredElsewhere: true, source: { permissionId: null } });
  });

  it("titles a plan by its first heading", () => {
    expect(planTitle("intro\n## Do the thing ##\n", "Plan")).toBe("Do the thing");
    expect(planTitle("no heading", "Plan")).toBe("Plan");
  });
});

describe("pruning", () => {
  it("deletes reviews and plans of workspaces archived over 30 days ago", async () => {
    await submitPlan("old", { title: "P", markdown: "x", source: { kind: "tool", agentId: "a" } });
    await writeAtomic(join(reviewDir("old"), "review.json"), "{}");
    await submitPlan("recent", { title: "P", markdown: "x", source: { kind: "tool", agentId: "a" } });
    const now = Date.now();
    await markArchived("old", new Date(now - RETENTION_MS - 1000).toISOString());
    await markArchived("recent", new Date(now - 1000).toISOString());
    expect(await pruneArchived(now)).toEqual(["old"]);
    expect(await listPlans("old")).toEqual([]);
    await expect(readdir(reviewDir("old"))).rejects.toThrow();
    expect(await listPlans("recent")).toHaveLength(1);
  });
});
