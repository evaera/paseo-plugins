/**
 * One card: a crewmate, a backlog item, or both, in two sizes.
 *
 * `CrewCard` is the board's: the summary, and pressing it opens the card's own
 * view (`./card-view`). Its chat button, drawn on hover, points Mission
 * Control's chat at it. `CardSheet` is the whole card, for that view and for the
 * panels beside a workspace: the summary, its facts, and what its column asks
 * the user to decide (`./card-commands`).
 *
 * What Mission Control wrote as the item's `(actions: …)` is a row of buttons
 * under the user's call on both, sent through the board's sender
 * (`./card-answer`), as a suggestion is. Interrupting and ending go to the
 * crewmate directly; relaunching goes through Mission Control, because it owns
 * the brief the new crewmate starts from. Ending archives the agent and leaves
 * its workspace and worktree exactly as they are.
 */
import type { PluginSvgIcon, PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { exitCrew, interruptCrew, relaunchCrew, renameTask, type AgentSummary, type FleetCard } from "../shared/fleet";
import { cardActions, type CoordinatorAsk } from "./card-answer";
import {
  cardMenu,
  dependPrompt,
  dropPrompt,
  undependPrompt,
  waitingPrompt,
  type Choice,
  type DraftKind,
  type Tool,
} from "./card-commands";
import { WorkerAvatar, stateColor } from "./avatar-view";
import { workerState } from "./worker-state";
import { CardDetails } from "./card-details";
import { Entrance, FlashWash } from "./flash";
import { cardForTask, dependencyChoices, useBoardTasks } from "./board-tasks";
import { COLUMNS, columnTone, linkKind } from "./format";
import { OptionPicker } from "./option-picker";
import type { DragHandle } from "./sortable";
import { contextMenuProps } from "./web";
import { IconButton, QuietButton, errorText, tint } from "./ui";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

type Draft = { kind: "relaunch" | "wait"; text: string } | { kind: "end" } | { kind: "drop" } | null;

const DRAFT_PLACEHOLDERS: Readonly<Record<"relaunch" | "wait", string>> = {
  relaunch: "What the new worker should know: progress so far, what to avoid",
  wait: "Waiting on whom, and for what?",
};

const DRAFT_SUBMIT: Readonly<Record<NonNullable<Draft>["kind"], { icon: string; label: string }>> = {
  relaunch: { icon: "RotateCcw", label: "Relaunch" },
  wait: { icon: "Hourglass", label: "Mark waiting" },
  end: { icon: "Power", label: "End it" },
  drop: { icon: "Trash2", label: "Drop it" },
};

function draftFor(kind: DraftKind | null): Draft {
  if (kind === null) return null;
  return kind === "end" || kind === "drop" ? { kind } : { kind, text: "" };
}

const STATE_WORDS: Record<string, string> = {
  working: "Working",
  "needs-decision": "Needs a decision",
  blocked: "Blocked",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  resolved: "Resolved",
};

function useCardStyles(theme: PluginTheme, compact: boolean, card: FleetCard) {
  const tone = columnTone(theme, card.column);
  return useMemo(() => {
    const { colors } = theme;
    const pad = compact ? 10 : 12;
    return {
      pad,
      cardRadius: 10,
      card: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface0 },
      body: { padding: pad, gap: compact ? 8 : 10 },
      header: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 10 },
      headerText: { flex: 1, minWidth: 0, gap: 3 },
      stateLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
      stateText: { fontSize: FONT_SIZE.caption, fontWeight: "600" as const },
      footerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      // A faint wash of the text colour, so a hovered card lifts in a dark theme and dims in a light one.
      washHovered: { backgroundColor: tint(colors.foreground, 0.025, colors.surface1) },
      titleRow: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6 },
      workerMark: { marginTop: -1 },
      corner: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2, marginRight: -4 },
      cornerFloating: {
        position: "absolute" as const,
        top: pad - 5,
        right: pad - 5,
        zIndex: 5,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      cornerButton: { paddingHorizontal: 2, paddingVertical: 2, borderRadius: 4 },
      links: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4, flexShrink: 1 },
      tags: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 4 },
      title: {
        flex: 1,
        color: colors.foreground,
        fontSize: FONT_SIZE.body,
        lineHeight: lineHeightFor(FONT_SIZE.body),
        fontWeight: "600" as const,
      },
      meta: { color: colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      report: { color: colors.foreground, fontSize: FONT_SIZE.small, lineHeight: lineHeightFor(FONT_SIZE.small) },
      reportState: { color: tone, fontWeight: "600" as const },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 2 },
      open: { gap: 12, padding: pad, borderTopWidth: 1, borderTopColor: colors.border },
      choices: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      tools: { flexDirection: "row" as const, flexWrap: "wrap" as const, columnGap: 14, rowGap: 4, flexShrink: 1 },
      input: {
        color: colors.foreground,
        fontSize: FONT_SIZE.body,
        minHeight: 60,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
        textAlignVertical: "top" as const,
      },
      prompt: { color: colors.foreground, fontSize: FONT_SIZE.small },
    };
  }, [theme, compact, tone]);
}

