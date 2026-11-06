import { describe, expect, it } from "vitest";

import type { Story } from "../shared/story";
import { codeSettingsFrom } from "./code-settings";
import { changedSpans, expandRun, foldedRuns, keepSpans, mapLine, mapSpan, pinSpans, unchangedRegions } from "./collapse";
import { buildDiffRows, interleave } from "./diff-rows";
import { countLabel, publishCounts, requestIntent, resetHub, takeIntent } from "./hub";
import { parseInline, parseMarkdownLite } from "./markdown-lite";
import { clip, draftAnnotations, locateSpan, planDiff, sortAnnotations } from "./plan-model";
import {
  chapterFocus,
  focusRows,
  hiddenSpans,
  insertNarration,
  mergeSpans,
  parsePlace,
  placeKey,
  stepSequence,
  storySequence,
} from "./story";

const lines = (count: number, prefix = "l") => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe("collapse", () => {
  const oldText = `${lines(40).join("\n")}\n`;
  const changed = lines(40);
  changed[19] = "changed";
  const newText = `${changed.join("\n")}\n`;

  it("keeps changed lines with three lines of context", () => {
    expect(changedSpans(oldText, newText)).toEqual({ old: [{ start: 17, end: 23 }], new: [{ start: 17, end: 23 }] });
  });

  it("folds the unchanged runs around them", () => {
    const keep = changedSpans(oldText, newText).new;
    expect(foldedRuns(40, keep, [])).toEqual([
      { start: 1, end: 16 },
      { start: 24, end: 40 },
    ]);
    // A run shorter than the minimum is shown, not folded.
    expect(foldedRuns(26, keep, [])).toEqual([{ start: 1, end: 16 }]);
  });

  it("keeps pinned lines with context out of folds", () => {
    expect(pinSpans([1, 30], 40)).toEqual([
      { start: 1, end: 4 },
      { start: 27, end: 33 },
    ]);
    const keep = keepSpans({ base: [{ start: 17, end: 23 }], pins: [30], mirroredPins: [], total: 40 });
    expect(foldedRuns(40, keep, [])).toEqual([
      { start: 1, end: 16 },
      { start: 34, end: 40 },
    ]);
  });

  it("expands 20 lines down, up, or all", () => {
    const run = { start: 30, end: 80 };
    expect(expandRun(run, "down")).toEqual({ start: 30, end: 49 });
    expect(expandRun(run, "up")).toEqual({ start: 61, end: 80 });
    expect(expandRun(run, "all")).toEqual(run);
    // A run a step would almost empty opens whole.
    expect(expandRun({ start: 1, end: 22 }, "down")).toEqual({ start: 1, end: 22 });
  });

  it("maps lines across unchanged runs", () => {
    const regions = unchangedRegions("a\nb\nc\n", "a\nx\ny\nb\nc\n");
    expect(regions).toEqual([
      { oldStart: 1, newStart: 1, length: 1 },
      { oldStart: 2, newStart: 4, length: 2 },
    ]);
    expect(mapLine(regions, 4, "new")).toBe(2);
    expect(mapLine(regions, 2, "new")).toBeNull();
    expect(mapLine(regions, 3, "old")).toBe(5);
    expect(mapSpan(regions, { start: 2, end: 5 }, "new")).toEqual({ start: 2, end: 3 });
  });
});

