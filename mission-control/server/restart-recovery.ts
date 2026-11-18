import type { Fleet } from "../shared/fleet";
import { readTextFile, writeTextFile } from "./files";
import { sendSessionRequest } from "./daemon-session";
import { fetchLiveAgent } from "./fleet";
import { sendWithoutInterrupting } from "./send";
import type { PaseoApi, TimelinePage } from "./host-types";

// The plugin is a direct child of the daemon worker. The desktop supervisor's PID survives worker crashes.
export const recoveryId = `daemon-${process.ppid}`;

async function readOptional(home: string, path: string) {
  try { return (await readTextFile(home, path)).content ?? ""; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function verifyNotice(paseo: PaseoApi, id: string, messageId: string, epoch: string, sinceSeq: number) {
  const timeline = paseo.agents.ref(id).timeline;
  let cursor: TimelinePage["startCursor"] = null;
  for (;;) {
    const page = await timeline.refetch({ ...(cursor ? { direction: "before" as const, cursor } : { direction: "tail" as const }),
      projection: "canonical", limit: 100 });
    if (page.error || page.reset || page.staleCursor || page.gap || page.epoch !== epoch) return "unknown";
    if (page.entries.some(({ item }) => item.type === "user_message" && item.clientMessageId === messageId)) return "delivered";
    if (page.window.maxSeq < sinceSeq || page.window.minSeq > sinceSeq + 1) return "unknown";
    if (!page.hasOlder || (page.startCursor && page.startCursor.seq <= sinceSeq + 1)) return "absent";
    if (!page.startCursor || (cursor && page.startCursor.seq >= cursor.seq)) return "unknown";
    cursor = page.startCursor;
  }
}

export class RestartRecovery {
  private finished = false;
  private checking = false;
  private requesting = false;

  constructor(private readonly boot = recoveryId) {}

  // The server entry has no SDK handle. This read-only call opens the ordinary fleet handler
  // with its host context even if no client has opened the board. The existing watch tick retries.
  request(): void {
    if (!process.send || this.finished || this.checking || this.requesting) return;
    this.requesting = true;
    void sendSessionRequest({ type: "plugin.rpc.invoke.request", pluginId: "mission-control",
      method: "mission-control.fleet.load", input: {} }, "plugin.rpc.invoke.response", 25_000)
      .catch((error) => console.warn("[mission-control] restart fleet read:", error.message))
      .finally(() => { this.requesting = false; });
  }

  async inspect(fleet: Fleet, paseo: PaseoApi): Promise<void> {
    if (this.finished || this.checking || !fleet.homeReady || !fleet.coordinator || fleet.stale || (fleet.reconciliationPending && !fleet.followThrough?.length)) return;
    this.checking = true;
    try {
      const interrupted = (fleet.followThrough ?? []).filter((entry) =>
        ["assign-next-step", "locate-owner", "verify-closed-worker", "check-shared-assignment", "reconcile-result"].includes(entry.reason));
      if (!interrupted.length) {
        if (fleet.reconciliationPending) return;
        this.finished = true;
        return;
      }
      const home = fleet.home, id = fleet.coordinator.id;
      const receipt = "state/restart-notification.txt";
      const key = this.boot + " " + id;
      const existing = await readOptional(home, receipt);
      const wake = await readOptional(home, "state/wake-state.md");
      const [priorKey, phase, issued, epoch, seq, pendingRound] = existing.trimEnd().split("\n");
      const delivered = priorKey === key && phase === "Delivered";
      const uncertain = priorKey === key && phase === "Pending";
      if (delivered && Date.now() - Number(issued ?? 0) < 5 * 60_000) return;
      const round = delivered ? Number(epoch ?? 0) + 1 : uncertain ? Number(pendingRound ?? 0) : 0;
      const messageId = "mission-control-recovery-" + this.boot + "-" + id + (round ? "-" + round : "");
      const confirmed = () => writeTextFile(home, { path: receipt,
        content: [key, "Delivered", Date.now(), round].join("\n") + "\n", expectedModifiedMs: null, force: true });
      const acknowledged = wake.split(/\r?\n/).includes("Reconciled " + key);
      const worker = await fetchLiveAgent(paseo, id);
      if (this.finished || !worker || worker.pendingPermissions.length || !["idle", "closed"].includes(worker.status)) return;
      if (uncertain) {
        if ( !epoch || !seq || !issued || Date.now() - Number(issued) < 30_000) return;
        const state = await verifyNotice(paseo, id, messageId, epoch, Number(seq));
        if (state === "unknown") return;
        if (state === "delivered") {
          await confirmed();
          return;
        }
      }
      const outstanding = interrupted.map((entry) => `${entry.taskId ?? entry.agentId} (${entry.reason}, ${entry.revision})`);
      const notice = [
        `Mission Control restart reconciliation for ${key}. Read the current fleet and every in-flight assignment.`,
        ...(delivered || acknowledged ? ["The prior coordinator receipt has outstanding assignments. Verify actual post-restart worker activity. A pre-crash dispatch or a delivered coordinator notification alone cannot establish recovery."] : []),
        "For each one compare the actual latest worker activity and delivery receipt with the newest user decision before sending anything. A closed listing can lag a delivered prompt or active tools.",
        "Keep an existing next owner, close verified completion, preserve an explicit park or wait, or give the original worker the next authorized step once.",
        ...(fleet.reconciliationPending ? ["The inventory is incomplete. Act on verified cases and revisit the remaining workers on the existing wake."] : []),
        ...outstanding,
        `Record actual dispositions in state/wake-state.md, then append this exact line: Reconciled ${key}`,
      ].join("\n");
      // Reserve before sending. A timeout or process exit can leave delivery uncertain;
      // the ordinary wake sees the same restart ID and reconciles before any worker is redriven.
      const baseline = await paseo.agents.ref(id).timeline.refetch({ direction: "tail", projection: "canonical", limit: 1 });
      if (baseline.error || baseline.gap || this.finished) return;
      const pending = [key, "Pending", Date.now(), baseline.epoch, baseline.window.maxSeq, round].join("\n");
      await writeTextFile(home, { path: receipt, content: pending, expectedModifiedMs: null, force: true });
      await sendWithoutInterrupting(paseo, id, notice, { messageId });
      await confirmed();
    } finally { this.checking = false; }
  }

  stop() { this.finished = true; }
}
