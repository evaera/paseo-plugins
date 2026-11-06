/**
 * A column's cards, rearranged by dragging a card's handle up or down. The
 * held card follows the pointer, the cards it passes step aside, and the new
 * order is handed over once, on release. A screen reader moves a card one
 * place at a time instead, through the handle's actions.
 *
 * Each card's responder is made once and kept: the responder system keeps a
 * gesture's state inside the object that started it, so one rebuilt on every
 * move of the drag would lose it.
 *
 * Only heights are measured; a card's place is worked out from the heights
 * above it. On the web `onLayout` fires only when a size changes, so a card
 * that moved up or down after a drop, or under a neighbour that opened, would
 * keep reporting where it used to be.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanResponder, View, type GestureResponderHandlers, type PanResponderInstance } from "react-native";

import { dropIndex, moveKey, shiftFor } from "./order";
import { trackPointerOnDocument } from "./web";

export interface DragHandle {
  panHandlers: GestureResponderHandlers;
  dragging: boolean;
  /**
   * Whether a drag just ended. On the web the release is also a click, which
   * lands on whatever is under the pointer — the card itself, which would open
   * or fold it — so the card ignores a press this soon after.
   */
  justDropped: () => boolean;
  /** Moves the card one place up (-1) or down (1). */
  step: (delta: -1 | 1) => void;
}

export function SortableList<T>({
  items,
  keyOf,
  gap,
  onReorder,
  renderItem,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The space between cards, which a card stepping aside crosses too. */
  gap: number;
  /** The keys in their new order, top first. */
  onReorder: (keys: string[]) => void;
  renderItem: (item: T, handle: DragHandle) => ReactNode;
}) {
  const [drag, setDrag] = useState<{ key: string; dy: number } | null>(null);
  const keys = items.map(keyOf);
  const heights = useRef(new Map<string, number>());
  const droppedAt = useRef(0);
  /** Read inside the responders, which are made once and must see the latest values. */
  const latest = useRef({ keys, onReorder, drag });
  latest.current = { keys, onReorder, drag };
  const responders = useRef(new Map<string, PanResponderInstance>());
  const stopTracking = useRef<() => void>(() => {});
  useEffect(() => () => stopTracking.current(), []);
  const keyList = keys.join("\n");
  useEffect(() => {
    const live = new Set(keyList.split("\n"));
    [...responders.current.keys()].forEach((key) => {
      if (!live.has(key)) responders.current.delete(key);
    });
    [...heights.current.keys()].forEach((key) => {
      if (!live.has(key)) heights.current.delete(key);
    });
  }, [keyList]);

  function measured(): Array<{ y: number; height: number }> {
    let y = 0;
    return latest.current.keys.map((key) => {
      const height = heights.current.get(key) ?? 0;
      const layout = { y, height };
      y += height + gap;
      return layout;
    });
  }

  function responderFor(key: string): PanResponderInstance {
    const made = responders.current.get(key);
    if (made !== undefined) return made;
    let startY = 0;
    let dy = 0;
    let active = false;
    const apply = (next: number) => {
      if (!active) return;
      dy = next;
      setDrag({ key, dy });
    };
    // On the web the document's pointerup and the responder's release both end the drag.
    const finish = () => {
      if (!active) return;
      active = false;
      droppedAt.current = Date.now();
      stopTracking.current();
      stopTracking.current = () => {};
      const { keys: current, onReorder: reorder } = latest.current;
      const from = current.indexOf(key);
      const to = from === -1 ? -1 : dropIndex(measured(), from, dy);
      setDrag(null);
      if (from !== -1 && to !== from) reorder(moveKey(current, from, to));
    };
    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // The column's scroll view asks for the responder as soon as the finger moves; keep it.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (event) => {
        startY = event.nativeEvent.pageY;
        active = true;
        apply(0);
        stopTracking.current = trackPointerOnDocument((_x, clientY) => apply(clientY - startY), finish, "grabbing");
      },
      onPanResponderMove: (_event, gesture) => apply(gesture.dy),
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
    responders.current.set(key, responder);
    return responder;
  }

  const from = drag === null ? -1 : keys.indexOf(drag.key);
  const to = drag === null || from === -1 ? -1 : dropIndex(measured(), from, drag.dy);
  const step = from === -1 ? 0 : (heights.current.get(keys[from] ?? "") ?? 0) + gap;

  return (
    <>
      {items.map((item, position) => {
        const key = keys[position] ?? "";
        const dragging = position === from;
        const offset = dragging ? (drag?.dy ?? 0) : from === -1 ? 0 : shiftFor(position, from, to, step);
        return (
          <View
            key={key}
            onLayout={(event) => {
              heights.current.set(key, event.nativeEvent.layout.height);
            }}
            style={[{ transform: [{ translateY: offset }] }, dragging ? { zIndex: 10, elevation: 4, opacity: 0.92 } : null]}
          >
            {renderItem(item, {
              panHandlers: responderFor(key).panHandlers,
              dragging,
              justDropped: () => Date.now() - droppedAt.current < 400,
              step: (delta) => {
                const index = latest.current.keys.indexOf(key);
                const target = index + delta;
                if (index === -1 || target < 0 || target >= latest.current.keys.length) return;
                latest.current.onReorder(moveKey(latest.current.keys, index, target));
              },
            })}
          </View>
        );
      })}
    </>
  );
}
