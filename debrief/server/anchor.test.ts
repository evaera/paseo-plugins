/**
 * Ported from Crit's internal/session/watch_test.go (MIT): the carry-forward,
 * anchorSimilar, oneMiddleCut, findAnchorInLines and remapLines cases.
 */
import { describe, expect, it } from "vitest";

import type { Comment } from "../shared/review";
import {
  anchorSimilar,
  captureAnchor,
  findAnchorInLines,
  oneMiddleCut,
  reanchorComments,
  remapLines,
  reverifyComments,
} from "./anchor";

function lineComment(startLine: number, endLine: number, anchor?: string, side: "old" | "new" = "new"): Comment {
  const comment: Comment = {
    id: "c_old",
    scope: "line",
    path: "plan.md",
    side,
    startLine,
    endLine,
    body: "body",
    author: { kind: "human", name: "Reviewer" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    resolved: false,
    drifted: false,
    replies: [],
  };
  if (anchor !== undefined) comment.anchor = anchor;
  return comment;
}

function carry(previous: string, current: string, comment: Comment): Comment {
  const comments = [comment];
  reanchorComments(comments, "plan.md", previous, current);
  return comments[0] as Comment;
}

describe("carrying comments forward (Crit's watch_test.go)", () => {
  it("follows the anchor when lines are inserted above", () => {
    const carried = carry("# Plan\n\nStep 1\n\nStep 2\n", "# Plan\n\nNew line A\nNew line B\nStep 1\n\nStep 2\n", lineComment(3, 3, "Step 1"));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([5, 5, false]);
  });

  it("drifts when the anchor is gone", () => {
    expect(carry("# Plan\n\nStep 1\n", "# Plan\n\nSomething else\n", lineComment(3, 3, "Step 1")).drifted).toBe(true);
  });

  it("stays anchored when text is appended to the line in place", () => {
    const anchor = "- Don't create a group for just 1 commit, merge it into the closest group";
    const carried = carry(`# Plan\n\n${anchor}\n`, `# Plan\n\n${anchor} (unless it's a single significant feature)\n`, lineComment(3, 3, anchor));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([3, 3, false]);
  });

  it("stays anchored when a clause is cut from the middle of the line", () => {
    const anchor = '      continue. If this organization has no locations yet,{" "}';
    const previous = `<div>\n  Please select a location above to\n${anchor}\n  <Link to="/admin">create one here</Link>\n</div>\n`;
    const current = '<div>\n  Please select a location above to\n      continue.{" "}\n  <Link to="/admin">Go to admin to create one</Link>\n</div>\n';
    const carried = carry(previous, current, lineComment(3, 3, anchor));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([3, 3, false]);
  });

  it("finds the anchor when the line map points elsewhere", () => {
    const carried = carry("A\nB\nC\nD\nE\n", "X\nY\nC\nZ\nA\nB\nD\nE\n", lineComment(1, 1, "A"));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([5, 5, false]);
  });

  it("maps a comment without an anchor by the line map alone, never drifted", () => {
    const carried = carry("# Plan\n\nStep 1\n\nStep 2\n", "# Plan\n\nNew line\nStep 1\n\nStep 2\n", lineComment(3, 3));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([4, 4, false]);
  });

  it("moves a multi-line range as a block", () => {
    const carried = carry("Header\nLine A\nLine B\nLine C\nFooter\n", "Header\nX\nY\nZ\nLine A\nLine B\nLine C\nFooter\n", lineComment(2, 4, "Line A\nLine B\nLine C"));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([5, 7, false]);
  });

  it("takes the range length from the anchor, not the mapped span", () => {
    const carried = carry(
      "Header\nLine A\nLine B\nLine C\nFooter\n",
      "Header\nExtra1\nExtra2\nExtra3\nLine A\nLine B\nLine C\nExtra4\nFooter\n",
      lineComment(2, 4, "Line A\nLine B\nLine C"),
    );
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([5, 7, false]);
  });

  it("leaves old-side comments where they are", () => {
    const carried = carry("a\nb\n", "x\ny\na\nb\n", lineComment(1, 1, "a", "old"));
    expect([carried.startLine, carried.endLine, carried.drifted]).toEqual([1, 1, false]);
  });

  it("marks anchored comments drifted when the file is gone, and reverify clears it", () => {
    const comments = [lineComment(2, 2, "b")];
    expect(reanchorComments(comments, "plan.md", "a\nb\n", null)).toBe(true);
    expect(comments[0]?.drifted).toBe(true);
    expect(reverifyComments(comments, "plan.md", "a\nb\n")).toBe(true);
    expect(comments[0]?.drifted).toBe(false);
  });
});

describe("oneMiddleCut", () => {
  it.each([
    ["abef", "abcdef", true],
    ["ab", "abcdef", true],
    ["ef", "abcdef", true],
    ["", "abcdef", true],
    ["abde", "abcdexf", false],
    ["efab", "abcdef", false],
    ["abcdef", "abcdef", false],
    ["abcdefg", "abcdef", false],
    ["a\u2014f", "a\u2014cdf", true],
    ["af", "a\u2014f", true],
  ])("%j from %j is %s", (short, long, want) => {
    expect(oneMiddleCut(short, long)).toBe(want);
  });
});

describe("anchorSimilar", () => {
  it.each([
    ["foo bar", "foo bar", true],
    ["  foo bar  ", "foo bar", true],
    ["foo bar baz qux", "foo bar baz", true],
    ["foo bar baz", "foo bar baz qux", true],
    ["the quick brown fox", "the quick brn fox", true],
    ['continue.{" "}', 'continue. If this organization has no locations yet,{" "}', true],
    ["if err := doSomething(arg); err != nil {", "doSomething(arg)", true],
    ["return nil, err", 'return fmt.Errorf("failed to open config file %q: %w", path, err)', false],
    ["t.Fatal(err)", 't.Fatalf("unexpected error reading %s: %v", path, err)', false],
    ["s.mu.Unlock()", "defer s.mu.RUnlock()", false],
    ["} else {", "}", false],
    ["x = foo()", "x = 1", false],
    ["", "foo bar", false],
    ["foo bar", "", false],
    ["the quick brown fox", "lorem ipsum dolor", false],
    ["foo bar baz", "completely different text here", false],
    ["line one\nline two changed", "line one\nline two", true],
  ])("%j vs %j is %s", (candidate, anchor, want) => {
    expect(anchorSimilar(candidate, anchor)).toBe(want);
  });
});

describe("findAnchorInLines", () => {
  it.each([
    [["alpha", "beta", "gamma"], "delta", 1, 0],
    [["alpha", "beta", "gamma"], "beta", 1, 2],
    [["x", "y", "x", "y", "x"], "x", 5, 5],
    [["x", "y", "x", "y", "x"], "x", 2, 1],
    [["alpha", "beta"], "", 1, 0],
    [["a", "b", "c", "a", "b", "d"], "a\nb", 4, 4],
    [["a"], "a\nb", 1, 0],
  ])("%j / %j near %i -> %i", (lines, anchor, preferred, want) => {
    expect(findAnchorInLines(lines, anchor, preferred)).toBe(want);
  });
});

describe("remapLines", () => {
  it.each([
    [{ 5: 7, 10: 12 }, 5, 10, 20, [7, 12]],
    [{}, 3, 8, 20, [3, 8]],
    [{}, 25, 30, 10, [10, 10]],
    [{ 5: 10, 8: 4 }, 5, 8, 20, [10, 10]],
    [{ 1: 0 }, 1, 1, 20, [1, 1]],
  ] as const)("%j %i-%i (max %i)", (map, start, end, max, want) => {
    const lineMap = new Map(Object.entries(map).map(([key, value]) => [Number(key), value]));
    expect(remapLines(lineMap, start, end, max)).toEqual(want);
  });
});

describe("captureAnchor", () => {
  it("joins the commented lines and clamps the end", () => {
    expect(captureAnchor("a\nb\nc\n", 2, 9)).toBe("b\nc\n");
    expect(captureAnchor("a\nb\n", 2, 2)).toBe("b");
    expect(captureAnchor("a\n", 5, 5)).toBeUndefined();
  });
});
