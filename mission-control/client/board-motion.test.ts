import { beforeEach, describe, expect, it } from "vitest";

import type { ColumnId, FleetCard } from "../shared/fleet";
import { ARRIVAL_MS, CLOSING_MS, arrivalOf, noteCards, noteColumns, resetBoardMotion } from "./board-motion";

const card = (taskId: string, column: ColumnId, line = 0): FleetCard => ({
  key: `backlog:queued:${taskId}:${line}`,
  column,
  taskId,
  title: taskId,
  project: null,
  kind: null,
  backlog: null,
  agent: null,
  report: null,
  links: [],
});

describe("what moved on the board", () => {
  beforeEach(() => resetBoardMotion());

  it("moves nothing on the first look, then stamps a card that changed column, once", () => {
    noteCards([card("a", "queued")], 0);
    expect(arrivalOf(card("a", "queued"), 0)).toBeNull();
    noteCards([card("a", "working")], 100);
    expect(arrivalOf(card("a", "working"), 150)).toBe(100);
    noteCards([card("a", "working")], 200);
    expect(arrivalOf(card("a", "working"), 250)).toBe(100);
    expect(arrivalOf(card("a", "working"), 100 + ARRIVAL_MS)).toBeNull();
  });

  it("follows a card by its task, not its line, and stamps one that is new", () => {
    noteCards([card("a", "queued", 0)], 0);
    noteCards([card("b", "queued", 0), card("a", "queued", 1)], 100);
    expect(arrivalOf(card("a", "queued", 1), 120)).toBeNull();
    expect(arrivalOf(card("b", "queued", 0), 120)).toBe(100);
  });

  it("opens a column that was not drawn, and closes one that emptied for a moment", () => {
    noteColumns(["queued"], 0);
    expect(noteColumns(["queued", "working"], 100)).toEqual({ opening: new Set(["working"]), closing: [] });
    const emptied = noteColumns(["working"], 1000);
    expect(emptied.closing).toEqual(["queued"]);
    expect(noteColumns(["working"], 1000 + CLOSING_MS).closing).toEqual([]);
  });
});
