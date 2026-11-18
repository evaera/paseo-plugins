import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

import { steerCrew, type FleetCard } from "../shared/fleet";
import { actionRevision } from "./action-order";
import { cardDebriefTarget, useBoardTasks } from "./board-tasks";
import type { CoordinatorAsk } from "./card-answer";
import { columnTone } from "./format";
import { GrowingSlot, useGrowingHeight } from "./growing-input";
import { useKeyboardOverlap } from "./keyboard";
import { isSendKey, type WebKeyPressEvent } from "./keys";
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
  const canReply = canAnswer && !answered;

  function openLink(url: string): void {
    void openExternalUrl(url).catch((error: unknown) => toast.error(errorText(error)));
  }

  function send(label: string, prompt: string, rewrite = false): void {
    if (inFlight.current || busy || answered || (rewrite && toCoordinator === null)) return;
    const subject = card.taskId ?? card.title;
    const kind = rewrite ? "card rewrite request" : pending ? "note" : "decision";
    const text = `Action Queue ${kind} for ${subject}: ${label}\n${prompt}\n\nReviewed item: ${description ?? card.title}`;
    inFlight.current = true;
    setSending(true);
    const finish = () => { inFlight.current = false; setSending(false); };
    const success = () => {
      if (!pending) onAnswered();
      setAnswer("");
      finish();
    };
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
        {canReply ? (
          <ActionReply value={answer} onChange={setAnswer} theme={theme} compact={compact} busy={busy}
            sending={sending} pending={pending} onSend={(reply) => send("Reply", reply)} />
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {answered ? <Text style={{ color: colors.foregroundMuted }}>Response sent</Text> : pending ? null : actions.map((action, index) => (
            <ActionButton key={index} label={action.label} theme={theme} primary={index === 0 && !answer.trim()}
              disabled={busy || !canAnswer} onPress={() => send(action.label, action.prompt)} />
          ))}
          <ActionButton label="Rewrite card" theme={theme} disabled={busy || answered || toCoordinator === null}
            onPress={() => send("Rewrite card", "Rewrite this card with enough context to understand what prompted it, what changed or is blocked, and what decision is needed. Attach current media when relevant and available. Return the revised card to the queue for the same decision.", true)} />
          {count === undefined || tasks.open === null ? null : (
            <ActionButton label="Open card" theme={theme} onPress={() => tasks.open?.(card)} />
          )}
          {onDefer === undefined ? null : <ActionButton label="Defer" theme={theme} disabled={sending} onPress={onDefer} />}
        </View>
      </View>
    </View>
  );
}

function ActionReply({ value, onChange, onSend, theme, compact, busy, sending, pending }: {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  theme: PluginTheme;
  compact: boolean;
  busy: boolean;
  sending: boolean;
  pending: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const { colors } = theme;
  const reply = value.trim();
  const disabled = busy || reply === "";
  const label = pending ? "Write a note" : "Write a custom reply";
  const growing = useGrowingHeight({ text: value, fontSize: 14, lineHeight: 20, maxLines: 5, enabled: true });

  return (
    <View style={{
      flexDirection: "row", alignItems: "flex-end", gap: 10, paddingLeft: 14, paddingRight: 5, paddingVertical: 5,
      borderRadius: 16, borderWidth: 1, borderColor: focused ? colors.accent : colors.border, backgroundColor: colors.surface0,
    }}>
      <View style={{ flex: 1, minWidth: 0, paddingVertical: 7 }}>
        <GrowingSlot twin={growing.twin}>
          <TextInput value={value} onChangeText={onChange} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            multiline editable={!sending} placeholder={`${label}…`} placeholderTextColor={colors.foregroundMuted}
            accessibilityLabel={label}
            onKeyPress={Platform.OS === "web" && !compact ? (event: WebKeyPressEvent) => {
              if (!isSendKey(event.nativeEvent)) return;
              event.preventDefault();
              if (!disabled) onSend(reply);
            } : undefined}
            style={{ height: growing.height, color: colors.foreground, fontSize: 14, lineHeight: 20,
              padding: 0, textAlignVertical: "top", outlineWidth: 0 }} />
        </GrowingSlot>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={pending ? "Send note" : "Send custom reply"}
        accessibilityState={{ disabled }} disabled={disabled} onPress={() => onSend(reply)} hitSlop={5}
        style={({ pressed }) => ({
          width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center",
          backgroundColor: disabled ? colors.surface2 : colors.accent,
          opacity: pressed ? 0.8 : 1,
        })}>
        <Icon name="ArrowUp" size={17} color={disabled ? colors.foregroundMuted : colors.accentForeground} />
      </Pressable>
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
