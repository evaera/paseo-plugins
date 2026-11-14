import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  return { load: () => load({}, context), stop,
    invoke: (method: string, input: unknown, paseo = context.paseo) => handlers.get(method)!(input, { paseo }),
  };
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

  it("returns a marked last good snapshot on deadlines and errors, then clears staleness", async () => {
    vi.useFakeTimers();
    const snapshot = { coordinator: null, home: "/cached", cards: [] } as unknown as Fleet;
    const assemble = vi.spyOn(fleet, "loadFleet").mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(new Promise(() => {})).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...snapshot, home: "/fresh" });
    const { load, stop } = register();
    try {
      await load();
      const timed = load();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await timed).toMatchObject({ ...snapshot, stale: true });
      expect(await load()).toMatchObject({ ...snapshot, stale: true, staleReason: "offline" });
      expect(await load()).toEqual({ ...snapshot, home: "/fresh" });
      expect(snapshot.stale).toBeUndefined();
      expect(assemble).toHaveBeenCalledTimes(4);
    } finally { await stop?.(); }
  });

  it("keeps late initial successes available for fallback", async () => {
    vi.useFakeTimers();
    let finish!: (value: Fleet) => void;
    const old = { coordinator: null, home: "/old" } as Fleet;
    const fresh = { ...old, home: "/fresh" };
    const assemble = vi.spyOn(fleet, "loadFleet").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(fresh)
      .mockReturnValueOnce(new Promise(() => {})).mockRejectedValue(new Error("offline"));
    const { load, stop } = register();
    try {
      const expired = expect(load()).rejects.toThrow("20 seconds");
      await vi.advanceTimersByTimeAsync(20_000); await expired;
      finish(old); await vi.advanceTimersByTimeAsync(0);
      expect(await load()).toMatchObject({ home: "/old", stale: true });
      expect(await load()).toEqual(fresh);
      // A second timed-out request must also preserve the last successful snapshot.
      const timed = load(); await vi.advanceTimersByTimeAsync(20_000);
      expect(await timed).toMatchObject({ home: "/fresh", stale: true });
      expect(await load()).toMatchObject({ home: "/fresh", stale: true });
      expect(assemble).toHaveBeenCalledTimes(5);
    } finally { await stop?.(); }
  });

  it("does not let an older late result overwrite a newer good snapshot", async () => {
    vi.useFakeTimers();
    let finish!: (value: Fleet) => void;
    const fresh = { coordinator: null, home: "/fresh" } as Fleet;
    vi.spyOn(fleet, "loadFleet").mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(fresh).mockRejectedValue(new Error("offline"));
    const { load, stop } = register();
    try {
      const expired = expect(load()).rejects.toThrow("20 seconds");
      await vi.advanceTimersByTimeAsync(20_000); await expired;
      expect(await load()).toEqual(fresh);
      finish({ ...fresh, home: "/old" }); await vi.advanceTimersByTimeAsync(0);
      expect(await load()).toMatchObject({ home: "/fresh", stale: true });
    } finally { await stop?.(); }
  });

  it("finds home-only files without requesting projects, and still resolves project files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-files-"));
    const root = join(dir, "home"), project = join(dir, "project");
    await mkdir(root); await mkdir(project);
    const note = join(root, "note.md"), external = join(project, "external.md");
    await writeFile(note, "note"); await writeFile(external, "external");
    const { invoke, stop } = register();
    vi.mocked(config.readMissionControlConfig).mockResolvedValue(MissionControlConfigSchema.parse({ home: root }));
    const list = vi.fn(async () => ({ projects: [{ projectRootPath: project }] }));
    const api = { projects: { list } } as unknown as PluginHandlerContext["paseo"];
    try {
      expect(await invoke("mission-control.files.find", { paths: ["note.md", note] }, api))
        .toMatchObject({ files: { "note.md": "note.md", [note]: "note.md" } });
      expect(list).not.toHaveBeenCalled();
      expect(await invoke("mission-control.files.find", { paths: [external] }, api))
        .toMatchObject({ projectFiles: { [external]: await realpath(external) } });
      expect(list).toHaveBeenCalledTimes(1);
    } finally { await stop?.(); await rm(dir, { recursive: true, force: true }); }
  });
});
