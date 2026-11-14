import { afterEach, describe, expect, it, vi } from "vitest";

import type { PaseoApi } from "./host-types";
import { forgetWorkspace, resolveWorkspace } from "./workspace";

afterEach(() => vi.useRealTimers());

describe("workspace resolution", () => {
  it("shares the paginated snapshot across workspaces and concurrent file reads", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async ({ page }: { page: { cursor?: string } }) => page.cursor === undefined
      ? { entries: [{ id: "w1", workspaceDirectory: "/one", title: null, name: "One" }], pageInfo: { nextCursor: "second" } }
      : { entries: [{ id: "w2", workspaceDirectory: "/two", title: "Two" }], pageInfo: {} });
    const paseo = { workspaces: { list } } as unknown as PaseoApi;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => resolveWorkspace(paseo, i % 2 ? "w1" : "w2")));
    expect(results[0]).toEqual({ directory: "/two", name: "Two" });
    expect(results[1]).toEqual({ directory: "/one", name: "One" });
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await resolveWorkspace(paseo, "w1");
    expect(list).toHaveBeenCalledTimes(4);
    forgetWorkspace("w1");
    await resolveWorkspace(paseo, "w2");
    expect(list).toHaveBeenCalledTimes(6);
  });

  it("isolates APIs, rejects missing directories, and backs off on daemon errors", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => { throw new Error("daemon busy"); });
    const busy = { workspaces: { list } } as unknown as PaseoApi;
    await expect(resolveWorkspace(busy, "w1")).rejects.toThrow("daemon busy");
    await expect(resolveWorkspace(busy, "w2")).rejects.toThrow("daemon busy");
    expect(list).toHaveBeenCalledTimes(1);
    const empty = { workspaces: { list: async () => ({ entries: [], pageInfo: {} }) } } as unknown as PaseoApi;
    await expect(resolveWorkspace(empty, "w1")).rejects.toThrow("not active or has no directory");
  });
});
