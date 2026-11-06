/**
 * The "Plan ready for review" card the daemon upserts into the submitting
 * agent's timeline. Timeline props carry no navigation, so the entry lends the
 * card a way to open the panel on the plan (`createPlanCard`).
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

import type { PlanRow } from "../shared/plan";
import { statusLabel } from "./plan-model";
import { Badge, Button } from "./ui";

export type OpenPlan = (workspaceId: string, planId: string) => void;

export function createPlanCard(openPlan: OpenPlan) {
  return function PlanCard({ item, theme }: PluginTimelineItemProps<PlanRow>) {
    const row = item.data;
    const colors = theme.colors;
    const pending = row.status === "pending";
    const styles = useMemo(
      () => ({
        card: {
          borderWidth: 1,
          borderColor: colors.border,
          borderLeftWidth: 3,
          borderLeftColor: pending ? colors.accent : row.status === "approved" ? colors.statusSuccess : colors.statusWarning,
          borderRadius: 8,
          backgroundColor: colors.surface1,
          padding: 10,
          gap: 6,
        },
        head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
        label: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
        title: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
        muted: { color: colors.foregroundMuted, fontSize: 12 },
        footer: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
      }),
      [colors, pending, row.status],
    );
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.label}>{pending ? "Plan ready for review" : "Plan"}</Text>
          <Badge text={`v${row.version}`} theme={theme} />
          <Badge
            text={statusLabel(row.status)}
            tone={row.status === "approved" ? "success" : row.status === "changes-requested" ? "warning" : "accent"}
            theme={theme}
          />
        </View>
        <Text style={styles.title}>{row.title}</Text>
        {row.answeredElsewhere ? <Text style={styles.muted}>Answered outside Debrief.</Text> : null}
        <View style={styles.footer}>
          <Button
            label={pending ? "Review plan" : "Open plan"}
            icon="ClipboardList"
            tone={pending ? "accent" : "default"}
            theme={theme}
            onPress={() => openPlan(row.workspaceId, row.planId)}
          />
        </View>
      </View>
    );
  };
}