describe("story", () => {
  const file = {
    hunks: [
      { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, header: "" },
      { oldStart: 50, oldLines: 2, newStart: 51, newLines: 0, header: "" },
    ],
  };

  it("focuses a chapter on its hunks", () => {
    expect(chapterFocus(file, undefined)).toBeNull();
    expect(chapterFocus(file, [10, 50])).toBeNull();
    expect(chapterFocus(file, [10])).toEqual({ new: [{ start: 10, end: 13 }], old: [{ start: 10, end: 12 }] });
    expect(chapterFocus(file, [50])).toEqual({ new: [{ start: 51, end: 51 }], old: [{ start: 50, end: 51 }] });
  });

  it("merges and inverts spans", () => {
    expect(mergeSpans([{ start: 5, end: 8 }, { start: 1, end: 2 }, { start: 3, end: 4 }])).toEqual([{ start: 1, end: 8 }]);
    expect(hiddenSpans([{ start: 3, end: 4 }], 6)).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(hiddenSpans([], 0)).toEqual([]);
  });

  it("cuts native rows to a focus and places narration above its line", () => {
    const rows = buildDiffRows("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n", "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n");
    const focused = focusRows(rows, { new: [{ start: 11, end: 11 }], old: [{ start: 11, end: 11 }] });
    expect(focused.filter((row) => row.kind === "line").map((row) => (row.kind === "line" ? row.text : ""))).toEqual(["k", "K"]);
    expect(focused[0]?.kind).toBe("hunk");
    const { items } = interleave(focused, [], null);
    const narrated = insertNarration(items, [
      { id: "n1", line: 11, side: "new", anchor: "K", body: "Why", drifted: false },
      { id: "n2", line: 2, side: "new", anchor: "B", body: "Hidden", drifted: false },
    ]);
    const index = narrated.items.findIndex((item) => item.kind === "narration");
    expect(narrated.items[index + 1]?.kind === "line" && narrated.items[index + 1]).toMatchObject({ text: "K" });
    expect(narrated.unplaced.map((annotation) => annotation.id)).toEqual(["n2"]);
  });

  it("walks a story's files in order and round-trips places", () => {
    const story = {
      chapters: [
        { id: "c1", title: "One", summary: "", files: [{ path: "a" }, { path: "b" }] },
        { id: "c2", title: "Two", summary: "", files: [{ path: "c" }] },
      ],
    } as unknown as Story;
    const sequence = storySequence(story);
    expect(sequence.map((entry) => entry.path)).toEqual(["a", "b", "c"]);
    expect(stepSequence(sequence, 1, 1)).toEqual({ chapterId: "c2", path: "c" });
    expect(stepSequence(sequence, 2, 1)).toBeNull();
    expect(stepSequence(sequence, -1, -1)).toEqual({ chapterId: "c2", path: "c" });
    expect(parsePlace(placeKey({ kind: "chapter", chapterId: "c2" }), story)).toEqual({ kind: "chapter", chapterId: "c2" });
    expect(parsePlace("chapter:gone", story)).toEqual({ kind: "prologue" });
    expect(parsePlace("support", story)).toEqual({ kind: "support" });
  });
});

describe("markdown-lite", () => {
  it("reads inline marks", () => {
    expect(parseInline("a `b` **c** *d* [e](http://x)")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " " },
      { kind: "strong", text: "c" },
      { kind: "text", text: " " },
      { kind: "em", text: "d" },
      { kind: "text", text: " e" },
    ]);
  });

  it("reads blocks", () => {
    const blocks = parseMarkdownLite("# Title\n\nOne\ntwo\n\n- a\n- b\n  more\n1. x\n\n```ts\nconst a = 1;\n```\n");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "paragraph", "list", "list", "code"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "One two" }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "a" }], [{ text: "b more" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toEqual({ kind: "code", text: "const a = 1;" });
  });
});

describe("plan model", () => {
  it("diffs versions with line numbers on the current one", () => {
    const diff = planDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.parts.map((part) => part.kind)).toEqual(["same", "removed", "added", "same", "added"]);
    expect(diff.parts[2]).toMatchObject({ startLine: 2, endLine: 2 });
    expect(diff.parts[4]).toMatchObject({ startLine: 4, endLine: 4 });
  });

  it("finds a rendered selection in the block source", () => {
    expect(locateSpan("Use **the cache** here", "the cache")).toEqual({ start: 6, end: 15 });
    expect(locateSpan("Use **the** cache", "the cache")).toEqual({ start: 6, end: 17 });
    expect(locateSpan("abc", "zzz")).toBeNull();
    expect(locateSpan("abc", "  ")).toBeNull();
  });

  it("orders annotations and finds drafts", () => {
    const base = { originalText: "", body: "", labels: [], inDiff: false, author: { kind: "human" as const, name: "R" }, replies: [] };
    const annotations = [
      { ...base, id: "b", type: "comment" as const, blockId: "b2", createdAt: "2" },
      { ...base, id: "g", type: "global" as const, createdAt: "3", sentInVersion: 1 },
      { ...base, id: "a", type: "deletion" as const, blockId: "b1", createdAt: "1" },
    ];
    const blocks = [
      { id: "b1", kind: "paragraph", startLine: 1, endLine: 1, text: "x" },
      { id: "b2", kind: "paragraph", startLine: 2, endLine: 2, text: "y" },
    ];
    expect(sortAnnotations(annotations, blocks).map((annotation) => annotation.id)).toEqual(["g", "a", "b"]);
    expect(draftAnnotations(annotations).map((annotation) => annotation.id)).toEqual(["b", "a"]);
    expect(clip("a  b\nc", 4)).toBe("a b…");
  });
});

describe("code settings", () => {
  it("falls back to Paseo's defaults", () => {
    expect(codeSettingsFrom(null)).toMatchObject({ fontSize: 12, lineHeight: 18, syntaxTheme: "one" });
    expect(codeSettingsFrom("not json").fontFamily).toContain("ui-monospace");
  });

  it("reads the stored font, size and theme", () => {
    const settings = codeSettingsFrom(JSON.stringify({ monoFontFamily: "JetBrains Mono", codeFontSize: 13, syntaxTheme: "nord" }));
    expect(settings.fontFamily.startsWith("JetBrains Mono, ")).toBe(true);
    expect(settings.lineHeight).toBe(20);
    expect(settings.syntaxTheme).toBe("nord");
  });
});

