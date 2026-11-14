import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetSchema } from "../shared/fleet";
import { createFleetQuery, FLEET_QUERY_KEY, fleetWaitMessage } from "./fleet-query";

const clients: QueryClient[] = [];
const client = () => { const value = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } }); clients.push(value); return value; };
const snapshot = () => FleetSchema.parse({ home: "/home", homeReady: true, coordinator: null, coordinatorMissing: false,
  coordinatorInHome: true, cards: [], projects: [], suggestions: [], watches: [], agentTools: true, charterOutdated: false, warnings: [] });
afterEach(async () => { clients.splice(0).forEach((value) => value.clear()); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers(); });

describe("fleet query recovery", () => {
  it("keeps retrying the first load beyond the normal retry limit, with backoff", async () => {
    vi.useFakeTimers();
    const query = createFleetQuery(), store = client(), fresh = snapshot();
    const load = vi.fn<() => Promise<typeof fresh>>();
    for (let index = 0; index < 7; index += 1) load.mockRejectedValueOnce(new Error("busy"));
    load.mockResolvedValue(fresh);
    const observer = new QueryObserver(store, query(load, 5)); const stop = observer.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(90_999);
      expect(load).toHaveBeenCalledTimes(7);
      expect(observer.getCurrentResult().isError).toBe(false);
      expect(fleetWaitMessage(observer.getCurrentResult().failureCount)).toContain("Retrying automatically");
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(8);
      expect(observer.getCurrentResult().data).toEqual(fresh);
      expect(observer.getCurrentResult().isFetching).toBe(false);
    } finally { stop(); }
  });

  it("bounds a lost initial reply and recovers on the next attempt", async () => {
    vi.useFakeTimers();
    const query = createFleetQuery(), store = client(), fresh = snapshot();
    const load = vi.fn<() => Promise<typeof fresh>>().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(fresh);
    const pending = store.fetchQuery(query(load, 5));
    await vi.advanceTimersByTimeAsync(30_999); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(fresh); expect(load).toHaveBeenCalledTimes(2);
  });

  it("preserves cached crew on transport errors, marks it stale, and clears staleness after recovery", async () => {
    vi.useFakeTimers();
    const query = createFleetQuery(), store = client(), fresh = snapshot();
    await store.fetchQuery(query(async () => fresh, 5));
    expect(await store.fetchQuery(query(async () => { throw new Error("offline"); }, 5))).toMatchObject({ ...fresh, stale: true, staleReason: "offline" });
    const next = { ...fresh, home: "/updated" };
    expect(await store.fetchQuery(query(async () => next, 5))).toEqual(next);
    expect(store.getQueryData(FLEET_QUERY_KEY)).toEqual(next);
  });

  it("uses an existing query snapshot after a module remount", async () => {
    vi.useFakeTimers();
    const store = client(), fresh = snapshot(); store.setQueryData(FLEET_QUERY_KEY, fresh);
    const query = createFleetQuery();
    expect(await store.fetchQuery(query(async () => { throw new Error("offline"); }, 5))).toMatchObject({ ...fresh, stale: true });
  });

  it("cleans up its deadline and stops retrying when the query is canceled", async () => {
    vi.useFakeTimers();
    const store = client(), query = createFleetQuery();
    const load = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(() => {}));
    const canceled = expect(store.fetchQuery(query(load, 5))).rejects.toBeDefined();
    await store.cancelQueries({ queryKey: FLEET_QUERY_KEY }); await canceled;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
