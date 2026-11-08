/**
 * A `[[run: …]]` embed, drawn as a pill: the command verbatim in a code block, the project it runs in,
 * and a run button. A press runs the command once, in a Paseo terminal (`mission-control.run.start`),
 * and the pill follows it by polling `mission-control.run.status`: running, then the exit code and the
 * last lines. Every run takes its own press; nothing runs on its own.
 *
 * Only Mission Control's own replies in the chat draw the button (`Markdown`'s `runButtons`). The state
 * is kept in module scope by project and command, so a pill scrolled away, a chat remounted after
 * navigating, or the same command written twice shows the run already going.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { runStatus, startRun, stopRun } from "../shared/fleet";
import { errorText } from "./format";
import { tintCommand, type TintKind } from "./run-tint";
import { FONT_SIZE, lineHeightFor } from "./type-scale";
import { MONOSPACE, QuietButton, Spinner, tint } from "./ui";
import { canCopyText, copyText } from "./web";

/** Opens a run's terminal: its workspace in Paseo. Null where there is no navigation. */
export const RunOpenContext = createContext<((workspaceId: string) => void) | null>(null);

type RunState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; runId: string; workspaceId: string; tail: string[] }
  | { phase: "finished"; runId: string; workspaceId: string; exitCode: number; tail: string[] }
  | { phase: "closed"; workspaceId: string; tail: string[] }
  | { phase: "lost" }
  | { phase: "error"; reason: string };

const POLL_MS = 1500;

/** Every pill's latest state, by project and command, for the life of the bundle. */
const states = new Map<string, RunState>();

function runKey(project: string | null, command: string): string {
  return `${project ?? ""}\u0000${command}`;
}

function useRunState(key: string): [RunState, (next: RunState) => void] {
  const [state, setState] = useState<RunState>(() => states.get(key) ?? { phase: "idle" });
  const set = (next: RunState) => {
    states.set(key, next);
    setState(next);
  };
  return [state, set];
}

function tintColor(kind: TintKind, theme: PluginTheme): string {
  const { colors } = theme;
  switch (kind) {
    case "program":
      return colors.accent;
    case "flag":
    case "assignment":
      return colors.statusWarning;
    case "string":
      return colors.statusSuccess;
    case "operator":
      return colors.foregroundMuted;
    default:
      return colors.foreground;
  }
}

