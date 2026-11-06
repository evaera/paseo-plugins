/**
 * The compact thread card Debrief upserts into the agent's timeline, one per
 * comment. Timeline props carry no navigation, so the entry lends the card a
 * way to open the panel (`createThreadCard`).
 */
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

import type { ThreadRow } from "../shared/timeline";
import { authorLabel, locationLabel } from "./format";
import { Badge, Button, MONOSPACE } from "./ui";

export type OpenReview = (workspaceId: string) => void;

export function createThreadCard(openReview: OpenReview) {
  return function ThreadCard({ item, theme }: PluginTimelineItemProps<ThreadRow>) {
    const row = item.data;
    const colors = theme.colors;
    const styles = useMemo(
      () => ({
        card: {
          borderWidth: 1,
          borderColor: colors.border,
          borderLeftWidth: 3,
          borderLeftColor: row.resolved ? colors.statusSuccess : colors.accent,
          borderRadius: 8,
          backgroundColor: colors.surface1,
          padding: 10,
          gap: 6,
        },
        head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
        title: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
        location: { color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE, flexShrink: 1 },
        excerpt: {
          fontFamily: MONOSPACE,
          fontSize: 12,
          color: colors.foregroundMuted,
          backgroundColor: colors.surface0,
          borderRadius: 4,
          padding: 6,
        },
        author: { color: colors.foreground, fontSize: 12, fontWeight: "600" as const },
        body: { color: colors.foreground, fontSize: 13 },
        reply: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6, gap: 2 },
        footer: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
      }),
      [colors, row.resolved],
    );
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Debrief</Text>
          <Text style={styles.location} numberOfLines={1}>
            {locationLabel(row.path, row)}
          </Text>
          {row.resolved ? <Badge text="resolved" tone="success" theme={theme} /> : null}
        </View>
        {row.excerpt ? (
          <Text style={styles.excerpt} numberOfLines={6}>
            {row.excerpt}
          </Text>
        ) : null}
        <Text style={styles.author}>{authorLabel(row.author)}</Text>
        <Text style={styles.body}>{row.body}</Text>
        {row.replies.map((reply, index) => (
          <View key={`${index}:${reply.createdAt}`} style={styles.reply}>
            <Text style={styles.author}>{authorLabel(reply.author)}</Text>
            <Text style={styles.body}>{reply.body}</Text>
          </View>
        ))}
        <View style={styles.footer}>
          <Button
            label="Open in Debrief"
            icon="MessageSquareDiff"
            theme={theme}
            onPress={() => openReview(row.workspaceId)}
          />
        </View>
      </View>
    );
  };
}
