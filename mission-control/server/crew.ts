/**
 * What the user can do to one crewmate from the board: steer it, interrupt
 * its turn, end it, or have Mission Control relaunch it.
 *
 * None of these tears anything down. Ending a crewmate archives the agent and
 * leaves its workspace and worktree exactly as they are; relaunching is the
 * Mission Control's job, because it owns the brief and the backlog.
 *
 * Steering goes straight to the crewmate — the user's words are
 * authoritative, as if typed into its tab — and Mission Control hears about it
 * when that turn ends, through `UserSteers` and the `turn_ended` hook.
 */
import type { PluginLifecycleRegistration } from "@getpaseo/plugin/server";

import { CREW_LABELS, type MissionControlConfig } from "../shared/fleet";
import { stopAgent } from "./cli";
import { closingText, fetchLiveAgent, resolveCoordinator } from "./fleet";
import type { PaseoAgent, PaseoApi, TimelineItem } from "./host-types";
import { askCoordinator } from "./coordinator";
import { sendWithoutInterrupting } from "./send";
import { TEMPLATES, message } from "./templates";

/** The most of a crewmate's answer relayed to Mission Control; the same cap Paseo's own notification uses. */
const MAX_RELAYED_CHARS = 4000;

/**
 * Where a crewmate runs: the API of its host (this daemon or a connected one),
 * that host's server ID (null for this daemon), and the agent IDs the backlog
 * names, which count as crew even without the label.
 */
export interface CrewTarget {
  api: PaseoApi;
  serverId: string | null;
  named: ReadonlySet<string>;
}

/** Refuses anything that is not a live crewmate, so the board cannot be pointed at an arbitrary agent. */
async function requireCrew(target: CrewTarget, agentId: string): Promise<PaseoAgent> {
  const agent = await fetchLiveAgent(target.api, agentId);
  if (agent === null) throw new Error(`Paseo has no live agent ${agentId}.`);
  if (agent.labels[CREW_LABELS.role] !== CREW_LABELS.crewRole && !target.named.has(agentId)) {
    throw new Error(`${agent.title ?? agentId} is not one of the crew.`);
  }
  return agent;
}

/** A steer nobody answered in this long is forgotten, so the map cannot grow for the life of the daemon. */
const STEER_TTL_MS = 60 * 60 * 1000;

/**
 * What the user has said to each crewmate that Mission Control has not yet
 * been told about. In memory: a plugin reload forgets it, and Mission Control
 * learns of the exchange the next time it looks at that crewmate.
 *
 * A steer is handed over only by a turn that *contains* it — its text is one
 * of the ended turn's user messages. The first `turn_ended` after a steer is
 * not always the answer: the turn that was running when it was sent may end
 * first, and a provider that cannot join a running turn cancels it and starts
 * a new one, so the ended turn has to show it read the words.
 */
