import { describe, expect, it, vi } from "vitest";
import { waitForCoordinatorDelivery } from "./coordinator-delivery";
import type { CoordinatorDelivery } from "../shared/fleet";
import { isImageMessageId, newCoordinatorMessageId } from "../shared/attachments";

const receipt = (state: CoordinatorDelivery["state"]): CoordinatorDelivery => ({ state, messageId: "message-1", agentId: null });

describe("coordinator send confirmation", () => {
  it("submits once after a lost reply, and only polls while missing, unknown or offline", async () => {
    const submit = vi.fn(async () => { throw new Error("RPC timeout"); });
    const read = vi.fn<() => Promise<CoordinatorDelivery>>().mockResolvedValueOnce(receipt("missing"))
      .mockResolvedValueOnce(receipt("unknown")).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(receipt("sent"));
    const pause = vi.fn<(_ms: number) => Promise<void>>(async () => {});
    await waitForCoordinatorDelivery(submit, read, pause);
    expect(submit).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(4);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("reports only a confirmed pre-send failure as a failed draft", async () => {
    const read = vi.fn(async () => ({ ...receipt("failed"), error: "No coordinator" }));
    await expect(waitForCoordinatorDelivery(async () => receipt("sending"), read, async () => {})).rejects.toThrow("No coordinator");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps image message identities compatible with saved attachments", () => {
    expect(isImageMessageId(newCoordinatorMessageId(true))).toBe(true);
    expect(newCoordinatorMessageId()).toMatch(/^mission-control-message-[0-9a-f-]{36}$/);
  });
});
