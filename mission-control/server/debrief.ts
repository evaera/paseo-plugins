/**
 * Mission Control's side of the Debrief plugin, which reviews a workspace's diff and story. Debrief
 * keeps its files in `$PASEO_HOME/plugin-data/debrief/`; this module only reads its reviews, for a
 * card's badge, and writes the one thing Debrief asks of it: a request to open its tab on a workspace
 * (`open-requests/<nonce>.json`, staged and renamed so Debrief never reads half of one). A worker on
 * another host has its diff size read through that host's Paseo, and the app opens that host's Debrief
 * directly (`client/debrief-bridge.ts`); its badges are Debrief's files there, out of reach.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DebriefInfo, DebriefView } from "../shared/fleet";
import { paseoHome } from "./data-dir";
import type { PaseoApi } from "./host-types";

const WORKSPACE_ID = /^[\w-]{1,128}$/;

function debriefDir(): string {
  return join(paseoHome(), "plugin-data", "debrief");
}

/** Whether Debrief has ever run on this Mac; without it, there is nothing for the buttons to open. */
export async function debriefInstalled(): Promise<boolean> {
  try {
    return (await stat(debriefDir())).isDirectory();
  } catch {
    return false;
  }
}

/** Open comments in Debrief's review of a workspace, and whether it has a story; nothing when it has neither. */
async function reviewState(workspaceId: string): Promise<{ openComments: number; story: boolean }> {
  const base = join(debriefDir(), "reviews", workspaceId);
  let openComments = 0;
  try {
    const review = JSON.parse(await readFile(join(base, "review.json"), "utf8")) as { comments?: unknown };
    if (Array.isArray(review.comments)) {
      openComments = review.comments.filter(
        (comment) => typeof comment === "object" && comment !== null && (comment as { resolved?: unknown }).resolved !== true,
      ).length;
    }
  } catch {
    // No review yet, or one Debrief is writing: no badge this poll.
  }
  const story = await stat(join(base, "story.json")).then(
    () => true,
    () => false,
  );
  return { openComments, story };
}

/** A workspace's diff size as last read, by host and workspace, kept while its worker has not moved. */
const diffs = new Map<string, { stamp: string; at: number; diff: { additions: number; deletions: number } | null }>();
/** How long a reading stands even when nothing about the worker has changed: edits by hand do not move it. */
const DIFF_TTL_MS = 60_000;

/**
 * What a worker's workspace has changed, or null when nothing has (or Paseo would not say). `paseo` is
 * the worker's own host; `serverId` is null for this Mac, whose Debrief files give the badges. `stamp`
 * is the worker's `updatedAt`, so a quiet worker's workspace is asked about once a minute, not every poll.
 */
export async function debriefInfo(
  paseo: PaseoApi,
  workspaceId: string,
  serverId: string | null = null,
  stamp = "",
): Promise<DebriefInfo | null> {
  if (!WORKSPACE_ID.test(workspaceId)) return null;
  const key = `${serverId ?? ""}/${workspaceId}`;
  const known = diffs.get(key);
  let diff = known !== undefined && known.stamp === stamp && Date.now() - known.at < DIFF_TTL_MS ? known.diff : undefined;
  if (diff === undefined) {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    diff = workspace?.diffStat ?? null;
    diffs.set(key, { stamp, at: Date.now(), diff });
  }
  if (diff === null || diff.additions + diff.deletions === 0) return null;
  const badges = serverId === null ? await reviewState(workspaceId) : { openComments: 0, story: false };
  return { workspaceId, serverId, additions: diff.additions, deletions: diff.deletions, ...badges };
}

/** Leaves Debrief a request to open its tab on `workspaceId`, in `view`. */
export async function requestDebriefOpen(input: {
  workspaceId: string;
  agentId?: string | undefined;
  view: DebriefView;
  path?: string | undefined;
}): Promise<void> {
  if (!WORKSPACE_ID.test(input.workspaceId)) throw new Error(`"${input.workspaceId}" is not a workspace id.`);
  const dir = join(debriefDir(), "open-requests");
  await mkdir(dir, { recursive: true });
  const nonce = randomUUID();
  const staged = join(dir, `.${nonce}.tmp`);
  const request = {
    workspaceId: input.workspaceId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    view: input.view,
    ...(input.path === undefined ? {} : { path: input.path }),
    createdAt: new Date().toISOString(),
  };
  await writeFile(staged, `${JSON.stringify(request)}\n`, "utf8");
  await rename(staged, join(dir, `${nonce}.json`));
}
