/**
 * "FROM vs TO": what the review compares, as two pills joined by "vs", each
 * showing its side resolved ("main @ b990f96", "working tree"). A pill opens a
 * menu (drawn by the panel's popover): the three presets first, then every
 * endpoint, greyed with the reason when it cannot be that side, then a custom
 * ref.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { type RefObject, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { type Compare, type Endpoint, PRESET_COMPARES, sameCompare, sameEndpoint } from "../shared/compare";
import {
  ENDPOINT_CHOICES,
  endpointHint,
  endpointName,
  type EndpointNames,
  endpointProblem,
  pickEndpoint,
  type Side,
} from "./compare";
import { MenuDivider, MenuRow, MenuSection } from "./popover";
import { Button, MONOSPACE } from "./ui";

function Pill({
  label,
  side,
  active,
  anchor,
  theme,
  onPress,
}: {
  label: string;
  side: Side;
  active: boolean;
  anchor: RefObject<View | null>;
  theme: PluginTheme;
  onPress: () => void;
}) {
  const colors = theme.colors;
  return (
    <View ref={anchor} collapsable={false} style={{ flexShrink: 1, minWidth: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Compare ${side}: ${label}`}
        onPress={onPress}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          maxWidth: 220,
          minWidth: 0,
          overflow: "hidden",
          paddingLeft: 9,
          paddingRight: 6,
          paddingVertical: 3,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: active ? colors.accent : colors.border,
          backgroundColor: colors.surface0,
        }}
      >
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE, flexShrink: 1 }}>
          {label}
        </Text>
        <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

export function CompareControl({
  fromLabel,
  toLabel,
  open,
  fromAnchor,
  toAnchor,
  theme,
  onOpen,
}: {
  fromLabel: string;
  toLabel: string;
  /** The side whose menu is open, if any. */
  open: Side | null;
  fromAnchor: RefObject<View | null>;
  toAnchor: RefObject<View | null>;
  theme: PluginTheme;
  onOpen: (side: Side) => void;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 }}>
      <Pill label={fromLabel} side="from" active={open === "from"} anchor={fromAnchor} theme={theme} onPress={() => onOpen("from")} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>vs</Text>
      <Pill label={toLabel} side="to" active={open === "to"} anchor={toAnchor} theme={theme} onPress={() => onOpen("to")} />
    </View>
  );
}

export function presetLabel(compare: Compare, names: EndpointNames): string {
  return `${endpointName(compare.from, names)} vs ${endpointName(compare.to, names)}`;
}

/** The menu for one side: presets, endpoints, a custom ref. */
export function CompareMenu({
  side,
  compare,
  names,
  theme,
  onPick,
}: {
  side: Side;
  compare: Compare;
  names: EndpointNames;
  theme: PluginTheme;
  /** Called with the new compare; the menu closes. */
  onPick: (compare: Compare) => void;
}) {
  const colors = theme.colors;
  const current = side === "from" ? compare.from : compare.to;
  const other = side === "from" ? compare.to : compare.from;
  const [ref, setRef] = useState(current.kind === "ref" ? current.ref : "");
  const styles = useMemo(
    () => ({
      presets: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
      preset: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        backgroundColor: colors.surface0,
      },
      presetOn: {
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
        backgroundColor: colors.accent,
      },
      presetText: { color: colors.foreground, fontSize: 12 },
      presetTextOn: { color: colors.accentForeground, fontSize: 12, fontWeight: "600" as const },
      custom: { flexDirection: "row" as const, gap: 6, alignItems: "center" as const, paddingHorizontal: 12, paddingBottom: 10 },
      input: {
        flex: 1,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        color: colors.foreground,
        backgroundColor: colors.surface0,
        fontSize: 12,
        fontFamily: MONOSPACE,
      },
    }),
    [colors],
  );
  const choose = (endpoint: Endpoint) => onPick(pickEndpoint(compare, side, endpoint));
  const customRef = ref.trim();
  return (
    <View style={{ paddingTop: 2 }}>
      <MenuSection theme={theme} title="PRESETS" />
      <View style={styles.presets}>
        {PRESET_COMPARES.map((preset) => {
          const on = sameCompare(preset.compare, compare);
          const needsUpstream = preset.compare.from.kind === "upstream" || preset.compare.to.kind === "upstream";
          const disabled = needsUpstream && names.upstream === null;
          return (
            <Pressable
              key={preset.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled }}
              disabled={disabled}
              onPress={() => onPick(preset.compare)}
              style={[on ? styles.presetOn : styles.preset, disabled ? { opacity: 0.45 } : null]}
            >
              <Text style={on ? styles.presetTextOn : styles.presetText}>{presetLabel(preset.compare, names)}</Text>
            </Pressable>
          );
        })}
      </View>
      <MenuDivider theme={theme} />
      <MenuSection theme={theme} title={side === "from" ? "COMPARE FROM" : "COMPARE TO"} />
      {ENDPOINT_CHOICES.map((endpoint) => {
        const problem = endpointProblem(side, endpoint, other, names);
        // Picking the other side's endpoint swaps the two, unless the swapped pair is invalid too.
        const swaps = sameEndpoint(endpoint, other) && pickEndpoint(compare, side, endpoint) !== compare;
        const blocked = problem !== null && !swaps;
        return (
          <MenuRow
            key={endpoint.kind}
            label={endpointName(endpoint, names)}
            detail={problem !== null && blocked ? problem : swaps ? "Swaps the two sides" : endpointHint(endpoint)}
            selected={sameEndpoint(endpoint, current)}
            disabled={blocked}
            theme={theme}
            onPress={() => choose(endpoint)}
            trailing={sameEndpoint(endpoint, current) ? <Icon name="Check" size={14} color={colors.accent} /> : null}
          />
        );
      })}
      <MenuDivider theme={theme} />
      <MenuSection theme={theme} title="CUSTOM REF" />
      <View style={styles.custom}>
        <TextInput
          style={styles.input}
          value={ref}
          onChangeText={setRef}
          placeholder="branch, tag or commit"
          placeholderTextColor={colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => {
            if (customRef !== "") choose({ kind: "ref", ref: customRef });
          }}
        />
        <Button
          label="Use"
          tone="accent"
          disabled={customRef === "" || (other.kind === "ref" && other.ref === customRef)}
          theme={theme}
          onPress={() => choose({ kind: "ref", ref: customRef })}
        />
      </View>
    </View>
  );
}
