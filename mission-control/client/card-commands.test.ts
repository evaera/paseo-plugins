import { describe, expect, it } from "vitest";

import type { AgentSummary, BacklogItem, ColumnId, FleetCard } from "../shared/fleet";
import { addedAt, homePath } from "./format";
import { cardMenu, contextMenu, dependPrompt, dropPrompt, undependPrompt, waitingPrompt } from "./card-commands";
import { cardForRef, cardForTask, dependencyChoices } from "./board-tasks";
import { aboutMessage } from "./chat-about";

const item: BacklogItem = {
  section: "queued",
  id: "dark-mode",
  title: "Add dark mode",
  project: null,
  kind: null,
  mode: null,
  agentId: null,
  host: null,
  hold: null,
  waiting: null,
  actions: [],
  blockedBy: null,
  since: null,
  url: null,
  links: [],
  reportPath: null,
  outcome: null,
};

const worker = { id: "a1", host: "eryn" } as AgentSummary;

function card(column: ColumnId, agent: AgentSummary | null, backlog: BacklogItem | null = item): FleetCard {
  return { key: "k", column, taskId: backlog?.id ?? null, title: backlog?.title ?? "Stray", project: null, kind: null, backlog, agent, report: null, links: [] };
}

const choices = (entry: FleetCard) => cardMenu(entry).choices.map((choice) => choice.label);

describe("what an open card offers", () => {
  it("asks a backlog item's column question, with Drop set apart and no worker tools", () => {
    expect(choices(card("queued", null))).toEqual(["Start"]);
    expect(choices(card("idle", null))).toEqual(["Restart", "Waiting on…", "Mark done"]);
    expect(choices(card("waiting", null))).toEqual(["Back to work", "Mark done"]);
    expect(choices(card("done", null))).toEqual(["Reopen"]);
    expect(cardMenu(card("queued", null))).toMatchObject({ tools: [], removal: "drop" });
    expect(cardMenu(card("done", null)).removal).toBeNull();
  });

  it("asks an idle worker whether to keep going, wait on someone, or finish", () => {
    expect(choices(card("idle", worker))).toEqual(["Keep going", "Waiting on…", "Mark done"]);
    expect(cardMenu(card("idle", worker))).toMatchObject({ tools: ["relaunch"], removal: "end" });
  });

  it("gives a working worker its tools and no choices, and Interrupt only there", () => {
    expect(cardMenu(card("working", worker))).toEqual({ choices: [], tools: ["interrupt"], removal: "end" });
    expect(cardMenu(card("idle", worker)).tools).not.toContain("interrupt");
    expect(choices(card("failed", worker))).toEqual(["Relaunch"]);
    expect(choices(card("parked", worker))).toEqual(["Resume", "Waiting on…"]);
  });

  it("names the task in every request", () => {
    const start = cardMenu(card("queued", null)).choices[0];
    expect(start).toMatchObject({ prompt: "dark-mode — Add dark mode: start this now." });
    expect(dropPrompt(card("queued", null))).toBe("dark-mode — Add dark mode: drop this task and take it off the backlog.");
    expect(waitingPrompt(card("idle", null), " a code review ")).toBe(
      "dark-mode — Add dark mode: nothing is left for us to do; it is waiting on a code review. Mark it waiting.",
    );
  });

  it("names a worker with no task by its agent and host", () => {
    expect(cardMenu(card("parked", worker, null)).choices[0]).toMatchObject({
      prompt: 'the worker "Stray" (agent a1 on eryn): resume this, carrying on where the worker stopped.',
    });
  });
});

describe("an open card's facts", () => {
  it("writes a home directory as ~", () => {
    expect(homePath("/Users/sam/projects/paseo")).toBe("~/projects/paseo");
    expect(homePath("/home/dev/web")).toBe("~/web");
    expect(homePath("/Users/sam")).toBe("~");
    expect(homePath("/opt/work")).toBe("/opt/work");
  });

  it("dates a card by its task's since, else its worker's creation", () => {
    expect(addedAt(card("queued", null, { ...item, since: "2026-10-20" }))?.iso).toBe(new Date(2026, 9, 20).toISOString());
    expect(addedAt(card("idle", { ...worker, createdAt: "2026-10-28T15:04:00.000Z" }))?.iso).toBe("2026-10-28T15:04:00.000Z");
    expect(addedAt(card("idle", { ...worker, createdAt: null }))).toBeNull();
  });

  it("says a day-only date in days, never hours", () => {
    const on = (since: string) => addedAt(card("queued", null, { ...item, since }), new Date(2026, 9, 29, 17, 0))?.ago;
    expect(on("2026-10-29")).toBe("today");
    expect(on("2026-10-28")).toBe("yesterday");
    expect(on("2026-10-20")).toBe("9d ago");
  });
});

