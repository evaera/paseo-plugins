/**
 * An anchored menu drawn inside the panel: a transparent backdrop over the
 * whole panel (a press on it closes the menu) and a card placed under the
 * control that opened it. The panel owns one; `useAnchor` measures a control
 * against the panel's root with `measureInWindow`, which React Native and
 * React Native Web both have. Colours are theme tokens; the card has a border
 * rather than a shadow, since a shadow colour would have to be a literal.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode, RefObject } from "react";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

export interface Anchor {
  /** Left and bottom edge of the control, relative to the panel's root. */
  x: number;
  y: number;
  width: number;
  /** The panel's own width, to keep the card on screen. */
  rootWidth: number;
}

type Measurable = { measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void };

/** Measures `control` against `root`; calls back with null when either cannot be measured. */
export function measureAnchor(
  root: RefObject<View | null>,
  control: RefObject<View | null>,
  onAnchor: (anchor: Anchor | null) => void,
): void {
  const rootNode = root.current as unknown as Measurable | null;
  const controlNode = control.current as unknown as Measurable | null;
  if (rootNode === null || controlNode === null || typeof controlNode.measureInWindow !== "function") {
    onAnchor(null);
    return;
  }
  rootNode.measureInWindow((rootX, rootY, rootWidth) => {
    controlNode.measureInWindow((x, y, width, height) => {
      onAnchor({ x: x - rootX, y: y - rootY + height, width, rootWidth });
    });
  });
}

export function Popover({
  anchor,
  align = "left",
  width,
  maxHeight = 420,
  theme,
  onClose,
  children,
}: {
  anchor: Anchor;
  align?: "left" | "right";
  width: number;
  maxHeight?: number;
  theme: PluginTheme;
  onClose: () => void;
  children: ReactNode;
}) {
  const colors = theme.colors;
  const placement = useMemo(() => {
    const cardWidth = Math.min(width, Math.max(200, anchor.rootWidth - 16));
    const wanted = align === "left" ? anchor.x : anchor.x + anchor.width - cardWidth;
    const left = Math.max(8, Math.min(wanted, anchor.rootWidth - cardWidth - 8));
    return { left, top: anchor.y + 4, width: cardWidth };
  }, [anchor, align, width]);
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 }} pointerEvents="box-none">
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: "absolute",
          top: placement.top,
          left: placement.left,
          width: placement.width,
          maxHeight,
          backgroundColor: colors.surface1,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** A row in a menu: a label, an optional detail line, a check when selected, greyed when disabled. */
export function MenuRow({
  label,
  detail,
  theme,
  onPress,
  selected = false,
  disabled = false,
  trailing,
}: {
  label: string;
  detail?: string;
  theme: PluginTheme;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
}) {
  const colors = theme.colors;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        backgroundColor: pressed || selected ? colors.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <MenuText theme={theme} text={label} strong={selected} />
        {detail !== undefined ? <MenuText theme={theme} text={detail} muted /> : null}
      </View>
      {trailing}
    </Pressable>
  );
}


export function MenuText({ theme, text, muted = false, strong = false }: { theme: PluginTheme; text: string; muted?: boolean; strong?: boolean }) {
  return (
    <Text
      numberOfLines={1}
      style={{
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: muted ? 11 : 13,
        fontWeight: strong ? "600" : "400",
      }}
    >
      {text}
    </Text>
  );
}

export function MenuSection({ theme, title }: { theme: PluginTheme; title: string }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "700",
        letterSpacing: 0.6,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 3,
      }}
    >
      {title}
    </Text>
  );
}

export function MenuDivider({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 4 }} />;
}
