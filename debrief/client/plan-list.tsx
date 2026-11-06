/**
 * The plans view's left column: every plan in the workspace, newest first,
 * with its status, version count and unsent annotations.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { PlanSummary } from "../shared/plan";
import { relativeTime } from "./format";
import { sourceLabel, statusLabel } from "./plan-model";
import { Badge } from "./ui";

export function PlanList({
  plans,
  selectedId,
  theme,
  onSelect,
}: {
  plans: readonly PlanSummary[];
  selectedId: string | null;
  theme: PluginTheme;
  onSelect: (planId: string) => void;
}) {
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      row: { paddingHorizontal: 10, paddingVertical: 8, gap: 3 },
      selected: { paddingHorizontal: 10, paddingVertical: 8, gap: 3, backgroundColor: colors.surface2 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
      muted: { color: colors.foregroundMuted, fontSize: 11 },
      empty: { color: colors.foregroundMuted, fontSize: 12, padding: 12 },
    }),
    [colors],
  );
  const sorted = useMemo(() => [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [plans]);
  return (
    <FlatList
      data={sorted}
      keyExtractor={(plan) => plan.id}
      ListEmptyComponent={
        <Text style={styles.empty}>
          No plans yet. A plan arrives when an agent leaves plan mode, submits one with debrief_submit_plan, or when a
          Markdown file is opened with Debrief.
        </Text>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          style={item.id === selectedId ? styles.selected : styles.row}
          onPress={() => onSelect(item.id)}
        >
          <View style={styles.head}>
            <Text style={styles.title} numberOfLines={2}>
              {item.title}
            </Text>
            {item.drafts > 0 ? <Badge text={String(item.drafts)} tone="accent" theme={theme} /> : null}
          </View>
          <View style={styles.head}>
            <Badge
              text={statusLabel(item.status)}
              tone={item.status === "approved" ? "success" : item.status === "changes-requested" ? "warning" : "accent"}
              theme={theme}
            />
            <Text style={styles.muted} numberOfLines={1}>
              {`v${item.versions} · ${relativeTime(item.updatedAt)} · ${sourceLabel(item.source)}`}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}
