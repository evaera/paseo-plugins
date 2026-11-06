/**
 * Forgetting archived workspaces. `workspace.archived` records when each was
 * archived in `plugin-data/debrief/archived.json`; at start, the reviews and
 * plans of a workspace archived more than `RETENTION_MS` ago are deleted. A
 * workspace that shows up in use again (a review loaded) is taken off the
 * list, so unarchiving it keeps its review.
 */
import { rm } from "node:fs/promises";

import { z } from "zod";

import { dataPath } from "./data-dir";
import { plansRoot } from "./plans";
import { serialized } from "./serialize";
import { readJson, reviewDir, writeAtomic } from "./store";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ArchivedSchema = z.record(z.string(), z.string());
type Archived = z.infer<typeof ArchivedSchema>;

function archivedPath(): string {
  return dataPath("archived.json");
}

async function readArchived(): Promise<Archived> {
  const parsed = ArchivedSchema.safeParse(await readJson(archivedPath()).catch(() => undefined));
  return parsed.success ? parsed.data : {};
}

function change<T>(edit: (archived: Archived) => T): Promise<T> {
  return serialized("archived", async () => {
    const archived = await readArchived();
    const before = JSON.stringify(archived);
    const result = edit(archived);
    if (JSON.stringify(archived) !== before) await writeAtomic(archivedPath(), `${JSON.stringify(archived, null, 2)}\n`);
    return result;
  });
}

/** Workspaces known to be on the list, so `markActive` costs nothing for the rest. */
let known: Set<string> | null = null;

export function markArchived(workspaceId: string, archivedAt: string | null): Promise<void> {
  known?.add(workspaceId);
  return change((archived) => {
    archived[workspaceId] = archivedAt ?? new Date().toISOString();
  });
}

export async function markActive(workspaceId: string): Promise<void> {
  if (known === null) known = new Set(Object.keys(await readArchived()));
  if (!known.has(workspaceId)) return;
  known.delete(workspaceId);
  await change((archived) => {
    delete archived[workspaceId];
  });
}

/** Deletes what belongs to workspaces archived before `now - RETENTION_MS`. Returns their ids. */
export async function pruneArchived(now = Date.now()): Promise<string[]> {
  const archived = await readArchived();
  const expired = Object.entries(archived)
    .filter(([, at]) => {
      const time = Date.parse(at);
      return Number.isFinite(time) && now - time > RETENTION_MS;
    })
    .map(([workspaceId]) => workspaceId);
  const pruned: string[] = [];
  for (const workspaceId of expired) {
    try {
      await rm(reviewDir(workspaceId), { recursive: true, force: true });
      await rm(plansRoot(workspaceId), { recursive: true, force: true });
      pruned.push(workspaceId);
    } catch (error) {
      console.error(`[debrief] could not prune archived workspace ${workspaceId}:`, error);
    }
  }
  if (pruned.length > 0) {
    await change((current) => {
      for (const workspaceId of pruned) delete current[workspaceId];
    });
  }
  known = new Set(Object.keys(await readArchived()));
  return pruned;
}
