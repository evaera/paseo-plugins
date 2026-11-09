/**
 * The Mission Control surface: the conversation with Mission Control beside the
 * board of its crew.
 *
 * Everything on it comes from one RPC, `mission-control.fleet.load`, polled at the
 * interval in the display settings and refetched right after any action. The
 * chat reads Mission Control's timeline directly and streams.
 *
 * Mission Control's suggestions are buttons that send their words to it, as
 * the chat's Send would: a card beside the crew's columns on a wide layout, a
 * tab of their own on a phone, and nowhere at all while it has none. The home's
 * watch scripts are a card after the columns, and on a phone the foot of the
 * Crew tab: they are looked at now and then, not acted on, so they get no tab.
 *
 * A surface is unmounted whenever the user opens a workspace, so the last
 * fleet, the compact tab and the crewmate being watched live in module scope
 * and the board comes back drawn rather than empty.
 */
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import {
  acknowledgeCharter,
  compareCharter,
  enableAgentTools,
  loadFleet,
  markCoordinatorSeen,
  openInDebrief,
  removeSuggestion,
  saveBoardOrder,
  type ColumnId,
  type DebriefView,
  type FleetCard,
  type Fleet,
  type Suggestion,
} from "../shared/fleet";
import { displaySettings, type DisplaySettings } from "../shared/settings";
import { Board } from "./board";
import { FilesView, type FilesRequest } from "./files";
import { CoordinatorChat } from "./chat";
import { userMessage } from "./attachments";
import { CardView } from "./card-view";
import { chatAbout } from "./chat-about";
import { subject, type DraftKind } from "./card-commands";
import { BOARD_ORDER, agentStatusLabel, agentStatusTone, groupCards, revealFilesPatch, shortPath } from "./format";
import { BoardTasksContext, cardForRef, type BoardTasks, type DebriefTarget } from "./board-tasks";
import { debriefOpener } from "./debrief-bridge";
import { CrewCard } from "./card";
import { LocalHostContext } from "./local-host";
import { applyColumnOrder, rankedColumns } from "./order";
import { LaunchPanel } from "./launch";
import { useCoordinatorSender } from "./coordinator-send";
import type { CoordinatorAsk } from "./card-answer";
import { ResizeHandle, clampShare } from "./resize-handle";
import { RunOpenContext } from "./run-embed";
import { Banner, Chip, IconButton, Segmented, errorText } from "./ui";
import { FONT_SIZE } from "./type-scale";
import { LayoutTierContext, TOUCH_TARGET, besideBoardWidth, layoutTier } from "./layout-tier";
import { useTouchTargets } from "./touch-targets";
import { boardAttention } from "./screen";
import { SafeEdges } from "./edges";

export const FLEET_QUERY_KEY = ["mission-control", "fleet"] as const;

let cachedFleet: Fleet | null = null;
type Tab = "chat" | "board" | "files";
let cachedTab: Tab = "chat";
/** What the right-hand pane shows on a wide layout: the crew, or the home's files. */
let cachedRightPane: "board" | "files" = "board";
/** The open card, by `openedRef`: kept across a remount like the open tab. */
let cachedWatching: string | null = null;
/** The step the open card was opened on from its context menu, if any; kept with it. */
let openedDraft: { draft: DraftKind; at: number } | null = null;
/** The open card was opened from the board beside the chat, so its Crew button goes back to the chat. */
let openedFromChat = false;

/**
 * How the open card is found again on every poll: by its task and worker,
 * and by its task alone once that worker is gone — ended, or relaunched as
 * another — so the task stays open. A worker with no task is found by itself.
 * A card's key will not do, because a backlog item's includes its line number.
 */
function openedRef(card: FleetCard): string {
  const worker = card.agent === null ? null : `agent:${card.agent.id}`;
  if (card.taskId === null) return worker ?? card.key;
  return worker === null ? `task:${card.taskId}` : `task:${card.taskId}|${worker}`;
}

/** The open card as last found, so a worker on a connected host stays open through a poll that could not reach it. */
let lastOpened: { ref: string; card: FleetCard } | null = null;

/** The open card on this poll; a task that has gained or lost a worker since is still found by its task. */
function findOpened(cards: readonly FleetCard[], ref: string): FleetCard | null {
  const taskId = ref.startsWith("task:") ? (ref.slice("task:".length).split("|")[0] ?? null) : null;
  const found =
    cards.find((card) => openedRef(card) === ref) ??
    (taskId === null ? undefined : cards.find((card) => card.taskId === taskId));
  if (found !== undefined) {
    lastOpened = { ref, card: found };
    return found;
  }
  const remote = lastOpened?.ref === ref && lastOpened.card.agent?.serverId != null;
  return remote ? (lastOpened?.card ?? null) : null;
}

