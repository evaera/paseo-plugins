/**
 * The few pieces every Debrief view draws with. The host kit has no button, so
 * these are built from `Pressable`, with every colour taken from the theme.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Platform, Pressable, Text, View } from "react-native";

/** A fixed-width font on every platform; iOS has no font named "monospace". */
export const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

export type Tone = "default" | "accent" | "danger" | "quiet";

export function Button({
  label,
  theme,
  onPress,
  icon,
  tone = "default",
  disabled = false,
  showLabel = true,
  selected = false,
}: {
  label: string;
  theme: PluginTheme;
  onPress: () => void;
  icon?: string;
  tone?: Tone;
  disabled?: boolean;
  /** Draws the label beside the icon; otherwise it is only the accessibility label. */
  showLabel?: boolean;
  selected?: boolean;
}) {
  const colors = theme.colors;
  const filled = tone === "accent" || selected;
  const color = filled
    ? colors.accentForeground
    : tone === "danger"
      ? colors.statusDanger
      : tone === "quiet"
        ? colors.foregroundMuted
        : colors.foreground;
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: showLabel ? 9 : 6,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: tone === "quiet" ? 0 : 1,
        borderColor: filled ? colors.accent : colors.border,
        backgroundColor: filled ? colors.accent : tone === "quiet" ? "transparent" : colors.surface1,
        opacity: disabled ? 0.5 : 1,
      },
      label: { color, fontSize: 12, fontWeight: "500" as const },
    }),
    [colors, tone, disabled, showLabel, color, filled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={styles.button}
    >
      {icon !== undefined ? <Icon name={icon} size={14} color={color} /> : null}
      {showLabel ? <Text style={styles.label}>{label}</Text> : null}
    </Pressable>
  );
}

/** A small rounded label: a count, a status, "drifted". */
export function Badge({
  text,
  theme,
  tone = "default",
}: {
  text: string;
  theme: PluginTheme;
  tone?: "default" | "accent" | "success" | "warning" | "danger";
}) {
  const colors = theme.colors;
  const color =
    tone === "accent"
      ? colors.accent
      : tone === "success"
        ? colors.statusSuccess
        : tone === "warning"
          ? colors.statusWarning
          : tone === "danger"
            ? colors.statusDanger
            : colors.foregroundMuted;
  const styles = useMemo(
    () => ({
      badge: {
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: 6,
        paddingVertical: 1,
      },
      text: { color, fontSize: 11, fontWeight: "600" as const },
    }),
    [color],
  );
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

/** A row of mutually exclusive choices: the scope switcher, unified or split. */
export function Segmented<Value extends string>({
  value,
  options,
  onChange,
  theme,
}: {
  value: Value;
  /** With `icon`, the option draws only the icon and `label` becomes its accessibility label. */
  options: readonly { value: Value; label: string; icon?: string }[];
  onChange: (value: Value) => void;
  theme: PluginTheme;
}) {
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        overflow: "hidden" as const,
      },
      option: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.surface1 },
      selected: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.accent },
      label: { color: colors.foreground, fontSize: 12 },
      selectedLabel: { color: colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
    }),
    [colors],
  );
  return (
    <View style={styles.row}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          accessibilityState={{ selected: option.value === value }}
          accessibilityLabel={option.label}
          onPress={() => onChange(option.value)}
          style={[
            option.value === value ? styles.selected : styles.option,
            option.icon !== undefined ? { paddingHorizontal: 7, paddingVertical: 5 } : null,
          ]}
        >
          {option.icon !== undefined ? (
            <Icon
              name={option.icon}
              size={14}
              color={option.value === value ? colors.accentForeground : colors.foregroundMuted}
            />
          ) : (
            <Text style={option.value === value ? styles.selectedLabel : styles.label}>{option.label}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

/** A small borderless icon button for card headers: resolve, edit, delete. */
export function IconButton({
  icon,
  label,
  theme,
  onPress,
  tone = "default",
  text,
  active = false,
}: {
  icon: string;
  /** The accessibility label (and tooltip where the platform has one). */
  label: string;
  theme: PluginTheme;
  onPress: () => void;
  tone?: "default" | "danger" | "success";
  /** Text beside the icon, for the resolve pill. */
  text?: string;
  active?: boolean;
}) {
  const colors = theme.colors;
  const color =
    tone === "danger" ? colors.statusDanger : tone === "success" || active ? colors.statusSuccess : colors.foregroundMuted;
  const styles = useMemo(
    () => ({
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 3,
        paddingHorizontal: text !== undefined ? 7 : 4,
        paddingVertical: text !== undefined ? 1 : 4,
        borderRadius: text !== undefined ? 10 : 4,
        borderWidth: 1,
        borderColor: active ? colors.statusSuccess : "transparent",
      },
      text: { color, fontSize: 11 },
    }),
    [colors, color, text, active],
  );
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Icon name={icon} size={text !== undefined ? 12 : 13} color={color} />
      {text !== undefined ? <Text style={styles.text}>{text}</Text> : null}
    </Pressable>
  );
}
