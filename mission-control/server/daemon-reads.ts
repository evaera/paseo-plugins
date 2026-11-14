/** List snapshots are per API/host, never per card or per attachment. */
import type { PaseoApi } from "./host-types";
import { ReadCache } from "./read-cache";

type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
type Projects = Awaited<ReturnType<PaseoApi["projects"]["list"]>>;

const workspaceReads = new WeakMap<PaseoApi, ReadCache<Map<string, Workspace>>>();
const projectReads = new WeakMap<PaseoApi, ReadCache<Projects>>();

/** Agent stream timestamps do not invalidate this cache: all cards share one short TTL. */
export function readWorkspaces(paseo: PaseoApi): Promise<Map<string, Workspace>> {
  let cache = workspaceReads.get(paseo);
  if (cache === undefined) {
    cache = new ReadCache(15_000);
    workspaceReads.set(paseo, cache);
  }
  return cache.read(async () => {
    const workspaces = new Map<string, Workspace>();
    let cursor: string | undefined;
    do {
      const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } });
      page.entries.forEach((workspace) => workspaces.set(workspace.id, workspace));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return workspaces;
  });
}

export function readProjects(paseo: PaseoApi): Promise<Projects> {
  let cache = projectReads.get(paseo);
  if (cache === undefined) {
    cache = new ReadCache(30_000);
    projectReads.set(paseo, cache);
  }
  return cache.read(() => paseo.projects.list());
}
