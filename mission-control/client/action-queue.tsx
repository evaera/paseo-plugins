import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { steerCrew, type FleetCard } from "../shared/fleet";
import { actionRevision } from "./action-order";
import { cardDebriefTarget, useBoardTasks } from "./board-tasks";
import type { CoordinatorAsk } from "./card-answer";
import { columnTone } from "./format";
import { useKeyboardOverlap } from "./keyboard";
import { Markdown } from "./markdown";
import { PermissionCard, usePendingRequests } from "./permission-card";
import { QuietButton, errorText } from "./ui";
import { useAgentTimeline } from "./use-timeline";
import { useFileLinks } from "./use-file-links";

export function ActionPanel({
  card, theme, compact, toCoordinator, answered, stale, onAnswered, onDefer, count, onOpenFile,
}: {
  card: FleetCard;
  theme: PluginTheme;
  compact: boolean;
  toCoordinator: CoordinatorAsk | null;
  answered: boolean;
  stale: boolean;
  onAnswered: () => void;
  onDefer?: () => void;
  count?: number;
  onOpenFile?: ((path: string) => void) | null;
}) {
  const tasks = useBoardTasks();
  const steer = useRpc(steerCrew);
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState("");
  const inFlight = useRef(false);
  const root = useRef<View>(null);
  const keyboard = useKeyboardOverlap(root);
  const { colors } = theme;
  const review = card.column === "review";
  const report = card.report;
  const packet = (review && report?.state === "review") || (!review && report?.state === "needs-decision")
    ? report.packet
    : undefined;
  const description = review
    ? (report?.state === "review" ? report.text : card.backlog?.review ?? report?.text)
    : card.backlog?.hold ?? report?.text;
  const agent = card.agent;
  const actions = packet?.actions ?? card.backlog?.actions ?? [];
  const canAnswer = toCoordinator !== null || agent !== null;
  const busy = stale || sending || toCoordinator?.sending === true;
  const target = cardDebriefTarget(card);
  const canDebrief = target !== null && tasks.debrief != null && tasks.canDebrief?.(target.serverId) !== false;
  const debrief = packet?.debrief ?? [];
  const pending = agent !== null && agent.pendingPermissions > 0;
  const localFiles = agent?.serverId == null;
  const specimen = packet?.specimens;
  const files = useFileLinks(specimen ? [specimen] : [], {}, localFiles && onOpenFile != null);
  const reportPath = card.backlog?.reportPath;
  const freeAnswer = canAnswer && !answered && !pending && actions.length === 0;

  function openLink(url: string): void {
    void openExternalUrl(url).catch((error: unknown) => toast.error(errorText(error)));
  }

  function send(label: string, prompt: string): void {
    if (inFlight.current || busy || answered) return;
    const subject = card.taskId ?? card.title;
    const text = `Action Queue decision for ${subject}: ${label}\n${prompt}\n\nReviewed item: ${description ?? card.title}`;
    inFlight.current = true;
    setSending(true);
    const finish = () => { inFlight.current = false; setSending(false); };
    const success = () => { onAnswered(); setAnswer(""); finish(); };
    if (toCoordinator !== null) {
      if (!toCoordinator.send(text, finish, success)) finish();
    } else if (agent !== null) {
      void steer({ agentId: agent.id, serverId: agent.serverId, text })
        .then(success)
        .catch((error: unknown) => { toast.error(errorText(error)); finish(); });
    } else {
      finish();
    }
  }

  return (
    <View ref={root} style={{ flex: 1, minHeight: 0, minWidth: 0, backgroundColor: colors.surface0, paddingBottom: keyboard }}>
      <ScrollView key={actionRevision(card)} contentContainerStyle={{ padding: compact ? 16 : 24, gap: 16 }}>
        <View style={{ gap: 6 }}>
          <Text style={{ color: columnTone(theme, card.column), fontWeight: "600" }}>
            {review ? "Review" : "Needs you"}{count === undefined ? "" : ` · ${count} remaining`}
          </Text>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: compact ? 21 : 25, fontWeight: "700" }}>
            {card.title}
          </Text>
          {card.project === null ? null : <Text style={{ color: colors.foregroundMuted }}>{card.project}</Text>}
        </View>
        {description ? <Markdown source={description} theme={theme} onOpenLink={openLink} /> : null}
        {specimen ? (
          <Markdown source={specimen} theme={theme} onOpenLink={openLink}
            files={files} onOpenFile={localFiles ? onOpenFile ?? null : null} localImages={localFiles} />
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {canDebrief ? [...new Set(debrief)].map((view) => (
            <QuietButton
              key={view}
              icon={view === "plans" ? "ListChecks" : "FileDiff"}
              label={view === "plans" ? "Review plan in Debrief" : "Review code in Debrief"}
              theme={theme}
              onPress={() => tasks.debrief?.(target, view)}
            />
          )) : null}
          {reportPath && onOpenFile ? (
            <QuietButton icon="FileText" label="Open report" theme={theme} onPress={() => onOpenFile(reportPath)} />
          ) : null}
          {card.links.map((link) => (
            <Text key={link} accessibilityRole="link" onPress={() => openLink(link)} style={{ color: colors.accent }}>{link}</Text>
          ))}
        </View>
        {agent !== null && pending && !stale ? <ActionPermissions agent={agent} theme={theme} compact={compact} onOpenLink={openLink} /> : null}
      </ScrollView>
      <View style={{ gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface1 }}>
        {freeAnswer ? (
          <TextInput value={answer} onChangeText={setAnswer} placeholder="Write a decision"
            placeholderTextColor={colors.foregroundMuted} accessibilityLabel="Write a decision"
            style={{ color: colors.foreground, padding: 10, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }} />
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {answered ? <Text style={{ color: colors.foregroundMuted }}>Decision sent</Text> : pending ? null : actions.map((action, index) => (
            <ActionButton key={index} label={action.label} theme={theme} primary={index === 0}
              disabled={busy || !canAnswer} onPress={() => send(action.label, action.prompt)} />
          ))}
          {freeAnswer ? <ActionButton label="Send decision" theme={theme} primary disabled={busy || !answer.trim()} onPress={() => send("Reply", answer.trim())} /> : null}
          {count === undefined || tasks.open === null ? null : (
            <ActionButton label="Open card" theme={theme} onPress={() => tasks.open?.(card)} />
          )}
          {onDefer === undefined ? null : <ActionButton label="Defer" theme={theme} disabled={sending} onPress={onDefer} />}
        </View>
      </View>
    </View>
  );
}

function ActionButton({ label, theme, primary = false, disabled = false, onPress }: {
  label: string;
  theme: PluginTheme;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = theme;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{
        justifyContent: "center", minHeight: 44, paddingHorizontal: 14, borderRadius: 8,
        borderWidth: 1, borderColor: primary ? colors.accent : colors.border,
        backgroundColor: primary ? colors.accent : colors.surface0, opacity: disabled ? 0.5 : 1,
      }}>
      <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function ActionPermissions({ agent, theme, compact, onOpenLink }: {
  agent: NonNullable<FleetCard["agent"]>;
  theme: PluginTheme;
  compact: boolean;
  onOpenLink: (url: string) => void;
}) {
  const timeline = useAgentTimeline(agent.id, `${agent.updatedAt}:${agent.pendingPermissions}`, 1, agent.serverId);
  const { pending, respond } = usePendingRequests(agent.id, timeline.agent?.pendingPermissions, () => {}, agent.serverId);
  return pending.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>{timeline.error ?? (timeline.loading ? "Loading the worker’s request…" : "Waiting for the board to refresh…")}</Text> : (
    <View style={{ gap: 10 }}>
      {pending.map((request) => (
        <PermissionCard key={request.id} request={request} theme={theme} compact={compact}
          onRespond={(response) => respond(request.id, response)} onOpenLink={onOpenLink} />
      ))}
    </View>
  );
}
