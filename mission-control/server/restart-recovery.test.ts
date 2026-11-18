import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Fleet } from "../shared/fleet";
import type { PaseoApi } from "./host-types";
import { buildCards, followThrough } from "./fleet";
import { parseBacklog } from "./backlog";
import { RestartRecovery } from "./restart-recovery";

let home = "";
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

it("recovers once across reloads, waits for a settled roster and an idle coordinator, and preserves a prior dispatch", async () => {
  home = await mkdtemp(join(tmpdir(), "mc-restart-"));
  const cards = buildCards(parseBacklog(`## In flight
- [ ] oblique-shirt-layer - Recovery delivered to original worker (agent: shirt)
- [ ] godot-retire-er-poses - Retire poses (waiting: five consumers)
## Done
- [x] godot-character-lod - Keep evidence`), []);
  const snapshot = { home, homeReady: true, coordinator: { id: "control" }, cards,
    followThrough: followThrough(cards, () => true) } as unknown as Fleet;
  let status = "running";
  const send = vi.fn(async () => {});
  const timeline = { refetch: vi.fn(async () => ({ epoch: "epoch", window: { minSeq: 0, maxSeq: 12 }, entries: [] })) };
  const ref = vi.fn(() => ({ timeline, refresh: async () => ({ agent: { status, pendingPermissions: [], archivedAt: null } }), send }));
  const api = { agents: { ref } } as unknown as PaseoApi;
  const boot = new RestartRecovery("boot-one");
  await boot.inspect({ ...snapshot, reconciliationPending: true }, api);
  await boot.inspect(snapshot, api);
  expect(send).not.toHaveBeenCalled();
  status = "idle";
  await Promise.all([boot.inspect(snapshot, api), boot.inspect(snapshot, api)]);
  await new RestartRecovery("boot-one").inspect(snapshot, api);
  expect(send).toHaveBeenCalledTimes(1);
  expect(ref.mock.calls.every((args) => (args as unknown[])[0] === "control")).toBe(true);
  expect(send).toHaveBeenCalledWith(expect.stringContaining("oblique-shirt-layer (locate-owner"), expect.objectContaining({ messageId: "mission-control-recovery-boot-one-control" }));
  expect(cards.map((card) => card.column)).toEqual(["idle", "waiting", "done"]);
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(join(home, "state/wake-state.md"), "Reconciled boot-two control\n");
  await new RestartRecovery("boot-two").inspect({ ...snapshot, followThrough: [] }, api);
  expect(send).toHaveBeenCalledTimes(1);
  const degraded = { ...snapshot, reconciliationPending: true };
  send.mockRejectedValueOnce(new Error("connection lost"));
  await expect(new RestartRecovery("boot-three").inspect(degraded, api)).rejects.toThrow("connection lost");
  const path = join(home, "state/restart-notification.txt");
  const reservation = (await readFile(path, "utf8")).replace(/Pending\n\d+\n/, "Pending\n1\n");
  await writeFile(path, reservation);
  timeline.refetch.mockRejectedValueOnce(new Error("unavailable"));
  await expect(new RestartRecovery("boot-three").inspect(degraded, api)).rejects.toThrow("unavailable");
  expect(send).toHaveBeenCalledTimes(2);
  await new RestartRecovery("boot-three").inspect(degraded, api);
  expect(send).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("inventory is incomplete"), expect.anything());
  await writeFile(path, reservation);
  timeline.refetch.mockResolvedValueOnce({ epoch: "epoch", window: { minSeq: 0, maxSeq: 13 },
    entries: [{ item: { type: "user_message", clientMessageId: "mission-control-recovery-boot-three-control" } }] as never[] });
  await new RestartRecovery("boot-three").inspect(degraded, api);
  expect(send).toHaveBeenCalledTimes(3);
  await writeFile(path, "boot-three control\nDelivered\n1\n0\n");
  await writeFile(join(home, "state/wake-state.md"), "Reconciled boot-three control\n");
  await new RestartRecovery("boot-three").inspect(snapshot, api);
  expect(send).toHaveBeenCalledTimes(4);
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("Verify actual post-restart worker activity"), expect.objectContaining({ messageId: "mission-control-recovery-boot-three-control-1" }));
});
