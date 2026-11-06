/**
 * The open-request mailbox: another plugin (Mission Control) drops
 * `plugin-data/debrief/open-requests/<nonce>.json`, and the panel claims it.
 * Claiming reads and deletes every file; one that is not valid JSON or not
 * an `OpenRequest` is deleted too, so a bad drop cannot wedge the mailbox.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { OpenRequestSchema, type OpenRequest } from "../shared/rpc";
import { dataPath } from "./data-dir";

export async function claimOpenRequests(dir: string = dataPath("open-requests")): Promise<OpenRequest[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const claimed: Array<{ request: OpenRequest; name: string }> = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    // Deleted before parsing: a request is claimed once, by whoever read it first.
    await rm(path, { force: true });
    try {
      const parsed = OpenRequestSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success) claimed.push({ request: parsed.data, name });
      else console.error(`[debrief] ignored an invalid open request ${name}`);
    } catch {
      console.error(`[debrief] ignored an unreadable open request ${name}`);
    }
  }
  return claimed.map((entry) => entry.request);
}
