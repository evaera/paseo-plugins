/**
 * The board, assembled on the daemon: Mission Control, every crewmate Paseo
 * knows by its labels, the backlog Mission Control keeps, and each crewmate's
 * last status line — joined into cards and filed into columns.
 *
 * Status lines are keyed by the agent's `updatedAt`, so a quiet crewmate is
 * not asked for its timeline again. Workspace badges share the short-lived
 * list snapshots in daemon-reads, independently of streaming agent updates.
 */
import { createHash } from "node:crypto";
import { actionBasis, projectLegacyDecision, projectTaskFile, readCardTurn, scopedActions } from "./task-card";
import { realpath } from "node:fs/promises";

import {
  CREW_LABELS,
  type AgentSummary,
  type BacklogItem,
  type ColumnId,
  type CrewReportSummary,
  type DebriefInfo,
  type MissionControlConfig,
  type Fleet,
  type FleetCard,
  type WatchSummary,
} from "../shared/fleet";
import { resolveHome } from "./config";
import { parseCrewReport, reportUrl } from "./crew-report";
import { readCharterState } from "./charter-file";
import { debriefInfo, debriefInstalled } from "./debrief";
import { isHomeReady, readBacklog, readProjects, readSuggestions, readToolbar } from "./home";
import type { AgentListOptions, PaseoAgent, PaseoApi, TimelineItem, TimelinePage } from "./host-types";
import { HOST_TIMEOUT_MS, withTimeout, type CrewHost, type HostClients } from "./hosts";
import { timelineTails, type TimelineTails } from "./timeline-tails";

const PAGE_SIZE = 200;

export function summarizeAgent(
  agent: PaseoAgent,
  host: Pick<CrewHost, "serverId" | "label"> = { serverId: null, label: null },
): AgentSummary {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title,
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    cwd: agent.cwd,
    pendingPermissions: agent.pendingPermissions.length,
    activeTurnId: agent.activeTurn?.turnId ?? null,
    requiresAttention: agent.requiresAttention === true,
    lastError: agent.lastError ?? null,
    updatedAt: agent.updatedAt,
    createdAt: agent.createdAt ?? null,
    labels: agent.labels,
    serverId: host.serverId,
    host: host.label,
  };
}

/** Every agent matching `filter`, across pages, archived ones excluded. */
export async function listAgents(
  paseo: PaseoApi,
  filter: NonNullable<AgentListOptions["filter"]> = {},
): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { ...filter, includeArchived: false },
      page: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
    });
    agents.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return agents.filter((agent) => agent.archivedAt === null || agent.archivedAt === undefined);
}

/**
 * Mission Control: the agent the config names, while Paseo still has it.
 *
 * The config is the only source. The agent also carries a `pmc.role`
 * label, but that is for people (`paseo ls --label pmc.role=mission-control`)
 * and is not consulted here: the SDK cannot take a label off, so falling back
 * to it would bring a released Mission Control straight back.
 */
export async function resolveCoordinator(
  paseo: PaseoApi,
  config: MissionControlConfig,
): Promise<{ agent: PaseoAgent | null; missing: boolean }> {
  const configured = config.coordinatorAgentId.trim();
  if (configured === "") return { agent: null, missing: false };
  const agent = await fetchLiveAgent(paseo, configured);
  return agent === null ? { agent: null, missing: true } : { agent, missing: false };
}

/**
 * One agent, or null when Paseo no longer has it or has archived it. The
 * daemon answers an unknown id with an error ("Agent not found: …") rather
 * than an empty result, so that error is the null; anything else — the
 * daemon unreachable, a timeout — is thrown, because "your Mission Control is
 * gone" is the wrong thing to say about a hiccup.
 */
export async function fetchLiveAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  let found: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
  try {
    found = await paseo.agents.ref(agentId).refresh();
  } catch (error) {
    if (error instanceof Error && /not found|unknown agent|no agent/i.test(error.message)) return null;
    throw error;
  }
  const agent = found?.agent ?? null;
  if (agent === null || (agent.archivedAt !== null && agent.archivedAt !== undefined)) return null;
  return agent;
}

