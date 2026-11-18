import { describe, expect, it } from "vitest";

import { CREW_LABELS, type AgentSummary, type BacklogItem } from "../shared/fleet";
import { parseBacklog } from "./backlog";
import { parseCrewReport } from "./crew-report";
import { applyDispositions, backlogColumn, buildCards, closingText, crewColumn, followThrough } from "./fleet";
import type { TimelineItem } from "./host-types";

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "a1",
    workspaceId: "w1",
    title: "Fix login",
    provider: "claude",
    model: "sonnet",
    status: "idle",
    cwd: "/wt/fix-login",
    pendingPermissions: 0,
    requiresAttention: false,
    lastError: null,
    updatedAt: "2026-09-22T10:00:00.000Z",
    createdAt: null,
    labels: { [CREW_LABELS.role]: CREW_LABELS.crewRole, [CREW_LABELS.task]: "fix-login" },
    serverId: null,
    host: null,
    ...overrides,
  };
}

describe("crewColumn", () => {
  it("lets what Paseo knows win while the agent is busy or stuck", () => {
    const done = { state: "done" as const, text: "PR" };
    expect(crewColumn(agent({ pendingPermissions: 1, status: "running" }), done)).toBe("blocked");
    expect(crewColumn(agent({ status: "error" }), done)).toBe("failed");
    expect(crewColumn(agent({ status: "running" }), done)).toBe("working");
  });

  it("files a stopped crewmate by its status line", () => {
    expect(crewColumn(agent(), { state: "done", text: "" })).toBe("idle");
    expect(crewColumn(agent(), { state: "resolved", text: "" })).toBe("idle");
    expect(crewColumn(agent(), { state: "blocked", text: "" })).toBe("blocked");
    expect(crewColumn(agent(), { state: "needs-decision", text: "" })).toBe("blocked");
    expect(crewColumn(agent(), { state: "paused", text: "" })).toBe("parked");
    expect(crewColumn(agent(), { state: "review", text: "" }, true)).toBe("review");
    expect(crewColumn(agent({ status: "running" }), { state: "review", text: "" })).toBe("working");
    expect(crewColumn(agent(), { state: "failed", text: "" })).toBe("failed");
    expect(crewColumn(agent(), { state: "working", text: "" })).toBe("idle");
  });

  it("puts a stopped crewmate whose task is held for the user in Needs you, unless it failed", () => {
    expect(crewColumn(agent(), { state: "done", text: "" }, true)).toBe("blocked");
    expect(crewColumn(agent(), { state: "paused", text: "" }, true)).toBe("blocked");
    expect(crewColumn(agent(), null, true)).toBe("blocked");
    expect(crewColumn(agent(), { state: "failed", text: "" }, true)).toBe("failed");
    expect(crewColumn(agent({ status: "running" }), null, true)).toBe("working");
  });

  it("puts a stopped crewmate whose task waits on someone else in Waiting, unless it failed or asked", () => {
    expect(crewColumn(agent(), { state: "done", text: "" }, false, true)).toBe("waiting");
    expect(crewColumn(agent(), null, false, true)).toBe("waiting");
    expect(crewColumn(agent(), { state: "needs-decision", text: "" }, false, true)).toBe("blocked");
    expect(crewColumn(agent(), { state: "failed", text: "" }, false, true)).toBe("failed");
    expect(crewColumn(agent(), null, true, true)).toBe("blocked");
    expect(crewColumn(agent({ status: "running" }), null, false, true)).toBe("working");
    expect(crewColumn(agent(), null)).toBe("idle");
  });
});

describe("backlogColumn", () => {
  const item = (overrides: Partial<BacklogItem>): BacklogItem => ({
    section: "queued",
    host: null,
    id: "x",
    title: "X",
    project: null,
    kind: null,
    mode: null,
    agentId: null,
    hold: null,
    waiting: null,
    actions: [],
    blockedBy: null,
    since: null,
    url: null,
    links: [],
    reportPath: null,
    outcome: null,
    ...overrides,
  });

  it("puts a user's hold with the blocked work and everything else where its section says", () => {
    expect(backlogColumn(item({ kind: "user" }))).toBe("blocked");
    expect(backlogColumn(item({ hold: "which?" }))).toBe("blocked");
    expect(backlogColumn(item({ review: "Ready to land" }))).toBe("review");
    expect(backlogColumn(item({}))).toBe("queued");
    expect(backlogColumn(item({ section: "in-flight", waiting: "review" }))).toBe("waiting");
    expect(backlogColumn(item({ waiting: "review", hold: "merge?" }))).toBe("blocked");
    expect(backlogColumn(item({ section: "done" }))).toBe("done");
    expect(backlogColumn(item({ section: "in-flight" }))).toBe("idle");
  });
});

