import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MissionControlConfigSchema } from "../shared/fleet";
import {
  CHARTER_FILE,
  NEW_CHARTER_FILE,
  acknowledgeCharter,
  fingerprint,
  readCharterState,
  syncCharter,
  writeNewCharter,
  type PluginCharter,
} from "./charter-file";
import { prepareHome } from "./home";
import { TEMPLATES, fill, readTemplate } from "./templates";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "fm-home-"));
  tempDirs.push(home);
  await mkdir(join(home, "prompts"), { recursive: true });
  return home;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const read = (home: string, file: string) => readFile(join(home, file), "utf8");

/** Replaces what the copy says, keeping its note — an edit made in the panel. */
async function editCopy(home: string, words: string): Promise<void> {
  const copy = await read(home, CHARTER_FILE);
  const noteEnd = copy.indexOf("-->") + 3;
  await writeFile(join(home, CHARTER_FILE), `${copy.slice(0, noteEnd)}\n\n${words}\n`, "utf8");
}

// Two versions of the plugin's charter templates, as two releases would ship them.
const BODY1 = "# Mission Control\n\nVersion one. Home: {{home}}.";
const BODY2 = "# Mission Control\n\nVersion two. Home: {{home}}.";
const NEW = "<!-- for comparing -->\n\n{{charter}}\n";
const V1: PluginCharter = { charter: `<!-- mission-control-charter {{fingerprint}} -->\n\n${BODY1}\n`, charterNew: NEW };
const V2: PluginCharter = { charter: `<!-- mission-control-charter {{fingerprint}} -->\n\n${BODY2}\n`, charterNew: NEW };

describe("syncCharter", () => {
  it("writes the plugin's charter under a note with its fingerprint", async () => {
    const home = await tempHome();
    const state = await syncCharter(home, V1);
    expect(state).toEqual({ template: BODY1, edited: false, outdated: false });
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toBe(fill(V1.charter, { fingerprint: fingerprint(V1.charter) }));
    expect(fingerprint(V1.charter)).toBe(fingerprint(BODY1));
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
  });

  it("follows the plugin while the user has not edited it", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    const state = await syncCharter(home, V2);
    expect(state).toEqual({ template: BODY2, edited: false, outdated: false });
    expect(await read(home, CHARTER_FILE)).toContain("Version two.");
  });

  it("keeps an edited copy, and puts a changed plugin charter beside it until the user is done", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "# My Mission Control\n\nHome: {{home}}. Speak like a pirate.");

    // The same plugin charter: the edit is simply the user's.
    expect(await syncCharter(home, V1)).toMatchObject({ edited: true, outdated: false });
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);

    // A new plugin charter: the edit is kept and used, and the new one is offered for comparison.
    const state = await syncCharter(home, V2);
    expect(state).toEqual({ template: "# My Mission Control\n\nHome: {{home}}. Speak like a pirate.", edited: true, outdated: true });
    expect(await read(home, CHARTER_FILE)).toContain("Speak like a pirate.");
    expect(await read(home, NEW_CHARTER_FILE)).toContain("Version two.");
    expect((await readCharterState(home, V2)).outdated).toBe(true);

    await acknowledgeCharter(home, V2);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
    expect(await read(home, CHARTER_FILE)).toContain("Speak like a pirate.");
    expect(await readCharterState(home, V2)).toMatchObject({ edited: true, outdated: false });
    expect(await syncCharter(home, V2)).toMatchObject({ edited: true, outdated: false });
  });

  it("goes back to the plugin's charter when the copy is emptied or deleted", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    await editCopy(home, "Mine.");
    await writeFile(join(home, CHARTER_FILE), "<!-- nothing but a note -->\n", "utf8");
    expect(await syncCharter(home, V2)).toEqual({ template: BODY2, edited: false, outdated: false });
    expect(await read(home, CHARTER_FILE)).toContain(`mission-control-charter ${fingerprint(V2.charter)}`);

    await rm(join(home, CHARTER_FILE));
    expect(await syncCharter(home, V2)).toMatchObject({ edited: false });
    expect(await exists(join(home, CHARTER_FILE))).toBe(true);
  });

  it("treats a copy without its note as edited from nothing, and Done gives the note back", async () => {
    const home = await tempHome();
    await writeFile(join(home, CHARTER_FILE), "# Written from scratch\n", "utf8");
    expect(await syncCharter(home, V1)).toMatchObject({ edited: true, outdated: true });

    await acknowledgeCharter(home, V1);
    const copy = await read(home, CHARTER_FILE);
    expect(copy).toContain(`mission-control-charter ${fingerprint(V1.charter)}`);
    expect(copy).toContain("# Written from scratch");
    expect(await readCharterState(home, V1)).toMatchObject({ edited: true, outdated: false });
  });

  it("writes the comparison on request only when there is something to compare", async () => {
    const home = await tempHome();
    await syncCharter(home, V1);
    expect(await writeNewCharter(home, V1)).toBe(false);
    expect(await exists(join(home, NEW_CHARTER_FILE))).toBe(false);
    await editCopy(home, "Mine.");
    expect(await writeNewCharter(home, V2)).toBe(true);
    expect(await read(home, NEW_CHARTER_FILE)).toContain("Version two.");
  });
});

describe("prepareHome and the charter", () => {
  it("renders AGENTS.md from the user's copy, placeholders filled and notes left out", async () => {
    const home = await tempHome();
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    const agents = await read(home, "AGENTS.md");
    expect(agents).toMatch(/^<!-- Written by the Paseo Mission Control plugin from prompts\/charter\.md/);
    expect(agents).toContain(`Your home is \`${home}\``);
    expect(agents).not.toContain("mission-control-charter");
    expect(fingerprint(await read(home, CHARTER_FILE))).toBe(fingerprint(await readTemplate(TEMPLATES.charter)));
    // Pinned so a charter change is deliberate: every untouched home follows it, and every edited one is
    // offered it as charter.new.md. e0b749cb695c5df6 was the charter as it moved into templates/.
    expect(fingerprint(await readTemplate(TEMPLATES.charter))).toBe("a7e0ad6ee2c06924");

    await editCopy(home, "# My Mission Control\n\n<!-- a note to myself -->\nYour home is {{home}}; keep it tidy.");
    await prepareHome(home, MissionControlConfigSchema.parse({}));
    const edited = await read(home, "AGENTS.md");
    expect(edited).toContain(`Your home is ${home}; keep it tidy.`);
    expect(edited).not.toContain("a note to myself");
    expect(edited).not.toContain("## 1. Hard rules");
  });
});
