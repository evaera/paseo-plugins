import { describe, expect, it } from "vitest";

import { CREW_LABELS } from "../shared/fleet";
import { UserSteers, relaunchText, relayText } from "./crew";

describe("UserSteers", () => {
  it("hands a steer over only to a turn that read it, once", () => {
    const steers = new UserSteers();
    steers.record("a1", "use pnpm");
    steers.record("a1", "and skip the e2e suite");
    // The turn that was running when the steer was sent ends first, without it.
    expect(steers.take("a1", ["fix the login"])).toBeNull();
    expect(steers.take("a1", ["fix the login", "use pnpm"])).toEqual(["use pnpm"]);
    expect(steers.take("a1", ["use pnpm", "and skip the e2e suite"])).toEqual(["and skip the e2e suite"]);
    expect(steers.take("a1", ["use pnpm", "and skip the e2e suite"])).toBeNull();
    expect(steers.take("a2", ["anything"])).toBeNull();
  });

  it("forgets a steer whose send failed, and one nobody answered within the hour", () => {
    let now = 0;
    const steers = new UserSteers(() => now);
    steers.record("a1", "never delivered");
    steers.forget("a1", "never delivered");
    expect(steers.take("a1", ["never delivered"])).toBeNull();

    steers.record("a1", "too old");
    now = 61 * 60 * 1000;
    expect(steers.take("a1", ["too old"])).toBeNull();
  });
});

describe("relayText", () => {
  it("wraps the exchange for Mission Control and clips a long answer", async () => {
    const text = await relayText({ id: "a1", title: "Fix login" }, ["use pnpm"], `{{title}} ${"x".repeat(5000)}`);
    expect(text.startsWith("<mission-control-board>")).toBe(true);
    expect(text).toContain("crewmate a1 (Fix login)");
    expect(text).toContain("<user-message>\nuse pnpm\n</user-message>");
    expect(text).toContain("[truncated; use get_agent_activity for the rest]");
    // What the crewmate said is passed on as it is, even where it looks like a placeholder.
    expect(text).toContain("<agent-response>\n{{title}} xxx");
    const silent = await relayText({ id: "a1", title: null }, ["hi"], null);
    expect(silent).toContain("(it ended the turn without a message)");
    expect(silent).toContain("crewmate a1 (a1)");
  });
});

describe("relaunchText", () => {
  it("names the task when the crewmate carries one, and its title when not", async () => {
    expect(
      await relaunchText({ id: "a1", title: "Fix", labels: { [CREW_LABELS.task]: "fix-login" } }, " tests pass now "),
    ).toBe(
      "Relaunch the worker fix-login (crewmate a1) in the same local copy, as step 4 of your stuck-crewmate ladder says.\n" +
        "The user's note for the new worker: tests pass now",
    );
    expect(await relaunchText({ id: "a1", title: "Fix", labels: {} }, "go")).toContain('the worker "Fix"');
  });
});
