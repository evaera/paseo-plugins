/**
 * The conversation with Mission Control: its transcript, folded to the words,
 * and a composer. The whole session — every tool call and its output — is
 * one press away in Paseo itself, which is what the Open button is for.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  View,
  type TextInput as NativeTextInput,
} from "react-native";

import { MAX_FILE_CANDIDATES, findHomeFiles } from "../shared/files";
import type { AgentSummary, CoordinatorCommand, Suggestion } from "../shared/fleet";
import {
  admit,
  userMessage,
  formatBytes,
  hasContent,
  pendingAttachments,
  readEach,
  restoreFailed,
  type PendingAttachment,
} from "./attachments";
import { useAppFocused } from "./app-focus";
import { FlashWash } from "./flash";
import { avatarIcon } from "./avatar";
import { aboutMessage, chatAbout } from "./chat-about";
import { drafts } from "./draft";
import { lookupIn, recentCandidates } from "./file-links";
import { useFollowEnd } from "./use-follow-end";
import { isSendKey, type WebKeyPressEvent } from "./keys";
import { CoordinatorControls } from "./coordinator-controls";
import { SuggestionChips } from "./suggestions";
import { useCoordinatorSender } from "./coordinator-send";
import { Markdown } from "./markdown";
import { PermissionCard, usePendingRequests } from "./permission-card";
import { transcriptRows, type TranscriptRow } from "./transcript-rows";
import { latestCoordinatorSeq, unreadKeys } from "./unread";
import { JumpToEnd, MONOSPACE, QuietButton, Spinner, errorText, tint } from "./ui";
import { useKeyboardOverlap } from "./keyboard";
import { useAgentTimeline } from "./use-timeline";
import { canAttachFiles, pickFiles, receiveFiles, type OfferedFile } from "./web";
import { FONT_SIZE, lineHeightFor } from "./type-scale";

/** A run of tool calls shows this many before folding the rest behind a count. */
const TOOL_RUN_VISIBLE = 2;

/**
 * The composer's height; longer text scrolls inside it. Fixed rather than
 * grown with the text: on the web renderer a textarea's reported content
 * height is never less than its own height, so a box sized from it can grow
 * but never shrink back.
 */
const INPUT_HEIGHT = 72;
const INPUT_HEIGHT_COMPACT = 56;


type Group = { key: string; row: TranscriptRow } | { key: string; tools: Extract<TranscriptRow, { kind: "tool" }>[] };

/** Consecutive tool rows become one group, so a supervision pass is a line, not a page. */
function groupRows(rows: readonly TranscriptRow[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (row.kind === "tool" && last !== undefined && "tools" in last) {
      last.tools.push(row);
    } else if (row.kind === "tool") {
      groups.push({ key: row.key, tools: [row] });
    } else {
      groups.push({ key: row.key, row });
    }
  }
  return groups;
}

/**
 * Which of the paths Mission Control's replies name are files in its home — the
 * daemon's say, since only it can see the disk. Asked once for the whole
 * conversation, the most recently mentioned kept past the cap, and again now
 * and then, so a file Mission Control writes after naming it becomes a link.
 * Until the answer arrives, and if it fails, the paths are text.
 */
function useHomeFileLinks(rows: readonly TranscriptRow[]) {
  const find = useRpc(findHomeFiles);
  const candidates = useMemo(
    () => recentCandidates(rows.flatMap((row) => (row.kind === "coordinator" ? [row.text] : [])), MAX_FILE_CANDIDATES),
    [rows],
  );
  const found = useQuery({
    queryKey: ["mission-control", "files", "find", candidates],
    queryFn: () => find({ paths: candidates }),
    enabled: candidates.length > 0,
    refetchInterval: 30_000,
    // A new mention asks again; the links already drawn stay while it does.
    placeholderData: (previous) => previous,
  });
  const answer = found.data?.files;
  return useMemo(() => lookupIn(answer ?? {}), [answer]);
}

