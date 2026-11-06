/**
 * Opening Debrief on any host, from the app. Every host's copy of a plugin is evaluated in the same app,
 * so each host's Debrief registers an opener for its own tab under its host's id, in a Map on
 * `globalThis` (`Symbol.for("debrief.openers.v1")`, Debrief's side of the contract), and Mission Control
 * calls the one for the worker's host. That reaches a Debrief on a remote host, which a request file on
 * this machine never could; the file (`mission-control.debrief.open`) is the fallback for this machine only.
 */
import type { DebriefView } from "../shared/fleet";

export interface DebriefOpenRequest {
  workspaceId: string;
  agentId?: string;
  view?: DebriefView;
  path?: string;
}

type Opener = (request: DebriefOpenRequest) => void;

const OPENERS = Symbol.for("debrief.openers.v1");

/** The Debrief opener a host's copy registered, or null when that host's Debrief is not in this app. */
export function debriefOpener(serverId: string | null): Opener | null {
  if (serverId === null) return null;
  const openers = Reflect.get(globalThis, OPENERS) as unknown;
  if (!(openers instanceof Map)) return null;
  const opener = openers.get(serverId) as unknown;
  return typeof opener === "function" ? (opener as Opener) : null;
}
