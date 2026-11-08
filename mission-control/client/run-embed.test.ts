import { describe, expect, it } from "vitest";

import { parseMarkdown, parseRunEmbed } from "./markdown-parse";
import { tintCommand } from "./run-tint";

describe("a run embed", () => {
  it("is a line of its own, with a project or without one", () => {
    expect(parseMarkdown("[[run: fleetbound :: godot --path . res://scenes/dock.tscn]]")).toEqual([
      { kind: "run", project: "fleetbound", command: "godot --path . res://scenes/dock.tscn" },
    ]);
    expect(parseMarkdown("  [[run: npm test]]  ")).toEqual([{ kind: "run", project: null, command: "npm test" }]);
    expect(parseMarkdown("[[RUN:ls -la]]")).toEqual([{ kind: "run", project: null, command: "ls -la" }]);
  });

  it("takes a project name with spaces, and an empty one for the home", () => {
    expect(parseRunEmbed(" Mission Control :: ls")).toEqual({ project: "Mission Control", command: "ls" });
    expect(parseRunEmbed(" :: echo a :: b")).toEqual({ project: null, command: "echo a :: b" });
  });

  it("splits at the first spaced `::` only, and never at one inside a word", () => {
    expect(parseRunEmbed(" app :: echo a :: b")).toEqual({ project: "app", command: "echo a :: b" });
    expect(parseRunEmbed(" [IO.Path]::Combine('a', 'b')")).toEqual({ project: null, command: "[IO.Path]::Combine('a', 'b')" });
    expect(parseRunEmbed(" C:\\tools\\x.exe")).toEqual({ project: null, command: "C:\\tools\\x.exe" });
  });

  it("keeps the command's brackets, quotes and spacing exactly", () => {
    expect(parseMarkdown(`[[run: p :: echo "[[a]]"  'b']]`)).toEqual([{ kind: "run", project: "p", command: `echo "[[a]]"  'b'` }]);
  });

  it("is not a run embed without a command, or past the length cap", () => {
    expect(parseMarkdown("[[run:]]")[0]?.kind).toBe("paragraph");
    expect(parseMarkdown("[[run: app :: ]]")[0]?.kind).toBe("paragraph");
    expect(parseRunEmbed(` ${"x".repeat(2001)}`)).toBeNull();
  });

  it("is text inside a paragraph, a list item, a quote or a code block", () => {
    expect(parseMarkdown("Try [[run: ls]] now.")[0]?.kind).toBe("paragraph");
    expect(parseMarkdown("- [[run: ls]]")).toEqual([{ kind: "list", items: [{ marker: "•", depth: 0, text: "[[run: ls]]" }] }]);
    expect(parseMarkdown("- step one\n  [[run: ls]]")).toEqual([{ kind: "list", items: [{ marker: "•", depth: 0, text: "step one\n[[run: ls]]" }] }]);
    expect(parseMarkdown("> [[run: rm -rf ~]]")).toEqual([{ kind: "quote", blocks: [{ kind: "paragraph", text: "[[run: rm -rf ~]]" }] }]);
    expect(parseMarkdown("```\n[[run: ls]]\n```")).toEqual([{ kind: "code", text: "[[run: ls]]" }]);
    expect(parseMarkdown("    [[run: ls]]")[0]?.kind).toBe("paragraph");
  });

  it("ends the paragraph above it", () => {
    expect(parseMarkdown("Play the dock:\n[[run: godot dock.tscn]]").map((block) => block.kind)).toEqual(["paragraph", "run"]);
  });
});

describe("a run embed's tint", () => {
  it("gives back the command exactly", () => {
    const command = `FOO=1 godot --path "my game" res://a.tscn && echo 'done' | tee log.txt > out`;
    expect(
      tintCommand(command)
        .map((piece) => piece.text)
        .join(""),
    ).toBe(command);
  });

  it("marks the program after each operator, flags, strings and assignments", () => {
    const kinds = tintCommand(`FOO=1 godot --path "x y" && npm test > out`)
      .filter((piece) => piece.kind !== "space")
      .map((piece) => `${piece.kind}:${piece.text}`);
    expect(kinds).toEqual([
      "assignment:FOO=1",
      "program:godot",
      "flag:--path",
      'string:"x y"',
      "operator:&&",
      "program:npm",
      "plain:test",
      "operator:>",
      "plain:out",
    ]);
  });
});
