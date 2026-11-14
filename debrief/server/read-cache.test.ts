import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadCache } from "./read-cache";

afterEach(() => vi.useRealTimers());

describe("shared daemon reads", () => {
  it("coalesces concurrent callers, caches from completion, and refreshes after expiry", async () => {
    vi.useFakeTimers();
    let finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const cache = new ReadCache<number>(1000);
    const first = cache.read(load);
    const callers = Array.from({ length: 20 }, () => cache.read(load));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    finish(1);
    expect(await first).toBe(1);
    expect(await Promise.all(callers)).toEqual(Array(20).fill(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(await cache.read(load)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = cache.read(load);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2);
    finish(2);
    expect(await next).toBe(2);
  });

  it("backs off after failures without turning an expired result into a successful read", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new Error("busy"); });
    const cache = new ReadCache<number>(1000);
    await expect(cache.read(load)).rejects.toThrow("busy");
    await expect(cache.read(load)).rejects.toThrow("busy");
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(cache.read(load)).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(cache.read(load)).rejects.toThrow("busy");
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cache.read(async () => 3)).toBe(3);
  });

  it("keeps a slow operation shared and gives the daemon a cooldown after it completes", async () => {
    vi.useFakeTimers();
    let finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const cache = new ReadCache<number>(1000);
    const first = cache.read(load);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cache.read(load)).toBe(first);
    finish(7);
    await first;
    await vi.advanceTimersByTimeAsync(9999);
    expect(await cache.read(load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
