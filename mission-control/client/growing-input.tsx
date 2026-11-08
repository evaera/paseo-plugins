/**
 * A text box that starts one line tall and grows with what is typed, up to a cap, then scrolls.
 *
 * The box cannot be sized from its own content height: on the web renderer a textarea reports a content
 * height never less than its own height, so a box sized that way grows and never shrinks back. Instead
 * an invisible `Text` twin lays out the same words at the same width and font, and the box takes the
 * twin's height (`growingHeight`), which shrinks as readily as it grows. The twin goes beside the box,
 * inside a view that is exactly as wide as the box.
 */
import { useState, type ReactNode } from "react";
import { Text, View, type TextStyle } from "react-native";

import { growingHeight, twinText } from "./layout-tier";

export function useGrowingHeight({
  text,
  fontSize,
  lineHeight,
  maxLines,
  enabled,
}: {
  text: string;
  fontSize: number;
  lineHeight: number;
  maxLines: number;
  /** Off, the box keeps whatever fixed height its own style gives it and no twin is drawn. */
  enabled: boolean;
}): { height: number | undefined; twin: ReactNode } {
  const [measured, setMeasured] = useState<number | null>(null);
  if (!enabled) return { height: undefined, twin: null };
  const style: TextStyle = { position: "absolute", left: 0, right: 0, top: 0, opacity: 0, fontSize, lineHeight };
  return {
    height: growingHeight(measured, lineHeight, 1, maxLines),
    twin: (
      <Text
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={style}
        onLayout={(event) => setMeasured(event.nativeEvent.layout.height)}
      >
        {twinText(text)}
      </Text>
    ),
  };
}

/** The box and its twin in one view as wide as the box; with no twin, the box alone, as it always was. */
export function GrowingSlot({ twin, children }: { twin: ReactNode; children: ReactNode }) {
  if (twin === null) return <>{children}</>;
  return (
    <View>
      {twin}
      {children}
    </View>
  );
}
