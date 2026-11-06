import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { orderSections, writeBoardOrder } from "./board-order";

const columns = [
  {
    title: "Queued",
    cards: [
      { taskId: "dark-mode", title: "Add dark mode", agentId: null, host: null },
      { taskId: "fix-login", title: "Fix login", agentId: null, host: null },
    ],
  },
  { title: "Working", cards: [{ taskId: null, title: "Stray", agentId: "a1", host: "eryn" }] },
  { title: "Idle", cards: [] },
];

describe("the board order Mission Control reads", () => {
  it("lists each arranged column, top first, by task id or the worker's title", () => {
    expect(orderSections(columns)).toBe(
      '## Queued\n\n1. dark-mode - Add dark mode\n2. fix-login - Fix login\n\n## Working\n\n1. "Stray" (agent: a1, host: eryn)',
    );
  });

  it("writes state/board-order.md in the home with its note", async () => {
    const home = await mkdtemp(join(tmpdir(), "mission-control-order-"));
    await writeBoardOrder(home, columns);
    const text = await readFile(join(home, "state", "board-order.md"), "utf8");
    expect(text).toMatch(/^<!--/);
    expect(text).toContain("# The user's order");
    expect(text).toContain("1. dark-mode - Add dark mode");
    // Once, under the heading: the note used to name the placeholder, and was filled in too.
    expect(text.split("1. dark-mode - Add dark mode")).toHaveLength(2);
    expect(text.endsWith("Stray\" (agent: a1, host: eryn)\n")).toBe(true);
  });
});
