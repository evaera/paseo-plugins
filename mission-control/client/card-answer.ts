/**
 * What a card can say to Mission Control: the actions it wrote on the item's
 * backlog line. They go out through the board's sender — the chat's, as a
 * suggestion does — so they share its one message at a time and its failure
 * toast. Pure. Anything else the user wants to say about a card goes
 * through the chat itself, pointed at the card (`./chat-about`).
 */
import type { CardAction, FleetCard } from "../shared/fleet";

/** The board's way to Mission Control; null where there is no Mission Control to send to. */
export interface CoordinatorAsk {
  /** A message is already on its way; every button that sends is disabled. */
  sending: boolean;
  /**
   * Sends `text` as the user's message; false when refused. `onFailure` runs after the failure
   * toast, `onSent` once the daemon has taken it.
   */
  send: (text: string, onFailure?: () => void, onSent?: () => void) => boolean;
}

/** A card waiting on the user: its backlog line carries a `(hold: …)`. */
export function isHeld(card: FleetCard): boolean {
  const hold = card.backlog?.hold;
  return hold !== null && hold !== undefined;
}

/** The buttons a card draws: held or not, whatever Mission Control wrote. */
export function cardActions(card: FleetCard): readonly CardAction[] {
  return card.backlog?.actions ?? [];
}

/**
 * What a card asks the user to decide, for a phone's card view to show above the transcript: the hold
 * and the buttons that answer it. Null when the card asks nothing, so nothing is drawn. Buttons need
 * Mission Control to send to; the hold is drawn without them.
 */
export function cardDecision(card: FleetCard, canSend: boolean): { hold: string | null; actions: readonly CardAction[] } | null {
  const hold = card.backlog?.hold?.trim() || null;
  const actions = canSend ? cardActions(card) : [];
  if (hold === null && actions.length === 0) return null;
  return { hold, actions };
}
