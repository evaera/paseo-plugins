/**
 * A worker's face (`./avatar`), with a dot in its corner only when the worker
 * needs the user or has failed: amber for a permission or a question
 * waiting, red for an error. Working and idle are the card's column already; a dot for them
 * read as a stray mark. On the board it stands before the title; in a card's
 * view it heads the worker's transcript.
 *
 * The face moves a little, in a loop of a few frames (`avatarFrame`): it
 * raises a hand and waves while the worker needs the user, and rests its
 * chin on its hand while it works, and dozes under a floating Zzz while it
 * waits on others. Every face on screen runs off one clock,
 * which stops when none is animated.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import type { AgentSummary, FleetCard } from "../shared/fleet";
import { avatarFrame, avatarIcon, avatarMood, dozeCount, type AvatarFrame, type AvatarMood } from "./avatar";
import { agentStatusLabel } from "./format";
import type { StateTone } from "./worker-state";

/** How often a face can change frame. */
const TICK_MS = 250;

const ticking = new Set<(tick: number) => void>();
let clock: ReturnType<typeof setInterval> | undefined;
let ticks = 0;

/** Calls `listener` on every tick of the faces' one clock, which runs while anyone listens. */
function onTick(listener: (tick: number) => void): () => void {
  ticking.add(listener);
  clock ??= setInterval(() => {
    ticks += 1;
    ticking.forEach((each) => each(ticks));
  }, TICK_MS);
  return () => {
    ticking.delete(listener);
    if (ticking.size === 0 && clock !== undefined) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

/** The frame a worker's face shows now; a face at rest never joins the clock. */
function useAvatarFrame(agentId: string, mood: AvatarMood): AvatarFrame {
  const [frame, setFrame] = useState<AvatarFrame>(() => avatarFrame(mood, ticks, agentId));
  useEffect(() => {
    setFrame(avatarFrame(mood, ticks, agentId));
    if (mood === "rest") return;
    return onTick((tick) => setFrame(avatarFrame(mood, tick, agentId)));
  }, [agentId, mood]);
  return frame;
}

export function WorkerAvatar({
  agent,
  theme,
  size,
  column,
  /** What the dot's ring is drawn in: the ground the avatar sits on, so the dot looks cut out of the corner. */
  ground,
}: {
  agent: AgentSummary;
  theme: PluginTheme;
  size: number;
  /** The card's column, where there is one: Needs you for a held task waves too. */
  column?: FleetCard["column"] | undefined;
  ground: string;
}) {
  const frame = useAvatarFrame(agent.id, avatarMood(agent, column));
  const dot = Math.max(7, Math.round(size * 0.28));
  const ring = size >= 32 ? 2 : 1.5;
  // Not `requiresAttention`, which is only Paseo's "finished, not looked at yet".
  const alarm = agent.status === "error" || agent.pendingPermissions > 0;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Worker, ${agentStatusLabel(agent)}`}
      style={{ width: size, height: size }}
    >
      <Icon icon={avatarIcon(agent.id, frame)} size={size} />
      {/* A Zzz rising from the face's top right, a z more each beat, each higher and larger than the last. */}
      {[0, 1, 2].slice(0, dozeCount(frame)).map((index) => (
        <Text
          key={index}
          pointerEvents="none"
          style={{
            position: "absolute",
            left: size * (0.72 + index * 0.14),
            top: size * (0.12 - index * 0.2),
            color: theme.colors.foregroundMuted,
            fontSize: Math.round(size * (0.22 + index * 0.06)),
            fontWeight: "800",
            lineHeight: Math.round(size * (0.26 + index * 0.06)),
          }}
        >
          z
        </Text>
      ))}
      {!alarm ? null : (
        <View
          style={{
            position: "absolute",
            right: -ring - 1,
            bottom: -ring - 1,
            width: dot + ring * 2,
            height: dot + ring * 2,
            borderRadius: (dot + ring * 2) / 2,
            borderWidth: ring,
            borderColor: ground,
            backgroundColor: agent.status === "error" ? theme.colors.statusDanger : theme.colors.statusWarning,
          }}
        />
      )}
    </View>
  );
}

/** A worker's state in its tone's colour, from the theme. */
export function stateColor(theme: PluginTheme, tone: StateTone): string {
  const { colors } = theme;
  switch (tone) {
    case "success":
      return colors.statusSuccess;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    case "accent":
      return colors.accent;
    default:
      return colors.foregroundMuted;
  }
}
