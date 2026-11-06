/**
 * Live delivery of review events to the agent, and the thread cards in its
 * timeline.
 *
 * Each note goes through `send(text, { sourceAgentId: "debrief" })`, which the
 * daemon wraps as an agent-message envelope, debounces and steers into a
 * running turn. That send also clears the agent's
 * pending permissions, and for Claude a cleared `ExitPlanMode` is a denied
 * plan, so a note for an agent with a permission open is held and sent once
 * it is answered. Held notes are kept in `reviews/<workspaceId>/ledger.json`
 * so a plugin reload neither loses nor repeats them; the ledger also records
 * which agent each thread card lives on, so later updates land on the same
 * card.
 */
import { join } from "node:path";

import { z } from "zod";

import type { Comment, Review } from "../shared/review";
import { DEBRIEF_SENDER_ID, THREAD_KIND, THREAD_VERSION, threadRowId } from "../shared/timeline";
import { ensureTargetAgent } from "./agents";
import type { PaseoApi, TimelineData } from "./host-types";
import { noteText, threadRow, type NoteEvent } from "./note-text";
import { serialized } from "./serialize";
import { readJson, reviewDir, writeAtomic } from "./store";

const QueuedNoteSchema = z.object({ id: z.string(), agentId: z.string(), text: z.string(), createdAt: z.string() });
type QueuedNote = z.infer<typeof QueuedNoteSchema>;

const LedgerSchema = z.object({
  version: z.literal(1),
  /** commentId -> the agent whose timeline holds its card. */
  rows: z.record(z.string(), z.string()).default({}),
  /** Notes held for an agent with a pending permission. */
  queue: z.array(QueuedNoteSchema).default([]),
});
type Ledger = z.infer<typeof LedgerSchema>;

function ledgerPath(workspaceId: string): string {
  return join(reviewDir(workspaceId), "ledger.json");
}

async function readLedger(workspaceId: string): Promise<Ledger> {
  const parsed = LedgerSchema.safeParse(await readJson(ledgerPath(workspaceId)).catch(() => undefined));
  return parsed.success ? parsed.data : { version: 1, rows: {}, queue: [] };
}

