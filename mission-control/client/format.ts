import type { PluginSvgIcon, PluginTheme } from "@getpaseo/plugin";

import {
  COLUMN_IDS,
  type AgentSummary,
  type ColumnId,
  type FleetCard,
  type WatchResult,
  type WatchSummary,
} from "../shared/fleet";

export interface ColumnMeta {
  id: ColumnId;
  title: string;
  /** Lucide icon name. */
  icon: string;
}

export const COLUMNS: Readonly<Record<ColumnId, ColumnMeta>> = {
  queued: { id: "queued", title: "Inbox", icon: "Inbox" },
  working: { id: "working", title: "Working", icon: "Hammer" },
  blocked: { id: "blocked", title: "Needs you", icon: "Ban" },
  parked: { id: "parked", title: "Parked", icon: "Clock" },
  done: { id: "done", title: "Done", icon: "Check" },
  failed: { id: "failed", title: "Failed", icon: "AlertTriangle" },
  idle: { id: "idle", title: "Idle", icon: "CircleDot" },
  waiting: { id: "waiting", title: "Waiting", icon: "Hourglass" },
};

/** The board's columns, in the order work moves through them. */
export const BOARD_ORDER: readonly ColumnId[] = ["queued", "working", "blocked", "idle", "waiting", "parked", "failed", "done"];

/** The watches footer's one line: "pr-watch · ran 4m ago · nothing new", or a count past one. */
export function watchesSummary(watches: readonly WatchSummary[], now: number = Date.now()): string {
  const first = watches[0];
  if (first === undefined) return "";
  if (watches.length === 1) return `${first.name} · ${watchStatusText(first, now)}`;
  const failing = watches.filter((watch) => watch.lastResult === "failed" || watch.lastResult === "invalid").length;
  return `${watches.length} watches${failing === 0 ? "" : ` · ${failing} failing`}`;
}

