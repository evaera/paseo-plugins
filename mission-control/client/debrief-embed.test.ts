import { describe, expect, it } from "vitest";

import type { FleetCard } from "../shared/fleet";
import { contextMenu } from "./card-commands";
import { parseDebriefEmbed, parseMarkdown } from "./markdown-parse";

describe("a Debrief embed", () => {
  it("is a line of its own, naming the work, the view and a file, each optional", () => {
    expect(parseMarkdown("[[debrief]]")).toEqual([{ kind: "debrief", ref: null, view: "diff", path: null }]);
    expect(parseMarkdown("  [[debrief: fix-login]]  ")).toEqual([{ kind: "debrief", ref: "fix-login", view: "diff", path: null }]);
    expect(parseMarkdown("[[debrief: fix-login story]]")).toEqual([{ kind: "debrief", ref: "fix-login", view: "story", path: null }]);
    expect(parseMarkdown("[[debrief: plans]]")).toEqual([{ kind: "debrief", ref: null, view: "plans", path: null }]);
    expect(parseMarkdown("[[debrief: wks_abc diff src/app.ts]]")).toEqual([
      { kind: "debrief", ref: "wks_abc", view: "diff", path: "src/app.ts" },
    ]);
  });

  it("keeps a path's brackets and spacing", () => {
    expect(parseDebriefEmbed("t diff app/[id]/page.tsx")).toEqual({ ref: "t", view: "diff", path: "app/[id]/page.tsx" });
    expect(parseMarkdown("[[debrief: t diff app/[id]/page.tsx]]")[0]?.kind).toBe("debrief");
    expect(parseDebriefEmbed("t diff my  file.ts")?.path).toBe("my  file.ts");
  });

  it("is plain text inside a paragraph, or with a ref that is not one", () => {
    expect(parseMarkdown("See [[debrief]] for it.")[0]?.kind).toBe("paragraph");
    expect(parseDebriefEmbed("../etc story")).toBeNull();
  });
});

describe("a card's menu", () => {
  const card = (debrief?: FleetCard["debrief"]): FleetCard => ({
    key: "k",
    column: "idle",
    taskId: "t",
    title: "T",
    project: null,
    kind: null,
    backlog: null,
    agent: null,
    report: null,
    links: [],
    ...(debrief === undefined ? {} : { debrief }),
  });

  it("offers the diff, and the story when there is one, for work Debrief can show", () => {
    const ids = (menu: ReturnType<typeof contextMenu>) => menu.flat().map((item) => item.id);
    expect(ids(contextMenu(card(), true))).not.toContain("debrief:diff");
    const info = { workspaceId: "wks_a", serverId: null, additions: 3, deletions: 1, openComments: 0, story: false };
    expect(ids(contextMenu(card(info), true))).toContain("debrief:diff");
    expect(ids(contextMenu(card(info), true))).not.toContain("debrief:story");
    expect(ids(contextMenu(card({ ...info, story: true }), true))).toContain("debrief:story");
  });
});