export class UserSteers {
  private readonly pending = new Map<string, Array<{ text: string; at: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  record(agentId: string, text: string): void {
    this.pending.set(agentId, [...this.fresh(agentId), { text, at: this.now() }]);
  }

  /** Whether anything the user said to this crewmate is waiting to be relayed. */
  has(agentId: string): boolean {
    return this.fresh(agentId).length > 0;
  }

  /** Takes back a steer whose send failed, so it is never relayed as said. */
  forget(agentId: string, text: string): void {
    const kept = this.fresh(agentId).filter((entry) => entry.text !== text);
    if (kept.length === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, kept);
  }

  /** The steers `userMessages` shows were read, removed; null when it shows none of them. */
  take(agentId: string, userMessages: readonly string[]): string[] | null {
    const entries = this.fresh(agentId);
    const read = entries.filter((entry) => userMessages.some((message) => message.includes(entry.text.trim())));
    const left = entries.filter((entry) => !read.includes(entry));
    if (left.length === 0) this.pending.delete(agentId);
    else this.pending.set(agentId, left);
    return read.length === 0 ? null : read.map((entry) => entry.text);
  }

  private fresh(agentId: string): Array<{ text: string; at: number }> {
    const cutoff = this.now() - STEER_TTL_MS;
    return (this.pending.get(agentId) ?? []).filter((entry) => entry.at >= cutoff);
  }
}

/**
 * Recorded before the send, so a turn that ends the instant the message lands
 * still finds it; taken back if the send fails.
 */
/** Tells Mission Control what the user said to a crewmate and what it answered. */
export type RelaySteer = (agent: { id: string; title: string | null }, said: string[], answer: string | null) => Promise<void>;

/**
 * Lifecycle hooks fire only for this daemon's agents, so a steer to a crewmate
 * on a connected host is relayed here instead: wait for that turn on its host,
 * then read its closing message there.
 */
async function relayRemoteSteer(target: CrewTarget, agent: PaseoAgent, text: string, relay: RelaySteer): Promise<void> {
  try {
    const handle = target.api.agents.ref(agent.id);
    await handle.waitForFinish(STEER_TTL_MS);
    const page = await handle.timeline.refetch({ direction: "tail", limit: 30, projection: "projected" });
    await relay(agent, [text], closingText(page.entries.map((entry) => entry.item)));
  } catch (error) {
    console.error(`[mission-control] could not tell Mission Control about the user's words to ${agent.id}:`, error);
  }
}

export async function steerCrew(
  target: CrewTarget,
  steers: UserSteers,
  agentId: string,
  text: string,
  relay: RelaySteer,
): Promise<void> {
  const agent = await requireCrew(target, agentId);
  if (target.serverId !== null) {
    await sendWithoutInterrupting(target.api, agentId, text);
    void relayRemoteSteer(target, agent, text, relay);
    return;
  }
  steers.record(agentId, text);
  try {
    await sendWithoutInterrupting(target.api, agentId, text);
  } catch (error) {
    steers.forget(agentId, text);
    throw error;
  }
}

/**
 * The CLI stops a turn only on this daemon, and the SDK has no stop, so a
 * crewmate on a connected host is interrupted with a message that replaces
 * its turn instead.
 */
export async function interruptCrew(target: CrewTarget, agentId: string): Promise<void> {
  const agent = await requireCrew(target, agentId);
  if (target.serverId === null) {
    await stopAgent(agentId);
    return;
  }
  // A turn that ended since the card was drawn has nothing to interrupt; a message now would start one.
  if (agent.status !== "running" && agent.status !== "initializing") return;
  await target.api.agents
    .ref(agentId)
    .send(await message(TEMPLATES.remoteInterrupt), { activeTurnBehavior: "interrupt" });
}

export async function exitCrew(target: CrewTarget, agentId: string): Promise<void> {
  await requireCrew(target, agentId);
  await target.api.agents.ref(agentId).archive();
}

/** What Mission Control is asked when the user presses Relaunch (`templates/messages/relaunch.md`). */
export function relaunchText(
  agent: Pick<PaseoAgent, "id" | "title" | "labels">,
  note: string,
  serverId: string | null = null,
): Promise<string> {
  const task = agent.labels[CREW_LABELS.task];
  return message(TEMPLATES.relaunch, {
    worker: task ?? `"${agent.title ?? agent.id}"`,
    agentId: serverId === null ? agent.id : `${agent.id} (serverId ${serverId})`,
    note: note.trim(),
  });
}

/** `paseo` is this daemon's API, where Mission Control lives; `target` is the crewmate's host. */
export async function relaunchCrew(paseo: PaseoApi, target: CrewTarget, agentId: string, note: string): Promise<string> {
  const agent = await requireCrew(target, agentId);
  return askCoordinator(paseo, { text: await relaunchText(agent, note, target.serverId) });
}

/** What Mission Control is told when a turn the user started from the board ends (`templates/messages/steer-relay.md`). */
export async function relayText(
  agent: { id: string; title: string | null },
  user: readonly string[],
  answer: string | null,
): Promise<string> {
  const response =
    answer === null
      ? await message(TEMPLATES.steerRelayNoAnswer)
      : answer.length <= MAX_RELAYED_CHARS
        ? answer
        : await message(TEMPLATES.steerRelayClipped, { answer: answer.slice(0, MAX_RELAYED_CHARS) });
  return message(TEMPLATES.steerRelay, {
    agentId: agent.id,
    title: agent.title ?? agent.id,
    user: user.join("\n\n"),
    response,
  });
}

/**
 * Paseo tells Mission Control when a crewmate *it* prompted finishes. A turn
 * the user started from the board was prompted by nobody Paseo knows to
 * notify, so this hook does it: when that turn ends, Mission Control gets what
 * the user said and what the crewmate answered.
 */
export function registerSteerRelay(
  server: PluginLifecycleRegistration,
  steers: UserSteers,
  readConfig: () => Promise<MissionControlConfig>,
): () => void {
  return server.on("agent.turn_ended", async (event, { paseo }) => {
    // A cancelled turn is the one a steer replaced, not the one that answers it.
    if (event.outcome.kind === "canceled" || !steers.has(event.agent.id)) return;
    // The hook's own `timeline` is always empty on current Paseo, so the turn is read back from the daemon.
    let items: TimelineItem[];
    try {
      const page = await paseo.agents
        .ref(event.agent.id)
        .timeline.refetch({ direction: "tail", limit: 30, projection: "projected" });
      items = page.entries.map((entry) => entry.item);
    } catch (error) {
      console.error(`[mission-control] could not read the turn of ${event.agent.id}:`, error);
      return;
    }
    const userMessages = items.flatMap((item) => (item.type === "user_message" ? [item.text] : []));
    const user = steers.take(event.agent.id, userMessages);
    if (user === null) return;
    try {
      const coordinator = await resolveCoordinator(paseo, await readConfig());
      if (coordinator.agent === null) return;
      await sendWithoutInterrupting(
        paseo,
        coordinator.agent.id,
        await relayText(event.agent, user, closingText(items)),
      );
    } catch (error) {
      console.error(`[mission-control] could not tell Mission Control about the user's words to ${event.agent.id}:`, error);
    }
  });
}
