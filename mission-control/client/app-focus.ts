/**
 * Whether the user is looking at Paseo: the app is in the foreground
 * (`AppState`, which on the web is the tab being visible) and, on the web,
 * its window has the focus.
 */
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import { trackWindowFocus, windowHasFocus } from "./web";

export function useAppFocused(): boolean {
  const [focused, setFocused] = useState(() => AppState.currentState === "active" && windowHasFocus());
  useEffect(() => {
    const read = () => setFocused(AppState.currentState === "active" && windowHasFocus());
    const subscription = AppState.addEventListener("change", read);
    const stop = trackWindowFocus(read);
    read();
    return () => {
      subscription.remove();
      stop();
    };
  }, []);
  return focused;
}
