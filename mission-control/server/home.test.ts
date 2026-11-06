import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CREW_LABELS, MissionControlConfigSchema } from "../shared/fleet";
import { parseBacklog } from "./backlog";
import { renderCharter } from "./charter";
import { isHomeReady, parseProjects, prepareHome, readBacklog } from "./home";
import { TEMPLATES, readTemplate, withoutNotes } from "./templates";

const HOME_ICON_FILE = TEMPLATES.icon;
const defaultOpening = async () => withoutNotes(await readTemplate(TEMPLATES.opening));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mission-control-home-"));
  tempDirs.push(dir);
  return dir;
}

describe("prepareHome", () => {
  it("writes the charter and every record, and a relaunch rewrites only the charter", async () => {
    const home = await tempHome();
    expect(await isHomeReady(home)).toBe(false);

    await prepareHome(home, MissionControlConfigSchema.parse({}));
    expect(await isHomeReady(home)).toBe(true);
    expect(await readBacklog(home)).toEqual([]);

    await writeFile(join(home, "prompts", "user.md"), "- Always use pnpm.\n", "utf8");
    await writeFile(join(home, "AGENTS.md"), "stale", "utf8");
    await prepareHome(home, MissionControlConfigSchema.parse({ crewProvider: "codex/gpt-5.5" }));

    expect(await readFile(join(home, "prompts", "user.md"), "utf8")).toBe("- Always use pnpm.\n");
    const charter = await readFile(join(home, "AGENTS.md"), "utf8");
    expect(charter).toContain("`codex/gpt-5.5`");
    expect(charter).toContain(home);
  });

  it("puts an icon where Paseo looks for one, and keeps one the user replaced it with", async () => {
    const home = await tempHome();
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    const icon = await readFile(join(home, HOME_ICON_FILE), "utf8");
    // What Paseo takes from a project's folder: 32 KB at most, square — an SVG is taken as square.
    expect(Buffer.byteLength(icon)).toBeLessThan(32 * 1024);
    expect(icon).toContain('viewBox="0 0 128 128"');

    await writeFile(join(home, HOME_ICON_FILE), "<svg/>", "utf8");
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    expect(await readFile(join(home, HOME_ICON_FILE), "utf8")).toBe("<svg/>");
  });
});

describe("prompts/wake.md", () => {
  it("writes prompts/wake.md once, in the daemon's time zone", async () => {
    const home = await tempHome();
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    const wake = join(home, TEMPLATES.wake);
    const written = await readFile(wake, "utf8");
    expect(written).toContain("schedule: */15 9-17 * * 1-5");
    expect(written).toContain(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`);
    expect(written).not.toMatch(/\{\{[a-zA-Z]+\}\}/);

    await writeFile(wake, "schedule: off\n", "utf8");
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    expect(await readFile(wake, "utf8")).toBe("schedule: off\n");
  });
});

describe("renderCharter", () => {
  it("fills every placeholder and names the labels the board reads", async () => {
    for (const crewProvider of ["", "claude/sonnet"]) {
      const charter = await renderCharter({ home: "/h", crewProvider, crewModeId: crewProvider === "" ? "" : "acceptEdits" });
      expect(charter).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
      for (const key of [CREW_LABELS.role, CREW_LABELS.task, CREW_LABELS.kind, CREW_LABELS.project]) {
        expect(charter).toContain(key);
      }
      expect(charter).toContain(`"${CREW_LABELS.role}": "${CREW_LABELS.crewRole}"`);
      // It is told where the user's world lives, and how to look the crew up past list_agents' window.
      expect(charter).toContain("paseo project ls --json");
      expect(charter).toContain(`paseo ls -g --label ${CREW_LABELS.role}=${CREW_LABELS.crewRole} --json`);
    }
  });

  it("gives every hold the user's likely answers as actions, and its examples parse", async () => {
    const charter = await renderCharter({ home: "/h", crewProvider: "", crewModeId: "" });
    const rule = charter.indexOf("**Every `(hold: …)` carries `(actions: …)`**");
    expect(rule).toBeGreaterThan(-1);
    const text = charter.slice(rule, charter.indexOf("**Suggestions**", rule));
    for (const words of [
      "stands alone",
      "full `https://` URLs",
      "Most likely first, about four at most",
      "rewrite them when the next steps change",
      "drop them when the hold comes off",
    ]) {
      expect(text).toContain(words);
    }
    // The escapes it teaches are the parser's.
    expect(text).toContain("`\\|` for a pipe");
    expect(text).toContain("`\\(` or `\\)` for a lone parenthesis");
    // What the Answer box sends (`answerText` in client/card-answer.ts), as the charter quotes it.
    expect(text).toContain("`<id> — <title>: <their words>`");

    const examples = /```\n([\s\S]*?)```/.exec(text)?.[1]?.trim().split("\n") ?? [];
    expect(examples).toHaveLength(2);
    const items = parseBacklog(`## Queued\n${examples.map((line, index) => `- [ ] t${index} - Title ${line}`).join("\n")}`);
    expect(items.map((item) => item.actions.map((action) => action.label))).toEqual([
      ["Merge", "Hold"],
      ["Postgres", "SQLite"],
    ]);
    expect(items[0]?.actions[0]?.prompt).toBe("Merge https://github.com/you/web/pull/42");
    expect(items[1]?.actions[0]?.prompt).toBe("Use Postgres for the web project's database (pick-db)");
    expect(items.map((item) => [item.title, item.url])).toEqual([
      ["Title", null],
      ["Title", null],
    ]);
  });

  it("puts (actions: …) beside the hold in the backlog line format", async () => {
    const charter = await renderCharter({ home: "/h", crewProvider: "", crewModeId: "" });
    expect(charter).toContain("(hold: <what you need>) (actions: <label> => <prompt> | …)");
    expect(charter).toContain("(kind: user) (hold: <the options, in a few words>) (actions: <label> => <prompt> | …)");
  });
});

describe("parseProjects", () => {
  it("reads the registry lines and skips the prose around them", () => {
    const projects = parseProjects(`# Projects

One line per project: \`- <name> [<mode> +yolo] - <path or clone URL> - <description>\`.

- web [direct-PR +yolo] - /Users/me/code/web - The storefront
- api [local-only] - /Users/me/code/api
- docs - https://github.com/me/docs - Written by hand
- site - ~/src/site - see [the docs](https://x) [WIP]
- One line of prose that is not a project.
`);
    expect(projects).toEqual([
      { name: "web", mode: "direct-PR", yolo: true, location: "/Users/me/code/web", description: "The storefront" },
      { name: "api", mode: "local-only", yolo: false, location: "/Users/me/code/api", description: null },
      { name: "docs", mode: null, yolo: false, location: "https://github.com/me/docs", description: "Written by hand" },
      { name: "site", mode: null, yolo: false, location: "~/src/site", description: "see [the docs](https://x) [WIP]" },
    ]);
  });
});

describe("the crew's fast mode in the charter", () => {
  it("tells Mission Control to turn fast_mode on only when the settings say so", async () => {
    const on = await renderCharter({ home: "/h", crewProvider: "claude/opus", crewModeId: "", crewFast: true });
    const off = await renderCharter({ home: "/h", crewProvider: "claude/opus", crewModeId: "" });
    expect(on).toContain('`{"fast_mode": true}`');
    expect(off).not.toContain('`{"fast_mode": true}`');
    expect(off).toContain("leave `fast_mode` out");
    expect(on).not.toContain("{{crewFastRule}}");
  });
});
