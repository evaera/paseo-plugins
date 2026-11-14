import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as send from "./send";
const previousHome = process.env.PASEO_HOME;
let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "watch-delivery-")); process.env.PASEO_HOME = home;
  vi.spyOn(send, "sendCoordinatorMessage").mockImplementation((api, id, text, extras) => send.sendWithoutInterrupting(api, id, text, extras));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});
const messageId = "mission-control-watch-00000000-0000-4000-8000-000000000001";

import { MissionControlConfigSchema } from "../shared/fleet";
import type { PaseoApi } from "./host-types";
import { deliverToCoordinator } from "./watch-service";

/** A Paseo whose Mission Control is in `status`, recording what is sent to it. */
function paseoWith(status: string) {
  const sent: Array<{ text: string; options: unknown }> = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { id, status, archivedAt: null } }),
        send: async (text: string, options: unknown) => {
          sent.push({ text, options });
        },
      }),
    },
  } as unknown as PaseoApi;
  return { paseo, sent };
}

const config = MissionControlConfigSchema.parse({ coordinatorAgentId: "coordinator-1" });

describe("deliverToCoordinator", () => {
  it("never sends into a running turn, however it came to be asked", async () => {
    for (const status of ["running", "initializing"]) {
      const { paseo, sent } = paseoWith(status);
      expect(await deliverToCoordinator(paseo, config, "note", messageId)).toBe("wait");
      expect(sent).toEqual([]);
    }
  });

  it("sends to an idle Mission Control without interrupting, and waits without one or without Paseo", async () => {
    const { paseo, sent } = paseoWith("idle");
    expect(await deliverToCoordinator(paseo, config, "note", messageId)).toBe("sending");
    await vi.waitFor(async () => expect(await deliverToCoordinator(paseo, config, "note", messageId)).toBe("sent"));
    expect(sent).toEqual([
      { text: "note", options: { activeTurnBehavior: "steer", messageId } },
    ]);
    expect(await deliverToCoordinator(paseo, MissionControlConfigSchema.parse({}), "note", "absent")).toBe("wait");
    expect(await deliverToCoordinator(null, config, "note", "offline")).toBe("wait");
  });
});