/**
 * The text a turn closed with: the assistant messages at the very end of the
 * timeline, joined, since a streamed reply can arrive as several items. Any
 * other item — a tool call, the user's message — ends the search.
 */
export function closingText(items: readonly TimelineItem[]): string | null {
  const parts: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) break;
    if (item.type === "assistant_message") {
      parts.unshift(item.text);
      continue;
    }
    // Plugin rows and notices can land after a turn without being part of it.
    if (item.type === "plugin" || item.type === "notification") continue;
    break;
  }
  const text = parts.join("");
  return text.trim() === "" ? null : text;
}

/** Projected Codex tails can append unassigned shell receipts after the turn's closing message. */
export function reportFromTimeline(entries: TimelinePage["entries"]): CrewReportSummary | null {
  let end = entries.length;
  let skippedReceipt = false;
  while (end > 0) {
    const entry = entries[end - 1]!;
    const { item } = entry;
    if (item.type === "tool_call" && item.name === "shell" && !entry.turnId &&
        (item.status === "completed" || item.status === "failed")) {
      skippedReceipt = true;
    } else if (item.type !== "plugin" && item.type !== "notification") {
      break;
    }
    end -= 1;
  }
  const last = entries[end - 1];
  if (last?.item.type !== "assistant_message" || (skippedReceipt && !last.turnId)) return null;
  let start = end - 1;
  while (start > 0 && entries[start - 1]?.turnId === last.turnId) start -= 1;
  const report = parseCrewReport(closingText(entries.slice(start, end).map((entry) => entry.item)));
  if (report?.state === "review" || report?.state === "needs-decision") report.sequence = last.seqStart;
  return report;
}

interface CachedReport {
  updatedAt: string;
  report: CrewReportSummary | null;
  turnId: string | null;
}

/** Cached status lines; changed workers refresh in the background without holding up the board. */
export class ReportCache {
  private readonly reports = new Map<string, CachedReport>();
  private readonly pending = new Set<string>();
  private readonly latest = new Map<string, PaseoAgent>();
  private readonly cooldown = new Map<string, { until: number; retryMs: number }>();
  private coordinatorId = "";

  constructor(private readonly tails: TimelineTails = timelineTails) {}

  private allowed(agent: PaseoAgent): boolean {
    return agent.id !== this.coordinatorId && agent.labels[CREW_LABELS.role] !== CREW_LABELS.coordinatorRole &&
      (agent.archivedAt ?? null) === null && agent.status !== "closed" && agent.status !== "running" && agent.status !== "initializing";
  }

  async reportFor(paseo: PaseoApi, agent: PaseoAgent): Promise<CrewReportSummary | null> {
    const cached = this.reports.get(agent.id);
    const previous = cached?.report;
    const fallback = previous?.state === "review" || previous?.state === "needs-decision" ? null : previous ?? null;
    const latest = this.latest.get(agent.id);
    if (latest !== undefined && latest.updatedAt > agent.updatedAt) return fallback;
    this.latest.set(agent.id, agent);
    if (agent.status === "closed") return null;
    if (!this.allowed(agent)) return fallback;
    if (cached !== undefined && cached.updatedAt >= agent.updatedAt) return cached.report;
    if (this.pending.has(agent.id) || Date.now() < (this.cooldown.get(agent.id)?.until ?? 0)) return fallback;

    this.pending.add(agent.id);
    const updatedAt = agent.updatedAt;
    const started = Date.now();
    // Never make a fleet snapshot wait for a timeline projection. One queued/in-flight read per agent.
    void this.tails.read(paseo, {
      agentId: agent.id, source: "board-report", updatedAt,
      allowed: () => { const current = this.latest.get(agent.id); return current !== undefined && this.allowed(current); },
    }).then((page) => {
      const current = this.latest.get(agent.id);
      if (page === null || current === undefined) return;
      const duration = Date.now() - started;
      this.cooldown.set(agent.id, { until: Date.now() + (duration >= 1000 ? Math.min(60_000, duration * 2) : 0), retryMs: 5000 });
      if (!this.allowed(current)) return;
      const report = reportFromTimeline(page.entries);
      const turnId = [...page.entries].reverse().find((entry) => entry.turnId && entry.item.type !== "plugin" && entry.item.type !== "notification")?.turnId ?? null;
      this.reports.set(agent.id, { updatedAt: page.agent?.updatedAt ?? updatedAt, report, turnId });
    }).catch(() => {
      if (!this.latest.has(agent.id)) return;
      const retryMs = Math.min(60_000, Math.max(this.cooldown.get(agent.id)?.retryMs ?? 5000, (Date.now() - started) * 2));
      this.cooldown.set(agent.id, { until: Date.now() + retryMs, retryMs: Math.min(60_000, retryMs * 2) });
    }).finally(() => this.pending.delete(agent.id));
    return fallback;
  }

