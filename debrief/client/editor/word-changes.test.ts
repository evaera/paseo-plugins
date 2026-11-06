import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

const doc = (text: string) => Text.of(text.split("\n"));
import { describe, expect, it } from "vitest";

import { wordChangeRanges } from "./word-changes";

const chunksOf = (a: string, b: string) => Chunk.build(Text.of(a.split("\n")), Text.of(b.split("\n")));

describe("wordChangeRanges", () => {
  it("emphasises nothing in a block that was only added", () => {
    const b = "one\ntwo\nadded line\nanother added\nthree";
    const chunks = chunksOf("one\ntwo\nthree", b);
    expect(chunks.length).toBe(1);
    expect(wordChangeRanges(chunks, false, doc(b))).toEqual([]);
  });

  it("emphasises nothing in a block that was only removed", () => {
    const a = "one\ngone\nthree";
    const chunks = chunksOf(a, "one\nthree");
    expect(wordChangeRanges(chunks, true, doc(a))).toEqual([]);
    expect(wordChangeRanges(chunks, false, doc("one\nthree"))).toEqual([]);
  });

  it("emphasises the changed words of a modified line, on both sides", () => {
    const a = "import { mean } from './math';\nrest";
    const b = "import { mean, median } from './math';\nrest";
    const chunks = chunksOf(a, b);
    const added = wordChangeRanges(chunks, false, doc(b)).map(([f, t]) => b.slice(f, t));
    expect(wordChangeRanges(chunks, true, doc(a))).toEqual([]);
    expect(added.join("")).toContain("median");
    expect(added.join("")).not.toContain("import");
  });

  it("leaves wholly new lines plain inside a modified chunk", () => {
    const a = "import { mean } from './math';\nconsole.log(mean([1, 2, 3]));";
    const b = "import { mean, median } from './math';\nconst data = [3, 1, 4];\nconsole.log(mean(data));\nexport const VERSION = 2;";
    const marked = wordChangeRanges(chunksOf(a, b), false, doc(b)).map(([f, t]) => b.slice(f, t)).join("|");
    expect(marked).toContain("median");
    expect(marked).not.toContain("const data");
    expect(marked).not.toContain("VERSION");
  });
});
