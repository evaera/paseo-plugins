import { findSvgIconProblem } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";

import { ASANA_ICON, linkKind } from "./format";
import { latestCoordinatorSeq, unreadKeys } from "./unread";
import type { FleetCard } from "../shared/fleet";
import { applyColumnOrder, dropIndex, moveKey, rankKey, rankedColumns, shiftFor, sortByRank } from "./order";

const card = (key: string, taskId: string | null = null) => ({ key, taskId });

describe("the user's card order", () => {
  it("ranks a card by its task where it has one, so a relaunch keeps its place", () => {
    expect(rankKey(card("agent:a1", "fix-login"))).toBe("task:fix-login");
    expect(rankKey(card("agent:a1"))).toBe("agent:a1");
  });

  it("puts ranked cards first, in rank order, and keeps the rest in the order they came", () => {
    const cards = [card("a"), card("b"), card("agent:c", "t"), card("d")];
    expect(sortByRank(cards, ["d", "task:t"]).map((entry) => entry.key)).toEqual(["d", "agent:c", "a", "b"]);
    expect(sortByRank(cards, []).map((entry) => entry.key)).toEqual(["a", "b", "agent:c", "d"]);
  });

  it("saves a rearranged column ahead of everything else, without repeats", () => {
    expect(applyColumnOrder(["x", "b", "y", "a"], ["a", "b"])).toEqual(["a", "b", "x", "y"]);
    expect(applyColumnOrder([], ["a", "a", "b"])).toEqual(["a", "b"]);
  });

  it("drops the oldest ranks past 500", () => {
    const order = Array.from({ length: 600 }, (_, index) => `k${index}`);
    const saved = applyColumnOrder(order, ["new"]);
    expect(saved).toHaveLength(500);
    expect(saved[0]).toBe("new");
  });

  it("moves one key and clamps where it lands", () => {
    expect(moveKey(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveKey(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveKey(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
  });

  it("lands a dragged card past every card whose middle it crossed", () => {
    const layouts = [
      { y: 0, height: 100 },
      { y: 108, height: 60 },
      { y: 176, height: 100 },
    ];
    expect(dropIndex(layouts, 0, 0)).toBe(0);
    expect(dropIndex(layouts, 0, 80)).toBe(0);
    expect(dropIndex(layouts, 0, 90)).toBe(1);
    expect(dropIndex(layouts, 0, 400)).toBe(2);
    expect(dropIndex(layouts, 2, -200)).toBe(0);
    expect(dropIndex(layouts, 2, -60)).toBe(2);
    expect(dropIndex(layouts, 2, -100)).toBe(1);
  });

  it("steps the cards between the held one and where it points aside, and no others", () => {
    expect([0, 1, 2, 3].map((position) => shiftFor(position, 0, 2, 50))).toEqual([0, -50, -50, 0]);
    expect([0, 1, 2, 3].map((position) => shiftFor(position, 3, 1, 50))).toEqual([0, 50, 50, 0]);
    expect([0, 1, 2].map((position) => shiftFor(position, 1, 1, 50))).toEqual([0, 0, 0]);
  });
});

describe("the order Mission Control is given", () => {
  const full = (key: string, column: FleetCard["column"], taskId: string | null): FleetCard => ({
    key,
    column,
    taskId,
    title: key,
    project: null,
    kind: null,
    backlog: null,
    agent: null,
    report: null,
    links: [],
  });

  it("lists only the columns the user arranged, every card in them in the user's order", () => {
    const cards = [full("a", "queued", "a"), full("b", "queued", "b"), full("c", "working", null)];
    expect(rankedColumns(cards, ["task:b"])).toEqual([
      {
        title: "Inbox",
        cards: [
          { taskId: "b", title: "b", agentId: null, host: null },
          { taskId: "a", title: "a", agentId: null, host: null },
        ],
      },
    ]);
  });
});

describe("a card's links", () => {
  it("names each kind of page with an icon, and a pull request or issue by its number", () => {
    expect(linkKind("https://github.com/acme/web/pull/336301")).toEqual({
      icon: "GitPullRequest",
      label: "Pull request 336301",
      short: "#336301",
    });
    expect(linkKind("https://github.com/o/r/issues/7")).toMatchObject({ icon: "CircleDot", short: "#7" });
    expect(linkKind("https://app.asana.com/1/2/project/3/task/4")).toMatchObject({ icon: ASANA_ICON, label: "Asana task" });
    expect(linkKind("https://www.notion.so/page")).toMatchObject({ icon: "FileText" });
    expect(linkKind("http://localhost:63472")).toMatchObject({ icon: "AppWindow", label: "Local preview" });
    expect(linkKind("http://build-box.local:3247")).toEqual({ icon: "Link", label: "build-box.local:3247", short: null });
  });

  it("draws Asana with an SVG Paseo accepts", () => {
    expect(findSvgIconProblem(ASANA_ICON.svg)).toBeNull();
  });
});

describe("unread Mission Control messages", () => {
  const rows = [
    { key: "1", kind: "user" as const, text: "hi" },
    { key: "2", kind: "coordinator" as const, text: "a" },
    { key: "3", kind: "tool" as const, text: "t", status: "completed" as const },
    { key: "5", kind: "coordinator" as const, text: "b" },
    { key: "6", kind: "user" as const, text: "ok" },
  ];
  it("counts only Mission Control's own messages after the last one seen", () => {
    expect(latestCoordinatorSeq(rows)).toBe(5);
    expect(unreadKeys(rows, 2)).toEqual(["5"]);
    expect(unreadKeys(rows, 0)).toEqual(["2", "5"]);
    expect(unreadKeys(rows, 5)).toEqual([]);
    expect(latestCoordinatorSeq([])).toBeNull();
  });
});