  lastTurn(id: string): string | null {
    return this.reports.get(id)?.turnId ?? null;
  }

  isCurrent(agent: Pick<AgentSummary, "id" | "updatedAt">): boolean {
    const cached = this.reports.get(agent.id);
    return cached !== undefined && cached.updatedAt >= agent.updatedAt;
  }

  /** Drops agents no longer in the crew, so the map cannot grow for the life of the daemon. */
  retain(ids: ReadonlySet<string>, coordinatorId = ""): void {
    this.coordinatorId = coordinatorId;
    for (const map of [this.reports, this.latest, this.cooldown]) {
      for (const id of map.keys()) if (!ids.has(id) || id === coordinatorId) map.delete(id);
    }
  }
}

/**
 * Where a crewmate belongs. What Paseo knows wins while the agent is busy or
 * stuck — a pending permission, an error, a turn in flight. Once its turn has
 * ended, a task held for the user (`held`, its line's `(hold: …)`) is in
 * Needs you unless the crewmate failed, because what it waits on is the
 * user; a task waiting on someone else (`waiting`) is in Waiting unless the
 * crewmate failed or asked for something; otherwise the status line decides. A live crewmate is never Done, even
 * after `done:` or `resolved:`: the task has landed only once the backlog says
 * so, and until then Mission Control still has work to do with it.
 */
