/**
 * The board's tasks, for a card that names another: "Blocked by" on the
 * board, and the list a dependency is picked from in a card's view. The
 * screen and the panels provide it; `open` is null where there is no board to
 * open a card on, a panel. `debrief` opens the Debrief plugin on a card's
 * workspace, at its diff or its story; null where there is no navigation.
 */
import { createContext, useContext } from "react";

import type { DebriefView, FleetCard } from "../shared/fleet";

/** The work Debrief opens on: a workspace, the host it is on (null for this Mac), and its worker. */
export interface DebriefTarget {
  workspaceId: string;
  serverId: string | null;
  agentId?: string;
}

export interface BoardTasks {
  cards: readonly FleetCard[];
  open: ((card: FleetCard) => void) | null;
  debrief?: ((target: DebriefTarget, view: DebriefView, path?: string) => void) | null;
  /** Whether Debrief can be opened on a host from here: always this Mac, another only while its Debrief is in the app. */
  canDebrief?: ((serverId: string | null) => boolean) | null;
}

/** Where a card's own Diff and Story buttons point: its worker's workspace. */
export function cardDebriefTarget(card: FleetCard): DebriefTarget | null {
  if (card.debrief === undefined) return null;
  return {
    workspaceId: card.debrief.workspaceId,
    serverId: card.debrief.serverId,
    ...(card.agent === null ? {} : { agentId: card.agent.id }),
  };
}

export const BoardTasksContext = createContext<BoardTasks>({ cards: [], open: null });

export function useBoardTasks(): BoardTasks {
  return useContext(BoardTasksContext);
}

/** The card for a task id: the one with a worker on it when there is one, the backlog item otherwise. */
export function cardForTask(cards: readonly FleetCard[], taskId: string): FleetCard | null {
  return cards.find((card) => card.taskId === taskId && card.agent !== null) ?? cards.find((card) => card.taskId === taskId) ?? null;
}

/** The tasks another can be made to wait for: every other task on the board but the finished ones, once each. */
export function dependencyChoices(cards: readonly FleetCard[], taskId: string): FleetCard[] {
  const seen = new Set<string>([taskId]);
  return cards.filter((card) => {
    if (card.taskId === null || seen.has(card.taskId) || card.column === "done") return false;
    seen.add(card.taskId);
    return true;
  });
}

/**
 * The card a `[[card: …]]` embed names: a task by its id, its worker's card
 * first; or a worker by its agent id, whole or the start of it, as Mission
 * Control may shorten one. Null when the board has no such card.
 */
export function cardForRef(cards: readonly FleetCard[], ref: string): FleetCard | null {
  return (
    cardForTask(cards, ref) ??
    cards.find((card) => card.agent?.id === ref) ??
    (ref.length >= 8 ? cards.find((card) => card.agent?.id.startsWith(ref) === true) : undefined) ??
    null
  );
}
