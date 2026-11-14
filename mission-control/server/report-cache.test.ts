import { afterEach, describe, expect, it, vi } from "vitest";
import { CREW_LABELS } from "../shared/fleet";
import { ReportCache } from "./fleet";
import type { PaseoAgent, PaseoApi, TimelinePage } from "./host-types";
import { TimelineTails } from "./timeline-tails";
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { MissionControlConfigSchema } from "../shared/fleet";
import { registerSteerRelay, steerCrew, UserSteers } from "./crew";

const agent = (id: string, updatedAt = "one", role: string = CREW_LABELS.crewRole): PaseoAgent =>
  ({ id, updatedAt, status: "idle", archivedAt: null, labels: { [CREW_LABELS.role]: role } }) as unknown as PaseoAgent;
const page = (): TimelinePage => ({ entries: [{ item: { type: "assistant_message", text: "done: ready" } }] }) as unknown as TimelinePage;
const apiFor = (refetch: () => Promise<TimelinePage>): PaseoApi => ({ agents: { ref: () => ({ timeline: { refetch } }) } }) as unknown as PaseoApi;
async function flush() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("status report tails", () => {
  it("does not block, coalesces each agent, and reuses successful tails until updatedAt changes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let finish!: (value: TimelinePage) => void;
    const refetch = vi.fn(() => new Promise<TimelinePage>((resolve) => { finish = resolve; }));
    const api = apiFor(refetch), cache = new ReportCache(new TimelineTails());
    expect(await cache.reportFor(api, agent("a"))).toBeNull();
    await Promise.all(Array.from({ length: 20 }, () => cache.reportFor(api, agent("a"))));
    expect(refetch).toHaveBeenCalledTimes(1);
    finish(page()); await flush();
    expect(await cache.reportFor(api, agent("a"))).toMatchObject({ state: "done" });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(await cache.reportFor(api, agent("a", "two"))).toMatchObject({ state: "done" });
    expect(refetch).toHaveBeenCalledTimes(2);
    finish(page()); await flush();
    await cache.reportFor(api, agent("a", "one"));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("uses the returned timeline's agent stamp when it is newer than the directory snapshot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const refetch = vi.fn(async () => ({ ...page(), agent: agent("a", "2026-11-14T00:00:03.000Z") }));
    const api = apiFor(refetch), cache = new ReportCache(new TimelineTails());
    await cache.reportFor(api, agent("a", "2026-11-14T00:00:01.000Z")); await flush();
    await cache.reportFor(api, agent("a", "2026-11-14T00:00:02.000Z"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("never reads the configured coordinator, labelled coordinators, or running workers", async () => {
    const refetch = vi.fn(async () => page()), api = apiFor(refetch), cache = new ReportCache(new TimelineTails());
    cache.retain(new Set(["mine", "other", "busy"]), "mine");
    await cache.reportFor(api, agent("mine"));
    await cache.reportFor(api, agent("other", "one", CREW_LABELS.coordinatorRole));
    await cache.reportFor(api, { ...agent("busy"), status: "running" });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("preserves a good report and backs off when the API returns an error page", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "log").mockImplementation(() => {});
    const refetch = vi.fn<() => Promise<TimelinePage>>().mockResolvedValueOnce(page())
      .mockResolvedValueOnce({ ...page(), entries: [], error: "busy" }).mockResolvedValue(page());
    const api = apiFor(refetch), cache = new ReportCache(new TimelineTails());
    await cache.reportFor(api, agent("a")); await flush();
    await cache.reportFor(api, agent("a", "two")); await flush();
    expect(await cache.reportFor(api, agent("a", "two"))).toMatchObject({ state: "done" });
    expect(refetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); await cache.reportFor(api, agent("a", "two")); await flush();
    expect(refetch).toHaveBeenCalledTimes(3);
  });

  it("backs off failed reads and cools down after a slow successful tail", async () => {
    vi.useFakeTimers(); vi.spyOn(console, "log").mockImplementation(() => {});
    const refetch = vi.fn<() => Promise<TimelinePage>>().mockRejectedValueOnce(new Error("busy"));
    let finish!: (value: TimelinePage) => void;
    refetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const api = apiFor(refetch), cache = new ReportCache(new TimelineTails());
    await cache.reportFor(api, agent("a")); await flush();
    await vi.advanceTimersByTimeAsync(4999); await cache.reportFor(api, agent("a"));
    expect(refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await cache.reportFor(api, agent("a"));
    expect(refetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(105_000); finish(page()); await flush();
    await cache.reportFor(api, agent("a", "two"));
    expect(refetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000); await cache.reportFor(api, agent("a", "two"));
    expect(refetch).toHaveBeenCalledTimes(3);
    finish(page()); await flush();
  });
});

describe("shared timeline queue", () => {
  it("caps all three server paths at two requests and discards invalidated queued work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const finishes = new Map<string, (value: TimelinePage) => void>();
    const calls: string[] = [];
    const api = { agents: { ref: (id: string) => ({ timeline: { refetch: () => {
      calls.push(id); return new Promise<TimelinePage>((resolve) => { finishes.set(id, resolve); });
    } } }) } } as unknown as PaseoApi;
    const tails = new TimelineTails(); let allowed = true;
    const one = tails.read(api, { agentId: "a", source: "board-report" });
    const two = tails.read(api, { agentId: "b", source: "local-steer-relay" });
    const three = tails.read(api, { agentId: "c", source: "remote-steer-relay", allowed: () => allowed });
    const four = tails.read(api, { agentId: "d", source: "board-report" });
    expect(calls).toEqual(["a", "b"]);
    allowed = false;
    finishes.get("a")!(page()); await one; await flush();
    expect(await three).toBeNull(); expect(calls).toEqual(["a", "b", "d"]);
    finishes.get("b")!(page()); await two; await flush();
    finishes.get("d")!(page()); await four; await flush();
    const events = log.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(events.filter((event) => event.phase === "start").map((event) => event.agentId)).toEqual(["a", "b", "d"]);
    expect(JSON.stringify(events)).not.toContain("done: ready");
  });
});

describe("coordinator timeline exclusion", () => {
  it("does not read the coordinator from the turn-ended steer relay", async () => {
    const refetch = vi.fn(async () => page()), api = apiFor(refetch), steers = new UserSteers();
    steers.record("mine", "words");
    let ended!: (event: { agent: { id: string }; outcome: { kind: string } }, context: { paseo: PaseoApi }) => Promise<void>;
    const server = { on: (_name: string, handler: typeof ended) => { ended = handler; return () => {}; } } as unknown as PluginLifecycleRegistration;
    registerSteerRelay(server, steers, async () => MissionControlConfigSchema.parse({ coordinatorAgentId: "mine" }));
    await ended({ agent: { id: "mine" }, outcome: { kind: "completed" } }, { paseo: api });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refuses direct coordinator steers even if its crew label is wrong", async () => {
    const refetch = vi.fn(async () => page());
    const api = { agents: { ref: () => ({ refresh: async () => ({ agent: agent("mine") }), timeline: { refetch } }) } } as unknown as PaseoApi;
    await expect(steerCrew({ api, serverId: null, named: new Set(["mine"]), coordinatorAgentId: "mine" }, new UserSteers(), "mine", "words", vi.fn()))
      .rejects.toThrow("Mission Control is not a crewmate");
    expect(refetch).not.toHaveBeenCalled();
  });
});
