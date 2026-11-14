import { afterEach, describe, expect, it, vi } from "vitest";

import { readProjects, readWorkspaces } from "./daemon-reads";
import type { PaseoApi } from "./host-types";

afterEach(() => vi.useRealTimers());

describe("daemon list snapshots", () => {
  it("shares every page across concurrent cards and refreshes on TTL rather than agent activity", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async ({ page }: { page: { cursor?: string } }) => page.cursor === undefined
      ? { entries: [{ id: "w1" }], pageInfo: { nextCursor: "second" } }
      : { entries: [{ id: "w2" }], pageInfo: { nextCursor: null } });
    const paseo = { workspaces: { list } } as unknown as PaseoApi;
    const snapshots = await Promise.all(Array.from({ length: 20 }, () => readWorkspaces(paseo)));
    expect(list).toHaveBeenCalledTimes(2);
    expect([...snapshots[0]!.keys()]).toEqual(["w1", "w2"]);
    expect(snapshots.every((snapshot) => snapshot === snapshots[0])).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    await readWorkspaces(paseo);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await readWorkspaces(paseo);
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("coalesces media/file project reads and keeps separate API instances isolated", async () => {
    vi.useFakeTimers();
    const localList = vi.fn(async () => ({ projects: [{ projectRootPath: "/local" }] }));
    const remoteList = vi.fn(async () => ({ projects: [{ projectRootPath: "/remote" }] }));
    const local = { projects: { list: localList } } as unknown as PaseoApi;
    const remote = { projects: { list: remoteList } } as unknown as PaseoApi;
    await Promise.all(Array.from({ length: 20 }, () => readProjects(local)));
    expect(localList).toHaveBeenCalledTimes(1);
    expect((await readProjects(remote)).projects[0]?.projectRootPath).toBe("/remote");
    expect(remoteList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await readProjects(local);
    expect(localList).toHaveBeenCalledTimes(2);
  });
});
