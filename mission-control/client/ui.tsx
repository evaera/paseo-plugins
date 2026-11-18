/**
 * The few pieces every Mission Control screen draws with. The host kit has settings
 * rows and a modal but no button, so these are built from `Pressable`, with
 * every colour taken from the theme.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { FONT_SIZE, lineHeightFor } from "./type-scale";
import { TOUCH_TARGET } from "./layout-tier";

/** A fixed-width font on every platform; iOS has no font named "monospace". */
export const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

export type Tone = "default" | "accent" | "danger";

export const CONTROL_HEIGHT = 28;
const ICON_SIZE = 14;
const ICON_PADDING = 7;
const LABEL_PADDING = 10;
const LABEL_GAP = 6;

/** An unlabelled `IconButton`'s width: its icon, padding and 1-point border, or the touch target. */
export function iconButtonWidth(touch: boolean): number {
  return touch ? TOUCH_TARGET : ICON_SIZE + 2 * ICON_PADDING + 2;
}

/**
 * What `label` adds to an `IconButton`'s width before it has been drawn once to measure: the labelled
 * padding, the gap and about 7 points a character at `FONT_SIZE.small`.
 */
export function labelWidthEstimate(label: string): number {
  return 2 * (LABEL_PADDING - ICON_PADDING) + LABEL_GAP + label.length * 7;
}

export function IconButton({
  icon,
  label,
  theme,
  onPress,
  tone = "default",
  disabled = false,
  showLabel = false,
  touch = false,
}: {
  icon: string;
  label: string;
  theme: PluginTheme;
  onPress: () => void;
  tone?: Tone;
  disabled?: boolean;
  /** Draws the label beside the icon; otherwise it is only the accessibility label. */
  showLabel?: boolean;
  /** At least `TOUCH_TARGET` square, for the layouts a finger drives. */
  touch?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const colors = theme.colors;
  const color =
    tone === "accent" ? colors.accentForeground : tone === "danger" ? colors.statusDanger : colors.foreground;
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: LABEL_GAP,
        paddingHorizontal: showLabel ? LABEL_PADDING : ICON_PADDING,
        paddingVertical: 6,
        minHeight: touch ? TOUCH_TARGET : CONTROL_HEIGHT,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tone === "accent" ? colors.accent : colors.border,
        backgroundColor: tone === "accent" ? colors.accent : colors.surface1,
        opacity: disabled ? 0.5 : 1,
        // A long label — a card action Mission Control named — wraps inside a narrow card instead of overflowing it.
        maxWidth: "100%" as const,
        ...(touch ? { minWidth: TOUCH_TARGET, justifyContent: "center" as const } : {}),
      },
      // The accent fill has no lighter token to move to, so it dims instead.
      raised: tone === "accent" ? { opacity: 0.85 } : { backgroundColor: colors.surface2, borderColor: colors.foregroundMuted },
      pressed: { opacity: 0.7 },
      label: { color, fontSize: FONT_SIZE.small, fontWeight: "500" as const, flexShrink: 1 },
    }),
    [colors, tone, disabled, showLabel, color, touch],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [styles.button, hovered && !disabled ? styles.raised : null, pressed && !disabled ? styles.pressed : null]}
    >
      <Icon name={icon} size={ICON_SIZE} color={color} />
      {showLabel ? <Text style={styles.label}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * A button with no box: an icon and a word, muted until the pointer is over it.
 * For the actions a card keeps at hand but does not lead with.
 */
export function QuietButton({
  icon,
  label,
  theme,
  onPress,
  tone = "default",
  disabled = false,
}: {
  icon: string;
  label: string;
  theme: PluginTheme;
  onPress: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const { colors } = theme;
  const color = hovered && !disabled ? (tone === "danger" ? colors.statusDanger : colors.foreground) : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, opacity: disabled ? 0.5 : 1 }}
    >
      <Icon name={icon} size={13} color={color} />
      <Text style={{ color, fontSize: FONT_SIZE.small, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A two-or-more-way switch, drawn to sit in a row of `IconButton`s: the same
 * 28-point height (a 14-point icon, 6 points of padding each side, a 1-point
 * border), radius and border, with the selected segment in the accent colour.
 */
export function Segmented<Value extends string>({
  theme,
  value,
  options,
  onChange,
  touch = false,
}: {
  theme: PluginTheme;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  /** `TOUCH_TARGET` tall, for the layouts a finger drives. */
  touch?: boolean;
}) {
  const [hovered, setHovered] = useState<Value | null>(null);
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      frame: {
        flexDirection: "row" as const,
        height: touch ? TOUCH_TARGET : CONTROL_HEIGHT,
        padding: 2,
        gap: 2,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        overflow: "hidden" as const,
      },
      segment: { justifyContent: "center" as const, paddingHorizontal: 10, borderRadius: 6 },
      hovered: { backgroundColor: colors.surface2 },
      selectedHover: { opacity: 0.86 },
      pressed: { opacity: 0.68 },
      selected: { backgroundColor: colors.accent },
      label: { color: colors.foreground, fontSize: FONT_SIZE.small, fontWeight: "500" as const },
      labelSelected: { color: colors.accentForeground, fontWeight: "600" as const },
    }),
    [colors, touch],
  );
  return (
    <View style={styles.frame} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onHoverIn={() => setHovered(option.value)}
            onHoverOut={() => setHovered((current) => current === option.value ? null : current)}
            style={({ pressed }) => [
              styles.segment,
              selected ? styles.selected : null,
              hovered === option.value ? (selected ? styles.selectedHover : styles.hovered) : null,
              pressed ? styles.pressed : null,
            ]}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.label, selected ? styles.labelSelected : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The round button over a transcript's foot that goes back to its end, shown
 * while the reader is scrolled away from it — as in Paseo's own agent view.
 * Its parent must be the transcript's frame; it positions itself in it.
 */
export function JumpToEnd({ theme, onPress }: { theme: PluginTheme; onPress: () => void }) {
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      frame: { position: "absolute" as const, left: 0, right: 0, bottom: 12, alignItems: "center" as const },
      button: {
        width: 36,
        height: 36,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
    }),
    [colors],
  );
  return (
    <View style={styles.frame} pointerEvents="box-none">
      <Pressable accessibilityRole="button" accessibilityLabel="Scroll to the latest" onPress={onPress} style={styles.button}>
        <Icon name="ChevronDown" size={20} color={colors.foreground} />
      </Pressable>
    </View>
  );
}