describe("buildCards", () => {
  it("sends the authored title or opening plan heading to clients while retaining the backlog identity", () => {
    const backlog = parseBacklog("## In flight\n- [ ] fix-login - Original task (review: Review the plan)");
    const body = "# Safe NPC transfers\n\nReserve the stack before recording its receipt.";
    for (const [title, expected] of [["Review the transfer receipt", "Review the transfer receipt"], [undefined, "Safe NPC transfers"]]) {
      const message = "\x60\x60\x60action-queue\n" + JSON.stringify({ title, specimens: body }) + "\n\x60\x60\x60\nreview: Ready";
      const [card] = buildCards(backlog, [{ agent: agent(), report: parseCrewReport(message) }]);
      expect(card).toMatchObject({ title: expected, taskId: "fix-login", backlog: { title: "Original task" }, report: { packet: { specimens: body } } });
    }
  });

  it("accepts an active receipt only for this shared assignment and running turn", () => {
    const rows = parseBacklog(`## In flight
- [ ] corpse-foot-support - Fix trailing feet (agent: a1)
- [ ] inactive-peer-death-pose - Land disconnect guard (agent: a1)
- [ ] other-work - Another assignment (agent: a1)`);
    const worker = agent({ status: "running", activeTurnId: "landing-turn", labels: { [CREW_LABELS.task]: "corpse-foot-support" } });
    const project = (member = worker) => {
      const cards = buildCards(rows, [{ agent: member, report: null }]);
      return applyDispositions(cards, followThrough(cards, () => true));
    };
    const revision = project().followThrough.find((entry) => entry.taskId === "inactive-peer-death-pose")!.revision;
    rows[1] = parseBacklog(`## In flight\n- [ ] inactive-peer-death-pose - Land disconnect guard (agent: a1) (active: ${revision} Worker owns the approved local landing.)`)[0]!;
    const handled = project();
    expect(handled.cards.find((card) => card.taskId === "inactive-peer-death-pose")).toMatchObject({
      column: "working", disposition: { kind: "active", revision, next: "Worker owns the approved local landing." },
    });
    expect(handled.followThrough.map((entry) => entry.taskId)).toEqual(["other-work"]);
    expect(project()).toEqual(handled);
    expect(project({ ...worker, activeTurnId: "new-turn" }).followThrough).toContainEqual(expect.objectContaining({
      taskId: "inactive-peer-death-pose", revision: expect.not.stringMatching(revision),
    }));
    expect(project({ ...worker, status: "idle", activeTurnId: null }).cards.find((c) => c.taskId === "inactive-peer-death-pose")?.column).toBe("idle");
    rows[0]!.waiting = "not this turn";
    const reassigned = buildCards(rows, [{ agent: { ...worker, status: "idle" }, report: { state: "paused", text: "Original assignment waits" } }]);
    expect(reassigned.find((c) => c.taskId === "inactive-peer-death-pose")).toMatchObject({ column: "idle", report: null });
    expect(reassigned.find((c) => c.taskId === "corpse-foot-support")?.column).toBe("waiting");
    rows[1]!.waiting = "upstream owner";
    expect(project().cards.find((c) => c.taskId === "inactive-peer-death-pose")?.column).toBe("waiting");
  });

  it("keeps a durable cargo-fit park across closure and a missing worker until the coordinator reopens it", () => {
    const rows = parseBacklog("## In flight\n- [ ] elastic-cargo-pants - Cargo fit (agent: a1) (parked: Reopen for a scoped inner-thigh pass.)");
    for (const crew of [[], [{ agent: agent({ status: "closed" }), report: null }], [{ agent: agent(), report: null }]]) {
      const cards = buildCards(rows, crew);
      expect(cards[0]?.column).toBe("parked");
      expect(followThrough(cards, () => true)).toEqual([]);
    }
    delete rows[0]!.parked;
    expect(buildCards(rows, [{ agent: agent({ status: "running" }), report: null }])[0]?.column).toBe("working");
  });

  it("returns a previously parked shirt to the running worker after Eryn resumes it", () => {
    const rows = parseBacklog("## In flight\n- [ ] oblique-shirt-layer - Fix the shirt (agent: a1)");
    const stopped = { agent: agent(), report: { state: "paused" as const, text: "Lower-cup trials preserved." } };
    const [parked] = buildCards(rows, [stopped]);
    expect(parked?.column).toBe("parked");
    expect(followThrough([parked!], () => true)).toEqual([]);
    const [resumed] = buildCards(rows, [{ ...stopped, agent: agent({ status: "running", activeTurnId: "recovery" }) }]);
    expect(resumed?.column).toBe("working");
    expect(buildCards(rows, [])[0]?.column).toBe("idle");
  });

  it("keeps both assignments, retained outcomes and each task's next owner", () => {
    const rows = parseBacklog(`## In flight
- [ ] inactive-peer-death-pose - Fix disconnects (agent: a1)
- [ ] corpse-foot-support - Fix trailing feet (agent: a1)
- [ ] oblique-shirt-layer - Finish the shirt (agent: a2)
- [ ] pose-retirement - Retire after migration (waiting: five worktrees still use the poses)
- [ ] user-play - Play through the map (hold: Eryn will play)
## Done
- [x] level-design-playbook - Retain unpublished evidence`);
    const members = [
      { agent: agent({ status: "running", labels: { [CREW_LABELS.task]: "corpse-foot-support" } }), report: null },
      { agent: agent({ id: "a2", labels: {} }), report: null },
      { agent: agent({ id: "a3", labels: { [CREW_LABELS.task]: "level-design-playbook" } }), report: null },
    ];
    const cards = buildCards(rows, members);
    expect(cards).toHaveLength(rows.length);
    expect(cards.map((card) => card.taskId).sort()).toEqual(rows.map((item) => item.id).sort());
    expect(cards.find((card) => card.taskId === "level-design-playbook")).toMatchObject({ column: "done", agent: { id: "a3" } });
    expect(cards.find((card) => card.taskId === "inactive-peer-death-pose")).toMatchObject({ column: "idle", agent: { id: "a1" } });
    const cases = followThrough(cards, () => true);
    expect(cases.map(({ taskId, reason }) => [taskId, reason]).sort()).toEqual([
      ["inactive-peer-death-pose", "check-shared-assignment"], ["oblique-shirt-layer", "assign-next-step"],
    ]);
    expect(followThrough(buildCards(rows, members), () => true)).toEqual(cases);
    expect(followThrough(cards, () => false).some((row) => row.taskId === "oblique-shirt-layer")).toBe(false);
    const closed = members.map((member) => ({ ...member, agent: { ...member.agent, status: "closed" as const } }));
    const retired = buildCards(rows, closed);
    expect(retired.filter((card) => card.agent?.id === "a3")).toMatchObject([{ taskId: "level-design-playbook", column: "done" }]);
    expect(followThrough(retired, () => false)).toContainEqual(expect.objectContaining({ taskId: "oblique-shirt-layer", reason: "verify-closed-worker" }));
    expect(followThrough(retired, () => false)).toContainEqual(expect.objectContaining({ taskId: "inactive-peer-death-pose", reason: "verify-closed-worker" }));
    expect(buildCards(rows, [{ ...closed[1]!, report: { state: "review", text: "Before the crash" } }]).find((c) => c.taskId === "oblique-shirt-layer")).toMatchObject({ column: "idle", report: null });
    rows[0]!.waiting = "upstream migration";
    rows[2]!.hold = "Eryn will play";
    expect(followThrough(buildCards(rows, members), () => true)).toEqual([]);
  });

  const backlog = parseBacklog(`## In flight
- [ ] fix-login - Fix the login (project: web) (kind: ship)
- [ ] by-id - Found by agent id (agent: a2)
- [ ] orphan - Nobody on it
## Queued
- [ ] next - Next thing
## Done
- [x] fix-login - An older task with the same id https://github.com/o/r/pull/1 (merged 2026-09-01)
`);

  it("joins a crewmate to its item by task label or recorded agent id, and keeps the rest", () => {
    const cards = buildCards(backlog, [
      { agent: agent(), report: { state: "done", text: "PR https://github.com/o/r/pull/42" } },
      { agent: agent({ id: "a2", labels: { [CREW_LABELS.role]: CREW_LABELS.crewRole } }), report: null },
      { agent: agent({ id: "a3", title: "Stray", labels: { [CREW_LABELS.role]: CREW_LABELS.crewRole } }), report: null },
    ]);
    const byKey = new Map(cards.map((card) => [card.key, card]));

    expect(byKey.get("agent:a1")).toMatchObject({
      column: "idle",
      title: "Fix the login",
      project: "web",
      links: ["https://github.com/o/r/pull/42"],
    });
    expect(byKey.get("agent:a2")).toMatchObject({ taskId: "by-id", title: "Found by agent id" });
    expect(byKey.get("agent:a3")).toMatchObject({ taskId: null, title: "Stray", backlog: null });
    expect(cards.filter((card) => card.agent === null).map((card) => [card.taskId, card.column])).toEqual([
      ["orphan", "idle"],
      ["next", "queued"],
      ["fix-login", "done"],
    ]);
  });
});

describe("closingText", () => {
  it("joins the assistant messages that end the timeline, skipping late notices", () => {
    const items = [
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "earlier" },
      { type: "tool_call", callId: "c", name: "Bash", detail: { type: "shell", command: "ls" }, status: "completed", error: null },
      { type: "assistant_message", text: "All green.\n\ndo" },
      { type: "assistant_message", text: "ne: PR https://x/1" },
      { type: "notification", level: "info", message: "later" },
    ] as TimelineItem[];
    expect(closingText(items)).toBe("All green.\n\ndone: PR https://x/1");
    expect(closingText([{ type: "user_message", text: "hi" }] as TimelineItem[])).toBeNull();
  });
});
