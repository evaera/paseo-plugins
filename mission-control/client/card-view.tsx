/**
 * One card, open, in the board's place — the right-hand pane, or the Crew tab
 * on a phone — so the chat with Mission Control stays beside it. Any card opens
 * here, a backlog item with no worker too.
 *
 * On the left, the whole card (`CardSheet`) and the user's notes on its
 * task, which Mission Control reads. With a worker, on the right, its live
 * transcript — the prompt it was given, its reasoning, each tool call and what
 * came back, its plan, and anything it is waiting on, answered here — and a
 * box at its foot to talk to it directly, as in its own tab. Mission Control
 * hears about what is said there (`registerSteerRelay`). Paseo's own view of
 * the agent is one press away, for what this leaves out: attachments, the
 * model and mode pickers, the full history.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

import { steerCrew, type AgentSummary, type CrewReportSummary, type FleetCard } from "../shared/fleet";
import { activityRows, type ActivityRow, type PlanStatus } from "./activity-rows";
import { cardDebriefTarget, useBoardTasks } from "./board-tasks";
import { CardSheet } from "./card";
import { DebriefSelfContext } from "./debrief-embed";
import type { CoordinatorAsk } from "./card-answer";
import type { DraftKind } from "./card-commands";
import { useFollowEnd } from "./use-follow-end";
import { WorkerAvatar, stateColor } from "./avatar-view";
import { workerState } from "./worker-state";
import { useWorkerBranch } from "./card-details";
import { agentStatusLabel, agentStatusTone, contextPercent, contextTone, modelName } from "./format";
import { useLocalHost } from "./local-host";
import { isSendKey, type WebKeyPressEvent } from "./keys";
import { Markdown } from "./markdown";
import { PermissionCard, usePendingRequests } from "./permission-card";
import { TaskNotes } from "./task-notes";
import { Chip, IconButton, JumpToEnd, MONOSPACE, Spinner, errorText } from "./ui";
import { useAgentTimeline } from "./use-timeline";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

/** How much of a crewmate's history is read: its tail, this many entries long. */
const TIMELINE_LIMIT = 200;
/** Below this width the card sits above the transcript instead of beside it. */
const SIDE_BY_SIDE_WIDTH = 680;
const CARD_COLUMN_WIDTH = 320;
/** A card with no worker has nothing beside it, so it is held to a readable width. */
const ALONE_MAX_WIDTH = 640;
/**
 * A prompt or reasoning longer than this is folded until pressed. Only text
 * that gets the Show all toggle is clamped: a paragraph judged short can still
 * wrap past the fold on a phone, and clamping it would hide the rest for good.
 */
const FOLDED_LINES = 6;

const LABELS: Partial<Record<ActivityRow["kind"], string>> = {
  prompt: "PROMPT",
  reasoning: "REASONING",
  reply: "WORKER",
  plan: "PLAN",
};

/** Mission Control's chat's line height: 1.6, as Paseo's own chat sets its text. */
function relaxed(size: number): number {
  return Math.round(size * 1.6);
}

function isLong(text: string): boolean {
  return text.split("\n").length > FOLDED_LINES || text.length > 480;
}

