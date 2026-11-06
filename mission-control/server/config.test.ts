import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultHome, readMissionControlConfig, resolveHome, updateMissionControlConfig } from "./config";
import { pluginDir } from "./data-dir";
import { MissionControlConfigSchema, writeConfig } from "../shared/fleet";

let paseoHome = "";
const previousHome = process.env.PASEO_HOME;

beforeEach(async () => {
  paseoHome = await mkdtemp(join(tmpdir(), "mission-control-config-"));
  process.env.PASEO_HOME = paseoHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(paseoHome, { recursive: true, force: true });
});

describe("the config.write contract", () => {
  it("carries only the fields a save names, so the rest keep their saved values", async () => {
    expect(writeConfig.input.parse({ crewProvider: "codex/gpt-5.5" })).toEqual({ crewProvider: "codex/gpt-5.5" });
    // Every field of the config can be written, and nothing else.
    expect(Object.keys(writeConfig.input.shape).sort()).toEqual(Object.keys(MissionControlConfigSchema.shape).sort());

    await updateMissionControlConfig({ coordinatorAgentId: "coordinator-1", disabledWatches: ["pr-watch"] });
    const saved = await updateMissionControlConfig(writeConfig.input.parse({ crewProvider: "codex/gpt-5.5" }));
    expect(saved).toMatchObject({ coordinatorAgentId: "coordinator-1", disabledWatches: ["pr-watch"], crewProvider: "codex/gpt-5.5" });
  });
});

describe("updateMissionControlConfig", () => {
  it("keeps every field when updates overlap, and leaves no temporary file behind", async () => {
    // A launch recording its Mission Control while a settings save lands.
    await Promise.all([
      updateMissionControlConfig({ coordinatorAgentId: "coordinator" }),
      updateMissionControlConfig({ coordinatorProvider: "claude/claude-sonnet-5" }),
      updateMissionControlConfig({ coordinatorModeId: "plan" }),
    ]);
    expect(await readMissionControlConfig()).toMatchObject({
      coordinatorAgentId: "coordinator",
      coordinatorProvider: "claude/claude-sonnet-5",
      coordinatorModeId: "plan",
    });
    expect(await readdir(pluginDir())).toEqual(["config.json"]);
  });

  it("still applies an update queued behind one that failed", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "coordinator" });
    const results = await Promise.allSettled([
      updateMissionControlConfig({ home: "/somewhere/else" }),
      updateMissionControlConfig({ coordinatorProvider: "codex/gpt-5" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await readMissionControlConfig()).toMatchObject({ coordinatorAgentId: "coordinator", coordinatorProvider: "codex/gpt-5" });
  });
});

describe("Mission Control's home", () => {
  it("defaults to plugin-data", async () => {
    expect(defaultHome()).toBe(join(paseoHome, "plugin-data", "mission-control", "home"));
    expect(resolveHome(await readMissionControlConfig())).toBe(join(pluginDir(), "home"));
    expect(resolveHome(MissionControlConfigSchema.parse({ home: "/Users/user/mission-control" }))).toBe("/Users/user/mission-control");
  });
});
