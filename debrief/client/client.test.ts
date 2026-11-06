import { describe, expect, it } from "vitest";

import type { Comment } from "../shared/review";
import { buildDiffRows, interleave, rangeText } from "./diff-rows";
import {
  adjacentLine,
  baseLabel,
  completionType,
  locationLabel,
  openCountsByPath,
  rangeLabel,
  relativeTime,
  splitFences,
  threadsForFile,
} from "./format";
import { hideDebriefNotes } from "./transform";

function comment(overrides: Partial<Comment>): Comment {
  return {
    id: "c1",
    scope: "line",
    path: "a.ts",
    side: "new",
    startLine: 1,
    endLine: 1,
    body: "fix",
    author: { kind: "human", name: "Eryn" },
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    resolved: false,
    drifted: false,
    replies: [],
    ...overrides,
  };
}

describe("labels", () => {
  it("formats ranges and locations", () => {
    expect(rangeLabel({ startLine: 3 })).toBe("L3");
    expect(rangeLabel({ startLine: 3, endLine: 5 })).toBe("L3-5");
    expect(rangeLabel({ startLine: 3, endLine: 3, side: "old" })).toBe("old L3");
    expect(rangeLabel({})).toBe("");
    expect(locationLabel("a.ts", { startLine: 2, endLine: 4 })).toBe("a.ts:2-4");
    expect(locationLabel("a.ts", { startLine: 2, side: "old" })).toBe("a.ts:2 (old)");
    expect(locationLabel("a.ts", {})).toBe("a.ts");
    expect(locationLabel(null, {})).toBe("Review");
  });

  it("names the base", () => {
    expect(baseLabel(null)).toBe("no base");
    expect(baseLabel({ ref: "main", sha: "0123456789abcdef" })).toBe("main @ 0123456");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-11-02T12:00:00.000Z");
    expect(relativeTime("2026-11-02T11:59:50.000Z", now)).toBe("just now");
    expect(relativeTime("2026-11-02T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-11-02T09:00:00.000Z", now)).toBe("3h");
    expect(relativeTime("2026-10-01T09:00:00.000Z", now)).toBe("2026-10-01");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("grouping", () => {
  it("splits a file's threads by side and scope, in line order", () => {
    const threads = threadsForFile(
      [
        comment({ id: "late", startLine: 9, endLine: 9 }),
        comment({ id: "early", startLine: 2, endLine: 3 }),
        comment({ id: "old", side: "old", startLine: 1, endLine: 1 }),
        comment({ id: "file", scope: "file", startLine: undefined, endLine: undefined }),
        comment({ id: "other", path: "b.ts" }),
      ],
      "a.ts",
    );
    expect(threads.newSide.map((c) => c.id)).toEqual(["early", "late"]);
    expect(threads.oldSide.map((c) => c.id)).toEqual(["old"]);
    expect(threads.file.map((c) => c.id)).toEqual(["file"]);
  });

  it("counts open comments per path", () => {
    const counts = openCountsByPath([
      comment({ id: "1" }),
      comment({ id: "2" }),
      comment({ id: "3", resolved: true }),
      comment({ id: "4", path: "b.ts" }),
      comment({ id: "5", scope: "review", path: undefined }),
    ]);
    expect([...counts]).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });

  it("steps between thread lines, wrapping", () => {
    expect(adjacentLine([10, 3, 7], 3, 1)).toBe(7);
    expect(adjacentLine([10, 3, 7], 10, 1)).toBe(3);
    expect(adjacentLine([10, 3, 7], 3, -1)).toBe(10);
    expect(adjacentLine([10, 3, 7], 8, -1)).toBe(7);
    expect(adjacentLine([], 1, 1)).toBeNull();
  });
});

describe("lsp helpers", () => {
  it("maps completion kinds", () => {
    expect(completionType(3)).toBe("function");
    expect(completionType(7)).toBe("class");
    expect(completionType(null)).toBeUndefined();
  });

  it("splits fenced code out of hover markdown", () => {
    expect(splitFences("```ts\nconst a: number\n```\nThe count.")).toEqual([
      { code: true, text: "const a: number" },
      { code: false, text: "The count." },
    ]);
    expect(splitFences("plain")).toEqual([{ code: false, text: "plain" }]);
  });
});

describe("native diff rows", () => {
  const oldText = "one\ntwo\nthree\n";
  const newText = "one\n2\nthree\nfour\n";

  it("numbers both sides", () => {
    const rows = buildDiffRows(oldText, newText);
    const lines = rows.flatMap((row) => (row.kind === "line" ? [[row.type, row.oldLine, row.newLine, row.text]] : []));
    expect(rows[0]?.kind).toBe("hunk");
    expect(lines).toEqual([
      ["context", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["add", null, 2, "2"],
      ["context", 3, 3, "three"],
      ["add", null, 4, "four"],
    ]);
  });

  it("treats a new file as all additions starting at line 1", () => {
    const rows = buildDiffRows(null, "a\nb\n");
    const lines = rows.flatMap((row) => (row.kind === "line" ? [[row.type, row.newLine]] : []));
    expect(lines).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
  });

  it("slots threads and the composer after their end line", () => {
    const rows = buildDiffRows(oldText, newText);
    const { items, unplaced } = interleave(
      rows,
      [
        comment({ id: "new2", startLine: 2, endLine: 2 }),
        comment({ id: "old2", side: "old", startLine: 2, endLine: 2 }),
        comment({ id: "far", startLine: 99, endLine: 99 }),
      ],
      { side: "new", startLine: 3, endLine: 4 },
    );
    const keys = items.map((item) => item.key);
    expect(keys.indexOf("t:old2")).toBe(keys.indexOf("h0l1") + 1);
    expect(keys.indexOf("t:new2")).toBe(keys.indexOf("h0l2") + 1);
    expect(keys.indexOf("composer")).toBe(keys.indexOf("h0l4") + 1);
    expect(unplaced.map((c) => c.id)).toEqual(["far"]);
    expect(rangeText(rows, { side: "new", startLine: 2, endLine: 3 })).toBe("2\nthree");
  });
});

describe("timeline transformer", () => {
  const base = {
    type: "tool_call" as const,
    callId: "x",
    name: "agent_message",
    detail: { type: "unknown" as const, input: null, output: null },
    status: "completed" as const,
    error: null,
  };

  it("hides Debrief's notes and nothing else", () => {
    const debrief = { ...base, agentMessage: { event: "message" as const, sender: { id: "debrief" }, text: "hi" } };
    const other = { ...base, agentMessage: { event: "message" as const, sender: { id: "agent-2" }, text: "hi" } };
    // The item union is wider than these fixtures; the transformer reads only the fields set here.
    const run = (item: unknown) =>
      hideDebriefNotes({ item: item as Parameters<typeof hideDebriefNotes>[0]["item"], phase: "complete" });
    expect(run(debrief)).toEqual({ items: [] });
    expect(run(other)).toBeUndefined();
    expect(run({ ...base, name: "Bash" })).toBeUndefined();
  });
});