/** Read, change and write the ledger inside its own queue. */
function withLedger<T>(workspaceId: string, change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  return serialized(`ledger:${workspaceId}`, async () => {
    const ledger = await readLedger(workspaceId);
    const result = await change(ledger);
    await writeAtomic(ledgerPath(workspaceId), `${JSON.stringify(ledger, null, 2)}\n`);
    return result;
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FLUSH_RETRY_MS = 2_000;
const FLUSH_RETRIES = 5;

export class Notes {
  /** agentId -> the permission requests Debrief has seen open and not yet resolved. */
  private readonly pending = new Map<string, Set<string>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  permissionRequested(agentId: string, requestId: string): void {
    const open = this.pending.get(agentId) ?? new Set<string>();
    open.add(requestId);
    this.pending.set(agentId, open);
  }

  permissionResolved(paseo: PaseoApi, agentId: string, workspaceId: string | null, requestId: string): void {
    const open = this.pending.get(agentId);
    open?.delete(requestId);
    if (open !== undefined && open.size === 0) this.pending.delete(agentId);
    if (workspaceId !== null) this.flushLater(paseo, workspaceId, FLUSH_RETRIES);
  }

  forgetAgent(agentId: string): void {
    this.pending.delete(agentId);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Whether a send now would clear a permission the agent is waiting on. */
  private async hasPendingPermission(paseo: PaseoApi, agentId: string): Promise<boolean> {
    if ((this.pending.get(agentId)?.size ?? 0) > 0) return true;
    try {
      const found = await paseo.agents.ref(agentId).refresh();
      return (found?.agent.pendingPermissions.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Tells the review's target agent about `event`, starting an agent when the
   * workspace has none. Never throws: a note that cannot go is logged, since
   * the review itself has already been saved.
   */
  async deliver(paseo: PaseoApi, review: Review, event: NoteEvent): Promise<void> {
    const agentId = await this.deliverText(paseo, review, noteText(event)).catch((error: unknown) => {
      console.error(`[debrief] could not deliver a ${event.kind} note for ${review.workspaceId}:`, error);
      return null;
    });
    if (event.kind === "approved") return;
    // A deleted comment's card stays on the agent it was on, marked deleted.
    await this.upsertRow(paseo, review, event.comment, agentId, event.kind === "deleted");
  }

  /**
   * Sends `text` to the review's target agent, starting one with it as the
   * first prompt when the workspace has none. Returns the agent. Throws when
   * there is no agent and none can be started.
   */
  async deliverText(paseo: PaseoApi, review: Pick<Review, "workspaceId" | "agentId">, text: string): Promise<string> {
    const target = await ensureTargetAgent(paseo, review.workspaceId, review, text);
    if (!target.created) await this.sendOrHold(paseo, review.workspaceId, target.agentId, text);
    return target.agentId;
  }

  /** Sends to one named agent now, or holds it while that agent has a permission open. */
  async sendOrHold(paseo: PaseoApi, workspaceId: string, agentId: string, text: string): Promise<void> {
    await serialized(`notes:${agentId}`, async () => {
      if (await this.hasPendingPermission(paseo, agentId)) {
        await withLedger(workspaceId, (ledger) => {
          ledger.queue.push({ id: `${Date.now()}-${ledger.queue.length}`, agentId, text, createdAt: new Date().toISOString() });
        });
        return;
      }
      await this.send(paseo, agentId, text);
    });
  }

  private send(paseo: PaseoApi, agentId: string, text: string): Promise<void> {
    return paseo.agents.ref(agentId).send(text, { sourceAgentId: DEBRIEF_SENDER_ID, activeTurnBehavior: "steer" });
  }

  /** Sends held notes whose agent no longer has a permission open; keeps the rest. */
  async flush(paseo: PaseoApi, workspaceId: string): Promise<number> {
    const ledger = await readLedger(workspaceId);
    if (ledger.queue.length === 0) return 0;
    const agents = [...new Set(ledger.queue.map((note) => note.agentId))];
    let held = 0;
    await Promise.all(
      agents.map((agentId) =>
        serialized(`notes:${agentId}`, async () => {
          if (await this.hasPendingPermission(paseo, agentId)) {
            held += 1;
            return;
          }
          // Re-read inside the agent's queue: a flush that ran while this one waited has already sent some.
          const current = await readLedger(workspaceId);
          const sent: string[] = [];
          for (const note of current.queue.filter((entry) => entry.agentId === agentId)) {
            try {
              await this.send(paseo, agentId, note.text);
              sent.push(note.id);
            } catch (error) {
              console.error(`[debrief] could not send a held note to ${agentId}: ${describe(error)}`);
              break;
            }
          }
          if (sent.length > 0) {
            await withLedger(workspaceId, (latest) => {
              latest.queue = latest.queue.filter((entry) => !sent.includes(entry.id));
            });
          }
        }),
      ),
    );
    return held;
  }

  /** Flushes after a resolution, retrying while the agent's snapshot still shows the permission. */
  private flushLater(paseo: PaseoApi, workspaceId: string, retries: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.flush(paseo, workspaceId)
        .then((held) => {
          if (held > 0 && retries > 1) this.flushLater(paseo, workspaceId, retries - 1);
        })
        .catch((error: unknown) => console.error(`[debrief] could not flush held notes: ${describe(error)}`));
    }, FLUSH_RETRY_MS);
    this.timers.add(timer);
  }

  /**
   * Upserts the comment's thread card. It stays on the agent that first got
   * it, while that agent exists; `fallbackAgentId` is where a new card goes.
   */
  async upsertRow(paseo: PaseoApi, review: Review, comment: Comment, fallbackAgentId: string | null, deleted = false): Promise<void> {
    try {
      const agentId = await withLedger(review.workspaceId, (ledger) => {
        const existing = ledger.rows[comment.id];
        if (existing !== undefined) return existing;
        if (fallbackAgentId === null) return null;
        ledger.rows[comment.id] = fallbackAgentId;
        return fallbackAgentId;
      });
      if (agentId === null) return;
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: threadRowId(comment.id),
        kind: THREAD_KIND,
        version: THREAD_VERSION,
        // A JSON round trip drops the optional keys `JsonValue` will not take as undefined.
        data: JSON.parse(JSON.stringify(threadRow(review.workspaceId, comment, deleted))) as TimelineData,
      });
    } catch (error) {
      console.error(`[debrief] could not update the thread card for ${comment.id}: ${describe(error)}`);
    }
  }
}
