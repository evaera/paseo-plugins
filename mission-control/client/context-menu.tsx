/**
 * A card's context menu, drawn over the board where it was asked for: a
 * right click, or a long press on a touch screen. Its items are the card's
 * own (`contextMenu` in `./card-commands`), in groups with a rule between
 * them; anything that ends or drops something, or needs words, opens the
 * card's view on that step rather than doing it from here. A press outside
 * the menu closes it.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";

import type { MenuItem } from "./card-commands";
import { FONT_SIZE } from "./type-scale";
import { tint } from "./ui";

const MENU_WIDTH = 220;
const ROW_HEIGHT = 32;
/** A rule between groups, with its space either side. */
const RULE_SPACE = 9;
const MENU_PADDING = 4;

export function CardContextMenu({
  groups,
  x,
  y,
  width,
  height,
  theme,
  onPick,
  onClose,
}: {
  groups: readonly (readonly MenuItem[])[];
  /** The press point, in the board's own coordinates. */
  x: number;
  y: number;
  /** The board's size, so the menu stays inside it. */
  width: number;
  height: number;
  theme: PluginTheme;
  onPick: (item: MenuItem) => void;
  onClose: () => void;
}) {
  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      scrim: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 50 },
      menu: {
        position: "absolute" as const,
        width: MENU_WIDTH,
        padding: MENU_PADDING,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        // Android draws a shadow from elevation alone; elsewhere the border and the raised ground carry it.
        elevation: 8,
      },
      rule: { height: 1, marginVertical: (RULE_SPACE - 1) / 2, marginHorizontal: -MENU_PADDING, backgroundColor: colors.border },
    };
  }, [theme]);
  const rows = groups.reduce((count, group) => count + group.length, 0);
  const tall = rows * ROW_HEIGHT + (groups.length - 1) * RULE_SPACE + MENU_PADDING * 2 + 2;
  // Below and right of the press, as a desktop menu opens; flipped up or left where the board runs out.
  const left = x + MENU_WIDTH + 4 <= width ? x : Math.max(4, x - MENU_WIDTH);
  const top = y + tall + 4 <= height ? y : Math.max(4, y - tall);
  // A quick fade and a small drop, so the menu arrives rather than appears.
  const shown = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.timing(shown, { toValue: 1, duration: 120, useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [shown]);

  return (
    <Pressable accessibilityLabel="Close the menu" style={styles.scrim} onPress={onClose}>
      <Animated.View
        style={[
          styles.menu,
          {
            left,
            top,
            opacity: shown,
            transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
          },
        ]}
      >
        {/* Its own Pressable, so a press on the menu's padding is not a press of the scrim behind. */}
        <Pressable accessibilityRole="menu" onPress={() => {}}>
          {groups.map((group, index) => (
            <View key={group[0]?.id ?? index}>
              {index === 0 ? null : <View style={styles.rule} />}
              {group.map((item) => (
                <MenuRow key={item.id} item={item} theme={theme} onPress={() => onPick(item)} />
              ))}
            </View>
          ))}
        </Pressable>
      </Animated.View>
    </Pressable>
  );
}

function MenuRow({ item, theme, onPress }: { item: MenuItem; theme: PluginTheme; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  const danger = item.danger === true;
  const color = danger ? theme.colors.statusDanger : theme.colors.foreground;
  const ground = danger ? tint(theme.colors.statusDanger, 0.14, theme.colors.surface2) : theme.colors.surface2;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={item.label}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 10, height: ROW_HEIGHT, paddingHorizontal: 8, borderRadius: 6 },
        hovered || pressed ? { backgroundColor: ground } : null,
      ]}
    >
      <Icon name={item.icon} size={15} color={danger ? color : hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
      <Text style={{ flex: 1, color, fontSize: FONT_SIZE.body }} numberOfLines={1}>
        {item.label}
      </Text>
    </Pressable>
  );
}