export function crewColumn(
  agent: AgentSummary,
  report: CrewReportSummary | null,
  held = false,
  waiting = false,
  review = false,
): ColumnId {
  if (agent.pendingPermissions > 0) return "blocked";
  if (agent.status === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (report?.state === "needs-decision" || report?.state === "blocked") return "blocked";
  if (report?.state === "review" || (review && report?.state !== "failed")) return "review";
  if (held && report?.state !== "failed") return "blocked";
  if (waiting && report?.state !== "failed") {
    return "waiting";
  }
  switch (report?.state) {
    case "failed":
      return "failed";
    case "paused":
      return "parked";
    default:
      // Finished and waiting on Mission Control, stopped without saying why,
      // or said "working" and then stopped.
      return "idle";
  }
}

/** Where a backlog item with no crewmate on it belongs. */
export function backlogColumn(item: BacklogItem): ColumnId {
  if (item.section === "done") return "done";
  if (item.review !== undefined) return "review";
  if (item.kind === "user" || item.hold !== null) return "blocked";
  if (item.waiting !== null) return "waiting";
  if (item.parked) return "parked";
  if (item.section === "in-flight") return "idle";
  return "queued";
}

function cardLinks(reported: string | null, listed: readonly string[]): string[] {
  return [...new Set(reported === null ? listed : [reported, ...listed])];
}

export interface CrewMember {
  agent: AgentSummary;
  report: CrewReportSummary | null;
}

/**
 * Crewmates and backlog items joined into cards. A crewmate is matched to its
 * item by the task label, or by the agent id the item recorded; whatever is
 * left over on either side is a card of its own.
 */
export function buildCards(backlog: readonly BacklogItem[], crew: readonly CrewMember[]): FleetCard[] {
  const cards: FleetCard[] = [];
  const claimed = new Set<number>();

  const byUpdate = [...crew].sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt));
  for (const member of byUpdate) {
    const taskId = member.agent.labels[CREW_LABELS.task] ?? null;
    const stopped = member.agent.status === "idle" || member.agent.status === "closed";
    const matches = (item: BacklogItem, position: number) =>
      !claimed.has(position) && (item.agentId === member.agent.id || (item.agentId === null && item.id === taskId));
    const active = (item: BacklogItem, position: number) => item.section !== "done" && matches(item, position);
    const available = (item: BacklogItem, position: number) => active(item, position) && item.section === "in-flight" &&
      !item.parked && !item.waiting && !item.hold && !item.review && !item.blockedBy && item.kind !== "user";
    let index = backlog.findIndex((item, position) => available(item, position) && item.id === taskId);
    if (index < 0) index = backlog.findIndex((item, position) => available(item, position) && item.agentId === member.agent.id);
    if (index < 0) index = backlog.findIndex((item, position) => active(item, position) && item.id === taskId);
    if (index < 0) index = backlog.findIndex(active);
    if (index < 0 && stopped && !member.agent.pendingPermissions) {
      index = backlog.findIndex((item, position) => item.section === "done" && matches(item, position) && (item.id === taskId || !taskId));
    }
    const item = index === -1 ? null : (backlog[index] ?? null);
    const superseded = !item && taskId !== null && backlog.some((row) => row.id === taskId);
    if (superseded && stopped && !member.agent.pendingPermissions) continue;
    if (index !== -1) claimed.add(index);
    const parked = stopped && item?.parked && !item.review && !item.hold && !item.waiting && item.kind !== "user" && !member.agent.pendingPermissions;
    const anotherAssignment = taskId && item && item.id !== taskId && backlog.some((row) => row.id === taskId && row.section !== "done");
    const report = member.agent.status === "closed" || anotherAssignment ? null : member.report;
    cards.push({
      key: `agent:${member.agent.id}`,
      column: item?.section === "done" ? "done" : parked ? "parked" : crewColumn(member.agent, report, item?.hold != null || item?.kind === "user", item?.waiting != null, item?.review !== undefined),
      taskId: item?.id ?? (superseded ? null : taskId),
      title: item?.title ?? member.agent.title ?? taskId ?? "Untitled crewmate",
      project: item?.project ?? member.agent.labels[CREW_LABELS.project] ?? null,
      kind: item?.kind ?? member.agent.labels[CREW_LABELS.kind] ?? null,
      backlog: item,
      agent: member.agent,
      report,
      links: cardLinks(report === null ? null : reportUrl(report.text), item?.links ?? []),
    });
  }

  const owners = new Map(crew.map(({ agent }) => [agent.id, agent]));
  backlog.forEach((item, index) => {
    if (claimed.has(index)) return;
    cards.push({
      key: `backlog:${item.section}:${item.id}:${index}`,
      column: backlogColumn(item),
      taskId: item.id,
      title: item.title,
      project: item.project,
      kind: item.kind,
      backlog: item,
      agent: item.section !== "done" && item.agentId ? owners.get(item.agentId) ?? null : null,
      report: null,
      links: item.links,
    });
  });
  return cards.map((card) => {
    if (card.column !== "review" && card.column !== "blocked") return card;
    const state = card.column === "review" ? "review" : "needs-decision";
    const packet = card.report?.state === state ? card.report.packet : undefined;
    const heading = packet?.specimens?.trimStart().match(/^#{1,6}[ \t]+([^\r\n]{1,160})(?:\r?\n|$)/)?.[1];
    const assignmentTitle = card.backlog && card.agent?.labels[CREW_LABELS.task] !== card.taskId ? card.title : card.agent?.title || card.title;
    const decision = state === "review" ? card.backlog?.review : card.backlog?.hold;
    const manualChoices = card.backlog?.actions.length || card.backlog?.specimens;
    if (!decision || card.agent?.pendingPermissions || (packet && !manualChoices)) {
      return { ...card, title: packet?.title || heading || assignmentTitle };
    }
    return { ...card, title: assignmentTitle, report: { state, text: decision, packet: { specimens: card.backlog?.specimens } } };
  });
}

