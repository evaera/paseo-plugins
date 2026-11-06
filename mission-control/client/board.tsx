/**
 * The crew board, laid out like a Notion board: one row of fixed-width
 * columns in the order work moves through them, each scrolling on its own,
 * with the row scrolling sideways when it is wider than the pane. A column
 * with nobody in it is not drawn; a column can be folded to a narrow strip.
 * On a phone the columns stack and a folded column is one line.
 *
 * The home's watches are one quiet line under the columns that opens into
 * their list. Mission Control's suggestions live beside the chat's composer,
 * not on the board.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { interruptCrew, type ColumnId, type FleetCard, type WatchSummary } from "../shared/fleet";
import { CrewCard } from "./card";
import { contextMenu, type DraftKind, type MenuItem } from "./card-commands";
import { cardDebriefTarget, useBoardTasks } from "./board-tasks";
import { CardContextMenu } from "./context-menu";
import { errorText } from "./format";
import type { CoordinatorAsk } from "./card-answer";
import { BOARD_ORDER, COLUMNS, columnTone, groupCards, watchesSummary } from "./format";
import { CLOSING_MS, arrivalOf, noteCards, noteColumns } from "./board-motion";
import { ColumnFrame } from "./column-frame";
import { Entrance } from "./flash";
import { rankKey, sortByRank } from "./order";
import { SortableList } from "./sortable";
import { tint } from "./ui";
import { WATCHES_ICON, WatchList } from "./watches";
import { FONT_SIZE } from "./type-scale";

const COLUMN_WIDTH = 280;
const COLLAPSED_WIDTH = 40;
const CARD_GAP = 8;

interface BoardProps {
  cards: readonly FleetCard[];
  collapsed: readonly string[];
  /** The user's order within each column, as rank keys (`./order`). */
  order: readonly string[];
  theme: PluginTheme;
  compact: boolean;
  /** Sends a card's action or a held card's answer to Mission Control. */
  toCoordinator: CoordinatorAsk;
  /** The home's watch scripts, as one line under the columns; empty draws nothing. */
  watches: readonly WatchSummary[];
  /** Opens a home file in the Files view: the tab on a phone, the right-hand pane on a wide layout. */
  onOpenFile: (path: string) => void;
  /** Shows one card's own view in place of the board, on a step that needs words or a confirmation when given one. */
  onOpen: (card: FleetCard, draft?: DraftKind) => void;
  /** Points Mission Control's chat at a card. */
  onChat: (card: FleetCard) => void;
  onToggleColumn: (id: ColumnId) => void;
  /** One column rearranged: its cards' rank keys, top first. */
  onReorder: (rankKeys: string[]) => void;
  onChanged: () => void;
}

