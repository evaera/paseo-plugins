/**
 * The screen's edges on a phone or a tablet: the safe-area insets, and the fade that says a row or a
 * transcript goes on past its edge.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { TOUCH_TARGET, overflowEdges } from "./layout-tier";

export type SafeEdge = "left" | "right" | "bottom";

/**
 * Pads `edges` clear of the notch, the rounded corners, a landscape sensor housing and the home indicator.
 *
 * The host pads only a surface's top, and `react-native-safe-area-context` is not a host module, so:
 * - **iOS**: React Native's `SafeAreaView`, which pads each edge by how far the view itself overlaps the
 *   unsafe area. It ignores `edges`, but a view below the host's header never overlaps the top, and a
 *   `SafeAreaView` nested in a padded one overlaps nothing, so insets never stack.
 * - **Web**: the browser's `env(safe-area-inset-*)`, on the edges asked for only. The web renderer's own
 *   `SafeAreaView` pads all four, which under the host's header would add the status bar's height a
 *   second time. On a desktop every inset is 0.
 * - **Android**: no inset source a plugin can reach; a plain view.
 */
export function SafeEdges({
  edges,
  style,
  children,
}: {
  edges: readonly SafeEdge[];
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  if (Platform.OS === "ios") return <SafeAreaView style={style}>{children}</SafeAreaView>;
  if (Platform.OS !== "web") return <View style={style}>{children}</View>;
  // A View either way on the web, with or without edges, so a change of edges never remounts what is inside.
  const inset: Record<string, string> = {};
  for (const edge of edges) {
    const side = edge === "left" ? "Left" : edge === "right" ? "Right" : "Bottom";
    inset[`padding${side}`] = `env(safe-area-inset-${edge})`;
  }
  // `env()` is CSS the web renderer passes through; React Native's style types know only numbers.
  return <View style={[style, inset as unknown as ViewStyle]}>{children}</View>;
}

/** The fade's steps, nearest the edge first: a gradient made of views, since no gradient is a host module. */
const FADE_STEPS = [0.96, 0.86, 0.7, 0.5, 0.3, 0.12];
const STEP = 6;

/**
 * A fade over one end of a scrolled view, in the colour of the ground under it, so a cut row reads as
 * one that goes on. Never takes a touch itself. With `onPress`, a chevron button sits in it that scrolls
 * the row on, a target for a finger that may not know the row swipes.
 */
export function EdgeFade({
  side,
  color,
  theme,
  onPress,
  label,
}: {
  side: "start" | "end" | "top";
  color: string;
  theme?: PluginTheme;
  onPress?: () => void;
  label?: string;
}) {
  const vertical = side === "top";
  const length = FADE_STEPS.length * STEP;
  const steps = FADE_STEPS.map((opacity, index) => (
    <View
      key={index}
      style={{ backgroundColor: color, opacity, ...(vertical ? { height: STEP } : { width: STEP }) }}
    />
  ));
  const position: ViewStyle = vertical
    ? { top: 0, left: 0, right: 0, height: length, flexDirection: "column" }
    : side === "start"
      ? { top: 0, bottom: 0, left: 0, width: length, flexDirection: "row" }
      : { top: 0, bottom: 0, right: 0, width: length, flexDirection: "row-reverse" };
  return (
    <>
      <View pointerEvents="none" style={[{ position: "absolute", zIndex: 2 }, position]}>
        {steps}
      </View>
      {onPress === undefined || theme === undefined || vertical ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label ?? (side === "end" ? "Scroll right" : "Scroll left")}
          onPress={onPress}
          style={{
            position: "absolute",
            zIndex: 3,
            top: "50%",
            marginTop: -TOUCH_TARGET / 2,
            ...(side === "end" ? { right: 2 } : { left: 2 }),
            width: TOUCH_TARGET,
            height: TOUCH_TARGET,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Icon name={side === "end" ? "ChevronRight" : "ChevronLeft"} size={16} color={theme.colors.foreground} />
          </View>
        </Pressable>
      )}
    </>
  );
}

/**
 * Which ends of a sideways `ScrollView` have more beyond them, kept from its own scroll, size and content
 * events. Spread `scrollProps` onto the scroll view.
 */
export function useOverflowEdges() {
  const scroller = useRef<ScrollView>(null);
  const metrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const [edges, setEdges] = useState({ start: false, end: false });

  function update(next: Partial<typeof metrics.current>): void {
    metrics.current = { ...metrics.current, ...next };
    const { offset, viewport, content } = metrics.current;
    const found = overflowEdges(offset, viewport, content);
    setEdges((current) => (current.start === found.start && current.end === found.end ? current : found));
  }

  const scrollProps = {
    ref: scroller,
    scrollEventThrottle: 50,
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
      update({ offset: event.nativeEvent.contentOffset.x });
    },
    onLayout(event: LayoutChangeEvent): void {
      update({ viewport: event.nativeEvent.layout.width });
    },
    onContentSizeChange(width: number): void {
      update({ content: width });
    },
  };

  return {
    edges,
    scrollProps,
    offset: () => metrics.current.offset,
    scrollTo: (x: number) => scroller.current?.scrollTo({ x, animated: true }),
  };
}
