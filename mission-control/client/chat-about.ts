/**
 * The card the user is about to talk to Mission Control about, and the
 * request to put the cursor in the chat's box. A card's chat button sets it;
 * the chat draws it as a pill above the box, starts the message with it when
 * it goes, and takes the focus. Module scope with listeners, so a chat that
 * mounts after the press — a phone switching to its tab — still finds both.
 */
export interface ChatAbout {
  /** The card's key, so pressing the same card again changes nothing. */
  key: string;
  /** What the pill says. */
  title: string;
  /** What the message starts with: `<task id> — <title>`, or the worker. */
  subject: string;
  /** Set by an open card's view, which takes it off when it closes; a message going out leaves it. */
  sticky?: boolean;
  /** The card's worker, whose face the pill shows; null for a task with none. */
  agentId?: string | null;
}

let about: ChatAbout | null = null;
let focusWanted = false;
const listeners = new Set<() => void>();

function changed(): void {
  listeners.forEach((listener) => listener());
}

export const chatAbout = {
  get: (): ChatAbout | null => about,
  set(next: ChatAbout | null): void {
    about = next;
    changed();
  },
  /** Asks the chat for the cursor; the chat on screen, or the next one to mount, takes it once. */
  focus(): void {
    focusWanted = true;
    changed();
  },
  takeFocus(): boolean {
    const wanted = focusWanted;
    focusWanted = false;
    return wanted;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The message as it goes: the card it is about first, then what was typed. */
export function aboutMessage(current: ChatAbout | null, text: string): string {
  if (current === null) return text;
  // Attachments alone: the card is named, with nothing after it.
  return text.trim() === "" ? current.subject : `${current.subject}: ${text.trim()}`;
}