export function CoordinatorChat({
  coordinator,
  theme,
  compact,
  onChanged,
  onOpenFile,
  suggestions,
  onPickSuggestion,
  onRemoveSuggestion,
  visible,
  seenSeq,
  onSeen,
  renderCard,
}: {
  coordinator: AgentSummary;
  theme: PluginTheme;
  compact: boolean;
  /** After a compact or a restart, so the board catches up without waiting for its poll. */
  onChanged: () => void;
  /** Opens a home file in the Files view, the same way a watch's name does. */
  onOpenFile: (path: string) => void;
  /** Mission Control's next-step suggestions, as chips above the composer. */
  suggestions: readonly Suggestion[];
  onPickSuggestion: (prompt: string) => void;
  onRemoveSuggestion: (suggestion: Suggestion) => Promise<void>;
  /** The chat is on screen: not folded on a wide layout, its tab chosen on a phone. */
  visible: boolean;
  /** The newest Mission Control message the user has seen, by sequence number; null before any. */
  seenSeq: number | null;
  /** Records the newest one seen. */
  onSeen: (seq: number) => void;
  /** Draws a `[[card: …]]` Mission Control embedded, from the live board. */
  renderCard: (ref: string) => ReactNode;
}) {
  const toast = useToast();
  /** Shared with the surface's suggestion buttons: one message on its way at a time — see `./coordinator-send`. */
  const { sending, send, command: sendCoordinatorCommand } = useCoordinatorSender(coordinator.id);
  const timeline = useAgentTimeline(coordinator.id, `${coordinator.updatedAt}:${coordinator.pendingPermissions}`);
  const rows = useMemo(() => transcriptRows(timeline.entries), [timeline.entries]);
  const groups = useMemo(() => groupRows(rows), [rows]);

  /**
   * Whether this chat is laid out on screen. Paseo keeps an earlier Mission Control screen mounted, hidden,
   * under the one in view, chat and all; that one has no size. It must neither take the cursor a card's
   * button asks for — it subscribed first, and focused its own invisible box — nor count as the user
   * looking, which would mark messages seen behind their back.
   */
  const [displayed, setDisplayed] = useState(true);
  const displayedRef = useRef(true);
  displayedRef.current = displayed;

  /**
   * Discord's way with what came in while the user was away: when the chat comes into view — the
   * screen opened, its tab chosen, Paseo's window focused again — Mission Control's messages since the
   * last one seen sit under a red "New" line and flash a warm wash that fades. What arrives while the
   * user is looking is seen as it lands. A first look with nothing recorded flashes nothing.
   */
  const focused = useAppFocused();
  const looking = visible && focused && displayed;
  const latest = useMemo(() => latestCoordinatorSeq(rows), [rows]);
  const [unread, setUnread] = useState<{ keys: ReadonlySet<string>; first: string; at: number } | null>(null);
  const wasLooking = useRef(false);
  useEffect(() => {
    if (latest === null) return;
    if (looking && !wasLooking.current && seenSeq !== null && latest > seenSeq) {
      const keys = unreadKeys(rows, seenSeq);
      const first = keys[0];
      if (first !== undefined) setUnread({ keys: new Set(keys), first, at: Date.now() });
    }
    wasLooking.current = looking;
    if (looking && (seenSeq === null || latest > seenSeq)) onSeen(latest);
    // `rows` changes with `latest`, which is what matters here.
  }, [looking, latest, seenSeq]);
  const files = useHomeFileLinks(rows);
  const follow = useFollowEnd();
  /** What Mission Control is waiting on — a question, a permission, a plan. */
  const { pending, respond } = usePendingRequests(coordinator.id, timeline.agent?.pendingPermissions, follow.pin);

  /**
   * A half-typed message survives the surface unmounting, which it does every
   * time the user opens a workspace, and the plugin being evaluated afresh
   * after a lost connection — see `./draft`.
   */
  const [draft, setDraftState] = useState(() => drafts.get(coordinator.id));
  /** What is attached to the draft, kept beside it for the same reasons — see `./attachments`. */
  const [attachments, setAttachmentsState] = useState(() => pendingAttachments.get(coordinator.id));
  /**
   * The stores are the truth and this chat follows them, so a send that fails
   * after the chat that made it was unmounted — a tab switch mid-send on a
   * phone — puts its text and attachments back in the chat on screen now.
   */
  useEffect(() => {
    function reread(): void {
      setDraftState(drafts.get(coordinator.id));
      setAttachmentsState(pendingAttachments.get(coordinator.id));
    }
    const stopDrafts = drafts.subscribe(reread);
    const stopAttachments = pendingAttachments.subscribe(reread);
    reread();
    return () => {
      stopDrafts();
      stopAttachments();
    };
  }, [coordinator.id]);
  /** The card a card's chat button pointed this message at, and the box it puts the cursor in. */
  const about = useSyncExternalStore(chatAbout.subscribe, chatAbout.get);
  const input = useRef<NativeTextInput>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * After the press that asked and the render it caused have both finished, and only here when this
     * chat is the one on screen; a hidden one leaves the request for it.
     */
    function claim(): void {
      if (!displayedRef.current || !chatAbout.takeFocus()) return;
      clearTimeout(timer);
      timer = setTimeout(() => input.current?.focus(), 0);
    }
    claim();
    const stop = chatAbout.subscribe(claim);
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);
  /** A drag carrying files is over the chat. */
  const [dragging, setDragging] = useState(false);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const pane = useRef<View>(null);
  /** The keyboard's cover over this pane; padding it away lifts the composer above the keyboard. */
  const keyboard = useKeyboardOverlap(pane);
  // The transcript shrinks when the keyboard opens; keep its end in view if that is where the user was.
  useEffect(() => {
    // Not a dependency: `follow` is new every render, and the keyboard opening is the event.
    if (keyboard > 0) follow.keepAtEnd();
  }, [keyboard]);
  // A message going out from anywhere — a suggestion's button too — brings the end, where it will appear, into view.
  useEffect(() => {
    if (sending) follow.pin();
  }, [sending]);
  const submitOnEnter = Platform.OS === "web" && !compact;
  /** The timeline's snapshot is re-read with every stream event; the board's poll is the fallback. */
  const status = timeline.agent?.status ?? coordinator.status;
  const usage = timeline.agent?.lastUsage;

  function setDraft(text: string): void {
    drafts.set(coordinator.id, text);
    setDraftState(text);
  }

  function setAttachments(list: readonly PendingAttachment[]): void {
    pendingAttachments.set(coordinator.id, list);
    setAttachmentsState(list);
  }

  /**
   * Reads what was picked, pasted or dropped and adds it to the draft's
   * attachments. Nothing past the limits is read at all; a file that cannot be
   * read is reported and the rest still attach. The list is re-read from the
   * store once the bytes are in, and the limits checked again, so two quick
   * drops, or a removal while one is reading, both hold.
   */
  function attach(files: readonly OfferedFile[]): void {
    const first = admit(pendingAttachments.get(coordinator.id), files);
    first.problems.forEach((problem) => toast.error(problem));
    if (first.accepted.length === 0) return;
    readEach(first.accepted)
      .then(({ read, failures }) => {
        failures.forEach((failure) => toast.error(failure));
        const current = pendingAttachments.get(coordinator.id);
        const second = admit(current, read);
        second.problems.forEach((problem) => toast.error(problem));
        if (second.accepted.length > 0) setAttachments([...current, ...second.accepted]);
      })
      .catch((caught: unknown) => toast.error(errorText(caught)));
  }

  /** Paste and drop call whichever `attach` the latest render made, so they never hold a stale Mission Control. */
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(
    () =>
      receiveFiles(
        pane.current,
        (files) => attachRef.current(files),
        (over) => setDragging(over),
      ),
    [],
  );

  function openPicker(): void {
    pickFiles()
      .then((files) => attach(files))
      .catch((caught: unknown) => toast.error(errorText(caught)));
  }

  /** A warm wash: the warning colour, faint over the transcript's own ground. */
  const flashColor = tint(theme.colors.statusWarning, 0.14, theme.colors.surface1);
  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      pane: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
      transcript: { flex: 1 },
      scroller: { flex: 1 },
      transcriptBody: { paddingHorizontal: compact ? 14 : 22, paddingVertical: compact ? 14 : 20, gap: 18 },
      user: {
        alignSelf: "flex-end" as const,
        maxWidth: "85%" as const,
        backgroundColor: colors.surface2,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
      },
      userText: { color: colors.foreground, fontSize: FONT_SIZE.content, lineHeight: Math.round(FONT_SIZE.content * 1.6) },
      coordinator: { alignSelf: "stretch" as const, position: "relative" as const },
      newLine: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, marginVertical: -6 },
      newRule: { flex: 1, height: 1, backgroundColor: colors.statusDanger },
      newText: { color: colors.statusDanger, fontSize: FONT_SIZE.micro, fontWeight: "700" as const, letterSpacing: 0.6 },
      line: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      lineText: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      toolText: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption, fontFamily: MONOSPACE },
      more: { color: colors.accent, fontSize: FONT_SIZE.caption },
      error: { color: colors.statusDanger, fontSize: FONT_SIZE.small },
      hint: { color: colors.foregroundMuted, fontSize: FONT_SIZE.small, textAlign: "center" as const, padding: 16 },
      composerFrame: {
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface0,
      },
      composer: { paddingHorizontal: compact ? 8 : 12, paddingTop: 8, paddingBottom: compact ? 8 : 12, gap: 8 },
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
      toolbar: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      toolbarStart: { flex: 1, flexDirection: "row" as const, alignItems: "center" as const, gap: 14, minWidth: 0 },
      toolIcon: { padding: 4, marginLeft: -4 },
      send: {
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: colors.accent,
      },
      sendIdle: { backgroundColor: colors.surface2 },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      aboutPill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        maxWidth: "100%" as const,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      aboutText: { flexShrink: 1, color: colors.foreground, fontSize: FONT_SIZE.small },
      dropZone: {
        position: "absolute" as const,
        top: 8,
        right: 8,
        bottom: 8,
        left: 8,
        zIndex: 10,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 6,
        borderWidth: 2,
        borderStyle: "dashed" as const,
        borderColor: colors.accent,
        borderRadius: 10,
        backgroundColor: colors.surface1,
      },
      dropText: { color: colors.foreground, fontSize: FONT_SIZE.body },
      input: {
        color: colors.foreground,
        fontSize: FONT_SIZE.content,
        lineHeight: lineHeightFor(FONT_SIZE.content),
        height: compact ? INPUT_HEIGHT_COMPACT : INPUT_HEIGHT,
        padding: 0,
        // The box around it is the field; the web's own focus ring inside it would draw a second one.
        outlineWidth: 0,
        textAlignVertical: "top" as const,
      },
    };
  }, [theme, compact]);

  /**
   * The draft and its attachments are cleared as the message goes, not when
   * the daemon answers: the box stays editable while it is in flight, and a
   * follow-up typed in that second must not be wiped by the reply. A failed
   * send puts the text back, unless something new has been typed since, and
   * its attachments ahead of any attached since.
   */
  function sendDraft(): void {
    const text = draft;
    const attached = attachments;
    const card = about;
    if (!hasContent(text, attached) || sending) return;
    // Through the stores only: this chat may be gone by the time the send fails, and the one on screen follows them.
    const sent = send(userMessage(aboutMessage(card, text), attached), () => {
      if (drafts.get(coordinator.id).trim() === "") drafts.set(coordinator.id, text);
      pendingAttachments.set(coordinator.id, restoreFailed(pendingAttachments.get(coordinator.id), attached));
      if (chatAbout.get() === null) chatAbout.set(card);
    });
    if (!sent) return;
    follow.pin();
    setDraft("");
    setAttachments([]);
    // A card's button points one message; an open card points them all until it closes.
    if (card !== null && card.sticky !== true) chatAbout.set(null);
  }

  /** Status or Catch up: the words are the daemon's, from its templates. */
  function sendCommand(command: CoordinatorCommand): void {
    if (sendCoordinatorCommand(command)) follow.pin();
  }

  function openLink(url: string): void {
    void openExternalUrl(url).catch((caught: unknown) => toast.error(errorText(caught)));
  }

  function renderGroup(group: Group) {
    if ("tools" in group) {
      const open = openGroups.has(group.key);
      const shown = open ? group.tools : group.tools.slice(-TOOL_RUN_VISIBLE);
      const hidden = group.tools.length - shown.length;
      return (
        <View key={group.key} style={{ gap: 3 }}>
          {hidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${hidden} more tool calls`}
              onPress={() => setOpenGroups((current) => new Set([...current, group.key]))}
            >
              <Text style={styles.more}>+ {hidden} more tool calls</Text>
            </Pressable>
          ) : null}
          {shown.map((tool) => (
            <View key={tool.key} style={styles.line}>
              {tool.status === "running" ? (
                <Spinner size={11} color={theme.colors.foregroundMuted} />
              ) : (
                <Icon
                  name={tool.status === "failed" ? "X" : "Wrench"}
                  size={11}
                  color={tool.status === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted}
                />
              )}
              <Text style={styles.toolText} numberOfLines={1}>
                {tool.text}
              </Text>
            </View>
          ))}
        </View>
      );
    }
    const row = group.row;
    switch (row.kind) {
      case "user":
        return (
          <View key={row.key} style={styles.user}>
            <Text selectable style={styles.userText}>
              {row.text}
            </Text>
          </View>
        );
      case "coordinator":
        return (
          <View key={row.key} style={styles.coordinator}>
            {unread?.keys.has(row.key) === true ? <FlashWash key={unread.at} color={flashColor} outset={10} radius={10} /> : null}
            <Markdown
              source={row.text}
              theme={theme}
              fontSize={FONT_SIZE.content}
              relaxed
              onOpenLink={openLink}
              files={files}
              onOpenFile={onOpenFile}
              renderCard={renderCard}
            />
          </View>
        );
      case "error":
        return (
          <Text key={row.key} style={styles.error}>
            {row.text}
          </Text>
        );
      default:
        return (
          <View key={row.key} style={styles.line}>
            <Icon name="Bell" size={11} color={theme.colors.foregroundMuted} />
            <Text style={styles.lineText}>{row.text}</Text>
          </View>
        );
    }
  }

  return (
    <View
      ref={pane}
      style={[styles.pane, { paddingBottom: keyboard }]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setDisplayed(width > 0 && height > 0);
      }}
    >
      <View style={styles.transcript}>
        <ScrollView {...follow.scrollProps} style={styles.scroller} contentContainerStyle={styles.transcriptBody}>
          {timeline.error === null ? null : <Text style={styles.error}>{timeline.error}</Text>}
          {groups.length === 0 && pending.length === 0 ? (
            <Text style={styles.hint}>{timeline.loading ? "Loading the conversation…" : "Nothing said yet. Ask below."}</Text>
          ) : (
            groups.map((group) =>
              unread?.first === group.key ? (
                <View key={`new:${group.key}`} style={{ gap: 18 }}>
                  <View style={styles.newLine} accessibilityRole="text" accessibilityLabel="New messages">
                    <View style={styles.newRule} />
                    <Text style={styles.newText}>New</Text>
                  </View>
                  {renderGroup(group)}
                </View>
              ) : (
                renderGroup(group)
              ),
            )
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
        </ScrollView>
        {follow.away ? <JumpToEnd theme={theme} onPress={follow.jumpToEnd} /> : null}
      </View>
      {/*
        The host pads a surface's top, under its header, but not its bottom, so
        on a phone the composer would sit on the home indicator. React Native's
        own SafeAreaView is the one inset source a plugin can import — the
        safe-area-context library is not among the host's modules. It pads
        only the edges it overlaps, and it replaces any padding in its own
        style, which is why the composer's padding is on the view inside.
        Deprecated in React Native 0.81 but present; the web renderer pads by
        the browser's safe-area insets, which are zero on a desktop.
      */}
      <SafeAreaView style={styles.composerFrame}>
        <View style={styles.composer}>
          <SuggestionChips
            suggestions={suggestions}
            theme={theme}
            disabled={sending}
            onPick={onPickSuggestion}
            onRemove={onRemoveSuggestion}
          />
          {/* One box, as Paseo's composer is: what the message carries, the words, and its toolbar. */}
          <View style={styles.box}>
            {attachments.length === 0 && about === null ? null : (
              <View style={styles.chips}>
                {about === null ? null : (
                  <View style={styles.aboutPill}>
                    {about.agentId == null ? (
                      <Icon name="SquareKanban" size={12} color={theme.colors.foregroundMuted} />
                    ) : (
                      <Icon icon={avatarIcon(about.agentId)} size={16} />
                    )}
                    <Text style={styles.aboutText} numberOfLines={1}>
                      {about.title}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Stop talking about ${about.title}`}
                      hitSlop={6}
                      onPress={() => chatAbout.set(null)}
                    >
                      <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  </View>
                )}
                {attachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    theme={theme}
                    onRemove={() =>
                      setAttachments(pendingAttachments.get(coordinator.id).filter((kept) => kept.id !== attachment.id))
                    }
                  />
                ))}
              </View>
            )}
            <TextInput
              ref={input}
              value={draft}
              onChangeText={setDraft}
              placeholder={about === null ? "Message the coordinator…" : `Message the coordinator about this…`}
              placeholderTextColor={theme.colors.foregroundMuted}
              multiline
              onKeyPress={
                submitOnEnter
                  ? (event: WebKeyPressEvent) => {
                      // Nothing to send, or a send in flight: Enter is left alone, as Paseo leaves it.
                      if (!isSendKey(event.nativeEvent) || sending || !hasContent(draft, attachments)) return;
                      event.preventDefault();
                      sendDraft();
                    }
                  : undefined
              }
              style={styles.input}
            />
            <View style={styles.toolbar}>
              <View style={styles.toolbarStart}>
                {canAttachFiles ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Attach files or images"
                    style={styles.toolIcon}
                    onPress={openPicker}
                  >
                    <Icon name="Paperclip" size={15} color={theme.colors.foregroundMuted} />
                  </Pressable>
                ) : null}
                <QuietButton
                  icon="Compass"
                  label="Status"
                  theme={theme}
                  disabled={sending}
                  onPress={() => sendCommand("status")}
                />
                <QuietButton
                  icon="History"
                  label="Catch up"
                  theme={theme}
                  disabled={sending}
                  onPress={() => sendCommand("catch-up")}
                />
              </View>
              <CoordinatorControls
                theme={theme}
                compact={compact}
                usedTokens={usage?.contextWindowUsedTokens}
                maxTokens={usage?.contextWindowMaxTokens}
                running={status === "running" || status === "initializing"}
                onChanged={onChanged}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: sending || !hasContent(draft, attachments) }}
                disabled={sending || !hasContent(draft, attachments)}
                onPress={sendDraft}
                style={[styles.send, sending || !hasContent(draft, attachments) ? styles.sendIdle : null]}
              >
                <Icon
                  name="ArrowUp"
                  size={16}
                  color={sending || !hasContent(draft, attachments) ? theme.colors.foregroundMuted : theme.colors.accentForeground}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
      {dragging ? (
        /*
          Over the whole chat, transcript through composer, since the whole
          pane takes the drop; it never takes the pointer itself. The pane's
          last child and raised, because on the web renderer every view is
          positioned and a later sibling — the composer — paints over an
          earlier one; opaque, so the transcript's scrollbar does not show
          through its right edge.
        */
        <View pointerEvents="none" style={styles.dropZone}>
          <Icon name="Paperclip" size={18} color={theme.colors.accent} />
          <Text style={styles.dropText}>Drop to attach</Text>
        </View>
      ) : null}
    </View>
  );
}