export function columnTone(theme: PluginTheme, column: ColumnId): string {
  switch (column) {
    case "working":
      return theme.colors.accent;
    case "blocked":
    case "parked":
      return theme.colors.statusWarning;
    case "done":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    // Nothing for anyone here to do, so neither a status colour nor Idle's grey.
    case "waiting":
      return theme.colors.foreground;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function agentStatusLabel(agent: AgentSummary): string {
  if (agent.pendingPermissions > 0) {
    return agent.pendingPermissions === 1 ? "waiting on a permission" : `waiting on ${agent.pendingPermissions} permissions`;
  }
  switch (agent.status) {
    case "running":
      return "working";
    case "initializing":
      return "starting";
    case "error":
      return "errored";
    case "closed":
      return "closed";
    default:
      return "idle";
  }
}

export function agentStatusTone(theme: PluginTheme, agent: AgentSummary): string {
  // Not `requiresAttention`: that is Paseo's "finished, not looked at yet", not a request for the user.
  if (agent.pendingPermissions > 0) return theme.colors.statusWarning;
  if (agent.status === "error") return theme.colors.statusDanger;
  if (agent.status === "running" || agent.status === "initializing") return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

/** A token count as Paseo's own context meter writes it: "840", "84k", "1m". */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}

/** How full a context window is, in percent, or null while the provider has not said. */
export function contextPercent(used: number | null | undefined, max: number | null | undefined): number | null {
  if (typeof used !== "number" || typeof max !== "number") return null;
  if (!Number.isFinite(used) || !Number.isFinite(max) || used < 0 || max <= 0) return null;
  return (used / max) * 100;
}

/** The meter's colour, at Paseo's own thresholds: past 90% it is danger, from 70% a warning. */
export function contextTone(theme: PluginTheme, percent: number): string {
  if (percent > 90) return theme.colors.statusDanger;
  if (percent >= 70) return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

const WATCH_RESULTS: Readonly<Record<WatchResult, string>> = {
  never: "not run yet",
  silent: "nothing new",
  queued: "waiting for Mission Control",
  dropped: "dropped before Mission Control could take it",
  delivered: "sent to Mission Control",
  failed: "failed",
  invalid: "cannot run",
};

/** One line on how a watch stands: "every 5 min" is the schedule's, this is the rest — "off · ran 5m ago · nothing new". */
export function watchStatusText(watch: WatchSummary, now: number = Date.now()): string {
  const parts: string[] = [];
  if (!watch.enabled) parts.push("off");
  if (watch.running) parts.push("running now");
  if (watch.lastRunAt !== null && watch.lastResult !== "invalid") parts.push(`ran ${relativeTime(watch.lastRunAt, now)}`);
  parts.push(WATCH_RESULTS[watch.lastResult]);
  return parts.join(" · ");
}

export function watchTone(theme: PluginTheme, watch: WatchSummary): string {
  if (!watch.enabled) return theme.colors.foregroundMuted;
  switch (watch.lastResult) {
    case "failed":
    case "invalid":
      return theme.colors.statusDanger;
    case "queued":
    case "dropped":
      return theme.colors.statusWarning;
    case "delivered":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What showing the Files view changes about the saved layout: a wide layout
 * whose right pane is hidden brings it back, or opening a file there would
 * draw nothing. A phone shows Files as a tab, and a shown pane needs nothing.
 */
export function revealFilesPatch(compact: boolean, boardCollapsed: boolean): { boardCollapsed: false } | null {
  return !compact && boardCollapsed ? { boardCollapsed: false } : null;
}

/** A path under a home directory written from `~`, as Paseo's hover card writes it. */
export function homePath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * When a card was added: its task's `(since …)`, a date Mission Control wrote,
 * or else when its worker was created. `ago` is how long ago, in days where
 * only a day is known — "17h ago" would claim more than Mission Control wrote —
 * and `exact` is the date written out, for the tooltip.
 */
export function addedAt(
  card: Pick<FleetCard, "backlog" | "agent">,
  now: Date = new Date(),
): { iso: string; ago: string; exact: string } | null {
  const since = card.backlog?.since ?? null;
  const day = since === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(since.trim());
  if (day !== null && day !== undefined) {
    const local = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Math.max(0, Math.round((today.getTime() - local.getTime()) / 86_400_000));
    return {
      iso: local.toISOString(),
      ago: days === 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`,
      exact: local.toLocaleDateString(undefined, { dateStyle: "medium" }),
    };
  }
  const created = card.agent?.createdAt ?? null;
  if (created === null || Number.isNaN(Date.parse(created))) return null;
  return {
    iso: created,
    ago: relativeTime(created, now.getTime()),
    exact: new Date(created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  };
}

/** The last `max` characters of a path, from a separator, so the end — the part that differs — survives. */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const tail = path.slice(-max);
  const cut = tail.indexOf("/");
  return `…${cut > 0 ? tail.slice(cut) : tail}`;
}

/**
 * A model as people say it: `claude-opus-5-5` is "Opus 5.5", `gpt-5.5` is "GPT-5.5"; anything else as
 * Paseo names it.
 */
export function modelName(agent: Pick<AgentSummary, "provider" | "model">): string {
  const model = agent.model ?? agent.provider;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(model);
  if (claude !== null) {
    const family = (claude[1] ?? "").replace(/^\w/, (first) => first.toUpperCase());
    return claude[3] === undefined ? `${family} ${claude[2]}` : `${family} ${claude[2]}.${claude[3]}`;
  }
  if (/^gpt-/i.test(model)) return model.replace(/^gpt/i, "GPT");
  return model;
}

/** The provider and model, `claude/opus` style, or whichever of the two is known. */
export function modelLabel(agent: Pick<AgentSummary, "provider" | "model">): string {
  return agent.model === null ? agent.provider : `${agent.provider}/${agent.model}`;
}

/** Cards grouped by column, each column in the order the daemon sent them. */
export function groupCards(cards: readonly FleetCard[]): Map<ColumnId, FleetCard[]> {
  const groups = new Map<ColumnId, FleetCard[]>(COLUMN_IDS.map((id) => [id, []]));
  for (const card of cards) groups.get(card.column)?.push(card);
  return groups;
}

/**
 * The sentence a failure is worth showing. An RPC that fails in the daemon
 * reaches the app as "Request failed: <the handler's message>
 * requestType=plugin.rpc.invoke.request code=handler_error"; the wrapper is
 * for logs, and the user gets the message the handler wrote.
 */
export function errorText(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const clean = raw
    .replace(/^Request failed:\s*/, "")
    .replace(/\s+requestType=\S+(\s+code=\S+)?\s*$/, "")
    .trim();
  return clean === "" ? raw : clean;
}

/** Asana's three dots, drawn in the color the card gives it; Lucide has no Asana mark. */
export const ASANA_ICON: PluginSvgIcon = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="7" r="4.3" fill="currentColor"/><circle cx="6" cy="16.5" r="4.3" fill="currentColor"/><circle cx="18" cy="16.5" r="4.3" fill="currentColor"/></svg>',
};

export interface LinkKind {
  icon: string | PluginSvgIcon;
  /** What a screen reader says, and what the link is called anywhere it is spelled out. */
  label: string;
  /** Drawn beside the icon: a pull request's or issue's number, so several can be told apart. */
  short: string | null;
}

/** What a card's link is: an icon for the kind of page, never the raw URL. */
export function linkKind(url: string): LinkKind {
  const github = /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/i.exec(url);
  if (github !== null) {
    const number = github[2] ?? "";
    return github[1]?.toLowerCase() === "pull"
      ? { icon: "GitPullRequest", label: `Pull request ${number}`, short: `#${number}` }
      : { icon: "CircleDot", label: `Issue ${number}`, short: `#${number}` };
  }
  if (/app\.asana\.com/i.test(url)) return { icon: ASANA_ICON, label: "Asana task", short: null };
  if (/notion\.(so|com)/i.test(url)) return { icon: "FileText", label: "Notion page", short: null };
  if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url)) return { icon: "AppWindow", label: "Local preview", short: null };
  const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1];
  return { icon: "Link", label: host === undefined ? "Link" : host.replace(/^www\./, ""), short: null };
}