export function Board(props: BoardProps) {
  const { cards, collapsed, order, theme, compact, watches } = props;
  const [watchesOpen, setWatchesOpen] = useState(false);
  const interrupt = useRpc(interruptCrew);
  const tasks = useBoardTasks();
  const toast = useToast();
  /** The open context menu: whose, and where, in the board's coordinates. */
  const [menu, setMenu] = useState<{ card: FleetCard; x: number; y: number } | null>(null);
  const root = useRef<View>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /** A press point in window coordinates, made the board's own: the menu is drawn inside the board. */
  function openMenu(card: FleetCard, x: number, y: number): void {
    const node = root.current;
    // A card with nothing to do from here — a finished one with no Reopen — opens no empty menu.
    if (node === null || contextMenu(card, true).length === 0) return;
    node.measureInWindow((left, top) => setMenu({ card, x: x - left, y: y - top }));
  }

  function pick(card: FleetCard, item: MenuItem): void {
    setMenu(null);
    const act = item.act;
    if (act.kind === "ask") props.toCoordinator.send(act.prompt);
    else if (act.kind === "draft") props.onOpen(card, act.draft);
    else if (act.kind === "debrief") {
      const target = cardDebriefTarget(card);
      if (target !== null) tasks.debrief?.(target, act.view);
    } else if (card.agent !== null) {
      const agent = card.agent;
      interrupt({ agentId: agent.id, serverId: agent.serverId })
        .then(() => {
          toast.show("Interrupted.", { variant: "success" });
          props.onChanged();
        })
        .catch((caught: unknown) => toast.error(errorText(caught)));
    }
  }
  const groups = useMemo(
    () => new Map([...groupCards(cards)].map(([id, entries]) => [id, sortByRank(entries, order)])),
    [cards, order],
  );
  const occupied = useMemo(() => BOARD_ORDER.filter((id) => (groups.get(id)?.length ?? 0) > 0), [groups]);
  // What moved since the board was last drawn; every render asks, and a change is stamped once.
  const now = Date.now();
  noteCards(cards, now);
  const motion = noteColumns(occupied, now);
  // A column that just emptied is still drawn, closing, in its place.
  const shown = BOARD_ORDER.filter((id) => occupied.includes(id) || motion.closing.includes(id));
  const [, redraw] = useState(0);
  const closingKey = motion.closing.join(",");
  useEffect(() => {
    if (closingKey === "") return undefined;
    const timer = setTimeout(() => redraw((count) => count + 1), CLOSING_MS + 20);
    return () => clearTimeout(timer);
  }, [closingKey]);
  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      board: { flex: 1, minHeight: 0 },
      row: { flexGrow: 1, gap: 10, padding: compact ? 10 : 12, alignItems: "stretch" as const },
      stack: { gap: 10, padding: 10, paddingBottom: 24 },
      nobody: { padding: compact ? 10 : 12, color: colors.foregroundMuted, fontSize: FONT_SIZE.small },
      column: { borderRadius: 10, padding: 6, gap: 8 },
      columnStacked: { borderRadius: 10, padding: 6, gap: 8 },
      columnFolded: { alignItems: "center" as const },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: 2, paddingTop: 2 },
      headerFolded: { alignItems: "center" as const, gap: 8, paddingTop: 2 },
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
      },
      dot: { width: 7, height: 7, borderRadius: 4 },
      pillText: { color: colors.foreground, fontSize: FONT_SIZE.small, fontWeight: "500" as const },
      count: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      fold: { padding: 3 },
      body: { gap: CARD_GAP, paddingBottom: 8 },
      foldedTitle: {
        color: colors.foregroundMuted,
        fontSize: FONT_SIZE.caption,
        transform: [{ rotate: "90deg" }],
        width: 120,
        textAlign: "center" as const,
        marginTop: 56,
      },
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      },
      footerText: { flex: 1, color: colors.foregroundMuted, fontSize: FONT_SIZE.caption },
      footerList: { paddingHorizontal: compact ? 10 : 14, paddingBottom: 10, maxHeight: 260 },
    };
  }, [theme, compact]);

  function columnGround(id: ColumnId): string {
    return tint(columnTone(theme, id), 0.07, theme.colors.surface1);
  }

  function renderHeader(id: ColumnId, folded: boolean, count: number) {
    const meta = COLUMNS[id];
    const tone = columnTone(theme, id);
    const fold = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${folded ? "Unfold" : "Fold"} ${meta.title}`}
        style={styles.fold}
        onPress={() => props.onToggleColumn(id)}
      >
        <Icon name={folded ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
    if (folded && !compact) {
      return (
        <View style={styles.headerFolded}>
          {fold}
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <Text style={styles.count}>{count}</Text>
        </View>
      );
    }
    return (
      <View style={styles.header}>
        <View style={[styles.pill, { backgroundColor: tint(tone, 0.22, theme.colors.surface2) }]}>
          <View style={[styles.dot, { backgroundColor: tone }]} />
          <Text style={styles.pillText} numberOfLines={1}>
            {meta.title}
          </Text>
        </View>
        <Text style={styles.count}>{count}</Text>
        {fold}
      </View>
    );
  }

  function renderCards(entries: readonly FleetCard[]) {
    const byKey = new Map(entries.map((card) => [card.key, card]));
    return (
      <SortableList
        items={entries}
        keyOf={(card) => card.key}
        gap={CARD_GAP}
        onReorder={(keys) =>
          props.onReorder(keys.flatMap((key) => {
            const card = byKey.get(key);
            return card === undefined ? [] : [rankKey(card)];
          }))
        }
        renderItem={(card, drag) => (
          <CrewCard
            card={card}
            theme={theme}
            compact={compact}
            onOpen={() => props.onOpen(card)}
            onChat={() => props.onChat(card)}
            toCoordinator={props.toCoordinator}
            arrivedAt={arrivalOf(card, now)}
            onMenu={(x, y) => openMenu(card, x, y)}
            drag={entries.length > 1 ? drag : null}
          />
        )}
      />
    );
  }


  const footer =
    watches.length === 0 ? null : (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${watchesOpen ? "Hide" : "Show"} watches`}
          accessibilityState={{ expanded: watchesOpen }}
          style={styles.footer}
          onPress={() => setWatchesOpen(!watchesOpen)}
        >
          <Icon name={WATCHES_ICON} size={13} color={theme.colors.foregroundMuted} />
          <Text style={styles.footerText} numberOfLines={1}>
            {watchesSummary(watches)}
          </Text>
          <Icon name={watchesOpen ? "ChevronDown" : "ChevronUp"} size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
        {watchesOpen ? (
          <ScrollView style={styles.footerList}>
            <WatchList watches={watches} theme={theme} onChanged={props.onChanged} onOpenFile={props.onOpenFile} />
          </ScrollView>
        ) : null}
      </View>
    );

  const nobody = <Text style={styles.nobody}>No crew on the board.</Text>;

  const menuLayer =
    menu === null ? null : (
      <CardContextMenu
        groups={contextMenu(menu.card, true)}
        x={menu.x}
        y={menu.y}
        width={size.width}
        height={size.height}
        theme={theme}
        onPick={(item) => pick(menu.card, item)}
        onClose={() => setMenu(null)}
      />
    );
  const frame = (content: ReactNode) => (
    <View
      ref={root}
      style={{ flex: 1, minHeight: 0 }}
      onLayout={(event) => setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
    >
      {content}
      {menuLayer}
    </View>
  );

  if (compact) {
    return frame(
      // The boxes on a card are inside this list; on iOS the system insets it
      // for the keyboard and scrolls the focused box into view.
      <ScrollView contentContainerStyle={styles.stack} automaticallyAdjustKeyboardInsets>
        {shown.length === 0 ? nobody : null}
        {shown.map((id) => {
          const entries = groups.get(id) ?? [];
          const folded = collapsed.includes(id);
          // A phone's stack does not close a column; the next card simply takes its place.
          if (motion.closing.includes(id)) return null;
          return (
            <Entrance key={id} play={motion.opening.has(id)} style={[styles.columnStacked, { backgroundColor: columnGround(id) }]}>
              {renderHeader(id, folded, entries.length)}
              {folded ? null : <View style={styles.body}>{renderCards(entries)}</View>}
            </Entrance>
          );
        })}
        {footer}
      </ScrollView>
    );
  }

  return frame(
    <View style={styles.board}>
      {shown.length === 0 ? (
        <View style={{ flex: 1 }}>{nobody}</View>
      ) : (
        <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={styles.row}>
          {shown.map((id) => {
            const entries = groups.get(id) ?? [];
            const folded = collapsed.includes(id);
            return (
              <ColumnFrame
                key={id}
                width={folded ? COLLAPSED_WIDTH : COLUMN_WIDTH}
                opening={motion.opening.has(id)}
                closing={motion.closing.includes(id)}
                style={[styles.column, folded ? styles.columnFolded : null, { backgroundColor: columnGround(id) }]}
              >
                {renderHeader(id, folded, entries.length)}
                {folded ? (
                  <Text style={styles.foldedTitle} numberOfLines={1}>
                    {COLUMNS[id].title}
                  </Text>
                ) : (
                  <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body}>
                    {renderCards(entries)}
                  </ScrollView>
                )}
              </ColumnFrame>
            );
          })}
        </ScrollView>
      )}
      {footer}
    </View>
  );
}
