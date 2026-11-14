import { describe, expect, it } from "vitest";

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
      expect(await deliverToCoordinator(paseo, config, "note")).toBe("wait");
      expect(sent).toEqual([]);
    }
  });

  it("sends to an idle Mission Control without interrupting, and waits without one or without Paseo", async () => {
    const { paseo, sent } = paseoWith("idle");
    expect(await deliverToCoordinator(paseo, config, "note")).toBe("sent");
    expect(sent).toEqual([
      { text: "note", options: { activeTurnBehavior: "steer", messageId: expect.stringMatching(/^mission-control-watch-[0-9a-f-]{36}$/) } },
    ]);
    expect(await deliverToCoordinator(paseo, MissionControlConfigSchema.parse({}), "note")).toBe("wait");
    expect(await deliverToCoordinator(null, config, "note")).toBe("wait");
  });
});
