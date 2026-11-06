/**
 * Module-scope state the entry and the panels share, for the life of this
 * host connection.
 *
 * - **Intents:** `openPanel` takes no params for a workspace panel, so what to
 *   show (the story, a plan) is left here before the panel is opened; a
 *   mounted panel hears it through `subscribe`, a fresh one takes it on mount.
 * - **Counts:** each mounted panel publishes its workspace's open comments and
 *   pending plans, which the header buttons draw.
 */
export type PanelView = "diff" | "story" | "plans";

export interface Intent {
  view: PanelView;
  planId?: string;
  /** Diff view: the file; story view: the file within `chapterId`. */
  path?: string;
  chapterId?: string;
  /** Open the comments list once the panel shows. */
  comments?: boolean;
  /** Diff view: the 1-based new-side line in `path` to scroll to. */
  line?: number;
}

export interface Counts {
  openComments: number;
  pendingPlans: number;
}

const intents = new Map<string, Intent>();
const counts = new Map<string, Counts>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestIntent(workspaceId: string, intent: Intent): void {
  intents.set(workspaceId, intent);
  emit();
}

/** Whether the workspace has a pending intent, without taking it. */
export function hasIntent(workspaceId: string): boolean {
  return intents.has(workspaceId);
}

/** Takes the workspace's pending intent, if any; it is consumed. */
export function takeIntent(workspaceId: string): Intent | null {
  const intent = intents.get(workspaceId) ?? null;
  intents.delete(workspaceId);
  return intent;
}

export function publishCounts(workspaceId: string, next: Counts): void {
  const before = counts.get(workspaceId);
  if (before?.openComments === next.openComments && before.pendingPlans === next.pendingPlans) return;
  counts.set(workspaceId, next);
  emit();
}

export function countsFor(workspaceId: string): Counts | null {
  return counts.get(workspaceId) ?? null;
}

/** The header button's label: the open comments, and pending plans when there are any. */
export function countLabel(value: Counts | null): string | undefined {
  if (value === null) return undefined;
  const parts: string[] = [];
  if (value.openComments > 0) parts.push(String(value.openComments));
  if (value.pendingPlans > 0) parts.push(`${value.pendingPlans} plan${value.pendingPlans === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Only for tests. */
export function resetHub(): void {
  intents.clear();
  counts.clear();
  listeners.clear();
}