describe("hub", () => {
  it("hands an intent to the next panel once", () => {
    resetHub();
    requestIntent("w1", { view: "story" });
    expect(takeIntent("w1")).toEqual({ view: "story" });
    expect(takeIntent("w1")).toBeNull();
  });

  it("labels counts", () => {
    resetHub();
    publishCounts("w1", { openComments: 3, pendingPlans: 1 });
    expect(countLabel({ openComments: 3, pendingPlans: 1 })).toBe("3 · 1 plan");
    expect(countLabel({ openComments: 0, pendingPlans: 0 })).toBeUndefined();
    expect(countLabel(null)).toBeUndefined();
  });
});

describe("compare", () => {
  it("round-trips compare keys and migrates scopes", async () => {
    const { parseCompareKey, storedCompare, scopeForCompare, pickEndpoint, endpointProblem, endpointName } = await import("./compare");
    const { compareKey } = await import("../shared/compare");
    const custom = { from: { kind: "ref" as const, ref: "v1.2" }, to: { kind: "worktree" as const } };
    expect(parseCompareKey(compareKey(custom))).toEqual(custom);
    expect(parseCompareKey("bogus")).toBeNull();
    expect(parseCompareKey("worktree..nope")).toBeNull();
    expect(storedCompare(null, "staged")).toEqual({ from: { kind: "head" }, to: { kind: "index" } });
    expect(storedCompare("head..worktree", "staged")).toEqual({ from: { kind: "head" }, to: { kind: "worktree" } });
    expect(scopeForCompare({ from: { kind: "upstream" }, to: { kind: "head" } })).toBe("unpushed");
    expect(scopeForCompare(custom)).toBeNull();

    const base = { from: { kind: "main" as const }, to: { kind: "worktree" as const } };
    expect(pickEndpoint(base, "from", { kind: "head" })).toEqual({ from: { kind: "head" }, to: { kind: "worktree" } });
    // Picking the other side's endpoint swaps, unless the swap puts the working tree on the from side.
    expect(pickEndpoint(base, "to", { kind: "main" })).toBe(base);
    const heads = { from: { kind: "main" as const }, to: { kind: "head" as const } };
    expect(pickEndpoint(heads, "to", { kind: "main" })).toEqual({ from: { kind: "head" }, to: { kind: "main" } });

    const names = { defaultBranch: "main", upstream: null };
    expect(endpointProblem("from", { kind: "worktree" }, { kind: "head" }, names)).not.toBeNull();
    expect(endpointProblem("to", { kind: "upstream" }, { kind: "main" }, names)).toBe("This branch has no upstream");
    expect(endpointProblem("to", { kind: "head" }, { kind: "main" }, names)).toBeNull();
    expect(endpointName({ kind: "index" }, names)).toBe("staged");
  });
});

describe("comments list", () => {
  it("groups threads by file, open first", async () => {
    const { commentListItems, itemOffsets, firstLine, FILE_ROW_HEIGHT } = await import("./comments-model");
    const make = (id: string, path: string | undefined, resolved: boolean, startLine?: number) => ({
      id,
      scope: path === undefined ? ("review" as const) : ("line" as const),
      ...(path !== undefined ? { path } : {}),
      ...(startLine !== undefined ? { startLine, endLine: startLine } : {}),
      body: "## Fix\nthis",
      author: { kind: "human" as const, name: "R" },
      createdAt: id,
      updatedAt: id,
      resolved,
      drifted: false,
      replies: [],
    });
    const comments = [
      make("1", "b.ts", true, 1),
      make("2", "a.ts", false, 9),
      make("3", "a.ts", true, 2),
      make("4", undefined, false),
      make("5", "c.ts", false, 3),
    ];
    const all = commentListItems(comments, ["a.ts", "b.ts", "c.ts"], "all");
    expect(all.map((item) => item.key)).toEqual(["f:", "t:4", "f:a.ts", "t:2", "t:3", "f:c.ts", "t:5", "f:b.ts", "t:1"]);
    const open = commentListItems(comments, ["a.ts", "b.ts", "c.ts"], "open");
    expect(open.map((item) => item.key)).toEqual(["f:", "t:4", "f:a.ts", "t:2", "f:c.ts", "t:5"]);
    expect(itemOffsets(open)[2]).toEqual({ length: FILE_ROW_HEIGHT, offset: FILE_ROW_HEIGHT + 54 });
    expect(firstLine("\n## Fix *it*\nmore")).toBe("Fix it");
  });
});
