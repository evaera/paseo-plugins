import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import contribute from "../index.server";
import { type Fleet, MissionControlConfigSchema } from "../shared/fleet";
import * as config from "./config";
import * as fleet from "./fleet";
import * as home from "./home";

vi.mock("./watch-service", () => ({ startWatches: () => ({ remember() {}, stop() {}, runner: { summaries: async () => [] } }) }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function register() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(config, "readMissionControlConfig").mockResolvedValue(MissionControlConfigSchema.parse({}));
  vi.spyOn(home, "isHomeReady").mockResolvedValue(false);
  const handlers = new Map<string, (input: unknown, context: PluginHandlerContext) => Promise<unknown>>();
  const server = {
    handle(contract: { name: string }, handler: (input: unknown, context: PluginHandlerContext) => Promise<unknown>) { handlers.set(contract.name, handler); },
    on: () => () => {}, before: () => () => {}, registerSettings() {},
  } as unknown as PluginServerContext;
  const stop = contribute(server);
  const load = handlers.get("mission-control.fleet.load")!;
  const context = { paseo: {} } as PluginHandlerContext;
  return { load: () => load({}, context), stop };
}

describe("fleet RPC", () => {
  it("shares an overlapping assembly, then reads fresh state for the next request", async () => {
    let finish!: (snapshot: Fleet) => void;
    const pending = new Promise<Fleet>((resolve) => { finish = resolve; });
    const assemble = vi.spyOn(fleet, "loadFleet").mockReturnValue(pending);
    const { load, stop } = register();
    try {
      const first = load(), second = load();
      await Promise.resolve();
      expect(assemble).toHaveBeenCalledTimes(1);
      const snapshot = { coordinator: null } as Fleet;
      finish(snapshot);
      expect(await Promise.all([first, second])).toEqual([snapshot, snapshot]);
      await load();
      expect(assemble).toHaveBeenCalledTimes(2);
    } finally { await stop?.(); }
  });

  it("retries assembly after a shared failure", async () => {
    const error = new Error("busy");
    const assemble = vi.spyOn(fleet, "loadFleet").mockRejectedValueOnce(error).mockResolvedValue({ coordinator: null } as Fleet);
    const { load, stop } = register();
    try {
      await expect(load()).rejects.toBe(error);
      await expect(load()).resolves.toMatchObject({ coordinator: null });
      expect(assemble).toHaveBeenCalledTimes(2);
    } finally { await stop?.(); }
  });

  it("lets later requests recover when the original assembly never settles", async () => {
    vi.useFakeTimers();
    const assemble = vi.spyOn(fleet, "loadFleet")
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ coordinator: null } as Fleet);
    const { load, stop } = register();
    try {
      const stalled = expect(load()).rejects.toThrow("The board did not answer within 20 seconds");
      await vi.advanceTimersByTimeAsync(20_000);
      await stalled;
      await expect(load()).resolves.toMatchObject({ coordinator: null });
      expect(assemble).toHaveBeenCalledTimes(2);
    } finally { await stop?.(); }
  });
});
