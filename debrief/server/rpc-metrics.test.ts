import { afterEach, describe, expect, it, vi } from "vitest";
import { defineRpc } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

import { measureRpcHandlers } from "./rpc-metrics";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("RPC metrics", () => {
  it("counts completions across flushes without logging inputs or outputs", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let call!: (input: string, context: PluginHandlerContext) => Promise<string>;
    const server = { handle: (_contract: unknown, handler: typeof call) => { call = handler; } } as unknown as PluginServerContext;
    const metrics = measureRpcHandlers(server, "test");
    const contract = defineRpc({ name: "test.read", input: z.string(), output: z.string() });
    let finish!: (output: string) => void;
    metrics.handle(contract, () => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = call("private input", {} as PluginHandlerContext);
    await vi.advanceTimersByTimeAsync(30_000);
    const first = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(first.methods[0]).toMatchObject({ method: "test.read", started: 1, completed: 0, inFlight: 1 });
    finish("private output");
    expect(await pending).toBe("private output");
    metrics.stop();
    const second = JSON.parse(String(log.mock.calls[1]?.[0]));
    expect(second.methods[0]).toMatchObject({ started: 0, completed: 1, failed: 0, inFlight: 0 });
    expect(second.pid).toBe(process.pid);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private input|private output/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes errors back unchanged and counts failures", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let call!: (input: unknown, context: PluginHandlerContext) => Promise<unknown>;
    const server = { handle: (_contract: unknown, handler: typeof call) => { call = handler; } } as unknown as PluginServerContext;
    const metrics = measureRpcHandlers(server, "test");
    const error = new Error("private error");
    metrics.handle(defineRpc({ name: "test.fail", input: z.object({}), output: z.object({}) }), () => { throw error; });
    await expect(call({}, {} as PluginHandlerContext)).rejects.toBe(error);
    metrics.stop();
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).methods[0]).toMatchObject({ started: 1, completed: 1, failed: 1, inFlight: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private error");
  });
});
