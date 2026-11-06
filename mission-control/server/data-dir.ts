/**
 * Where this plugin keeps its own files: `$PASEO_HOME/plugin-data/mission-control/`. Not under
 * `$PASEO_HOME/plugins/<id>/`, which is where Paseo installs an npm or Git plugin and which
 * `paseo plugin remove` deletes whole; Paseo never touches `plugin-data/`.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "mission-control";

export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

export function pluginDir(): string {
  return join(paseoHome(), "plugin-data", PLUGIN_ID);
}