/** Only unresolved assignments belong on the coordinator's existing finish/wake check. */
export function followThrough(cards: FleetCard[], current: (agent: AgentSummary) => boolean) {
  return cards.flatMap((card) => {
    const item = card.backlog;
    if ((!card.coordinatorReason && card.column !== "idle") || item?.blockedBy || (item && item.section !== "in-flight" && !card.coordinatorReason)) return [];
    const worker = card.agent;
    const secondary = worker !== null && card.key !== `agent:${worker.id}`;
    if (!card.coordinatorReason && worker && worker.status !== "closed" && !secondary && !current(worker)) return [];
    const reason = card.coordinatorReason ?? (worker?.status === "closed" ? "verify-closed-worker" : secondary ? "check-shared-assignment" : !worker ? "locate-owner" :
      card.report?.state === "done" || card.report?.state === "resolved" ? "reconcile-result" : "assign-next-step");
    const agentId = worker?.id ?? item?.agentId ?? null;
    // Recording a disposition must preserve the revision it acknowledges.
    const { active: _active, consumed: _consumed, ...assignment } = item ?? {};
    const revision = createHash("sha256").update(JSON.stringify([
      item ? assignment : null, card.taskId, agentId, card.cardBasis ?? (secondary ? worker?.status : worker?.updatedAt), card.report, reason,
      ...(secondary && worker?.activeTurnId ? [worker.activeTurnId] : []),
      ...(reason === "review-checkpoint" && worker && worker.status !== "running" ? [worker.status] : []),
    ])).digest("hex");
    const detail = reason === "verify-closed-worker" ? "Check the recorded worker for recovery and the latest owner decision before dispatching." : card.report?.text ?? null;
    return [{ key: card.key, taskId: card.taskId, title: card.title, agentId, reason, revision, detail }];
  });
}

/** A coordinator receipt only resolves the specific assignment and evidence it names. */
export function applyDispositions(cards: FleetCard[], cases: ReturnType<typeof followThrough>) {
  const outstanding = new Map(cases.map((entry) => [entry.key, entry]));
  const projected = cards.map((card) => {
    const entry = outstanding.get(card.key);
    if (!entry) return card;
    const kind = entry.reason === "review-checkpoint" ? "consumed" :
      entry.reason === "check-shared-assignment" && card.agent?.status === "running" && card.agent.activeTurnId ? "active" : null;
    if (!kind) return card;
    const receipt = card.backlog?.[kind];
    if (!receipt?.startsWith(entry.revision + " ")) return card;
    const next = receipt.slice(entry.revision.length).trim();
    if (!next) return card;
    outstanding.delete(card.key);
    const disposition = { kind, next, revision: entry.revision } as const;
    return kind === "active" ? { ...card, disposition, column: "working" as const, report: { state: "working" as const, text: next } } :
      { ...card, disposition, coordinatorReason: undefined };
  });
  return { cards: projected, followThrough: [...outstanding.values()] };
}

/** Whether two paths name one directory, through symlinks; a path that does not resolve is compared as written. */
export async function sameDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
}

/**
 * Whether agents get Paseo's own tools. Without them Mission Control can talk
 * but cannot start a crewmate or hear from one, so the board says so up front.
 */
