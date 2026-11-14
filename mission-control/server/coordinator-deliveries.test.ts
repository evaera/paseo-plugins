import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorDeliveries, UnconfirmedDelivery } from "./coordinator-deliveries";
import { sendCoordinatorMessage } from "./send";
import type { PaseoApi } from "./host-types";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "coordinator-delivery-")); });
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
const settle = async (store: CoordinatorDeliveries, id: string, state: string) => {
  await vi.waitFor(async () => expect((await store.status(id)).state).toBe(state));
};

describe("durable coordinator deliveries", () => {
  it("coalesces repeats, retains intent across reloads, and records a late success", async () => {
    let finish!: (agentId: string) => void;
    const send = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const store = new CoordinatorDeliveries(() => directory);
    const request = { text: "land it" };
    const initial = await store.submit("message-1", request, send);
    expect(initial.state).toBe("sending");
    expect(JSON.parse(await readFile(join(directory, "message-1.json"), "utf8")).state).toBe("sending");
    await Promise.all(Array.from({ length: 6 }, () => store.submit("message-1", request, send)));
    const reloaded = new CoordinatorDeliveries(() => directory);
    expect(await reloaded.submit("message-1", request, send)).toMatchObject({ state: "unknown" });
    expect(send).toHaveBeenCalledTimes(1);
    finish("coordinator");
    await settle(reloaded, "message-1", "sent");
    await reloaded.submit("message-1", request, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never retries an uncertain outcome and refuses id reuse with different content", async () => {
    const store = new CoordinatorDeliveries(() => directory);
    const send = vi.fn(async () => { throw new UnconfirmedDelivery("ack lost"); });
    await store.submit("message-2", { text: "one" }, send);
    await settle(store, "message-2", "unknown");
    await store.submit("message-2", { text: "one" }, send);
    await expect(store.submit("message-2", { text: "two" }, send)).rejects.toThrow("another message");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("distinguishes pre-send failure, and never dispatches without a durable intent", async () => {
    const store = new CoordinatorDeliveries(() => directory);
    await store.submit("message-3", {}, async () => { throw new Error("no coordinator"); });
    await settle(store, "message-3", "failed");
    const file = join(directory, "not-a-directory"); await writeFile(file, "file");
    const blocked = new CoordinatorDeliveries(() => file), send = vi.fn(async () => "coordinator");
    await expect(blocked.submit("message-4", {}, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("late coordinator acknowledgments", () => {
  it("listens beyond the SDK's 60s timeout and sends only one frame", async () => {
    vi.useFakeTimers();
    const previousSend = process.send;
    const frames: Array<{ data: string }> = [];
    process.send = ((frame: { data: string }) => { frames.push(frame); return true; }) as NonNullable<typeof process.send>;
    try {
      const result = sendCoordinatorMessage({} as PaseoApi, "coordinator", "hello", { messageId: "message-5" });
      await vi.advanceTimersByTimeAsync(367_000);
      expect(frames).toHaveLength(1);
      const request = JSON.parse(frames[0]!.data).message;
      expect(request).toMatchObject({ type: "send_agent_message_request", messageId: "message-5", activeTurnBehavior: "steer" });
      process.emit("message", { type: "paseo_frame", isBinary: false, data: JSON.stringify({ type: "session", message: {
        type: "send_agent_message_response", payload: { requestId: request.requestId, agentId: "coordinator", accepted: true, error: null },
      } }) });
      await expect(result).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { if (previousSend === undefined) delete process.send; else process.send = previousSend; }
  });
});
