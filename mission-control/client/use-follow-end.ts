/**
 * A transcript that stays at its end while the reader is there, and stays put
 * once they scroll up to read something.
 *
 * Shared by Mission Control's chat and a card's view, which both stream: a
 * reply growing at the end is followed, and a question or permission request
 * arriving at the end is brought into view whole.
 *
 * One flag, `atEnd`, and only a scroll event sets it, from that event's own
 * position. Anything that changes the content or the view's size — a reply
 * growing, the composer under it growing — scrolls back to the end while the
 * flag is on, and never touches the flag. That only holds if the reader and
 * this hook's own scrolls are all that scroll the view, so the web's scroll
 * anchoring, which moves the view by itself when a row above the end changes
 * height, is switched off (`disableScrollAnchoring`): with it on, the chat
 * stopped following a reply mid-stream.
 */
import { useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, LayoutRectangle, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";

import { isAtEnd } from "./follow-end";
import { disableScrollAnchoring } from "./web";

export function useFollowEnd() {
  const scroller = useRef<ScrollView>(null);
  const atEnd = useRef(true);
  /** The transcript's visible height, to tell whether a card fits in it. */
  const viewport = useRef(0);
  /** Cards already brought into view, so one is scrolled to once, not on every re-layout. */
  const revealed = useRef(new Set<string>());
  /** Whether the reader is away from the end, for the button that brings them back. */
  const [away, setAway] = useState(false);

  useEffect(() => {
    disableScrollAnchoring(scroller.current?.getScrollableNode?.());
  }, []);

  function scrollToEnd(): void {
    scroller.current?.scrollToEnd({ animated: false });
  }

  /** Back to the end if that is where the reader was; after the layout pass, so the new size has applied. */
  function keepAtEnd(): void {
    if (!atEnd.current) return;
    scrollToEnd();
    setTimeout(() => {
      if (atEnd.current) scrollToEnd();
    }, 0);
  }

  /** The reader sent or answered something: follow the end again. */
  function pin(): void {
    atEnd.current = true;
    setAway(false);
  }

  /** Back to the end, now, whatever the reader was doing — the button's press. */
  function jumpToEnd(): void {
    pin();
    scrollToEnd();
  }

  /**
   * Brings a card into view once it has a size: whole, with the end of the
   * transcript, when it fits; from its top, where the question is, when it is
   * taller than the transcript — which leaves the reader away from the end.
   * The layout must be in the transcript's coordinates: the card's wrapper a
   * direct child of the scroll view. The jump is instant, so no scroll event
   * mid-animation reads as the reader leaving the end.
   */
  function reveal(id: string, layout: LayoutRectangle): void {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    const fits = layout.height + 16 <= viewport.current;
    atEnd.current = fits;
    setAway(!fits);
    setTimeout(() => {
      if (fits) scrollToEnd();
      else scroller.current?.scrollTo({ y: Math.max(0, layout.y - 8), animated: false });
    }, 0);
  }

  /** Spread onto the transcript's `ScrollView`. */
  const scrollProps = {
    ref: scroller,
    scrollEventThrottle: 100,
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      atEnd.current = isAtEnd(contentOffset.y, layoutMeasurement.height, contentSize.height);
      setAway(!atEnd.current);
    },
    onContentSizeChange(): void {
      keepAtEnd();
    },
    onLayout(event: LayoutChangeEvent): void {
      viewport.current = event.nativeEvent.layout.height;
      keepAtEnd();
    },
  };

  return { pin, keepAtEnd, reveal, away, jumpToEnd, scrollProps };
}
