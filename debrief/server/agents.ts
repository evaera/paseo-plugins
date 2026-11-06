/**
 * Which agent a review talks to.
 *
 * The review's `agentId` when it is still a live agent of the workspace;
 * otherwise the workspace's most recently active agent; otherwise none, and
 * `ensureTargetAgent` starts one when a note has to go somewhere. The
 * agent-list RPC has no workspace filter, so the whole list is paged and
 * filtered here.
 */
import type { AgentChoice, Review } from "../shared/review";
import type { PaseoAgent, PaseoApi } from "./host-types";

const PAGE_SIZE = 200;

export const REVIEWEE_LABEL = { key: "debrief.role", value: "reviewee" } as const;

/** Every non-archived, non-internal agent, across pages. */
export async function listAllAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived: false },
      page: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
    });
    agents.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return agents.filter((agent) => (agent.archivedAt ?? null) === null && agent.internal !== true);
}

/** When an agent last did or was told something, for "most recent". */
export function lastActivity(agent: PaseoAgent): number {
  const times = [agent.updatedAt, agent.lastUserMessageAt, agent.createdAt]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return times.length === 0 ? 0 : Math.max(...times);
}

/** The workspace's agents, most recent first. */
export async function workspaceAgents(paseo: PaseoApi, workspaceId: string): Promise<PaseoAgent[]> {
  const agents = (await listAllAgents(paseo)).filter((agent) => agent.workspaceId === workspaceId);
  return agents.sort((a, b) => lastActivity(b) - lastActivity(a));
}

export function agentChoice(agent: PaseoAgent): AgentChoice {
  return {
    id: agent.id,
    title: agent.title ?? `Agent ${agent.id.slice(0, 8)}`,
    provider: agent.model === null ? agent.provider : `${agent.provider}/${agent.model}`,
    status: agent.status,
  };
}

/** The rule, over an already-fetched list (most recent first). */
export function pickTarget(review: Pick<Review, "agentId">, agents: readonly PaseoAgent[]): PaseoAgent | null {
  if (review.agentId !== null) {
    const bound = agents.find((agent) => agent.id === review.agentId);
    if (bound !== undefined) return bound;
  }
  return agents[0] ?? null;
}

export async function resolveTarget(paseo: PaseoApi, workspaceId: string, review: Pick<Review, "agentId">): Promise<PaseoAgent | null> {
  return pickTarget(review, await workspaceAgents(paseo, workspaceId));
}

/**
 * The provider a new reviewee starts on. Paseo has no daemon-wide default
 * provider (the app keeps its preference client-side), so this follows what
 * the user last used: the most recent agent anywhere, then the first
 * available of Claude and Codex, then whatever is available.
 */
async function defaultProvider(paseo: PaseoApi): Promise<string> {
  const recent = (await listAllAgents(paseo)).sort((a, b) => lastActivity(b) - lastActivity(a))[0];
  if (recent !== undefined) return recent.model === null ? recent.provider : `${recent.provider}/${recent.model}`;
  const { providers } = await paseo.providers.listAvailable();
  const available = providers.filter((entry) => entry.available).map((entry) => entry.provider);
  const preferred = ["claude", "codex"].find((id) => available.includes(id));
  const chosen = preferred ?? available[0];
  if (chosen === undefined) throw new Error("No agent provider is available to send the review to.");
  return chosen;
}

/**
 * The target, starting one with `prompt` as its first message when the
 * workspace has none. Returns whether it was created, because a created
 * agent has already received `prompt` and must not be sent it again.
 */
export async function ensureTargetAgent(
  paseo: PaseoApi,
  workspaceId: string,
  review: Pick<Review, "agentId">,
  prompt: string,
): Promise<{ agentId: string; title: string; created: boolean }> {
  const existing = await resolveTarget(paseo, workspaceId, review);
  if (existing !== null) return { agentId: existing.id, title: existing.title ?? "", created: false };
  const handle = await paseo.workspaces.ref(workspaceId).agents.create({
    config: { provider: await defaultProvider(paseo) },
    title: "Debrief review",
    labels: { [REVIEWEE_LABEL.key]: REVIEWEE_LABEL.value },
    prompt,
  });
  return { agentId: handle.id, title: "Debrief review", created: true };
}
