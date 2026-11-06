/**
 * An open card's facts, drawn the way Paseo's workspace hover card draws
 * them: a muted icon and a line of text each, the host on a server, the
 * branch, the folder. Then when the card was added, with the exact date in a
 * tooltip.
 *
 * The branch is not on the board's payload: it is the worker's workspace's,
 * which the app asks the worker's own host for once the card is open, so a
 * closed card costs nothing.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { AgentSummary, FleetCard } from "../shared/fleet";
import { addedAt, homePath } from "./format";
import { useHostPaseo } from "./host-paseo";
import { useLocalHost } from "./local-host";
import { FONT_SIZE } from "./type-scale";

const BRANCH_STALE_MS = 60_000;

/** A worker's branch, asked of its own host once and shared by everything that draws it; null while unknown. */
export function useWorkerBranch(agent: AgentSummary | null) {
  const { acquire } = useHostPaseo(agent?.serverId ?? null);
  const workspaceId = agent?.workspaceId ?? null;
  return useQuery({
    queryKey: ["mission-control", "branch", agent?.serverId ?? "local", workspaceId],
    enabled: workspaceId !== null,
    staleTime: BRANCH_STALE_MS,
    retry: false,
    queryFn: async () => {
      if (workspaceId === null) return null;
      const workspace = await acquire().workspaces.ref(workspaceId).refresh();
      return workspace?.gitRuntime?.currentBranch ?? null;
    },
  });
}

export function CardDetails({ card, theme }: { card: FleetCard; theme: PluginTheme }) {
  const agent = card.agent;
  const localHost = useLocalHost();
  const branch = useWorkerBranch(agent);
  const styles = useMemo(
    () => ({
      list: { gap: 6 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      text: { flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
    }),
    [theme],
  );

  const host = agent === null ? (card.backlog?.host ?? null) : (agent.host ?? localHost);
  const rows = [
    host === null ? null : { icon: "Server", text: host },
    branch.data == null ? null : { icon: "GitBranch", text: branch.data },
    agent === null ? null : { icon: "Folder", text: homePath(agent.cwd) },
  ].filter((row): row is { icon: string; text: string } => row !== null);
  const added = addedAt(card);

  if (rows.length === 0 && added === null) return null;
  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <View key={row.icon} style={styles.row}>
          <Icon name={row.icon} size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.text} numberOfLines={1}>
            {row.text}
          </Text>
        </View>
      ))}
      {added === null ? null : <AddedAgo theme={theme} ago={added.ago} exact={added.exact} />}
    </View>
  );
}

/**
 * "Added 3h ago", with the date in a tooltip: on hover where there is a
 * pointer, on a tap where there is not. A tap under a hovering pointer is
 * ignored, or clicking would hide the tooltip being read.
 */
function AddedAgo({ theme, ago, exact }: { theme: PluginTheme; ago: string; exact: string }) {
  const [open, setOpen] = useState(false);
  const hovering = useRef(false);
  const styles = useMemo(
    () => ({
      // The tooltip is placed against this full-width view: one placed against the short line would wrap to it.
      frame: { alignSelf: "stretch" as const },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, alignSelf: "flex-start" as const },
      text: { color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small },
      tip: {
        position: "absolute" as const,
        bottom: 22,
        left: 0,
        zIndex: 20,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      tipText: { color: theme.colors.foreground, fontSize: FONT_SIZE.caption },
    }),
    [theme],
  );
  return (
    <View style={styles.frame}>
      <Pressable
        accessibilityLabel={`Added ${ago}, ${exact}`}
        style={styles.row}
        onHoverIn={() => {
          hovering.current = true;
          setOpen(true);
        }}
        onHoverOut={() => {
          hovering.current = false;
          setOpen(false);
        }}
        onPress={() => {
          if (!hovering.current) setOpen((current) => !current);
        }}
      >
        <Icon name="Clock" size={12} color={theme.colors.foregroundMuted} />
        <Text style={styles.text}>Added {ago}</Text>
      </Pressable>
        {open ? (
          <View style={styles.tip} pointerEvents="none">
            <Text style={styles.tipText} numberOfLines={1}>
              {exact}
            </Text>
          </View>
        ) : null}
    </View>
  );
}
