/**
 * The board's and the chat's ways of saying something just changed: a wash
 * that lights behind it and fades, and an entrance that fades and slides it
 * into place. Opacity and transform only, so phones run them on the native
 * driver; the web has none and runs them in JavaScript.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Platform, type StyleProp, type ViewStyle } from "react-native";

const NATIVE = Platform.OS !== "web";

/** How long a wash stays lit before it fades, and how long the fade takes. */
export const FLASH_HOLD_MS = 600;
export const FLASH_FADE_MS = 1400;

/**
 * A wash behind whatever it sits in, on at once and then fading out. Behind
 * rather than over, so text keeps its colour; `outset` reaches past the
 * parent on every side, and the parent must not clip it.
 */
export function FlashWash({ color, outset = 0, radius = 8 }: { color: string; outset?: number; radius?: number }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const animation = Animated.sequence([
      Animated.delay(FLASH_HOLD_MS),
      Animated.timing(opacity, { toValue: 0, duration: FLASH_FADE_MS, useNativeDriver: NATIVE }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: -outset,
        bottom: -outset,
        left: -outset,
        right: -outset,
        borderRadius: radius,
        backgroundColor: color,
        opacity,
      }}
    />
  );
}

/** Fades and slides its child up into place when `play` is set at mount; otherwise it is simply there. */
export function Entrance({ play, children, style }: { play: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const shown = useRef(new Animated.Value(play ? 0 : 1)).current;
  useEffect(() => {
    if (!play) return undefined;
    const animation = Animated.timing(shown, { toValue: 1, duration: 260, useNativeDriver: NATIVE });
    animation.start();
    return () => animation.stop();
  }, [play, shown]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: shown,
          transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
