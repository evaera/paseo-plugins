/**
 * A `[[debrief …]]` embed, drawn as a button that opens the Debrief plugin on the work: its diff, its
 * story or its plans, at a file when the embed names one. Mission Control writes one in the chat, and a
 * worker in its own transcript, where a bare `[[debrief]]` means that worker (`DebriefSelfContext`).
 * The work is looked up on the live board (`BoardTasksContext`), so the button says what it opens and
 * how many review comments are open; one Debrief cannot open says why instead.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { createContext, useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { FleetCard } from "../shared/fleet";
import { cardForRef, useBoardTasks } from "./board-tasks";
import type { DebriefEmbedView } from "./markdown-parse";
import { FONT_SIZE } from "./type-scale";

/** The card whose worker's transcript is being read, for a bare `[[debrief]]`. */
export const DebriefSelfContext = createContext<FleetCard | null>(null);

const VIEWS: Record<DebriefEmbedView, { icon: string; label: string }> = {
  diff: { icon: "FileDiff", label: "View debrief" },
  story: { icon: "BookOpen", label: "View story" },
  plans: { icon: "ListChecks", label: "View plans" },
};

/** The card an embed names: a task, a worker, or a workspace Debrief knows; the reader's own worker when it names none. */
function embedCard(cards: readonly FleetCard[], self: FleetCard | null, ref: string | null): FleetCard | null {
  if (ref === null) return self;
  return cardForRef(cards, ref) ?? cards.find((card) => card.debrief?.workspaceId === ref) ?? null;
}

export function DebriefEmbed({
  refName,
  view,
  path,
  theme,
}: {
  refName: string | null;
  view: DebriefEmbedView;
  path: string | null;
  theme: PluginTheme;
}) {
  const tasks = useBoardTasks();
  const self = useContext(DebriefSelfContext);
  const [hovered, setHovered] = useState(false);
  const card = embedCard(tasks.cards, self, refName);
  // A workspace id names the work directly, card or not; plans can come before any change does.
  const named = refName?.startsWith("wks_") === true ? refName : null;
  const planned = view === "plans" ? (card?.agent?.workspaceId ?? null) : null;
  const workspaceId = card?.debrief?.workspaceId ?? planned ?? named;
  const serverId = card?.debrief?.serverId ?? card?.agent?.serverId ?? null;
  const open = tasks.debrief ?? null;
  const reachable = tasks.canDebrief?.(serverId) ?? serverId === null;
  const reason =
    open === null
      ? "Debrief opens from Mission Control's screen."
      : workspaceId !== null
        ? reachable
          ? null
          : `Debrief is not running on ${card?.agent?.host ?? "that host"} in this app.`
        : card === null
          ? `${refName ?? "This worker"} is not on the board.`
          : card.agent === null
            ? "No worker on this task yet."
            : "Nothing to review yet.";
  const { colors } = theme;
  const color = reason !== null ? colors.foregroundMuted : hovered ? colors.accentForeground : colors.foreground;
  const info = card?.debrief;
  // Not the diff's size: Paseo measures it from the base branch as this host has it, and a local `main`
  // nobody updates makes that millions of lines.
  const detail = [card?.title ?? null, info === undefined || info.openComments === 0 ? null : `${info.openComments} open`, path]
    .filter((part): part is string => part !== null)
    .join("  ·  ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${VIEWS[view].label}${detail === "" ? "" : `: ${detail}`}`}
      accessibilityState={{ disabled: reason !== null }}
      disabled={reason !== null}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => {
        if (workspaceId === null || open === null) return;
        open({ workspaceId, serverId, ...(card?.agent == null ? {} : { agentId: card.agent.id }) }, view, path ?? undefined);
      }}
      style={{
        alignSelf: "flex-start",
        maxWidth: 420,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: reason !== null ? colors.border : colors.accent,
        backgroundColor: reason !== null ? colors.surface1 : hovered ? colors.accent : colors.surface0,
      }}
    >
      <Icon name={VIEWS[view].icon} size={16} color={color} />
      <View style={{ flexShrink: 1, gap: 1 }}>
        <Text style={{ color, fontSize: FONT_SIZE.body, fontWeight: "600" }}>{VIEWS[view].label}</Text>
        {detail === "" && reason === null ? null : (
          <Text style={{ color: hovered && reason === null ? colors.accentForeground : colors.foregroundMuted, fontSize: FONT_SIZE.caption }} numberOfLines={2}>
            {reason ?? detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
