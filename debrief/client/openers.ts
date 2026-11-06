/**
 * The cross-host opener registry (contract version 1, shared with Mission Control).
 *
 * Every host's Debrief bundle is evaluated in the same app, so each copy can
 * register a function on `globalThis` under `Symbol.for("debrief.openers.v1")`:
 * a `Map` keyed by the serverId of the host whose copy registered it. Mission
 * Control calls `registry.get(serverId)?.(request)` to open Debrief on a
 * worker's own host, which the mailbox file cannot reach (it lands on one
 * daemon only). The Map is created if missing and never replaced, and a copy
 * removes only its own entry.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";

export interface OpenerRequest {
  workspaceId: string;
  agentId?: string;
  view?: "diff" | "story" | "plans";
  path?: string;
  chapterId?: string;
  planId?: string;
}
export type Opener = (request: OpenerRequest) => void;

const KEY = Symbol.for("debrief.openers.v1");

export function openerRegistry(): Map<string, Opener> {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  const existing = slot[KEY];
  if (existing instanceof Map) return existing as Map<string, Opener>;
  const created = new Map<string, Opener>();
  slot[KEY] = created;
  return created;
}

/** Registers `open` under this host's serverId once it is known; the returned cleanup removes it. */
export function registerOpener(client: Pick<PluginClientContext, "paseo">, open: Opener): () => void {
  let serverId: string | null = null;
  let stopped = false;
  client.paseo.hosts
    .list()
    .then((directory) => {
      if (stopped) return;
      serverId = directory.self.serverId;
      openerRegistry().set(serverId, open);
    })
    .catch((cause: unknown) => console.warn("[debrief] could not register the cross-host opener:", cause));
  return () => {
    stopped = true;
    if (serverId === null) return;
    const registry = openerRegistry();
    if (registry.get(serverId) === open) registry.delete(serverId);
  };
}