/** One attachment waiting to go: a thumbnail for an image, an icon for a file; its name, size and a remove button. */
function AttachmentChip({
  attachment,
  theme,
  onRemove,
}: {
  attachment: PendingAttachment;
  theme: PluginTheme;
  onRemove: () => void;
}) {
  const { colors } = theme;
  const styles = useMemo(
    () => ({
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        maxWidth: 220,
        paddingLeft: 4,
        paddingRight: 2,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      },
      thumb: { width: 28, height: 28, borderRadius: 4, backgroundColor: colors.surface2 },
      icon: {
        width: 28,
        height: 28,
        borderRadius: 4,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: colors.surface2,
      },
      text: { flexShrink: 1 },
      name: { color: colors.foreground, fontSize: FONT_SIZE.small },
      size: { color: colors.foregroundMuted, fontSize: FONT_SIZE.micro },
      remove: { padding: 4 },
    }),
    [colors],
  );
  return (
    <View style={styles.chip}>
      {attachment.kind === "image" ? (
        <Image
          source={{ uri: `data:${attachment.mimeType};base64,${attachment.data}` }}
          style={styles.thumb}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={styles.icon}>
          <Icon name="File" size={14} color={colors.foregroundMuted} />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {attachment.fileName}
        </Text>
        <Text style={styles.size}>{formatBytes(attachment.size)}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${attachment.fileName}`}
        hitSlop={6}
        style={styles.remove}
        onPress={onRemove}
      >
        <Icon name="X" size={14} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
