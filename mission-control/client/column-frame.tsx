/**
 * A wide board's column that opens and closes rather than appearing and
 * vanishing: a column that was not on the board grows from nothing to its
 * width as it fades in, and one whose last card left shrinks away. Its width
 * is animated, so the columns beside it slide over instead of jumping; that
 * is a layout property, which runs in JavaScript on every platform.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";

import { CLOSING_MS } from "./board-motion";

export function ColumnFrame({
  width,
  opening,
  closing,
  style,
  children,
}: {
  width: number;
  /** Newly on the board: grows open on mount. */
  opening: boolean;
  /** Its last card has left: shrinks away. */
  closing: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const open = useRef(new Animated.Value(opening ? 0 : 1)).current;
  useEffect(() => {
    if (!opening && !closing) {
      open.setValue(1);
      return undefined;
    }
    const animation = Animated.timing(open, {
      toValue: closing ? 0 : 1,
      duration: CLOSING_MS,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [opening, closing, open]);
  return (
    <Animated.View
      style={[
        style,
        {
          width: open.interpolate({ inputRange: [0, 1], outputRange: [0, width] }),
          opacity: open,
          overflow: "hidden",
        },
      ]}
      pointerEvents={closing ? "none" : "auto"}
    >
      {children}
    </Animated.View>
  );
}
