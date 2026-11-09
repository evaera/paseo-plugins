import { describe, expect, it } from "vitest";

import type { BacklogItem, FleetCard } from "../shared/fleet";
import { cardDecision } from "./card-answer";

const item: BacklogItem = {
  section: "in-flight",
  id: "sky",
  title: "Sky polish",
  project: null,
  kind: null,
  mode: null,
  agentId: null,
  host: null,
  hold: null,
  waiting: null,
  actions: [],
  blockedBy: null,
  since: null,
  url: null,
  links: [],
  reportPath: null,
  outcome: null,
};

function card(backlog: Partial<BacklogItem> | null): FleetCard {
  const line = backlog === null ? null : { ...item, ...backlog };
  return { key: "k", column: "blocked", taskId: line?.id ?? null, title: "Sky polish", project: null, kind: null, backlog: line, agent: null, report: null, links: [] };
}

const looksGood = { label: "Looks good", prompt: "sky: looks good, land it" };

describe("what a phone's card view puts above the transcript", () => {
  it("is the hold and its buttons", () => {
    expect(cardDecision(card({ hold: "review the stars", actions: [looksGood] }), true)).toEqual({
      hold: "review the stars",
      actions: [looksGood],
    });
  });

  it("keeps the hold but draws no buttons with no Mission Control to send them to", () => {
    expect(cardDecision(card({ hold: "review the stars", actions: [looksGood] }), false)).toEqual({ hold: "review the stars", actions: [] });
  });

  it("draws buttons Mission Control wrote on a card that is not held", () => {
    expect(cardDecision(card({ actions: [looksGood] }), true)).toEqual({ hold: null, actions: [looksGood] });
  });

  it("is nothing for a card that asks nothing, a blank hold included", () => {
    expect(cardDecision(card({}), true)).toBeNull();
    expect(cardDecision(card({ hold: "  " }), true)).toBeNull();
    expect(cardDecision(card(null), true)).toBeNull();
    expect(cardDecision(card({ actions: [looksGood] }), false)).toBeNull();
  });
});
