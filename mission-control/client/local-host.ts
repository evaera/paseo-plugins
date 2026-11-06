/**
 * What the host the board runs on is called, for an open card's host line: a
 * worker on this daemon carries no host of its own. The screen and the panels
 * know it from their props and provide it; anything below them reads it.
 */
import { createContext, useContext } from "react";

export const LocalHostContext = createContext<string | null>(null);

export function useLocalHost(): string | null {
  return useContext(LocalHostContext);
}
