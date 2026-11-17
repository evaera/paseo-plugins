import { describe, expect, it } from "vitest";

import type { FleetCard } from "../shared/fleet";
import { actionRevision, queueCards } from "./action-order";

function card(key: string, column: FleetCard["column"], priority = 0, revision = "1") {
  return { key, column, backlog: { priority }, actionRevision: key + revision } as FleetCard;
}

describe("Action Queue order", () => {
  it("uses Mission Control priority, advances after a reply, and defers to the end", () => {
    const review = card("review", "review", 3);
    const decision = card("decision", "blocked");
    const working = card("working", "working", 10);
    const cards = [working, decision, review];

    expect(queueCards(cards, { deferred: [], answered: [] })).toEqual([review, decision]);
    expect(queueCards(cards, { deferred: [actionRevision(review)], answered: [] })).toEqual([decision, review]);
    expect(queueCards(cards, { deferred: [], answered: [actionRevision(review)] })).toEqual([decision]);

    const revised = card("review", "review", 3, "2");
    expect(queueCards([revised, decision], { deferred: [actionRevision(review)], answered: [actionRevision(review)] }))
      .toEqual([revised, decision]);
  });
});
