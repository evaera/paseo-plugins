/**
 * The daemon's own file: `$PASEO_HOME/plugin-data/mission-control/config.json`. It
 * holds what handlers act on — where the home is, which agent is Mission
 * Control, and the models the charter names — and nothing the board only draws.
 *
 * Read on every call rather than cached: a save from the settings screen has
 * to take effect on the next one, and the file is a few hundred bytes.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { MissionControlConfigSchema, type MissionControlConfig } from "../shared/fleet";
import { pluginDir } from "./data-dir";
import { serialized } from "./serialize";

function configPath(): string {
  return join(pluginDir(), "config.json");
}

/** The home when the config names none: `plugin-data/mission-control/home`. */
export function defaultHome(): string {
  return join(pluginDir(), "home");
}

/** The home the config names, with `~` expanded; `defaultHome()` when it names none. */
export function resolveHome(config: MissionControlConfig): string {
  const configured = config.home.trim();
  if (configured === "") return defaultHome();
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  if (!isAbsolute(configured)) {
    throw new Error(`Mission Control's home must be an absolute path, not "${configured}".`);
  }
  return resolve(configured);
}

function parseConfig(raw: string): MissionControlConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    console.error(`[mission-control] ${configPath()} is not JSON, using defaults:`, error);
    return MissionControlConfigSchema.parse({});
  }
  const parsed = MissionControlConfigSchema.safeParse(json);
  if (!parsed.success) {
    console.error(`[mission-control] ${configPath()} is invalid, using defaults: ${parsed.error.message}`);
    return MissionControlConfigSchema.parse({});
  }
  return parsed.data;
}

/**
 * A missing file is the normal first run and yields the defaults. A file that
 * does not parse is reported and *also* yields the defaults, rather than
 * leaving the board unable to load at all.
 */
export async function readMissionControlConfig(): Promise<MissionControlConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return MissionControlConfigSchema.parse({});
    throw error;
  }
  return parseConfig(raw);
}

export type MissionControlConfigPatch = { [Key in keyof MissionControlConfig]?: MissionControlConfig[Key] | undefined };

/**
 * Merges `patch` into the saved config — a field left `undefined` keeps its
 * saved value — and writes it to a temporary file that is then renamed, so a
 * crash never leaves half a file. Updates run one at a time, so a settings
 * save landing during a launch cannot write back a config without the launch's
 * `coordinatorAgentId`.
 */
export function updateMissionControlConfig(patch: MissionControlConfigPatch): Promise<MissionControlConfig> {
  return serialized(configPath(), () => applyConfigPatch(patch));
}

async function applyConfigPatch(patch: MissionControlConfigPatch): Promise<MissionControlConfig> {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const previous = await readMissionControlConfig();
  const next = MissionControlConfigSchema.parse({ ...previous, ...defined });
  // Validated before it is saved, so a relative home is refused rather than stored.
  const home = resolveHome(next);
  // The board reads the home the config names, and a running Mission Control keeps
  // writing the one it was launched in; moving it under one would show an
  // empty backlog while the real one carried on out of sight.
  if (next.coordinatorAgentId !== "" && home !== resolveHome(previous)) {
    throw new Error("Release Mission Control before moving its home; it keeps working in the one it was launched in.");
  }
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return next;
}
