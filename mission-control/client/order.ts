/**
 * The order the user dragged cards into, within a column. Pure.
 *
 * One list of rank keys for the whole board, kept in the display settings: a
 * card earlier in the list sits higher in its column, and a card the list does
 * not name keeps the board's own order below the ones it does. A card is ranked
 * by its task where it has one, so a task keeps its place when its worker is
 * relaunched or it moves from the backlog onto a worker; otherwise by its key.
 */
import type { FleetCard } from "../shared/fleet";
import { BOARD_ORDER, COLUMNS, groupCards } from "./format";

/** Old entries fall off the end, so a long-lived board does not grow its settings for ever. */
const MAX_RANKED = 500;

export function rankKey(card: Pick<FleetCard, "key" | "taskId">): string {
  return card.taskId === null ? card.key : `task:${card.taskId}`;
}

/** `cards` in the user's order; a stable sort, so unranked cards keep the order they came in. */
export function sortByRank<T extends Pick<FleetCard, "key" | "taskId">>(cards: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return cards
    .map((card, index) => ({ card, index, rank: rank.get(rankKey(card)) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.card);
}

/** The saved order after one column was rearranged into `column` (its rank keys, top first). */
export function applyColumnOrder(order: readonly string[], column: readonly string[]): string[] {
  const placed = new Set(column);
  return [...new Set([...column, ...order.filter((key) => !placed.has(key))])].slice(0, MAX_RANKED);
}

/** `keys` with the one at `from` moved to `to`. */
export function moveKey<T>(keys: readonly T[], from: number, to: number): T[] {
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/**
 * Where a card dragged `dy` points from position `from` lands: past every
 * other card whose middle its own middle has crossed.
 */
export function dropIndex(layouts: ReadonlyArray<{ y: number; height: number }>, from: number, dy: number): number {
  const dragged = layouts[from];
  if (dragged === undefined) return from;
  const middle = dragged.y + dragged.height / 2 + dy;
  let index = 0;
  layouts.forEach((layout, position) => {
    if (position !== from && layout.y + layout.height / 2 < middle) index += 1;
  });
  return index;
}

/** How far the card at `position` steps aside while the one at `from` is held over `to`. */
export function shiftFor(position: number, from: number, to: number, step: number): number {
  if (position === from) return 0;
  if (from < to && position > from && position <= to) return -step;
  if (to < from && position >= to && position < from) return step;
  return 0;
}

/**
 * What `state/board-order.md` lists for Mission Control: every column holding a
 * card the user ranked, its cards in the user's order, top first.
 */
export function rankedColumns(cards: readonly FleetCard[], order: readonly string[]) {
  const ranked = new Set(order);
  const groups = groupCards(cards);
  return BOARD_ORDER.flatMap((id) => {
    const entries = sortByRank(groups.get(id) ?? [], order);
    if (!entries.some((card) => ranked.has(rankKey(card)))) return [];
    return [
      {
        title: COLUMNS[id].title,
        cards: entries.map((card) => ({
          taskId: card.taskId,
          title: card.title,
          agentId: card.agent?.id ?? null,
          host: card.agent?.host ?? null,
        })),
      },
    ];
  });
}