export function CardView({
  card,
  theme,
  compact,
  onBack,
  onOpen,
  onChanged,
  toCoordinator,
  initialDraft = null,
}: {
  /** Null once the card has left the board: its worker ended, its task dropped. */
  card: FleetCard | null;
  theme: PluginTheme;
  compact: boolean;
  onBack: () => void;
  /** Opens the worker in Paseo; null for a card with no worker, or where the host gives no navigation. */
  onOpen: (() => void) | null;
  onChanged: () => void;
  toCoordinator: CoordinatorAsk | null;
  /** A step for the card to open on, from its context menu. */
  initialDraft?: DraftKind | null;
}) {
  const [width, setWidth] = useState(0);
  const agent = card?.agent ?? null;
  const tasks = useBoardTasks();
  const debriefTarget = card === null ? null : cardDebriefTarget(card);
  const sideBySide = !compact && width >= SIDE_BY_SIDE_WIDTH;

  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      screen: { flex: 1, minHeight: 0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: compact ? 10 : 12,
        paddingTop: compact ? 0 : 12,
        paddingBottom: 8,
      },
      title: { flex: 1, color: colors.foreground, fontSize: FONT_SIZE.content, fontWeight: "600" as const },
      body: { flex: 1, minHeight: 0, paddingHorizontal: compact ? 10 : 12, paddingBottom: compact ? 10 : 12, gap: 10 },
      bodySide: { flexDirection: "row" as const },
      cardColumn: { width: CARD_COLUMN_WIDTH, flexGrow: 0, flexShrink: 0 },
      cardStacked: { flexGrow: 0, maxHeight: "45%" as const },
      cardContent: { gap: 10, paddingBottom: 4 },
      cardAlone: { flex: 1 },
      alone: { gap: 10, width: "100%" as const, maxWidth: ALONE_MAX_WIDTH, paddingBottom: 12 },
      gone: { color: colors.foregroundMuted, fontSize: FONT_SIZE.small, lineHeight: lineHeightFor(FONT_SIZE.small) },
      transcriptFrame: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        backgroundColor: colors.surface1,
        overflow: "hidden" as const,
      },
    };
  }, [theme, compact]);

  const sheet =
    card === null ? (
      <Text style={styles.gone}>This card is no longer on the board: its worker was ended, or its task dropped.</Text>
    ) : (
      <>
        <CardSheet
          card={card}
          theme={theme}
          compact={compact}
          onChanged={onChanged}
          toCoordinator={toCoordinator}
          initialDraft={initialDraft}
        />
        <TaskNotes card={card} theme={theme} />
      </>
    );

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <IconButton icon="ChevronLeft" label="Crew" showLabel theme={theme} onPress={onBack} />
        <Text style={styles.title} numberOfLines={1}>
          {card?.title ?? "Card"}
        </Text>
        {agent === null ? null : <Chip theme={theme} text={agentStatusLabel(agent)} color={agentStatusTone(theme, agent)} />}
        {debriefTarget === null || tasks.debrief == null || tasks.canDebrief?.(debriefTarget.serverId) === false ? null : (
          <IconButton
            icon="FileDiff"
            label="View diff"
            showLabel={!compact}
            theme={theme}
            onPress={() => tasks.debrief?.(debriefTarget, "diff")}
          />
        )}
        {onOpen === null ? null : (
          <IconButton icon="ExternalLink" label="Open in Paseo" showLabel={!compact} theme={theme} onPress={onOpen} />
        )}
      </View>
      {/*
        One tree whether or not the card has a worker, so a worker starting or ending under an open card
        never remounts the sheet: a half-typed note, Relaunch or Wait survives it, and so does the focus.
      */}
      <View
        style={[styles.body, sideBySide || agent === null ? styles.bodySide : null]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <ScrollView
          style={agent === null ? styles.cardAlone : sideBySide ? styles.cardColumn : styles.cardStacked}
          contentContainerStyle={agent === null ? styles.alone : styles.cardContent}
          // The card's boxes are in here; on iOS the system scrolls the focused one into view.
          automaticallyAdjustKeyboardInsets
        >
          {sheet}
        </ScrollView>
        {agent === null ? null : (
          <View style={styles.transcriptFrame}>
            {/* A bare `[[debrief]]` the worker writes means its own work. */}
            <DebriefSelfContext.Provider value={card}>
            <ActivityTranscript
              agent={agent}
              report={card?.report ?? null}
              column={card?.column}
              agentId={agent.id}
              serverId={agent.serverId}
              revision={`${agent.updatedAt}:${agent.pendingPermissions}`}
              theme={theme}
              compact={compact}
              onOpen={onOpen}
            />
            </DebriefSelfContext.Provider>
            <WorkerComposer agent={agent} theme={theme} compact={compact} onSent={onChanged} />
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The worker over its own work, in the manner of Scape's session header: its
 * face, large; its name and branch; where it stands, with an icon in that
 * state's colour; and on the right how full its context is, with its host and
 * model under it.
 */
function WorkerHeader({
  agent,
  column,
  theme,
  compact,
  usedTokens,
  maxTokens,
  report,
}: {
  agent: AgentSummary;
  column: FleetCard["column"] | undefined;
  theme: PluginTheme;
  compact: boolean;
  /** The status line the worker last ended a turn on, which names its state once it has stopped. */
  report: CrewReportSummary | null;
  usedTokens: number | null | undefined;
  maxTokens: number | null | undefined;
}) {
  const localHost = useLocalHost();
  const branch = useWorkerBranch(agent).data ?? null;
  const { colors } = theme;
  const worked = workerState(agent, report);
  const state = { icon: worked.icon, text: worked.label, color: stateColor(theme, worked.tone) };
  const percent = contextPercent(usedTokens, maxTokens);
  const facts = [agent.host ?? localHost, modelName(agent)].filter((fact): fact is string => fact !== null && fact !== "");
  const small = { color: colors.foregroundMuted, fontSize: FONT_SIZE.small };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: compact ? 10 : 14,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: compact ? 10 : 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <WorkerAvatar agent={agent} theme={theme} size={compact ? 40 : 48} column={column} ground={colors.surface0} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text
            style={{ flexShrink: 1, color: colors.foreground, fontSize: FONT_SIZE.content, fontWeight: "700" }}
            numberOfLines={1}
          >
            {agent.title ?? "Worker"}
          </Text>
          {branch === null ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 2, minWidth: 0 }}>
              <Icon name="GitBranch" size={12} color={colors.foregroundMuted} />
              <Text style={small} numberOfLines={1}>
                {branch}
              </Text>
            </View>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon name={state.icon} size={13} color={state.color} />
          <Text style={{ color: state.color, fontSize: FONT_SIZE.small, fontWeight: "500" }}>{state.text}</Text>
        </View>
      </View>
      {compact && percent === null && facts.length === 0 ? null : (
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          {percent === null ? null : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: compact ? 48 : 72, height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" }}>
                <View
                  style={{
                    width: `${Math.min(100, Math.max(2, percent))}%`,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: percent >= 70 ? contextTone(theme, percent) : colors.statusSuccess,
                  }}
                />
              </View>
              <Text style={[small, { fontVariant: ["tabular-nums"] }]}>{Math.round(percent)}%</Text>
            </View>
          )}
          {facts.length === 0 ? null : (
            <Text style={small} numberOfLines={1}>
              {facts.join("  ·  ")}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * The box at the transcript's foot: the user's words go straight to the
 * worker, joining its turn where the provider allows, and Mission Control hears
 * about it when that turn ends. Enter sends on the web's wide layout, as in
 * Mission Control's chat.
 */
function WorkerComposer({
  agent,
  theme,
  compact,
  onSent,
}: {
  agent: AgentSummary;
  theme: PluginTheme;
  compact: boolean;
  onSent: () => void;
}) {
  const steer = useRpc(steerCrew);
  const toast = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submitOnEnter = Platform.OS === "web" && !compact;
  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      frame: {
        paddingHorizontal: compact ? 8 : 12,
        paddingTop: 8,
        paddingBottom: compact ? 8 : 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface0,
      },
      // One box, as Mission Control's composer is: the words, and Send at its foot.
      box: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 12,
        backgroundColor: colors.surface1,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 6,
        gap: 6,
      },
      input: {
        height: compact ? 48 : 60,
        color: colors.foreground,
        fontSize: FONT_SIZE.content,
        lineHeight: lineHeightFor(FONT_SIZE.content),
        padding: 0,
        // The box around it is the field; the web's own focus ring inside it would draw a second one.
        outlineWidth: 0,
        textAlignVertical: "top" as const,
      },
      toolbar: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
      send: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: colors.accent,
      },
      sendIdle: { backgroundColor: colors.surface2 },
    };
  }, [theme, compact]);

  function send(): void {
    const words = text.trim();
    if (words === "" || sending) return;
    setSending(true);
    steer({ agentId: agent.id, serverId: agent.serverId, text: words })
      .then(() => {
        setText((current) => (current.trim() === words ? "" : current));
        onSent();
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setSending(false));
  }

  const idle = sending || text.trim() === "";
  return (
    <View style={styles.frame}>
      <View style={styles.box}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={!sending}
          placeholder="Message the worker…"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel={`Message ${agent.title ?? "the worker"}`}
          multiline
          onKeyPress={
            submitOnEnter
              ? (event: WebKeyPressEvent) => {
                  if (!isSendKey(event.nativeEvent) || sending || text.trim() === "") return;
                  event.preventDefault();
                  send();
                }
              : undefined
          }
          style={styles.input}
        />
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: idle }}
            disabled={idle}
            onPress={send}
            style={[styles.send, idle ? styles.sendIdle : null]}
          >
            <Icon name="ArrowUp" size={16} color={idle ? theme.colors.foregroundMuted : theme.colors.accentForeground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ActivityTranscript({
  agent,
  report,
  column,
  agentId,
  serverId,
  revision,
  theme,
  compact,
  onOpen,
}: {
  /** The worker as the board last saw it, for the header; null draws none. */
  agent: AgentSummary | null;
  report: CrewReportSummary | null;
  /** The card's column, so the face strikes the same pose as on the board. */
  column: FleetCard["column"] | undefined;
  agentId: string;
  /** The connected host the crewmate runs on; null for the board's own host. */
  serverId: string | null;
  /** Changes when the board's poll sees the crewmate change; a second trigger for a re-read. */
  revision: string;
  theme: PluginTheme;
  compact: boolean;
  onOpen: (() => void) | null;
}) {
  const toast = useToast();
  const timeline = useAgentTimeline(agentId, revision, TIMELINE_LIMIT, serverId);
  const rows = useMemo(() => activityRows(timeline.entries), [timeline.entries]);
  const follow = useFollowEnd();
  const { pending, respond } = usePendingRequests(agentId, timeline.agent?.pendingPermissions, follow.pin, serverId);
  /** Tool rows showing their detail, and prompts and reasoning shown whole, by row key. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const running = timeline.agent?.status === "running" || timeline.agent?.status === "initializing";

  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      // Mission Control's chat's measure: room at the sides, a gap between turns, 15-point text at 1.6.
      body: { paddingHorizontal: compact ? 14 : 22, paddingVertical: compact ? 14 : 20, gap: 14 },
      label: { color: colors.foregroundMuted, fontSize: FONT_SIZE.micro, fontWeight: "600" as const, letterSpacing: 0.6, marginTop: 8 },
      prompt: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: 12 },
      promptText: { color: colors.foreground, fontSize: FONT_SIZE.content, lineHeight: relaxed(FONT_SIZE.content) },
      reasoning: { color: colors.foregroundMuted, fontSize: FONT_SIZE.body, lineHeight: relaxed(FONT_SIZE.body), fontStyle: "italic" as const },
      more: { color: colors.accent, fontSize: FONT_SIZE.caption, marginTop: 4 },
      tool: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface0,
        paddingHorizontal: 12,
        paddingVertical: 9,
        gap: 8,
      },
      toolHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      toolLabel: { color: colors.foreground, fontSize: FONT_SIZE.body, fontWeight: "600" as const },
      toolSummary: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.small, fontFamily: MONOSPACE },
      detail: {
        color: colors.foreground,
        fontSize: FONT_SIZE.caption,
        lineHeight: lineHeightFor(FONT_SIZE.caption),
        fontFamily: MONOSPACE,
        backgroundColor: colors.surface2,
        borderRadius: 6,
        padding: 8,
      },
      planRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10 },
      planText: { flex: 1, color: colors.foreground, fontSize: FONT_SIZE.content, lineHeight: relaxed(FONT_SIZE.content) },
      planDone: { color: colors.foregroundMuted, textDecorationLine: "line-through" as const },
      planActive: { fontWeight: "600" as const },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      lineText: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.small },
      error: { color: colors.statusDanger, fontSize: FONT_SIZE.body },
      hint: { color: colors.foregroundMuted, fontSize: FONT_SIZE.small, textAlign: "center" as const, padding: 16 },
      link: { color: colors.accent, fontSize: FONT_SIZE.caption, textDecorationLine: "underline" as const },
    };
  }, [theme, compact]);

  function toggle(key: string): void {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openLink(url: string): void {
    void openExternalUrl(url).catch((caught: unknown) => toast.error(errorText(caught)));
  }

  /** Lines to clamp a foldable text to, or undefined to draw it whole. */
  function foldedLines(key: string, text: string): number | undefined {
    return isLong(text) && !open.has(key) ? FOLDED_LINES : undefined;
  }

  function foldToggle(key: string, text: string) {
    if (!isLong(text)) return null;
    return (
      <Pressable accessibilityRole="button" onPress={() => toggle(key)}>
        <Text style={styles.more}>{open.has(key) ? "Show less" : "Show all"}</Text>
      </Pressable>
    );
  }

  function planIcon(status: PlanStatus) {
    const { colors } = theme;
    // Set down to sit on the first line of the 1.6-spaced text beside it.
    const name = status === "completed" ? "SquareCheck" : status === "in_progress" ? "CircleDot" : "Square";
    const color = status === "completed" ? colors.statusSuccess : status === "in_progress" ? colors.accent : colors.foregroundMuted;
    return (
      <View style={{ marginTop: 5 }}>
        <Icon name={name} size={14} color={color} />
      </View>
    );
  }

  function toolStatusIcon(status: Extract<ActivityRow, { kind: "tool" }>["status"]) {
    const { colors } = theme;
    if (status === "running") return <Spinner size={12} color={colors.accent} />;
    if (status === "failed") return <Icon name="CircleX" size={12} color={colors.statusDanger} />;
    if (status === "canceled") return <Icon name="Ban" size={12} color={colors.foregroundMuted} />;
    return null;
  }

  function renderRow(row: ActivityRow) {
    switch (row.kind) {
      case "prompt":
        return (
          <View style={styles.prompt}>
            <Text selectable style={styles.promptText} numberOfLines={foldedLines(row.key, row.text)}>
              {row.text}
            </Text>
            {foldToggle(row.key, row.text)}
          </View>
        );
      case "reasoning": {
        const text = row.text.trim();
        return (
          <View>
            <Text selectable style={styles.reasoning} numberOfLines={foldedLines(row.key, text)}>
              {text}
            </Text>
            {foldToggle(row.key, text)}
          </View>
        );
      }
      case "reply":
        return <Markdown source={row.text} theme={theme} fontSize={FONT_SIZE.content} relaxed onOpenLink={openLink} debriefButtons />;
      case "tool": {
        const expanded = open.has(row.key) && row.detail !== null;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${row.label} ${row.summary}`}
            accessibilityState={{ expanded, disabled: row.detail === null }}
            disabled={row.detail === null}
            onPress={() => toggle(row.key)}
            style={styles.tool}
          >
            <View style={styles.toolHead}>
              <Icon name={row.icon} size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.toolLabel}>{row.label}</Text>
              <Text style={styles.toolSummary} numberOfLines={1}>
                {row.summary}
              </Text>
              {toolStatusIcon(row.status)}
              {row.detail === null ? null : (
                <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
              )}
            </View>
            {!expanded || row.detail === null ? null : row.markdown ? (
              <Markdown source={row.detail} theme={theme} fontSize={FONT_SIZE.small} onOpenLink={openLink} />
            ) : (
              <Text selectable style={styles.detail}>
                {row.detail}
              </Text>
            )}
          </Pressable>
        );
      }
      case "plan":
        return (
          <View style={{ gap: 4 }}>
            {row.items.map((item, index) => (
              <View key={index} style={styles.planRow}>
                {planIcon(item.status)}
                <Text
                  style={[
                    styles.planText,
                    item.status === "completed" ? styles.planDone : null,
                    item.status === "in_progress" ? styles.planActive : null,
                  ]}
                >
                  {item.text}
                </Text>
              </View>
            ))}
          </View>
        );
      case "error":
        return <Text style={styles.error}>{row.text}</Text>;
      default:
        return (
          <View style={styles.line}>
            <Icon name="Bell" size={11} color={theme.colors.foregroundMuted} />
            <Text style={styles.lineText}>{row.text}</Text>
          </View>
        );
    }
  }

  return (
    <View style={{ flex: 1 }}>
      {agent === null ? null : (
        <WorkerHeader
          agent={agent}
          theme={theme}
          compact={compact}
          report={report}
          column={column}
          usedTokens={timeline.agent?.lastUsage?.contextWindowUsedTokens}
          maxTokens={timeline.agent?.lastUsage?.contextWindowMaxTokens}
        />
      )}
      {/*
        A question's free-text box is at the end of this list; on iOS the system
        insets it for the keyboard and scrolls the focused box into view.
      */}
      <ScrollView {...follow.scrollProps} contentContainerStyle={styles.body} automaticallyAdjustKeyboardInsets>
        {timeline.hasOlder ? (
          <View style={styles.line}>
            <Icon name="History" size={11} color={theme.colors.foregroundMuted} />
            <Text style={styles.lineText}>
              Only the latest activity is shown here.{" "}
              {onOpen === null ? null : (
                <Text accessibilityRole="link" style={styles.link} onPress={onOpen}>
                  The rest is in Paseo.
                </Text>
              )}
            </Text>
          </View>
        ) : null}
        {timeline.error === null ? null : <Text style={styles.error}>{timeline.error}</Text>}
        {rows.length === 0 && pending.length === 0 ? (
          <Text style={styles.hint}>{timeline.loading ? "Loading the worker's activity…" : "Nothing has happened yet."}</Text>
        ) : (
          rows.map((row, index) => {
            const label = LABELS[row.kind];
            const previous = rows[index - 1];
            return (
              <View key={row.key} style={{ gap: 6 }}>
                {label === undefined || previous?.kind === row.kind ? null : <Text style={styles.label}>{label}</Text>}
                {renderRow(row)}
              </View>
            );
          })
        )}
        {pending.map((request) => (
          // A direct child of the transcript, so its layout is in the transcript's coordinates.
          <View key={request.id} onLayout={(event) => follow.reveal(request.id, event.nativeEvent.layout)}>
            <PermissionCard
              request={request}
              theme={theme}
              compact={compact}
              onRespond={(response) => respond(request.id, response)}
              onOpenLink={openLink}
            />
          </View>
        ))}
        {running && pending.length === 0 ? (
          <View style={styles.line}>
            <Spinner size={11} color={theme.colors.accent} />
            <Text style={styles.lineText}>Working…</Text>
          </View>
        ) : null}
      </ScrollView>
      {follow.away ? <JumpToEnd theme={theme} onPress={follow.jumpToEnd} /> : null}
    </View>
  );
}
