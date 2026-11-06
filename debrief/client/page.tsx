/**
 * Reading pages (the story prologue, the support list, the review overview):
 * a centered column with a comfortable measure, so prose never stretches
 * across a wide panel. Text stays left-aligned inside the column.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Text, View } from "react-native";

/** About 80 characters of body text. */
export const PAGE_MAX_WIDTH = 760;

export function Page({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <ScrollView
      contentContainerStyle={{
        alignItems: "center",
        paddingHorizontal: compact ? 16 : 32,
        paddingTop: compact ? 20 : 36,
        paddingBottom: 48,
      }}
    >
      <View style={{ width: "100%", maxWidth: PAGE_MAX_WIDTH, gap: 24 }}>{children}</View>
    </ScrollView>
  );
}

export function usePageStyles(theme: PluginTheme) {
  const colors = theme.colors;
  return useMemo(
    () => ({
      eyebrow: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
      title: { color: colors.foreground, fontSize: 24, lineHeight: 31, fontWeight: "700" as const },
      lead: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      header: { gap: 8 },
      card: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 10,
        backgroundColor: colors.surface1,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      },
      cardTitle: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
      item: { flexDirection: "row" as const, gap: 10, alignItems: "flex-start" as const },
      itemIcon: { marginTop: 3 },
      itemBody: { flex: 1, minWidth: 0 },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        flexWrap: "wrap" as const,
        paddingTop: 4,
      },
      meta: { color: colors.foregroundMuted, fontSize: 12 },
    }),
    [colors],
  );
}

/** A titled card of short Markdown items, each led by a small icon, or a dot when `icon` is "dot". */
export function ItemCard({
  title,
  items,
  icon,
  iconColor,
  theme,
}: {
  title: string;
  items: readonly string[];
  icon: string;
  iconColor: string;
  theme: PluginTheme;
}) {
  const styles = usePageStyles(theme);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {items.map((item, index) => (
        <View key={index} style={styles.item}>
          {icon === "dot" ? (
            <View style={{ width: 6, height: 6, borderRadius: 3, marginTop: 8, marginHorizontal: 4, backgroundColor: iconColor }} />
          ) : (
            <View style={styles.itemIcon}>
              <Icon name={icon} size={14} color={iconColor} />
            </View>
          )}
          <View style={styles.itemBody}>
            <Markdown>{item}</Markdown>
          </View>
        </View>
      ))}
    </View>
  );
}
