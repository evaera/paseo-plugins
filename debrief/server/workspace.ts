/**
 * A workspace id to the directory it works in, through Paseo.
 *
 * `workspaces.ref(id).refresh()` pages through the daemon's workspace list
 * to find one id. Share one paginated snapshot across all panels and callers,
 * including while a slow read is in flight. A workspace's directory does not move.
 */
import type { PaseoApi } from "./host-types";
import { ReadCache } from "./read-cache";

const TTL_MS = 10_000;

type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
let snapshots = new WeakMap<PaseoApi, ReadCache<Map<string, Workspace>>>();

export interface WorkspaceInfo {
  directory: string;
  name: string | null;
}

export async function resolveWorkspace(paseo: PaseoApi, workspaceId: string): Promise<WorkspaceInfo> {
  let cache = snapshots.get(paseo);
  if (cache === undefined) {
    cache = new ReadCache(TTL_MS);
    snapshots.set(paseo, cache);
  }
  const workspaces = await cache.read(async () => {
    const entries = new Map<string, Workspace>();
    let cursor: string | undefined;
    do {
      const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } });
      page.entries.forEach((entry) => entries.set(entry.id, entry));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return entries;
  });
  const workspace = workspaces.get(workspaceId);
  const directory = workspace?.workspaceDirectory;
  if (workspace === undefined || directory === undefined || directory === "") {
    throw new Error(`Workspace ${workspaceId} is not active or has no directory.`);
  }
  return { directory, name: workspace.title ?? workspace.name };
}

export function forgetWorkspace(_workspaceId: string): void {
  // Creation or archival invalidates the shared list for subsequent callers.
  snapshots = new WeakMap();
}