/**
 * A surface is given no way to open a settings screen, so the entry lends it
 * one; the gear is hidden while nothing is bound. Cleared in the entry's
 * cleanup, since this module outlives a disconnected client's context.
 */
let openSettings: ((id: string) => void) | null = null;
export function bindSettingsOpener(opener: ((id: string) => void) | null): void {
  openSettings = opener;
}

const DEFAULT_DISPLAY: DisplaySettings = displaySettings.schema.parse({});
const SAVE_DELAY_MS = 400;

/**
 * The fleet query, shared by the screen, the workspace panels and the sidebar item so they poll once
 * between them.
 */
export function useFleet(pollSeconds: number) {
  const load = useRpc(loadFleet);
  return useQuery({
    queryKey: FLEET_QUERY_KEY,
    queryFn: function () {
      return load({}).then((fleet) => {
        cachedFleet = fleet;
        return fleet;
      });
    },
    refetchInterval: pollSeconds * 1000,
    ...(cachedFleet === null ? {} : { placeholderData: cachedFleet }),
  });
}

export function FleetSurface(props: PluginScreenProps) {
  return (
    <LocalHostContext.Provider value={props.host.label}>
      <FleetScreen {...props} />
    </LocalHostContext.Provider>
  );
}

function FleetScreen({ theme, layout, navigation }: PluginScreenProps) {
  const compact = layout.compact;
  const enable = useRpc(enableAgentTools);
  const compareCharters = useRpc(compareCharter);
  const acknowledgeCharters = useRpc(acknowledgeCharter);
  const removeSuggestions = useRpc(removeSuggestion);
  const saveOrder = useRpc(saveBoardOrder);
  const toast = useToast();
  const queryClient = useQueryClient();
  const display = useSettings(displaySettings);
  const saved = display.status === "ready" ? display.values : DEFAULT_DISPLAY;

  /** Drawn at once and saved behind, so a fold or a drag never waits on a round trip. */
  const [override, setOverride] = useState<Partial<DisplaySettings>>({});
  const values: DisplaySettings = { ...saved, ...override };
  const [share, setShare] = useState<number | null>(null);
  /**
   * The surface's width: the split's too, which spans it, and what picks the layout tier. Measured on
   * the root, which is mounted in every layout, so a fold or an unfold that changes `compact` finds it
   * already known rather than starting the split at 0 wide.
   */
  const [width, setWidth] = useState(0);
  const tier = layoutTier(compact, width);
  /** Phone and medium: one pane at a time, behind tabs, inside the safe-area edges. */
  const single = tier !== "wide";
  const touch = useTouchTargets(tier);
  const [tab, setTabState] = useState<Tab>(cachedTab);
  const [rightPane, setRightPaneState] = useState(cachedRightPane);
  const [watching, setWatchingState] = useState(cachedWatching);
  const [enabling, setEnabling] = useState(false);
  const [charterBusy, setCharterBusy] = useState(false);
  /** A file the Files view should open; not kept across a remount, or it would open again on return. */
  const [filesRequest, setFilesRequest] = useState<FilesRequest | null>(null);

  const fleet = useFleet(values.pollSeconds);
  const data = fleet.data ?? null;

  /**
   * While a card is open, Mission Control's chat is about it: the card's pill is on the composer, and
   * stays through every message sent, until the view closes. A pill the user put there themselves,
   * or took off, is left as they had it.
   */
  const viewed = watching === null || data === null ? null : findOpened(data.cards, watching);
  const viewedAbout =
    viewed === null
      ? null
      : { key: viewed.key, title: viewed.title, subject: subject(viewed), agentId: viewed.agent?.id ?? null };
  const viewedKey =
    viewedAbout === null ? null : `${viewedAbout.key}\n${viewedAbout.title}\n${viewedAbout.subject}\n${viewedAbout.agentId}`;
  useEffect(() => {
    if (viewedAbout === null) return undefined;
    chatAbout.set({ ...viewedAbout, sticky: true });
    return () => {
      if (chatAbout.get()?.key === viewedAbout.key) chatAbout.set(null);
    };
    // `viewedAbout` is new every render; its key is what changes.
  }, [viewedKey]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: FLEET_QUERY_KEY });
  }, [queryClient]);

  const shownTab: Tab = tab;

  /**
   * Layout changes are drawn at once and saved behind, batched: a save is
   * checked against the document revision it was made from, so a second fold
   * sent before the first came back would be refused as stale. Changes inside
   * `SAVE_DELAY_MS` become one save, made from whatever revision is current
   * when it goes out, and a refused one is tried once more from the next.
   */
  const displayRef = useRef(display);
  displayRef.current = display;
  const pending = useRef<Partial<DisplaySettings>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  function flush(attempt: number): void {
    const current = displayRef.current;
    if (current.status !== "ready") return;
    const patch = pending.current;
    pending.current = {};
    void current.save({ ...current.values, ...patch }, current.revision).then((ok) => {
      if (ok) return;
      if (attempt === 0) {
        pending.current = { ...patch, ...pending.current };
        saveTimer.current = setTimeout(() => flush(1), SAVE_DELAY_MS);
      } else {
        console.warn("[mission-control] could not save the board layout:", displayRef.current.saveError);
      }
    });
  }

  function save(patch: Partial<DisplaySettings>): void {
    setOverride((current) => ({ ...current, ...patch }));
    pending.current = { ...pending.current, ...patch };
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flush(0), SAVE_DELAY_MS);
  }

  // Once the stored document says what was drawn, the local copy has done its
  // job; dropping it lets a change made on another device show here.
  useEffect(() => {
    if (display.status !== "ready") return;
    setOverride((current) => {
      const entries = Object.entries(current).filter(
        ([key, value]) => JSON.stringify(display.values[key as keyof DisplaySettings]) !== JSON.stringify(value),
      );
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [display]);

  function setTab(next: Tab): void {
    // As with the wide layout's Crew switch: pressing Crew again goes back to the board.
    if (next === "board" && tab === "board") setWatching(null);
    cachedTab = next;
    setTabState(next);
  }

  function setRightPane(next: "board" | "files"): void {
    // Choosing Crew while it is already showing is the way back from a watched crewmate to the board.
    if (next === "board" && rightPane === "board") setWatching(null);
    cachedRightPane = next;
    setRightPaneState(next);
  }

  function setWatching(next: string | null): void {
    if (next === null) {
      openedDraft = null;
      openedFromChat = false;
    }
    cachedWatching = next;
    setWatchingState(next);
  }

  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      screen: { flex: 1, backgroundColor: colors.surface0 },
      header: {
        paddingHorizontal: compact ? 12 : 16,
        paddingTop: compact ? 4 : single ? 6 : 14,
        paddingBottom: compact ? 4 : single ? 6 : 8,
        gap: 4,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      // The tabs' underline sits on the header's border, so the row loses its vertical padding.
      headerWithTabs: { paddingTop: 0, paddingBottom: 0 },
      headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: single ? ("nowrap" as const) : ("wrap" as const) },
      title: { color: colors.foreground, fontSize: compact ? FONT_SIZE.heading : FONT_SIZE.display, fontWeight: "600" as const },
      spacer: { flex: 1 },
      meta: { color: colors.foregroundMuted, fontSize: FONT_SIZE.small },
      banners: { paddingHorizontal: compact ? 12 : 16, paddingTop: 8, gap: 6 },
      split: { flex: 1, minHeight: 0, flexDirection: "row" as const },
      besideChat: { borderRightWidth: 1, borderRightColor: colors.border },
      rail: {
        width: touch ? TOUCH_TARGET + 8 : 40,
        alignItems: "center" as const,
        paddingTop: 10,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
      },
      // A phone's tabs are a bar at the foot, where a thumb reaches them, as Paseo's own phone tabs are.
      tabs: {
        flexDirection: "row" as const,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.surface0,
      },
      tab: {
        flex: 1,
        minHeight: TOUCH_TARGET + 6,
        paddingVertical: 5,
        gap: 2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      tabText: { color: colors.foregroundMuted, fontSize: FONT_SIZE.caption, fontWeight: "500" as const },
      tabTextActive: { color: colors.accent, fontWeight: "700" as const },
      // A medium layout's tabs lead the header row, underlined like Paseo's own workspace tabs.
      topTabs: { flexDirection: "row" as const, alignSelf: "stretch" as const, gap: 2 },
      topTab: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        minHeight: TOUCH_TARGET,
        paddingHorizontal: 12,
        borderBottomWidth: 2,
        borderBottomColor: "transparent",
      },
      topTabActive: { borderBottomColor: colors.accent },
      topTabText: { color: colors.foregroundMuted, fontSize: FONT_SIZE.body, fontWeight: "500" as const },
      topTabTextActive: { color: colors.foreground, fontWeight: "600" as const },
      badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: 9,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badgeText: { color: colors.accentForeground, fontSize: FONT_SIZE.caption, fontWeight: "700" as const },
      loading: { color: colors.foregroundMuted, fontSize: FONT_SIZE.body, padding: 20 },
    };
  }, [theme, compact, single, touch]);

  const coordinator = data?.coordinator ?? null;
  /** The chat's own sender, so a suggestion goes out exactly as a typed message does. */
  const coordinatorSender = useCoordinatorSender(coordinator?.id ?? "");

  /**
   * While this surface is open the user is looking at Mission Control, so
   * its "finished" flag is cleared the way opening it in Paseo would clear it,
   * and its workspace reads as done in the sidebar. Keyed by `updatedAt`, so a
   * turn that ends while the panel is open is cleared too, and a clear that
   * failed is not retried until something changes. A pending permission is
   * left flagged; the server checks that again.
   */
  const openInDebriefRpc = useRpc(openInDebrief);
  // This Mac's own host id, which its Debrief registers its opener under.
  const paseo = usePaseo();
  const self = useQuery({ queryKey: ["mission-control", "self-host"], queryFn: () => paseo.hosts.list(), staleTime: Number.POSITIVE_INFINITY });
  const ownServerId = self.data?.self.serverId ?? null;
  const markSeen = useRpc(markCoordinatorSeen);
  const unseen =
    coordinator !== null && coordinator.requiresAttention && coordinator.pendingPermissions === 0 ? `${coordinator.id}:${coordinator.updatedAt}` : null;
  useEffect(() => {
    if (unseen === null) return;
    markSeen({})
      .then((result) => {
        if (result.cleared) refresh();
      })
      .catch((caught: unknown) => {
        console.warn("[mission-control] could not mark Mission Control as seen:", caught);
      });
  }, [unseen, markSeen, refresh]);

  /**
   * A suggestion, a card's action or a held card's answer is sent to Mission
   * Control at once, through the chat's own path, and the chat comes into view to
   * show it going out. The draft the user was typing is left as it was.
   * While a message is on its way the buttons are disabled, and a press that
   * still gets through is refused by the sender, so a double press sends once.
   */
  function tellCoordinator(text: string, onFailure?: () => void, onSent?: () => void): boolean {
    if (coordinator === null || !coordinatorSender.send(userMessage(text, []), onFailure, onSent)) return false;
    if (single) setTab("chat");
    else if (values.chatCollapsed) save({ chatCollapsed: false });
    return true;
  }
  const toCoordinator: CoordinatorAsk = { sending: coordinatorSender.sending, send: tellCoordinator };

  /**
   * A card Mission Control embedded in a reply (`[[card: …]]`), drawn as the board draws it, from the live
   * board, so it says where the work stands now rather than when the reply was written. Pressing it opens
   * the card's view in the board's place, bringing that pane into view.
   */
  function renderEmbeddedCard(ref: string): ReactNode {
    const card = data === null ? null : cardForRef(data.cards, ref);
    if (card === null) {
      return (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE.small }}>
          {`${ref} is not on the board.`}
        </Text>
      );
    }
    return (
      <View style={{ maxWidth: 380 }}>
        <CrewCard
          card={card}
          theme={theme}
          compact={compact}
          onOpen={() => {
            openedDraft = null;
            setWatching(openedRef(card));
            if (single) setTab("board");
            else {
              if (rightPane !== "board") setRightPane("board");
              if (values.boardCollapsed) save({ boardCollapsed: false });
            }
          }}
          onChat={() => chatAboutCard(card)}
          toCoordinator={toCoordinator}
        />
      </View>
    );
  }

  /**
   * A Diff or Story button, a "View debrief" embed in the chat or a transcript, or the card's menu:
   * Debrief is asked to open its tab on the workspace, at that view (and file), and the workspace is
   * opened so the tab shows. Only work on this Mac carries the buttons.
   */
  function openDebrief(target: DebriefTarget, view: DebriefView, path?: string): void {
    if (navigation === undefined) return;
    const request = {
      workspaceId: target.workspaceId,
      ...(target.agentId === undefined ? {} : { agentId: target.agentId }),
      view,
      ...(path === undefined ? {} : { path }),
    };
    // That host's own Debrief, straight away, wherever it runs; this Mac's by its request file otherwise.
    const opener = debriefOpener(target.serverId ?? ownServerId);
    if (opener !== null) {
      navigation.openWorkspace(target.serverId === null ? { workspaceId: target.workspaceId } : { workspaceId: target.workspaceId, serverId: target.serverId });
      opener(request);
      return;
    }
    if (target.serverId !== null) {
      toast.error("Debrief is not running on that host in this app.");
      return;
    }
    openInDebriefRpc(request)
      .then(() => navigation.openWorkspace({ workspaceId: target.workspaceId }))
      .catch((caught: unknown) => toast.error(errorText(caught)));
  }

  /** A card's chat button: the card goes on the chat's box as a pill, and the box takes the cursor. */
  function chatAboutCard(card: FleetCard): void {
    chatAbout.set({ key: card.key, title: card.title, subject: subject(card), agentId: card.agent?.id ?? null });
    chatAbout.focus();
    if (single) setTab("chat");
    else if (values.chatCollapsed) save({ chatCollapsed: false });
  }

  /**
   * A suggestion's trash: the daemon records it as dismissed and its line leaves Mission Control's file,
   * and the board takes the list the daemon answers with at once rather than waiting for the next load.
   * Pressing a suggestion (`suggest`) never comes here, so sending one never dismisses it.
   */
  function dismissSuggestion(suggestion: Suggestion): Promise<void> {
    return removeSuggestions(suggestion)
      .then((result) => {
        queryClient.setQueryData<Fleet>(FLEET_QUERY_KEY, (current) =>
          current === undefined ? current : { ...current, suggestions: result.suggestions },
        );
        refresh();
      })
      .catch((caught: unknown) => {
        toast.error(errorText(caught));
        refresh();
      });
  }

  function turnOnTools(): void {
    setEnabling(true);
    enable({})
      .then((result) => {
        toast.show(
          result.agentTools
            ? coordinator === null
              ? "Agent tools are on."
              : "Agent tools are on. Mission Control gets them the next time its session starts — reload it from its tab."
            : "The daemon did not keep the change.",
          { variant: result.agentTools ? "success" : "warning" },
        );
        refresh();
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setEnabling(false));
  }

  /** Shows the Files view, the tab in one pane or the right-hand pane on a wide layout, unhidden, with `path` open. */
  function openFile(path: string): void {
    if (single) setTab("files");
    else setRightPane("files");
    const reveal = revealFilesPatch(single, values.boardCollapsed);
    if (reveal !== null) save(reveal);
    setFilesRequest({ path, at: Date.now() });
  }

  /** Puts the plugin's current charter beside the user's and opens it in the Files view. */
  function compareCharterFiles(): void {
    setCharterBusy(true);
    compareCharters({})
      .then(({ path }) => {
        if (path === null) {
          refresh();
          return;
        }
        openFile(path);
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setCharterBusy(false));
  }

  function acknowledgeCharterChange(): void {
    setCharterBusy(true);
    acknowledgeCharters({})
      .then(() => {
        toast.show("Your charter is now taken as up to date.", { variant: "success" });
        refresh();
      })
      .catch((caught: unknown) => toast.error(errorText(caught)))
      .finally(() => setCharterBusy(false));
  }

  const banners: ReactNode[] = [];
  if (fleet.error !== null) {
    banners.push(<Banner key="error" theme={theme} tone="danger" text={errorText(fleet.error)} />);
  }
  if (data?.agentTools === false) {
    banners.push(
      <Banner
        key="tools"
        theme={theme}
        tone="warning"
        text="Mission Control starts its crew and hears back from it through Paseo's agent tools, and this daemon does not give agents those tools."
        action={{ label: enabling ? "Turning on…" : "Turn them on", icon: "Wrench", onPress: turnOnTools, disabled: enabling }}
      />,
    );
  }
  if (data?.coordinatorMissing === true) {
    banners.push(
      <Banner
        key="missing"
        theme={theme}
        tone="info"
        text="The Mission Control agent you had is gone, archived or deleted. Launch a new one; its records are still in its home."
      />,
    );
  }
  if (coordinator !== null && data !== null && !data.coordinatorInHome) {
    banners.push(
      <Banner
        key="cwd"
        theme={theme}
        tone="warning"
        text={`Mission Control works in ${shortPath(coordinator.cwd, 60)}, not in its home, so it has not read its charter there.`}
      />,
    );
  }
  // The question itself is in the chat; the banner is for when the chat is
  // out of sight: folded away, or behind another tab in one pane.
  const chatHidden = single ? shownTab !== "chat" : values.chatCollapsed;
  if (coordinator !== null && coordinator.pendingPermissions > 0 && chatHidden) {
    banners.push(
      <Banner
        key="permission"
        theme={theme}
        tone="warning"
        text="Mission Control is waiting for your answer."
        action={{
          label: "Show",
          icon: "MessageSquare",
          onPress: () => (single ? setTab("chat") : save({ chatCollapsed: false })),
        }}
      />,
    );
  }
  if (data?.charterOutdated === true) {
    banners.push(
      <Banner
        key="charter"
        theme={theme}
        tone="info"
        text="The plugin's own charter has changed since you edited yours in prompts/charter.md. Compare them, bring over what you want, then press Done."
        actions={[
          { label: "Compare", icon: "FileDiff", onPress: compareCharterFiles, disabled: charterBusy },
          { label: "Done", icon: "Check", onPress: acknowledgeCharterChange, disabled: charterBusy },
        ]}
      />,
    );
  }
  for (const warning of data?.warnings ?? []) {
    banners.push(<Banner key={warning} theme={theme} tone="warning" text={warning} />);
  }

  const tabs: readonly { id: Tab; label: string; icon: string }[] = [
    { id: "chat", label: "Coordinator", icon: "MessageSquare" },
    { id: "board", label: "Board", icon: "SquareKanban" },
    { id: "files", label: "Files", icon: "Folder" },
  ];
  const attention = boardAttention(data?.cards ?? []);

  function badge(count: number, color: string, label: string): ReactNode {
    if (count === 0) return null;
    return (
      <View key={label} style={[styles.badge, { backgroundColor: color }]} accessibilityLabel={label}>
        <Text style={styles.badgeText}>{count}</Text>
      </View>
    );
  }

  /**
   * A medium layout's tabs, in the header row where the wide layout's Board/Files switch sits. While
   * the board is out of sight its tab counts what waits there, cards in Needs you and failed ones; the
   * Coordinator tab counts Mission Control's own questions while the chat is out of sight.
   */
  const topTabs =
    tier !== "medium" || coordinator === null || data === null ? null : (
      <View style={styles.topTabs} accessibilityRole="tablist">
        {tabs.map((item) => {
          const selected = shownTab === item.id;
          const color = selected ? theme.colors.foreground : theme.colors.foregroundMuted;
          const badges = selected
            ? null
            : item.id === "board"
              ? [
                  badge(attention.needsYou, theme.colors.statusWarning, `${attention.needsYou} in Needs you`),
                  badge(attention.failed, theme.colors.statusDanger, `${attention.failed} failed`),
                ]
              : item.id === "chat"
                ? badge(coordinator.pendingPermissions, theme.colors.statusWarning, "Mission Control is waiting for your answer")
                : null;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              style={[styles.topTab, selected ? styles.topTabActive : null]}
              onPress={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={16} color={color} />
              <Text style={[styles.topTabText, selected ? styles.topTabTextActive : null]} numberOfLines={1}>
                {item.label}
              </Text>
              {badges}
            </Pressable>
          );
        })}
      </View>
    );

  // The host's own header already says "Mission Control" above the screen; a phone or a medium layout has
  // no room to say it twice, so there the row is the tabs, the coordinator's state and the buttons.
  const header = (
    <View style={[styles.header, topTabs === null ? null : styles.headerWithTabs]}>
      <View style={styles.headerRow}>
        {single ? null : <Icon name="SatelliteDish" size={compact ? 16 : 18} color={theme.colors.foreground} />}
        {single ? null : <Text style={styles.title}>Mission Control</Text>}
        {topTabs}
        {topTabs === null ? null : <View style={styles.spacer} />}
        {coordinator === null ? null : (
          <Chip theme={theme} text={`Coordinator · ${agentStatusLabel(coordinator)}`} color={agentStatusTone(theme, coordinator)} />
        )}
        {topTabs === null ? <View style={styles.spacer} /> : null}
        {tier === "wide" && coordinator !== null && data !== null && !values.boardCollapsed ? (
          <Segmented
            theme={theme}
            value={rightPane}
            options={[
              { value: "board", label: "Board" },
              { value: "files", label: "Files" },
            ]}
            onChange={setRightPane}
            touch={touch}
          />
        ) : null}
        <IconButton
          icon="RefreshCw"
          label={fleet.isFetching ? "Refreshing" : "Refresh"}
          theme={theme}
          disabled={fleet.isFetching}
          onPress={refresh}
          touch={touch}
        />
        {openSettings === null ? null : (
          <IconButton
            icon="Settings"
            label="Mission Control settings"
            theme={theme}
            onPress={() => openSettings?.("mission-control")}
            touch={touch}
          />
        )}
      </View>
    </View>
  );

  /**
   * Every layout's root: measures the surface, provides the tier, and on a phone or a medium layout keeps the
   * content inside the safe area on the sides and at the foot (the host pads only the top). The same
   * element in every tier, so a fold or an unfold that crosses one does not remount the screen.
   */
  const frame = (content: ReactNode) => (
    <LayoutTierContext.Provider value={tier}>
      <SafeEdges edges={single ? ["left", "right", "bottom"] : []} style={styles.screen}>
        <View style={styles.screen} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {content}
        </View>
      </SafeEdges>
    </LayoutTierContext.Provider>
  );

  if (data === null) {
    return frame(
      <>
        {header}
        {banners.length === 0 ? null : <View style={styles.banners}>{banners}</View>}
        <Text style={styles.loading}>{fleet.error === null ? "Loading the crew…" : ""}</Text>
      </>,
    );
  }

  if (coordinator === null) {
    return frame(
      <>
        {header}
        <ScrollView automaticallyAdjustKeyboardInsets>
          {banners.length === 0 ? null : <View style={styles.banners}>{banners}</View>}
          <LaunchPanel theme={theme} compact={compact} home={data.home} onLaunched={refresh} />
        </ScrollView>
      </>,
    );
  }

  const groups = groupCards(data.cards);
  const occupied = BOARD_ORDER.filter((id) => (groups.get(id)?.length ?? 0) > 0);
  const foldedColumns = occupied.filter((id) => values.collapsedColumns.includes(id)).length;
  /** The Coordinator tab's board beside the chat on a medium layout wide enough for one; 0 for none. */
  const besideWidth = besideBoardWidth(tier, width, occupied.length - foldedColumns, foldedColumns);
  const beside = besideWidth > 0 && shownTab === "chat";

  /** A card opened from the board beside the chat takes the full width, as the Board tab's do. */
  function expandFromChat(): void {
    if (!beside) return;
    openedFromChat = true;
    setTab("board");
  }

  const board = (
    <Board
      cards={data.cards}
      collapsed={values.collapsedColumns}
      order={values.cardOrder}
      theme={theme}
      compact={compact}
      toCoordinator={toCoordinator}
      watches={data.watches}
      onOpenFile={openFile}
      onOpen={(card, draft) => {
        openedDraft = draft === undefined ? null : { draft, at: Date.now() };
        setWatching(openedRef(card));
        expandFromChat();
      }}
      onChat={chatAboutCard}
      onChanged={refresh}
      onReorder={(rankKeys) => {
        const cardOrder = applyColumnOrder(values.cardOrder, rankKeys);
        save({ cardOrder });
        // Mission Control reads the order from the home; the board's copy is the settings document.
        saveOrder({ columns: rankedColumns(data.cards, cardOrder) }).catch((caught: unknown) => {
          console.warn("[mission-control] could not write the board order for Mission Control:", caught);
        });
      }}
      onToggleColumn={(id: ColumnId) =>
        save({
          collapsedColumns: values.collapsedColumns.includes(id)
            ? values.collapsedColumns.filter((column) => column !== id)
            : [...values.collapsedColumns, id],
        })
      }
    />
  );
  const boardTasks: BoardTasks = {
    cards: data.cards,
    open: (card) => {
      openedDraft = null;
      setWatching(openedRef(card));
      expandFromChat();
    },
    debrief: navigation === undefined ? null : openDebrief,
    canDebrief: (serverId) => serverId === null || debriefOpener(serverId) !== null,
  };
  // A run embed's terminal lives in this host's workspace for the project, so no serverId.
  const openRunTerminal = navigation === undefined ? null : (workspaceId: string) => navigation.openWorkspace({ workspaceId });
  // The board's tasks reach the chat too, for the cards Mission Control embeds in its replies.
  const chat = (
    <BoardTasksContext.Provider value={boardTasks}>
      <RunOpenContext.Provider value={openRunTerminal}>
        <CoordinatorChat
          key={coordinator.id}
          coordinator={coordinator}
          theme={theme}
          compact={compact}
          onChanged={refresh}
          onOpenFile={openFile}
          suggestions={data.suggestions}
          onPickSuggestion={(prompt) => tellCoordinator(prompt)}
          onRemoveSuggestion={dismissSuggestion}
          visible={single ? shownTab === "chat" : !values.chatCollapsed}
          seenSeq={values.chatSeen[coordinator.id] ?? null}
          // Only Mission Control on board: a released one's entry would never be read again.
          onSeen={(seq) => save({ chatSeen: { [coordinator.id]: seq } })}
          renderCard={renderEmbeddedCard}
        />
      </RunOpenContext.Provider>
    </BoardTasksContext.Provider>
  );
  const opened = watching === null ? null : findOpened(data.cards, watching);
  const openedAgent = opened?.agent ?? null;
  const crewView =
    watching === null ? (
      board
    ) : (
      <CardView
        // A step asked for from the context menu mounts the view afresh on it, even over the same card.
        key={openedDraft === null ? watching : `${watching}#${openedDraft.at}`}
        initialDraft={openedDraft?.draft ?? null}
        card={opened}
        theme={theme}
        compact={compact}
        onBack={() => {
          const backToChat = openedFromChat;
          setWatching(null);
          if (backToChat) setTab("chat");
        }}
        onOpen={
          navigation === undefined || openedAgent === null
            ? null
            : () =>
                navigation.openAgent(
                  openedAgent.serverId === null
                    ? { agentId: openedAgent.id }
                    : { agentId: openedAgent.id, serverId: openedAgent.serverId },
                )
        }
        onChanged={refresh}
        toCoordinator={toCoordinator}
        onOpenFile={openFile}
      />
    );
  const crew = <BoardTasksContext.Provider value={boardTasks}>{crewView}</BoardTasksContext.Provider>;

  if (single) {
    return frame(
      <>
        {/*
          An open card is a step down from the board with a bar of its own, back included, so on a phone it
          takes the header's row too: the transcript under it gets the height. Back on the board, it returns.
        */}
        {compact && shownTab === "board" && watching !== null ? null : header}
        {banners.length === 0 ? null : <View style={styles.banners}>{banners}</View>}
        {/* The pane keeps its place whether or not the board is beside it, so the chat is not remounted. */}
        <View style={styles.split}>
          <View style={[{ flex: 1, minWidth: 0 }, beside ? styles.besideChat : null]}>
            {shownTab === "chat" ? (
              chat
            ) : shownTab === "board" ? (
              crew
            ) : (
              <FilesView theme={theme} compact={compact} request={filesRequest} />
            )}
          </View>
          {beside ? (
            <View style={{ width: besideWidth }}>
              <BoardTasksContext.Provider value={boardTasks}>{board}</BoardTasksContext.Provider>
            </View>
          ) : null}
        </View>
        {compact ? (
          <View style={styles.tabs} accessibilityRole="tablist">
            {tabs.map((tab) => {
              const selected = shownTab === tab.id;
              const color = selected ? theme.colors.accent : theme.colors.foregroundMuted;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{ selected }}
                  style={styles.tab}
                  onPress={() => setTab(tab.id)}
                >
                  <Icon name={tab.icon} size={20} color={color} />
                  <Text style={[styles.tabText, selected ? styles.tabTextActive : null]} numberOfLines={1}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </>,
    );
  }

  const chatShare = clampShare(share ?? values.chatWidthFraction);
  return frame(
    <>
      {header}
      {banners.length === 0 ? null : <View style={styles.banners}>{banners}</View>}
      <View style={styles.split}>
        {values.chatCollapsed ? (
          <View style={[styles.rail, { borderRightWidth: 1 }]}>
            <IconButton
              icon="PanelLeftOpen"
              label="Show the chat"
              theme={theme}
              onPress={() => save({ chatCollapsed: false })}
              touch={touch}
            />
          </View>
        ) : (
          <View style={values.boardCollapsed ? { flex: 1 } : { width: Math.round(chatShare * width) }}>{chat}</View>
        )}
        {values.chatCollapsed || values.boardCollapsed ? null : (
          <ResizeHandle
            theme={theme}
            share={chatShare}
            totalWidth={width}
            onChange={setShare}
            onCommit={(next) => {
              save({ chatWidthFraction: next });
              setShare(null);
            }}
          />
        )}
        {values.boardCollapsed ? (
          <View style={[styles.rail, { borderLeftWidth: 1 }]}>
            <IconButton
              icon="PanelRightOpen"
              label="Show the board"
              theme={theme}
              onPress={() => save({ boardCollapsed: false })}
              touch={touch}
            />
          </View>
        ) : (
          <View style={{ flex: 1, minWidth: 0 }}>
            {rightPane === "board" ? crew : <FilesView theme={theme} compact={false} request={filesRequest} />}
          </View>
        )}
      </View>
    </>,
  );
}
