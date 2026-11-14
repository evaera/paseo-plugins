import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startOpenRequestPoller } from "./open-requests";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("mailbox polling", () => {
  it("keeps responsive requests at two seconds and delivers each reply", async () => {
    vi.useFakeTimers();
    const request = { workspaceId: "w1", view: "diff" as const };
    const rpc = vi.fn(async () => ({ requests: [request] }));
    const open = vi.fn();
    const stop = startOpenRequestPoller({ rpc } as unknown as PluginClientContext, open);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledWith(request);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for slow replies before scheduling a cooldown, with no overlap", async () => {
    vi.useFakeTimers();
    let finish!: (reply: { requests: [] }) => void;
    const rpc = vi.fn(() => new Promise<{ requests: [] }>((resolve) => { finish = resolve; }));
    const stop = startOpenRequestPoller({ rpc } as unknown as PluginClientContext, vi.fn());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    finish({ requests: [] });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc).toHaveBeenCalledTimes(2);
    stop();
    finish({ requests: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("backs off consecutive failures and ignores replies after teardown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rpc = vi.fn(async () => { throw new Error("busy"); });
    const open = vi.fn();
    const stop = startOpenRequestPoller({ rpc } as unknown as PluginClientContext, open);
    await vi.advanceTimersByTimeAsync(15_999);
    expect(rpc).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
  });
});
