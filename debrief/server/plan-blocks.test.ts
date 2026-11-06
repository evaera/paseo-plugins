import { describe, expect, it } from "vitest";

import { blockLineLabel, parsePlanBlocks } from "./plan-blocks";

describe("parsePlanBlocks", () => {
  it("splits headings, paragraphs, lists, code, quotes, tables and rules with source lines", () => {
    const markdown = [
      "# Plan", // 1
      "", // 2
      "First paragraph", // 3
      "continues here.", // 4
      "", // 5
      "- one", // 6
      "  more of one", // 7
      "- two", // 8
      "", // 9
      "```ts", // 10
      "const x = 1;", // 11
      "", // 12
      "```", // 13
      "> quoted", // 14
      "> still", // 15
      "| a | b |", // 16
      "| - | - |", // 17
      "---", // 18
      "## Next", // 19
    ].join("\n");
    const blocks = parsePlanBlocks(markdown);
    expect(blocks.map((block) => [block.kind, block.startLine, block.endLine])).toEqual([
      ["heading", 1, 1],
      ["paragraph", 3, 4],
      ["list-item", 6, 7],
      ["list-item", 8, 8],
      ["code", 10, 13],
      ["quote", 14, 15],
      ["table", 16, 17],
      ["rule", 18, 18],
      ["heading", 19, 19],
    ]);
    expect(blocks[0]?.level).toBe(1);
    expect(blocks[8]?.level).toBe(2);
    expect(blocks[1]?.text).toBe("First paragraph\ncontinues here.");
    expect(blocks[2]?.text).toBe("- one\n  more of one");
    expect(blocks[4]?.text).toBe("```ts\nconst x = 1;\n\n```");
    expect(blocks.map((block) => block.id)).toEqual(blocks.map((_, index) => `block-${index}`));
  });

  it("treats #hashtag as text, nests list levels, and skips frontmatter", () => {
    const blocks = parsePlanBlocks("---\ntitle: x\n---\n#hashtag line\n\n- a\n    - b\n");
    expect(blocks[0]).toMatchObject({ kind: "paragraph", startLine: 4, text: "#hashtag line" });
    expect(blocks[1]).toMatchObject({ kind: "list-item", level: 0 });
    // An indented list marker is its own item, two levels in.
    expect(blocks[2]).toMatchObject({ kind: "list-item", level: 2, startLine: 7 });
  });

  it("keeps a balanced HTML block together across blank lines", () => {
    const blocks = parsePlanBlocks("<details>\n<summary>x</summary>\n\nbody\n</details>\nafter");
    expect(blocks[0]).toMatchObject({ kind: "html", startLine: 1, endLine: 5 });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", startLine: 6 });
  });

  it("runs an unclosed fence to the end", () => {
    const blocks = parsePlanBlocks("text\n```\ncode\nmore");
    expect(blocks[1]).toMatchObject({ kind: "code", startLine: 2, endLine: 4 });
  });

  it("labels lines", () => {
    expect(blockLineLabel({ startLine: 3, endLine: 3 })).toBe("line 3");
    expect(blockLineLabel({ startLine: 3, endLine: 5 })).toBe("lines 3-5");
  });
});