/** The box of `ActivityIndicator`'s "small" size, which the spinner is scaled down from. */
const SMALL_SPINNER = 20;

/**
 * Something running, drawn the size of the icon it stands in for. Lucide's
 * Loader is a spinner drawn standing still, and at a glance a still spinner
 * reads as broken; React Native's own `ActivityIndicator` turns on every
 * platform. It has only two sizes, so the small one is scaled into a box of
 * the icon's size, keeping the row it sits in the same height.
 */
export function Spinner({ size, color }: { size: number; color: string }) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: size / SMALL_SPINNER }] }} />
    </View>
  );
}

/** A full-width notice under the header. */
export interface BannerAction {
  label: string;
  icon: string;
  onPress: () => void;
  disabled?: boolean;
}

export function Banner({
  theme,
  tone,
  text,
  action,
  actions,
}: {
  theme: PluginTheme;
  tone: "warning" | "danger" | "info";
  text: string;
  action?: BannerAction;
  /** More than one action, in order; drawn after `action`. */
  actions?: readonly BannerAction[];
}) {
  const colors = theme.colors;
  const color =
    tone === "danger" ? colors.statusDanger : tone === "warning" ? colors.statusWarning : colors.foregroundMuted;
  const styles = useMemo(
    () => ({
      banner: {
        flexDirection: "row" as const,
        // On a phone the buttons go to a line of their own rather than squeezing the text to a column.
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 10,
        borderWidth: 1,
        borderColor: color,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
      },
      text: { flex: 1, minWidth: 200, color: colors.foreground, fontSize: FONT_SIZE.small, lineHeight: lineHeightFor(FONT_SIZE.small) },
    }),
    [colors, color],
  );
  return (
    <View style={styles.banner}>
      <Icon name={tone === "info" ? "Info" : "AlertTriangle"} size={14} color={color} />
      <Text style={styles.text}>{text}</Text>
      {[...(action === undefined ? [] : [action]), ...(actions ?? [])].map((each) => (
        <IconButton
          key={each.label}
          icon={each.icon}
          label={each.label}
          theme={theme}
          tone="accent"
          showLabel
          disabled={each.disabled === true}
          onPress={each.onPress}
        />
      ))}
    </View>
  );
}

/** A small rounded label, coloured by what it describes. */
export function Chip({ theme, text, color }: { theme: PluginTheme; text: string; color: string }) {
  const styles = useMemo(
    () => ({
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        // Shrinks only when its row has no room, so a long status truncates instead of pushing buttons off.
        flexShrink: 1,
        minWidth: 0,
      },
      dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color },
      text: { flexShrink: 1, color: theme.colors.foreground, fontSize: FONT_SIZE.caption },
    }),
    [theme, color],
  );
  return (
    <View style={styles.chip}>
      <View style={styles.dot} />
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export { errorText } from "./format";

/** `color` at `alpha` (0 to 1) when it is a hex color; otherwise `fallback`. */
export function tint(color: string, alpha: number, fallback: string): string {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  const hex = short === null ? color : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  return `${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** A small label on a tinted ground, like a Notion tag. */
export function Tag({ theme, text, color }: { theme: PluginTheme; text: string; color: string }) {
  const styles = useMemo(
    () => ({
      tag: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        backgroundColor: tint(color, 0.22, theme.colors.surface2),
      },
      text: { color: theme.colors.foreground, fontSize: FONT_SIZE.caption, lineHeight: lineHeightFor(FONT_SIZE.caption) },
    }),
    [theme, color],
  );
  return (
    <View style={styles.tag}>
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}
