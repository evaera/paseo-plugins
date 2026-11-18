import type { PluginButton, PluginButtonBehavior, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";

import { activateToolbarAction, readWorkspaceToolbar, toolbarIcon, type ToolbarItem } from "../shared/toolbar";

type Workspaces = PluginClientContext["paseo"]["workspaces"];
type Workspace = Awaited<ReturnType<Workspaces["list"]>>["entries"][number];

function observe(workspaces: Workspaces) {
  return workspaces.list({ subscribe: {}, page: { limit: 200 } });
}
type Observation = Awaited<ReturnType<typeof observe>>["subscription"];

const POLL_MS = 5000;

export function startWorkspaceToolbar(client: PluginClientContext): () => void {
  if (typeof client.addHeaderButton !== "function") return () => {};
  const { workspaces } = client.paseo;
  const live = new Set<string>();
  const registrations = new Map<string, { remove(): void }[]>();
  const inFlight = new Set<string>();
  let items: ToolbarItem[] = [];
  let signature = "";
  let disposed = false;
  let observation: Observation | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function button(item: ToolbarItem, workspaceId: string, fallback = false): PluginButton {
    const label = item.label ?? "Actions";
    let behavior: PluginButtonBehavior;
    if (item.type === "menu" || item.type === "group") {
      const entries: PluginButtonMenuEntry[] = item.items.map((child, index) => {
        const view = button(child, workspaceId, fallback);
        return { kind: "item", id: `item-${index}`, title: view.title, icon: view.icon, behavior: view.behavior };
      });
      behavior = { kind: "menu", items: entries };
    } else {
      behavior = {
        kind: "action",
        async onPress() {
          const key = JSON.stringify([workspaceId, item]);
          if (inFlight.has(key)) return;
          inFlight.add(key);
          try {
            await client.rpc(activateToolbarAction, { action: item, workspaceId, placement: "workspaces" });
          } finally {
            inFlight.delete(key);
          }
        },
      };
    }
    const icon = fallback ? toolbarIcon({ ...item, icon: undefined }) : toolbarIcon(item);
    return { title: label, label, icon, behavior };
  }

  function remove(workspaceId: string): void {
    registrations.get(workspaceId)?.forEach((registration) => registration.remove());
    registrations.delete(workspaceId);
  }

  function add(workspaceId: string): void {
    if (disposed || items.length === 0 || registrations.has(workspaceId)) return;
    const active: { remove(): void }[] = [];
    items.forEach((item, index) => {
      try {
        active.push(client.addHeaderButton({ id: `toolbar-${index}`, workspaceId, button: button(item, workspaceId) }));
      } catch (error) {
        console.warn("[mission-control] could not register a toolbar icon:", error);
        try {
          active.push(client.addHeaderButton({ id: `toolbar-${index}`, workspaceId, button: button(item, workspaceId, true) }));
        } catch (fallbackError) {
          console.warn("[mission-control] could not register a toolbar button:", fallbackError);
        }
      }
    });
    registrations.set(workspaceId, active);
  }

  function apply(workspace: Workspace): void {
    if (workspace.archivingAt) {
      live.delete(workspace.id);
      remove(workspace.id);
    } else {
      live.add(workspace.id);
      add(workspace.id);
    }
  }

  function setItems(next: ToolbarItem[]): void {
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    items = next;
    registrations.forEach((_entry, id) => remove(id));
    live.forEach(add);
    if (items.length === 0 && observation !== null) {
      void observation.release().catch(() => undefined);
      observation = null;
      live.clear();
    }
  }

  async function followWorkspaces(): Promise<void> {
    const initial = await observe(workspaces);
    if (disposed || items.length === 0) {
      await initial.subscription.release();
      return;
    }
    observation = initial.subscription;
    let newer: Set<string> | null = new Set();
    const snapshot = (page: Pick<typeof initial, "entries" | "pageInfo">): void => {
      if (disposed || observation !== initial.subscription) return;
      if (!page.pageInfo.hasMore) {
        const incoming = new Set(page.entries.map((workspace) => workspace.id));
        live.forEach((id) => { if (!incoming.has(id)) { live.delete(id); remove(id); } });
      }
      page.entries.forEach(apply);
    };
    snapshot(initial);
    initial.subscription.subscribe({
      snapshot,
      update(event) {
        if (disposed || observation !== initial.subscription || event.type !== "workspace_update") return;
        const payload = event.payload;
        if (payload.kind === "upsert") {
          newer?.add(payload.workspace.id);
          apply(payload.workspace as Workspace);
        } else {
          newer?.add(payload.id);
          live.delete(payload.id);
          remove(payload.id);
        }
      },
      error(error) {
        if (observation === initial.subscription) observation = null;
        if (!disposed) console.warn("[mission-control] workspace toolbar observation ended:", error);
      },
    });
    let cursor = initial.pageInfo.nextCursor;
    while (cursor != null && !disposed && observation === initial.subscription) {
      const page = await workspaces.list({ page: { limit: 200, cursor } });
      if (disposed || observation !== initial.subscription) return;
      page.entries.forEach((workspace) => { if (!newer?.has(workspace.id)) apply(workspace); });
      cursor = page.pageInfo.nextCursor;
    }
    newer = null;
  }

  async function refresh(): Promise<void> {
    try {
      const { items: next } = await client.rpc(readWorkspaceToolbar, {}).catch(() => ({ items: [] as ToolbarItem[] }));
      if (disposed) return;
      setItems(next);
      if (items.length > 0 && observation === null) await followWorkspaces();
    } catch (error) {
      if (!disposed) console.warn("[mission-control] could not refresh workspace toolbar:", error);
    } finally {
      if (!disposed) timer = setTimeout(() => { void refresh(); }, POLL_MS);
    }
  }

  void refresh();
  return () => {
    disposed = true;
    clearTimeout(timer);
    void observation?.release().catch(() => undefined);
    registrations.forEach((_entry, id) => remove(id));
    live.clear();
  };
}
