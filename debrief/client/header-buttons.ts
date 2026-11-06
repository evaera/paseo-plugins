/**
 * A Debrief button in every workspace's header, labelled with the open
 * comments (and pending plans) the workspace's panel last published. It opens
 * an action that opens Debrief with its comments list showing.
 *
 * One observation of the workspace list (`workspaces.list({ subscribe })`)
 * decides which workspaces get a button: registered on the first sight of a
 * workspace, removed when it is archived or goes away. Since 0.11 the plugin's
 * one `PaseoApi` outlives every panel, so the observation is released in the
 * cleanup, and reopened with backoff when it fails (Paseo releases a failed
 * observation silently). A snapshot is one page; workspaces past it get their
 * button from their first update instead.
 */
import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

import type { Intent } from "./hub";

export type OpenAt = (workspaceId: string, intent: Intent | null) => void;
import { countLabel, countsFor, subscribe } from "./hub";

type Paseo = PluginClientContext["paseo"];
type WorkspaceEntry = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];
type Observation = Awaited<ReturnType<typeof openObservation>>["subscription"];

const PAGE_LIMIT = 200;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

function openObservation(paseo: Paseo, signal: AbortSignal) {
  return paseo.workspaces.list({ subscribe: {}, page: { limit: PAGE_LIMIT }, signal } as Parameters<
    Paseo["workspaces"]["list"]
  >[0] & { subscribe: {} });
}

function live(workspace: WorkspaceEntry): boolean {
  return !workspace.archivingAt;
}

export function startHeaderButtons(
  client: Pick<PluginClientContext, "paseo" | "addHeaderButton">,
  /** `openAt` opens the panel, showing the intent when there is one. */
  options: { icon: string; openAt: OpenAt },
): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; label: string | undefined }>();
  const lifetime = new AbortController();
  let observation: Observation | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;

  function title(label: string | undefined): string {
    return label === undefined ? "Debrief" : `Debrief: ${label}`;
  }

  function add(workspaceId: string): void {
    if (buttons.has(workspaceId) || lifetime.signal.aborted) return;
    const label = countLabel(countsFor(workspaceId));
    const registration = client.addHeaderButton({
      // The host scopes ids by workspace.
      id: "debrief",
      workspaceId,
      button: {
        title: title(label),
        icon: options.icon,
        ...(label !== undefined ? { label } : {}),
        // A popover of the review's threads, with "Open Debrief" at the top.
        // An action, not a popover: the host keeps a popover's open state per button, and it keeps
        // earlier copies of a workspace screen mounted, so a popover opened in every copy and the
        // hidden one drew at the top left. Debrief opens with its comments list instead.
        behavior: {
          kind: "action",
          onPress: () => options.openAt(workspaceId, { view: "diff", comments: true }),
        },
      },
    });
    buttons.set(workspaceId, { registration, label });
  }

  function remove(workspaceId: string): void {
    buttons.get(workspaceId)?.registration.remove();
    buttons.delete(workspaceId);
  }

  function apply(workspace: WorkspaceEntry): void {
    if (live(workspace)) add(workspace.id);
    else remove(workspace.id);
  }

  function replace(entries: readonly WorkspaceEntry[]): void {
    const wanted = new Set(entries.filter(live).map((workspace) => workspace.id));
    [...buttons.keys()].forEach((workspaceId) => {
      if (!wanted.has(workspaceId)) remove(workspaceId);
    });
    wanted.forEach((workspaceId) => add(workspaceId));
  }

  const unsubscribeCounts = subscribe(() => {
    buttons.forEach((entry, workspaceId) => {
      const label = countLabel(countsFor(workspaceId));
      if (label === entry.label) return;
      entry.label = label;
      // The host spreads the patch, so an undefined label goes back to the icon-only button.
      entry.registration.update({ title: title(label), label } as Partial<PluginButton>);
    });
  });

  function reopen(error: unknown): void {
    observation = null;
    if (lifetime.signal.aborted || retry !== null) return;
    console.warn("[debrief] the workspace list failed; reopening", error);
    retry = setTimeout(() => {
      retry = null;
      open();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function open(): void {
    openObservation(client.paseo, lifetime.signal)
      .then((result) => {
        if (lifetime.signal.aborted) {
          void result.subscription.release().catch(() => undefined);
          return;
        }
        observation = result.subscription;
        if (result.pageInfo.hasMore) result.entries.forEach(apply);
        else replace(result.entries);
        result.subscription.subscribe({
          snapshot(snapshot) {
            retryDelay = RETRY_MIN_MS;
            // Only a complete first page is a full picture; otherwise merge it.
            if (snapshot.pageInfo.hasMore) snapshot.entries.forEach(apply);
            else replace(snapshot.entries);
          },
          update(message) {
            if (message.type !== "workspace_update") return;
            const payload = message.payload;
            if (payload.kind === "upsert") apply(payload.workspace as WorkspaceEntry);
            else remove(payload.id);
          },
          error: reopen,
        });
      })
      .catch(reopen);
  }

  open();
  return () => {
    lifetime.abort();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    unsubscribeCounts();
    void observation?.release().catch(() => undefined);
    observation = null;
    buttons.forEach((entry) => entry.registration.remove());
    buttons.clear();
  };
}