describe("a message pointed at a card", () => {
  const about = { key: "k", title: "Add dark mode", subject: "dark-mode — Add dark mode" };
  it("starts with the card, and is only the card when there are no words", () => {
    expect(aboutMessage(about, " make it the default ")).toBe("dark-mode — Add dark mode: make it the default");
    expect(aboutMessage(about, "  ")).toBe("dark-mode — Add dark mode");
    expect(aboutMessage(null, "hello")).toBe("hello");
  });
});

describe("a card's context menu", () => {
  const ids = (groups: ReturnType<typeof contextMenu>) => groups.map((group) => group.map((menuItem) => menuItem.id));
  it("offers what the open card does, with what needs words or a confirmation opening the view on it", () => {
    expect(ids(contextMenu(card("idle", worker), true))).toEqual([
      ["ask:Keep going", "draft:wait", "ask:Mark done"],
      ["draft:relaunch"],
      ["end"],
    ]);
    expect(ids(contextMenu(card("queued", null), true))).toEqual([["ask:Start"], ["drop"]]);
    expect(ids(contextMenu(card("working", worker), true))).toEqual([["interrupt"], ["end"]]);
  });

  it("puts Mission Control's own buttons first, and draws nothing that needs Mission Control without one", () => {
    const held = card("blocked", null, { ...item, hold: "which?", actions: [{ label: "Postgres", prompt: "Use Postgres" }] });
    expect(ids(contextMenu(held, true))).toEqual([["action:0"], ["drop"]]);
    expect(ids(contextMenu(held, false))).toEqual([]);
  });
});

describe("what a task is blocked by", () => {
  it("asks Mission Control to record and clear the dependency by id", () => {
    expect(dependPrompt(card("queued", null), { taskId: "fix-login", title: "Fix login" })).toBe(
      "dark-mode — Add dark mode: this is blocked by fix-login — Fix login. Record it as (blocked-by: fix-login).",
    );
    expect(undependPrompt(card("queued", null), "fix-login")).toBe(
      "dark-mode — Add dark mode: this is no longer blocked by fix-login. Take the blocked-by off its line.",
    );
  });

  it("offers every other open task once, and finds a task's card by its worker first", () => {
    const backlogOnly = (taskId: string, column: ColumnId) => card(column, null, { ...item, id: taskId, title: taskId });
    const worked = { ...backlogOnly("b", "working"), agent: worker, key: "agent:a1" };
    const cards = [backlogOnly("dark-mode", "queued"), backlogOnly("b", "idle"), worked, backlogOnly("c", "done")];
    expect(dependencyChoices(cards, "dark-mode").map((entry) => entry.taskId)).toEqual(["b"]);
    expect(cardForTask(cards, "b")?.key).toBe("agent:a1");
    expect(cardForTask(cards, "zzz")).toBeNull();
  });
});

describe("a card Mission Control embeds", () => {
  it("is a line of its own, by task id or agent id, and nothing else is", async () => {
    const { parseMarkdown } = await import("./markdown-parse");
    expect(parseMarkdown("Here it is:\n\n[[card: dark-mode]]\n\nMore.")).toEqual([
      { kind: "paragraph", text: "Here it is:" },
      { kind: "card", ref: "dark-mode" },
      { kind: "paragraph", text: "More." },
    ]);
    expect(parseMarkdown("  [[ Card : 4f1c2a90-5b7d ]]  ")).toEqual([{ kind: "card", ref: "4f1c2a90-5b7d" }]);
    expect(parseMarkdown("see [[card: dark-mode]] here")[0]?.kind).toBe("paragraph");
    expect(parseMarkdown("```\n[[card: dark-mode]]\n```")[0]?.kind).toBe("code");
  });

  it("finds its card by task, by agent id, or by the start of a long agent id", () => {
    const backlogOnly = card("queued", null, { ...item, id: "dark-mode" });
    const worked = { ...card("working", worker, null), key: "agent:4f1c2a90-5b7d-4e3a", agent: { ...worker, id: "4f1c2a90-5b7d-4e3a" } };
    const cards = [backlogOnly, worked];
    expect(cardForRef(cards, "dark-mode")).toBe(backlogOnly);
    expect(cardForRef(cards, "4f1c2a90-5b7d-4e3a")).toBe(worked);
    expect(cardForRef(cards, "4f1c2a90")).toBe(worked);
    expect(cardForRef(cards, "86e2")).toBeNull();
  });
});
