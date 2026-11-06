/**
 * A workspace id to the directory it works in, through Paseo.
 *
 * `workspaces.ref(id).refresh()` pages through the daemon's workspace list
 * to find one id, so the answer is cached briefly: the panel polls, and a
 * workspace's directory does not move under it.
 */
import type { PaseoApi } from "./host-types";

const TTL_MS = 10_000;

interface Cached {
  directory: string;
  name: string | null;
  at: number;
}

const cache = new Map<string, Cached>();

export interface WorkspaceInfo {
  directory: string;
  name: string | null;
}

export async function resolveWorkspace(paseo: PaseoApi, workspaceId: string): Promise<WorkspaceInfo> {
  const cached = cache.get(workspaceId);
  if (cached !== undefined && Date.now() - cached.at < TTL_MS) return cached;
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  const directory = workspace?.workspaceDirectory;
  if (workspace === null || directory === undefined || directory === "") {
    cache.delete(workspaceId);
    throw new Error(`Workspace ${workspaceId} is not active or has no directory.`);
  }
  const entry: Cached = { directory, name: workspace.title ?? workspace.name, at: Date.now() };
  cache.set(workspaceId, entry);
  return entry;
}

export function forgetWorkspace(workspaceId: string): void {
  cache.delete(workspaceId);
}