type CardStyles = ReturnType<typeof useCardStyles>;

/**
 * What both sizes show under the title: the status line, the user's call
 * and its buttons, what it waits on, an error, its links, and when it landed.
 * `clamp` folds the long ones to a few lines, for the board.
 */
function CardSummary({
  card,
  theme,
  styles,
  clamp,
  toCoordinator,
  stateInHeader = false,
}: {
  card: FleetCard;
  theme: PluginTheme;
  styles: CardStyles;
  clamp: boolean;
  toCoordinator: CoordinatorAsk | null;
  /** The worker's state is on the line under the title, so the status line reads without its own state word. */
  stateInHeader?: boolean;
}) {
  const toast = useToast();
  const backlog = card.backlog;
  const agent = card.agent;
  const actions = toCoordinator === null ? [] : cardActions(card);
  const tasks = useBoardTasks();
  const blockerId = backlog?.blockedBy?.trim() || null;
  const blocker = blockerId === null ? null : cardForTask(tasks.cards, blockerId);
  // When it landed is worth a line; when it was filed is in the open card's facts.
  const landed = backlog?.outcome ?? null;
  return (
    <>

      {card.report === null ? null : (
        <Text style={styles.report} numberOfLines={clamp ? 3 : undefined}>
          {stateInHeader ? null : (
            <Text style={styles.reportState}>{STATE_WORDS[card.report.state] ?? card.report.state}: </Text>
          )}
          {card.report.text}
        </Text>
      )}
      {backlog?.hold == null ? null : (
        <Text style={styles.report}>
          <Text style={styles.reportState}>Needs you: </Text>
          {backlog.hold}
        </Text>
      )}
      {blockerId === null ? null : (
        // The task this one is blocked by, by its title, and where that one stands; pressing it opens it.
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Blocked by ${blocker?.title ?? blockerId}. Open it`}
          disabled={blocker === null || tasks.open === null}
          onPress={() => {
            if (blocker !== null) tasks.open?.(blocker);
          }}
        >
          <Text style={styles.report}>
            <Text style={styles.reportState}>Blocked by: </Text>
            {blocker?.title ?? blockerId}
            {blocker === null ? null : <Text style={styles.meta}>{`  ·  ${COLUMNS[blocker.column].title}`}</Text>}
          </Text>
        </Pressable>
      )}
      {backlog?.waiting == null ? null : (
        <Text style={styles.report}>
          <Text style={styles.reportState}>Waiting on: </Text>
          {backlog.waiting}
        </Text>
      )}
      {actions.length === 0 ? null : (
        <View style={styles.actions}>
          {actions.map((action, index) => (
            <IconButton
              key={`${index}:${action.label}`}
              icon="Send"
              label={action.label}
              showLabel
              theme={theme}
              disabled={toCoordinator?.sending ?? true}
              onPress={() => toCoordinator?.send(action.prompt)}
            />
          ))}
        </View>
      )}
      {agent?.lastError == null ? null : (
        <Text style={[styles.report, { color: theme.colors.statusDanger }]} numberOfLines={clamp ? 2 : undefined}>
          {agent.lastError}
        </Text>
      )}
      {card.links.length === 0 && backlog?.reportPath == null && landed === null ? null : (
        // One footer row: where the work lives on the left, when it landed on the right.
        <View style={styles.footerRow}>
          <View style={styles.links}>
            {card.links.map((url) => (
              <LinkChip key={url} url={url} theme={theme} onError={(caught) => toast.error(errorText(caught))} />
            ))}
            {backlog?.reportPath == null ? null : <Text style={styles.meta}>Report: {backlog.reportPath}</Text>}
          </View>
          {landed === null ? null : (
            <Text style={styles.meta}>{landed.replace(/^\w/, (first) => first.toUpperCase())}</Text>
          )}
        </View>
      )}
    </>
  );
}

/** Under a worker's title: where it stands, in that state's colour. */
function StateLine({
  agent,
  report,
  theme,
  styles,
}: {
  agent: AgentSummary;
  report: FleetCard["report"];
  theme: PluginTheme;
  styles: CardStyles;
}) {
  const state = workerState(agent, report);
  const color = stateColor(theme, state.tone);
  return (
    <View style={styles.stateLine}>
      <Icon name={state.icon} size={12} color={color} />
      <Text style={[styles.stateText, { color }]}>{state.label}</Text>
    </View>
  );
}

/** The board's card: the summary. Pressing it opens the card's view. */
export function CrewCard({
  card,
  theme,
  compact,
  onOpen,
  onChat,
  toCoordinator,
  drag = null,
  arrivedAt = null,
  onMenu = null,
}: {
  card: FleetCard;
  theme: PluginTheme;
  compact: boolean;
  onOpen: () => void;
  /** Points Mission Control's chat at this card; null where there is no chat to point. */
  onChat: (() => void) | null;
  /** Sends the card's `(actions: …)` buttons to Mission Control; null draws none. */
  toCoordinator: CoordinatorAsk | null;
  /** The handle that moves the card within its column; null where cards cannot be rearranged. */
  drag?: DragHandle | null;
  /** When the card just arrived in its column — moved from another, or new — so it eases in and flashes; null once settled. */
  arrivedAt?: number | null;
  /** Opens the card's context menu at a point in window coordinates: a right click, or a long press on a touch screen. */
  onMenu?: ((x: number, y: number) => void) | null;
}) {
  const styles = useCardStyles(theme, compact, card);
  const [hovered, setHovered] = useState(false);
  // A touch screen has no hover, so the corner buttons are always drawn there, in the title's row; a tablet's
  // browser says so with its first touch. With a pointer they float over the card's corner while it is hovered,
  // as Notion's do, so the title keeps its whole width the rest of the time.
  const [touch, setTouch] = useState(false);
  const alwaysShown = compact || Platform.OS !== "web" || touch;
  const showCorner = alwaysShown || hovered || drag?.dragging === true;
  // An Inbox task's one decision, at hand without opening it.
  const startChoice =
    toCoordinator !== null && card.agent === null && card.column === "queued"
      ? cardMenu(card).choices.find((choice) => choice.kind === "ask")
      : undefined;
  const start = startChoice?.kind === "ask" ? startChoice : null;
  const hasCorner = onChat !== null || drag !== null || start !== null;
  const corner =
    !hasCorner || !showCorner ? null : (
      <View style={alwaysShown ? styles.corner : styles.cornerFloating}>
        {start === null ? null : (
          <QuietButton
            icon={start.icon}
            label={start.label}
            theme={theme}
            disabled={toCoordinator?.sending ?? true}
            onPress={() => toCoordinator?.send(start.prompt)}
          />
        )}
        {onChat === null ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Talk to Mission Control about ${card.title}`}
            style={styles.cornerButton}
            onPress={onChat}
          >
            <Icon name="MessageCircle" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        )}
        {drag === null ? null : (
          // A Pressable of its own, because on the web a click on the grip would otherwise reach the card and open it.
          <Pressable accessible={false} onPress={() => {}}>
            <View
              accessibilityRole="adjustable"
              accessibilityLabel={`Move ${card.title}`}
              accessibilityActions={[
                { name: "increment", label: "Move down" },
                { name: "decrement", label: "Move up" },
              ]}
              onAccessibilityAction={(event) => drag.step(event.nativeEvent.actionName === "decrement" ? -1 : 1)}
              style={styles.cornerButton}
              {...drag.panHandlers}
            >
              <Icon name="GripVertical" size={14} color={theme.colors.foregroundMuted} />
            </View>
          </Pressable>
        )}
      </View>
    );
  return (
    <Entrance play={arrivedAt !== null}>
      <View
        style={[styles.card, drag?.dragging === true ? { borderColor: theme.colors.accent } : null]}
        onPointerEnter={(event) => {
          if (event.nativeEvent.pointerType === "touch") setTouch(true);
          else setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        {...(onMenu === null ? {} : contextMenuProps(onMenu))}
      >
        {arrivedAt === null ? null : (
          // In the colour of the column it arrived in, so where it went reads at a glance.
          <FlashWash key={arrivedAt} color={tint(columnTone(theme, card.column), 0.22, theme.colors.surface1)} radius={styles.cardRadius - 1} />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${card.title}`}
          onPress={() => {
            if (drag?.justDropped() !== true) onOpen();
          }}
          // A touch screen's right click. On the web a long press is left to the browser, which has the right click.
          onLongPress={
            onMenu === null || Platform.OS === "web"
              ? undefined
              : (event) => onMenu(event.nativeEvent.pageX, event.nativeEvent.pageY)
          }
          style={[styles.body, { borderRadius: styles.cardRadius - 1 }, hovered || drag?.dragging === true ? styles.washHovered : null]}
        >
          <View style={styles.header}>
            {card.agent === null ? null : (
              <WorkerAvatar agent={card.agent} theme={theme} size={36} column={card.column} ground={theme.colors.surface0} />
            )}
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={3}>
                {card.title}
              </Text>
              {card.agent === null ? null : <StateLine agent={card.agent} report={card.report} theme={theme} styles={styles} />}
            </View>
            {alwaysShown ? corner : null}
          </View>
          <CardSummary card={card} theme={theme} styles={styles} clamp toCoordinator={toCoordinator} stateInHeader={card.agent !== null} />
          {alwaysShown ? null : corner}
        </Pressable>
      </View>
    </Entrance>
  );
}

/**
 * The whole card, for its own view and the panels: the summary, its facts,
 * and what its column asks for, with Interrupt and Relaunch at hand and End or
 * Drop set apart, each behind a confirmation.
 */
export function CardSheet({
  card,
  theme,
  compact,
  onChanged,
  toCoordinator,
  initialDraft = null,
}: {
  card: FleetCard;
  theme: PluginTheme;
  compact: boolean;
  /** Called after an action lands, so the board refreshes without waiting for its poll. */
  onChanged: () => void;
  /** Sends a choice to Mission Control; null draws only what goes elsewhere. */
  toCoordinator: CoordinatorAsk | null;
  /** A step to open on — the context menu's Relaunch…, Waiting on…, End or Drop — or none. */
  initialDraft?: DraftKind | null;
}) {
  const interrupt = useRpc(interruptCrew);
  const exit = useRpc(exitCrew);
  const relaunch = useRpc(relaunchCrew);
  const toast = useToast();
  const styles = useCardStyles(theme, compact, card);
  const [draft, setDraft] = useState<Draft>(() => draftFor(initialDraft));
  const [busy, setBusy] = useState(false);
  const agent = card.agent;
  const sending = toCoordinator?.sending ?? false;

  const menu = cardMenu(card);
  // Everything but Relaunch is a word to Mission Control, so where there is no Mission Control to send to none of it is drawn.
  const choices = menu.choices.filter((choice) => toCoordinator !== null || choice.kind === "relaunch");
  const tools = menu.tools;
  const removal = menu.removal === "drop" && toCoordinator === null ? null : menu.removal;

  function run(label: string, action: () => Promise<unknown>): void {
    setBusy(true);
    action()
      .then(() => {
        toast.show(label, { variant: "success" });
        setDraft(null);
        onChanged();
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setBusy(false));
  }

  /** Sends the open draft's request to Mission Control and closes the draft once the daemon has it. */
  function tell(prompt: string): void {
    toCoordinator?.send(prompt, undefined, () => setDraft(null));
  }

  function choose(choice: Choice): void {
    // A one-tap request leaves whatever draft is open alone.
    if (choice.kind === "ask") toCoordinator?.send(choice.prompt);
    else setDraft({ kind: choice.kind, text: "" });
  }

  function applyTool(tool: Tool): void {
    if (tool === "relaunch") setDraft({ kind: "relaunch", text: "" });
    else if (agent !== null) run("Interrupted.", () => interrupt({ agentId: agent.id, serverId: agent.serverId }));
  }

  function submitDraft(): void {
    if (draft === null) return;
    if (draft.kind === "drop") {
      tell(dropPrompt(card));
      return;
    }
    if (draft.kind === "wait") {
      if (draft.text.trim() !== "") tell(waitingPrompt(card, draft.text));
      return;
    }
    if (agent === null) return;
    if (draft.kind === "end") {
      run("The worker was ended; its local copy is untouched.", () => exit({ agentId: agent.id, serverId: agent.serverId }));
      return;
    }
    const text = draft.text.trim();
    if (text !== "") run("Asked Mission Control to relaunch it.", () => relaunch({ agentId: agent.id, serverId: agent.serverId, note: text }));
  }

  return (
    <View style={styles.card}>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          {card.backlog === null ? (
            <Text style={styles.title}>{card.title}</Text>
          ) : (
            <EditableTitle
              key={card.backlog.id}
              taskId={card.backlog.id}
              title={card.title}
              theme={theme}
              style={styles.title}
              onChanged={onChanged}
            />
          )}
        </View>
        <CardSummary card={card} theme={theme} styles={styles} clamp={false} toCoordinator={toCoordinator} />
      </View>
      <View style={styles.open}>
        <CardDetails card={card} theme={theme} />
        {card.taskId === null || toCoordinator === null ? null : (
          <Blocker card={card} taskId={card.taskId} theme={theme} compact={compact} toCoordinator={toCoordinator} />
        )}
        {choices.length === 0 ? null : (
          <View style={styles.choices}>
            {choices.map((choice, index) => (
              <IconButton
                key={choice.label}
                icon={choice.icon}
                label={choice.label}
                showLabel
                tone={index === 0 ? "accent" : "default"}
                theme={theme}
                disabled={choice.kind === "relaunch" ? busy : sending}
                onPress={() => choose(choice)}
              />
            ))}
          </View>
        )}
        {tools.length === 0 && removal === null ? null : (
          <View style={styles.footer}>
            <View style={styles.tools}>
              {tools.map((tool) => (
                <QuietButton
                  key={tool}
                  icon={tool === "interrupt" ? "Square" : "RotateCcw"}
                  label={tool === "interrupt" ? "Interrupt" : "Relaunch"}
                  theme={theme}
                  disabled={busy || (tool === "interrupt" && agent?.status !== "running" && agent?.status !== "initializing")}
                  onPress={() => applyTool(tool)}
                />
              ))}
            </View>
            {removal === null ? null : (
              <QuietButton
                icon={removal === "end" ? "Power" : "Trash2"}
                label={removal === "end" ? "End worker" : "Drop task"}
                tone="danger"
                theme={theme}
                disabled={removal === "end" ? busy : sending}
                onPress={() => setDraft({ kind: removal })}
              />
            )}
          </View>
        )}
        {draft === null ? null : (
          <View style={{ gap: 6 }}>
            {draft.kind === "end" || draft.kind === "drop" ? (
              <Text style={styles.prompt}>
                {draft.kind === "end"
                  ? "End this worker? The agent is archived; its workspace and local copy stay exactly as they are."
                  : "Drop this task? Mission Control takes it off the backlog."}
              </Text>
            ) : (
              <TextInput
                value={draft.text}
                onChangeText={(text) => setDraft({ kind: draft.kind, text })}
                placeholder={DRAFT_PLACEHOLDERS[draft.kind]}
                placeholderTextColor={theme.colors.foregroundMuted}
                multiline={draft.kind !== "wait"}
                autoFocus={!compact}
                style={[styles.input, draft.kind === "wait" ? { minHeight: 0 } : null]}
              />
            )}
            <View style={styles.choices}>
              <IconButton
                icon={DRAFT_SUBMIT[draft.kind].icon}
                label={DRAFT_SUBMIT[draft.kind].label}
                showLabel
                tone={draft.kind === "end" || draft.kind === "drop" ? "danger" : "accent"}
                theme={theme}
                // Only Wait and Drop go through Mission Control's one-at-a-time send; the rest go to the worker.
                disabled={
                  busy ||
                  ((draft.kind === "wait" || draft.kind === "drop") && sending) ||
                  ("text" in draft && draft.text.trim() === "")
                }
                onPress={submitDraft}
              />
              <IconButton icon="X" label="Cancel" showLabel theme={theme} onPress={() => setDraft(null)} />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The task this one is blocked by, in its view, as one line beside its other
 * facts: that task, which opens it, and an × that clears it; or, with none,
 * Add blocker, which picks one of the board's other open tasks. "Blocked by"
 * is task order only — who the work waits on is Waiting on. Changes go to the
 * Mission Control, which keeps the backlog's `(blocked-by: …)`, as Start and Drop
 * do; the line changes once it has written it.
 */
function Blocker({
  card,
  taskId,
  theme,
  compact,
  toCoordinator,
}: {
  card: FleetCard;
  taskId: string;
  theme: PluginTheme;
  compact: boolean;
  toCoordinator: CoordinatorAsk;
}) {
  const tasks = useBoardTasks();
  const current = card.backlog?.blockedBy?.trim() || null;
  const blocker = current === null ? null : cardForTask(tasks.cards, current);
  const muted = theme.colors.foregroundMuted;
  const options = useMemo(
    () =>
      dependencyChoices(tasks.cards, taskId).map((other) => ({
        label: other.title,
        value: other.taskId ?? "",
        detail: COLUMNS[other.column].title,
      })),
    [tasks.cards, taskId],
  );

  if (current !== null) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="Link2" size={12} color={muted} />
        <Text style={{ color: muted, fontSize: FONT_SIZE.small }}>Blocked by</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${blocker?.title ?? current}`}
          disabled={blocker === null || tasks.open === null}
          style={{ flex: 1, minWidth: 0 }}
          onPress={() => {
            if (blocker !== null) tasks.open?.(blocker);
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: FONT_SIZE.small }} numberOfLines={1}>
            {blocker?.title ?? current}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove the blocker"
          hitSlop={6}
          disabled={toCoordinator.sending}
          onPress={() => toCoordinator.send(undependPrompt(card, current))}
        >
          <Icon name="X" size={13} color={muted} />
        </Pressable>
      </View>
    );
  }
  return (
    <OptionPicker
      label="Blocked by"
      title="Blocked by which task?"
      value=""
      options={options}
      searchPlaceholder="Search tasks"
      theme={theme}
      compact={compact}
      disabled={toCoordinator.sending}
      onSelect={(value) => {
        const other = options.find((option) => option.value === value);
        if (other !== undefined) toCoordinator.send(dependPrompt(card, { taskId: value, title: other.label }));
      }}
      renderTrigger={(open) => (
        <View style={{ alignSelf: "flex-start" }}>
          <QuietButton icon="Link2" label="Add blocker" theme={theme} disabled={toCoordinator.sending} onPress={open} />
        </View>
      )}
    />
  );
}

/**
 * A task's title in its view, which becomes a text box when pressed: outlined
 * where it stands, at the same size, so it reads as the title being edited
 * rather than a form. Enter or leaving the box saves, Escape puts it back. The
 * daemon rewrites the title on the task's backlog line (`mission-control.task.rename`);
 * until the board's next load shows it, the new title stays on screen. A worker
 * with no task has no line to rename, and its title is plain text.
 */
function EditableTitle({
  taskId,
  title,
  theme,
  style,
  onChanged,
}: {
  taskId: string;
  title: string;
  theme: PluginTheme;
  style: object;
  onChanged: () => void;
}) {
  const rename = useRpc(renameTask);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(title);
  /** A title saved but not yet back from the daemon, drawn in the meantime. */
  const [saved, setSaved] = useState<string | null>(null);
  /** Set once an edit has ended, so Enter and the blur that follows it — or Escape and its blur — end it once. */
  const ended = useRef(false);
  const shown = saved !== null && saved !== title ? saved : title;
  const box = {
    marginVertical: -4,
    marginHorizontal: -6,
    paddingVertical: 3,
    paddingHorizontal: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    // The box around it is the field; the web's own focus ring inside it would draw a second one.
    outlineWidth: 0,
  };

  function finish(save: boolean): void {
    if (ended.current) return;
    ended.current = true;
    setEditing(false);
    const next = text.replace(/\s+/g, " ").trim();
    if (!save || next === "" || next === shown) {
      setText(shown);
      return;
    }
    setSaved(next);
    rename({ taskId, title: next })
      .then(() => onChanged())
      .catch((caught: unknown) => {
        setSaved(null);
        setText(title);
        toast.error(errorText(caught));
      });
  }

  if (!editing) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${shown}. Rename`}
        style={{ flex: 1 }}
        onPress={() => {
          ended.current = false;
          setText(shown);
          setEditing(true);
        }}
      >
        <Text style={style}>{shown}</Text>
      </Pressable>
    );
  }
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      autoFocus
      selectTextOnFocus
      multiline
      blurOnSubmit
      accessibilityLabel="Task title"
      onSubmitEditing={() => finish(true)}
      onBlur={() => finish(true)}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") finish(false);
      }}
      style={[style, box]}
    />
  );
}

/** One link on a card: an icon for the kind of page, and a pull request's number. */
function LinkChip({ url, theme, onError }: { url: string; theme: PluginTheme; onError: (caught: unknown) => void }) {
  const [hovered, setHovered] = useState(false);
  const kind = linkKind(url);
  const color = hovered ? theme.colors.foreground : theme.colors.foregroundMuted;
  const icon: string | PluginSvgIcon = kind.icon;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${kind.label}`}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => {
        void openExternalUrl(url).catch(onError);
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: kind.short === null ? 4 : 6,
        paddingVertical: 3,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: hovered ? theme.colors.surface2 : theme.colors.surface1,
      }}
    >
      {typeof icon === "string" ? <Icon name={icon} size={13} color={color} /> : <Icon icon={icon} size={13} color={color} />}
      {kind.short === null ? null : <Text style={{ color, fontSize: FONT_SIZE.caption }}>{kind.short}</Text>}
    </Pressable>
  );
}
