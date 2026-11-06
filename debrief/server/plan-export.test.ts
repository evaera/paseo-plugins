import { describe, expect, it } from "vitest";

import type { PlanAnnotation } from "../shared/plan";
import { parsePlanBlocks } from "./plan-blocks";
import { exportPlanFeedback, NO_CHANGES, planDenyFeedback } from "./plan-export";

const author = { kind: "human" as const, name: "Eryn" };

function annotation(partial: Partial<PlanAnnotation> & Pick<PlanAnnotation, "id" | "type">): PlanAnnotation {
  return { originalText: "", body: "", labels: [], inDiff: false, author, createdAt: "2026-11-03T00:00:00Z", replies: [], ...partial };
}

const markdown = "# Plan\n\nStep one does a thing.\n\n- step two\n- step three\n";
const blocks = parsePlanBlocks(markdown);

describe("exportPlanFeedback", () => {
  it("says so when there is nothing", () => {
    expect(exportPlanFeedback(blocks, [])).toBe(NO_CHANGES);
  });

  it("writes Plannotator's format in document order", () => {
    const out = exportPlanFeedback(blocks, [
      annotation({ id: "b", type: "deletion", blockId: "block-3", originalText: "step three" }),
      annotation({
        id: "a",
        type: "comment",
        blockId: "block-1",
        originalText: "does a thing",
        body: "Which thing?",
        replies: [{ id: "r", body: "The parser.", author: { kind: "agent", name: "Claude" }, createdAt: "x", updatedAt: "x" }],
      }),
      annotation({ id: "g", type: "global", body: "Looks fine overall." }),
      annotation({ id: "l", type: "comment", blockId: "block-2", originalText: "step two", labels: ["verify", "tests"] }),
    ]);
    expect(out).toBe(
      [
        "# Plan Feedback",
        "",
        "I've reviewed this plan and have 4 pieces of feedback:",
        "",
        "## 1. General feedback about the plan",
        "> Looks fine overall.",
        "",
        '## 2. (line 3) Feedback on: "does a thing"',
        "> Which thing?",
        "**Replies:**",
        "- **Reply (Claude):** The parser.",
        "",
        '## 3. (line 5) [Verify this] [Needs tests] Feedback on: "step two"',
        "> This seems like an assumption. Verify it by reading the actual code before relying on it.",
        "> Say how this will be tested.",
        "",
        "## 4. (line 6) Remove this",
        "```",
        "step three",
        "```",
        "> I don't want this in the plan.",
        "",
        "---",
        "",
        "## Label Summary",
        "",
        "- **Verify this**: 1",
        "- **Needs tests**: 1",
        "",
        "",
      ].join("\n"),
    );
  });

  it("puts diff-view comments last and singularises one piece", () => {
    const out = exportPlanFeedback(blocks, [annotation({ id: "d", type: "comment", inDiff: true, originalText: "x", body: "y" })]);
    expect(out).toContain("have 1 piece of feedback:");
    expect(out).toContain('## 1. [In diff content] Feedback on: "x"');
  });

  it("wraps a denial", () => {
    expect(planDenyFeedback("# Plan Feedback")).toMatch(/^YOUR PLAN WAS NOT APPROVED\.[\s\S]*calling ExitPlanMode again[\s\S]*# Plan Feedback$/);
    expect(planDenyFeedback(NO_CHANGES, "debrief_submit_plan")).toMatch(/debrief_submit_plan[\s\S]*Plan changes requested$/);
  });
});