export function RunEmbed({ project, command, theme }: { project: string | null; command: string; theme: PluginTheme }) {
  const key = runKey(project, command);
  const [state, setState] = useRunState(key);
  const start = useRpc(startRun);
  const status = useRpc(runStatus);
  const stop = useRpc(stopRun);
  const openWorkspace = useContext(RunOpenContext);
  const toast = useToast();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const pieces = useMemo(() => tintCommand(command), [command]);
  const { colors } = theme;

  const runId = state.phase === "running" ? state.runId : null;
  useEffect(() => {
    if (runId === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      status({ runId })
        .then((answer) => {
          if (cancelled) return;
          const current = states.get(key);
          if (current?.phase !== "running" || current.runId !== runId) return;
          if (answer.state === "running") {
            setState({ ...current, tail: answer.tail });
            timer = setTimeout(poll, POLL_MS);
          } else if (answer.state === "finished") {
            setState({ phase: "finished", runId, workspaceId: current.workspaceId, exitCode: answer.exitCode ?? 0, tail: answer.tail });
          } else if (answer.state === "closed") {
            setState({ phase: "closed", workspaceId: current.workspaceId, tail: answer.tail });
          } else {
            setState({ phase: "lost" });
          }
        })
        .catch(() => {
          // A dropped connection or a reload in progress: ask again rather than give up on the run.
          if (!cancelled) timer = setTimeout(poll, POLL_MS * 2);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `key` and `runId` name the run; the RPC callers are stable for the plugin's life.
  }, [key, runId]);

  const busy = state.phase === "starting" || state.phase === "running";
  const run = () => {
    if (busy) return;
    setState({ phase: "starting" });
    start({ project, command })
      .then((started) => setState({ phase: "running", runId: started.runId, workspaceId: started.workspaceId, tail: [] }))
      .catch((caught: unknown) => setState({ phase: "error", reason: errorText(caught) }));
  };

  const failed = state.phase === "error" || (state.phase === "finished" && state.exitCode !== 0);
  const accent = failed ? colors.statusDanger : state.phase === "finished" ? colors.statusSuccess : colors.accent;
  const workspaceId = state.phase === "running" || state.phase === "finished" || state.phase === "closed" ? state.workspaceId : null;
  const tail = state.phase === "running" || state.phase === "finished" || state.phase === "closed" ? state.tail : [];
  const where = project === null ? "Mission Control's home" : project;
  const buttonColor = busy ? colors.foregroundMuted : hovered ? colors.accentForeground : accent;

  return (
    <View
      style={{
        alignSelf: "stretch",
        maxWidth: 640,
        flexDirection: "row",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tint(accent, 0.55, colors.border),
        backgroundColor: colors.surface0,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Run ${command} in ${where}`}
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={run}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={{
          width: 44,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered && !busy ? accent : tint(accent, 0.14, colors.surface1),
          borderRightWidth: 1,
          borderRightColor: tint(accent, 0.4, colors.border),
        }}
      >
        {busy ? <Spinner size={16} color={buttonColor} /> : <Icon name={state.phase === "idle" ? "Play" : "RotateCcw"} size={18} color={buttonColor} />}
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 8, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="SquareTerminal" size={12} color={colors.foregroundMuted} />
          <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption }} numberOfLines={1}>
            {where}
          </Text>
          {canCopyText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copied ? "Copied" : "Copy command"}
              onPress={() => {
                void copyText(command).then((ok) => {
                  if (!ok) return toast.error("Could not copy the command.");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              hitSlop={6}
            >
              <Icon name={copied ? "Check" : "Copy"} size={13} color={copied ? colors.statusSuccess : colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          style={{ backgroundColor: colors.surface2, borderRadius: 6 }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 7 }}
        >
          <Text selectable style={{ fontFamily: MONOSPACE, fontSize: FONT_SIZE.code, lineHeight: lineHeightFor(FONT_SIZE.code), color: colors.foreground }}>
            <Text style={{ color: colors.foregroundMuted }}>$ </Text>
            {pieces.map((piece, index) => (
              <Text key={index} style={{ color: tintColor(piece.kind, theme) }}>
                {piece.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
        {tail.length === 0 ? null : (
          <View style={{ gap: 1 }}>
            {tail.map((line, index) => (
              <Text key={index} style={{ fontFamily: MONOSPACE, fontSize: FONT_SIZE.micro, color: colors.foregroundMuted }} numberOfLines={1}>
                {line}
              </Text>
            ))}
          </View>
        )}
        <RunStatusLine
          state={state}
          theme={theme}
          onOpen={openWorkspace === null || workspaceId === null ? null : () => openWorkspace(workspaceId)}
          onStop={
            state.phase === "running"
              ? () => {
                  stop({ runId: state.runId }).catch((caught: unknown) => toast.error(errorText(caught)));
                }
              : null
          }
        />
      </View>
    </View>
  );
}

function RunStatusLine({
  state,
  theme,
  onOpen,
  onStop,
}: {
  state: RunState;
  theme: PluginTheme;
  onOpen: (() => void) | null;
  onStop: (() => void) | null;
}) {
  const { colors } = theme;
  if (state.phase === "idle") return null;
  let icon: string | null = null;
  let color = colors.foregroundMuted;
  let text: string;
  switch (state.phase) {
    case "starting":
      text = "Opening a terminal…";
      break;
    case "running":
      text = "Running in a terminal";
      break;
    case "finished":
      icon = state.exitCode === 0 ? "CircleCheck" : "CircleX";
      color = state.exitCode === 0 ? colors.statusSuccess : colors.statusDanger;
      text = state.exitCode === 0 ? "Finished, exit code 0" : `Failed, exit code ${state.exitCode}`;
      break;
    case "closed":
      icon = "Ban";
      text = "The terminal closed before the command finished";
      break;
    case "lost":
      icon = "Clock";
      text = "Started before the plugin reloaded; its terminal is still in Paseo";
      break;
    case "error":
      icon = "TriangleAlert";
      color = colors.statusDanger;
      text = state.reason;
      break;
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 14, rowGap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
        {icon === null ? <Spinner size={12} color={colors.foregroundMuted} /> : <Icon name={icon} size={13} color={color} />}
        <Text style={{ color, fontSize: FONT_SIZE.caption, flexShrink: 1 }}>{text}</Text>
      </View>
      {onOpen === null ? null : <QuietButton icon="SquareArrowOutUpRight" label="Open terminal" theme={theme} onPress={onOpen} />}
      {onStop === null ? null : <QuietButton icon="Square" label="Stop" theme={theme} tone="danger" onPress={onStop} />}
    </View>
  );
}
