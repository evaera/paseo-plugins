import { describe, expect, it } from "vitest";

import { parseBacklog } from "./backlog";
import { cleanTitle, renamedBacklog } from "./rename";

const BACKLOG = [
  "## In flight",
  "- [ ] fix-login - Fix login https://github.com/o/r/pull/42 (project: web) (agent: a1) (since 2026-10-20)",
  '- [ ] split - Split "A" https://github.com/o/r/pull/1 and "B" https://github.com/o/r/pull/2 (project: web)',
  "## Queued",
  "- [ ] dark-mode - Add dark mode",
  "- [ ] pick-db - Choose the database (kind: user) (hold: which?) (actions: Postgres => Use (Postgres) | SQLite => Use SQLite)",
].join("\n");

describe("renaming a task", () => {
  it("replaces only the title, keeping its links and every field", () => {
    const next = renamedBacklog(BACKLOG, "fix-login", "Fix the login flow");
    expect(next?.split("\n")[1]).toBe(
      "- [ ] fix-login - Fix the login flow https://github.com/o/r/pull/42 (project: web) (agent: a1) (since 2026-10-20)",
    );
    expect(next?.split("\n").filter((line, index) => index !== 1)).toEqual(BACKLOG.split("\n").filter((line, index) => index !== 1));
  });

  it("keeps the links that were among the title's words, after the new title", () => {
    const [, split] = parseBacklog(renamedBacklog(BACKLOG, "split", "Split the upsells") ?? "");
    expect(split).toMatchObject({ title: "Split the upsells", project: "web" });
    expect(split?.links).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
  });

  it("renames a line with no fields, and one whose actions hold parentheses", () => {
    expect(parseBacklog(renamedBacklog(BACKLOG, "dark-mode", "Dark mode everywhere") ?? "")[2]?.title).toBe("Dark mode everywhere");
    const [, , , pick] = parseBacklog(renamedBacklog(BACKLOG, "pick-db", "Pick a database") ?? "");
    expect(pick).toMatchObject({ title: "Pick a database", hold: "which?" });
    expect(pick?.actions).toHaveLength(2);
  });

  it("finds nothing to rename for a task the backlog does not have, and keeps a title to one line", () => {
    expect(renamedBacklog(BACKLOG, "nope", "x")).toBeNull();
    expect(cleanTitle("  Fix\n the   login ")).toBe("Fix the login");
  });
});
