/**
 * Where Debrief keeps its own files: `$PASEO_HOME/plugin-data/debrief/`.
 *
 * Never `$PASEO_HOME/plugins/<id>/`, which is Paseo's install root for an npm
 * or Git plugin and is deleted whole by `paseo plugin remove`. Debrief is new,
 * so unlike the other plugins here it has no legacy directory to migrate from.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "debrief";

export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function pluginDir(): string {
  return join(paseoHome(), "plugin-data", PLUGIN_ID);
}

export function dataPath(...segments: string[]): string {
  return join(pluginDir(), ...segments);
}