export async function readAgentTools(paseo: PaseoApi): Promise<boolean | null> {
  try {
    const { config } = await paseo.config.get();
    return config.mcp.injectIntoAgents === true;
  } catch (error) {
    console.error("[mission-control] could not read the daemon config:", error);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The agent IDs the backlog names on lines that are not done, which count as
 * crew even without the label: workers started before the plugin labelled them,
 * or by another coordinator. Never Mission Control itself.
 */
export function namedCrew(backlog: readonly BacklogItem[], coordinatorAgentId: string): Map<string, BacklogItem> {
  const coordinator = coordinatorAgentId.trim();
  const named = new Map<string, BacklogItem>();
  for (const item of backlog) {
    if (item.section === "done" || item.agentId === null || item.agentId === coordinator) continue;
    named.set(item.agentId, item);
  }
  return named;
}

/** Where each backlog-named agent was last found: a server ID, or null for this daemon. */
export type CrewLocations = Map<string, string | null>;

/**
 * The crew on every host: agents with the crew label, listed per host, and the
 * agents `named` holds, fetched one by one on the host they were last found on
 * or else on the host their `(host: …)` names, this daemon, then the rest. The
 * cost per poll follows the crew and the backlog, not every agent on every
 * host. A host that cannot be read in time is a warning, never an empty board.
 */
export async function listCrew(
  paseo: PaseoApi,
  hosts: HostClients,
  named: ReadonlyMap<string, BacklogItem>,
  locations: CrewLocations,
  warnings: string[],
): Promise<Array<{ agent: PaseoAgent; host: CrewHost }>> {
  const all = await hosts.all(paseo);
  const failed = new Set<CrewHost>();
  const fail = (host: CrewHost, error: unknown) => {
    if (failed.has(host)) return;
    failed.add(host);
    warnings.push(`Paseo could not list the crew on ${host.label ?? "this host"}: ${describe(error)}`);
    if (host.serverId !== null) void hosts.drop(host.serverId, host.api);
  };
  const labelled = await Promise.all(
    all.map(async (host) => {
      try {
        const agents = await withTimeout(
          listAgents(host.api, { labels: { [CREW_LABELS.role]: CREW_LABELS.crewRole } }),
          HOST_TIMEOUT_MS,
          host.label ?? "This daemon",
        );
        return agents.map((agent) => ({ agent, host }));
      } catch (error) {
        fail(host, error);
        return [];
      }
    }),
  );
  const crew = labelled.flat();
  const seen = new Set(crew.map(({ agent }) => agent.id));

  const order = (agentId: string, item: BacklogItem): CrewHost[] => {
    const usable = all.filter((host) => !failed.has(host));
    const known = locations.get(agentId);
    const hint = item.host?.trim().toLowerCase() ?? "";
    const first = usable.find((host) =>
      known !== undefined ? host.serverId === known : hint !== "" && host.label?.toLowerCase() === hint,
    );
    return first === undefined ? usable : [first, ...usable.filter((host) => host !== first)];
  };
  const found = await Promise.all(
    [...named].map(async ([agentId, item]) => {
      if (seen.has(agentId)) return null;
      for (const host of order(agentId, item)) {
        try {
          const agent = await withTimeout(fetchLiveAgent(host.api, agentId), HOST_TIMEOUT_MS, host.label ?? "This daemon");
          if (agent === null) continue;
          locations.set(agentId, host.serverId);
          return { agent, host };
        } catch (error) {
          fail(host, error);
        }
      }
      locations.delete(agentId);
      return null;
    }),
  );
  for (const member of found) if (member !== null) crew.push(member);
  for (const agentId of [...locations.keys()]) if (!named.has(agentId)) locations.delete(agentId);
  return crew;
}

export async function loadFleet(
  paseo: PaseoApi,
  hosts: HostClients,
  config: MissionControlConfig,
  reports: ReportCache,
  watchSummaries: () => Promise<WatchSummary[]> = async () => [],
  locations: CrewLocations = new Map(),
): Promise<Fleet> {
  const home = resolveHome(config);
  const warnings: string[] = [];

  const backlogRead = readBacklog(home).catch((error: unknown): BacklogItem[] => {
    warnings.push(`The backlog could not be read: ${describe(error)}`);
    return [];
  });
  const [homeReady, backlog, foundCrew, projects, suggestions, toolbar, coordinator, agentTools, charter, watches] = await Promise.all([
    isHomeReady(home),
    backlogRead,
    backlogRead.then((items) => listCrew(paseo, hosts, namedCrew(items, config.coordinatorAgentId), locations, warnings)),
    readProjects(home).catch((error: unknown) => {
      warnings.push(`The project registry could not be read: ${describe(error)}`);
      return [];
    }),
    readSuggestions(home).catch((error: unknown) => {
      warnings.push(`The suggestions could not be read: ${describe(error)}`);
      return [];
    }),
    readToolbar(home).catch((error: unknown) => {
      warnings.push(`state/toolbar.json could not be read: ${describe(error)}`);
      return undefined;
    }),
    resolveCoordinator(paseo, config),
    readAgentTools(paseo),
    readCharterState(home).catch((error: unknown) => {
      warnings.push(`The charter could not be read: ${describe(error)}`);
      return null;
    }),
    watchSummaries().catch((error: unknown) => {
      warnings.push(`The watches could not be read: ${describe(error)}`);
      return [];
    }),
  ]);

  const coordinatorId = config.coordinatorAgentId.trim();
  const crewAgents = foundCrew.filter(({ agent }) => agent.id !== coordinatorId && agent.labels[CREW_LABELS.role] !== CREW_LABELS.coordinatorRole);
  reports.retain(new Set(crewAgents.map(({ agent }) => agent.id)), coordinatorId);
  const crew = await Promise.all(
    crewAgents.map(async ({ agent, host }) => ({
      agent: summarizeAgent(agent, host),
      report: await reports.reportFor(host.api, agent).catch((error: unknown) => {
        console.error(`[mission-control] could not read the status line of ${agent.id}:`, error);
        return null;
      }),
    })),
  );

  // Each worker's workspace as Debrief sees it, for its Diff and Story buttons: on this Mac while Debrief is here, and
  // on every other host through that host's Paseo (whether its Debrief is there is the app's to see).
  const debrief = new Map<string, DebriefInfo>();
  const localDebrief = await debriefInstalled();
  await Promise.all(
    crewAgents
      .filter(({ agent, host }) => agent.workspaceId != null && (host.serverId !== null || localDebrief))
      .map(async ({ agent, host }) => {
        const workspaceId = agent.workspaceId ?? "";
        // A host too slow to say what changed still has a workspace Debrief can open.
        const info = await withTimeout(debriefInfo(host.api, workspaceId, host.serverId), HOST_TIMEOUT_MS, "A workspace's changes").catch(
          (): DebriefInfo => ({ workspaceId, serverId: host.serverId, additions: 0, deletions: 0, openComments: 0, story: false }),
        );
        if (info !== null) debrief.set(agent.id, info);
      }),
  );
  const workers = new Map(crewAgents.map(({ agent }) => [agent.id, agent]));
  const projected = await Promise.all(buildCards(backlog, crew).map(async (card) => {
    const worker = card.agent && workers.get(card.agent.id);
    if (!card.backlog?.cardEpoch || !worker || card.backlog.section !== "in-flight") return projectLegacyDecision(card);
    const turn = card.agent?.serverId ? worker.activeTurn?.turnId ?? reports.lastTurn(worker.id) : await readCardTurn(home, worker.id);
    const basis = actionBasis(card, worker, turn);
    return projectTaskFile(home, card, basis, reports.isCurrent(worker));
  }));
  const cards = projected.map((card) => {
    const info = card.agent === null ? undefined : debrief.get(card.agent.id);
    const actionRevision = card.column === "review" || card.column === "blocked"
      ? createHash("sha256").update(JSON.stringify([
          card.taskId ?? card.key, card.agent?.id, card.agent?.serverId, card.column,
          card.report, card.backlog?.hold, card.backlog?.review, card.backlog?.actions,
          card.agent?.pendingPermissions, card.links, card.backlog?.reportPath,
          ...(card.cardBasis ? [card.cardBasis] : []),
        ])).digest("hex")
      : undefined;
    return {
      ...scopedActions(card),
      ...(info === undefined ? {} : { debrief: info }),
      ...(actionRevision === undefined ? {} : { actionRevision }),
    };
  });

  const incomplete = warnings.some((warning) => warning.startsWith("The backlog") || warning.startsWith("Paseo could not list the crew"));
  return {
    home,
    homeReady,
    coordinator: coordinator.agent === null ? null : summarizeAgent(coordinator.agent),
    coordinatorMissing: coordinator.missing,
    coordinatorInHome: coordinator.agent === null ? true : await sameDirectory(coordinator.agent.cwd, home),
    ...applyDispositions(cards, followThrough(incomplete ? cards.filter((card) => card.backlog && card.agent) : cards, (agent) => reports.isCurrent(agent))),
    reconciliationPending: incomplete || cards.some((card) => card.agent?.status === "idle" && !card.coordinatorReason && card.key === `agent:${card.agent.id}` && card.column === "idle" && !reports.isCurrent(card.agent)),
    projects,
    suggestions,
    ...(toolbar === undefined ? {} : { toolbar }),
    watches,
    agentTools,
    // A home nobody has launched in has no charter of the user's to be out of date.
    charterOutdated: homeReady && charter !== null && charter.outdated,
    warnings,
  };
}
