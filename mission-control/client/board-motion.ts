/**
 * What moved on the board since it was last drawn: cards that arrived in a
 * column — from another one, or new — and columns that opened or emptied.
 * Module scope, so a board drawn again after the user looked at a card,
 * or a remount, still shows what changed in the meantime. The first look
 * records everything and moves nothing.
 *
 * Asking is idempotent: a change is stamped once, and asking again inside its
 * window gives the same stamp, so a re-render does not restart its animation.
 */
import type { ColumnId, FleetCard } from "../shared/fleet";

/** How long after a change it still counts as arriving: the flash's whole run. */
export const ARRIVAL_MS = 2200;
/** How long an emptied column takes to close. */
export const CLOSING_MS = 320;

const columnOf = new Map<string, ColumnId>();
const arrived = new Map<string, number>();
let cardsPrimed = false;

let shownBefore: ReadonlySet<ColumnId> = new Set();
const openedAt = new Map<ColumnId, number>();
const emptiedAt = new Map<ColumnId, number>();
let columnsPrimed = false;

/** A card as the board follows it between polls: its worker, or its task, never its line number. */
export function cardIdentity(card: Pick<FleetCard, "key" | "taskId" | "agent">): string {
  if (card.agent !== null) return `agent:${card.agent.id}`;
  return card.taskId === null ? card.key : `task:${card.taskId}`;
}

/** Records where every card is; a card in a new place is stamped as arriving now. */
export function noteCards(cards: readonly FleetCard[], now: number): void {
  cards.forEach((card) => {
    const id = cardIdentity(card);
    if (columnOf.get(id) !== card.column) {
      if (cardsPrimed) arrived.set(id, now);
      columnOf.set(id, card.column);
    }
  });
  const live = new Set(cards.map(cardIdentity));
  [...columnOf.keys()].forEach((id) => {
    if (!live.has(id)) {
      columnOf.delete(id);
      arrived.delete(id);
    }
  });
  cardsPrimed = true;
}

/** When the card arrived where it is, while that is recent enough to show; otherwise null. */
export function arrivalOf(card: FleetCard, now: number): number | null {
  const at = arrived.get(cardIdentity(card));
  return at !== undefined && now - at < ARRIVAL_MS ? at : null;
}

/**
 * Records which columns are drawn: one newly drawn is opening, one no longer
 * drawn is closing for `CLOSING_MS` and is still to be drawn, empty, meanwhile.
 */
export function noteColumns(
  shown: readonly ColumnId[],
  now: number,
): { opening: ReadonlySet<ColumnId>; closing: readonly ColumnId[] } {
  const current = new Set(shown);
  if (columnsPrimed) {
    current.forEach((id) => {
      if (!shownBefore.has(id)) {
        openedAt.set(id, now);
        emptiedAt.delete(id);
      }
    });
    shownBefore.forEach((id) => {
      if (!current.has(id) && !emptiedAt.has(id)) emptiedAt.set(id, now);
    });
  }
  shownBefore = current;
  columnsPrimed = true;
  const opening = new Set([...current].filter((id) => now - (openedAt.get(id) ?? -Infinity) < CLOSING_MS));
  const closing = [...emptiedAt.entries()].flatMap(([id, at]) => {
    if (current.has(id) || now - at >= CLOSING_MS) {
      emptiedAt.delete(id);
      return [];
    }
    return [id];
  });
  return { opening, closing };
}

/** For tests: forgets everything, as a fresh app would. */
export function resetBoardMotion(): void {
  columnOf.clear();
  arrived.clear();
  cardsPrimed = false;
  shownBefore = new Set();
  openedAt.clear();
  emptiedAt.clear();
  columnsPrimed = false;
}
