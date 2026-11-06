/**
 * The read-only diff for iOS and Android, where there is no DOM to mount the
 * editor into: a list of unified diff rows with line-number gutters, threads
 * between rows, and a composer. Press a line number to start a range and
 * press another on the same side to end it.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { Comment, Side } from "../shared/review";
import type { Annotation } from "../shared/story";
import { buildDiffRows, type ComposerAnchor, type DiffItem, interleave, plainRows } from "./diff-rows";
import { rangeLabel } from "./format";
import { NarrationBlock } from "./narration";
import { type Focus, focusRows, insertNarration } from "./story";
import { Composer, type ThreadActions, ThreadView } from "./thread";
import { Button, MONOSPACE } from "./ui";
import type { NewComment } from "./editor/threads";

const NO_ANNOTATIONS: readonly Annotation[] = [];
/** An embedded section draws its rows as plain views; past this many it asks before drawing the rest. */
const EMBEDDED_ROWS = 400;

export function NativeDiff({
  oldText,
  newText,
  plain,
  comments,
  theme,
  actions,
  onCreate,
  annotations = NO_ANNOTATIONS,
  focus = null,
  embedded = false,
}: {
  oldText: string | null;
  newText: string | null;
  /** A file outside the diff: its lines, unmarked. */
  plain: boolean;
  /** Line comments on both sides. */
  comments: readonly Comment[];
  theme: PluginTheme;
  actions: ThreadActions;
  onCreate: (input: NewComment) => Promise<void>;
  /** Story narration, drawn above its line. */
  annotations?: readonly Annotation[];
  /** The chapter's lines; null shows every change. */
  focus?: Focus | null;
  /** A section of the continuous diff: drawn in full (the panel's list virtualizes whole files), not as its own list. */
  embedded?: boolean;
}) {
  const colors = theme.colors;
  const [pending, setPending] = useState<{ side: Side; line: number } | null>(null);
  const [composer, setComposer] = useState<ComposerAnchor | null>(null);
  const [rowLimit, setRowLimit] = useState(EMBEDDED_ROWS);

  const rows = useMemo(
    () => (plain ? plainRows(newText ?? oldText ?? "") : focusRows(buildDiffRows(oldText, newText), focus)),
    [plain, oldText, newText, focus],
  );
  const { items, unplaced, unplacedNarration } = useMemo(() => {
    const threaded = interleave(rows, comments, composer);
    const narrated = insertNarration(threaded.items, annotations);
    return { items: narrated.items, unplaced: threaded.unplaced, unplacedNarration: narrated.unplaced };
  }, [rows, comments, composer, annotations]);

  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, borderLeftWidth: 3, borderLeftColor: "transparent" },
      add: {
        flexDirection: "row" as const,
        borderLeftWidth: 3,
        borderLeftColor: colors.statusSuccess,
        backgroundColor: colors.surface1,
      },
      del: {
        flexDirection: "row" as const,
        borderLeftWidth: 3,
        borderLeftColor: colors.statusDanger,
        backgroundColor: colors.surface2,
      },
      gutter: { width: 44, paddingRight: 6, alignItems: "flex-end" as const },
      gutterPending: { width: 44, paddingRight: 6, alignItems: "flex-end" as const, backgroundColor: colors.accent },
      number: { fontFamily: MONOSPACE, fontSize: 11, color: colors.foregroundMuted, lineHeight: 18 },
      numberPending: { fontFamily: MONOSPACE, fontSize: 11, color: colors.accentForeground, lineHeight: 18 },
      marker: { width: 14, fontFamily: MONOSPACE, fontSize: 12, color: colors.foregroundMuted, lineHeight: 18 },
      code: { flex: 1, fontFamily: MONOSPACE, fontSize: 12, color: colors.foreground, lineHeight: 18 },
      hunk: {
        fontFamily: MONOSPACE,
        fontSize: 11,
        color: colors.foregroundMuted,
        backgroundColor: colors.surface1,
        paddingVertical: 4,
        paddingHorizontal: 8,
      },
      inset: { paddingVertical: 6, paddingLeft: 8, paddingRight: 8 },
      hint: { color: colors.foregroundMuted, fontSize: 12, padding: 8 },
      composer: {
        gap: 6,
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 3,
        borderLeftColor: colors.statusWarning,
        borderRadius: 6,
        padding: 10,
        backgroundColor: colors.surface1,
      },
    }),
    [colors],
  );

  function pressLine(side: Side, line: number) {
    if (pending === null || pending.side !== side) {
      setPending({ side, line });
      return;
    }
    setComposer({ side, startLine: Math.min(pending.line, line), endLine: Math.max(pending.line, line) });
    setPending(null);
  }

  function gutterCell(side: Side, line: number | null) {
    const isPending = pending !== null && line !== null && pending.side === side && pending.line === line;
    if (line === null) return <View style={styles.gutter} />;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${side === "old" ? "Old" : "New"} line ${line}`}
        onPress={() => pressLine(side, line)}
        style={isPending ? styles.gutterPending : styles.gutter}
      >
        <Text style={isPending ? styles.numberPending : styles.number}>{line}</Text>
      </Pressable>
    );
  }

  function renderItem({ item }: { item: DiffItem }) {
    if (item.kind === "hunk") return <Text style={styles.hunk}>{item.header}</Text>;
    if (item.kind === "narration") {
      return (
        <View style={styles.inset}>
          <NarrationBlock annotation={item.annotation} theme={theme} />
        </View>
      );
    }
    if (item.kind === "thread") {
      return (
        <View style={styles.inset}>
          <ThreadView comment={item.comment} theme={theme} actions={actions} />
        </View>
      );
    }
    if (item.kind === "composer") {
      const anchor = item.anchor;
      return (
        <View style={styles.inset}>
          <View style={styles.composer}>
            <Text style={styles.hint}>{`Comment on ${rangeLabel(anchor)}`}</Text>
            <Composer
              theme={theme}
              placeholder="Leave a comment"
              submitLabel="Comment"
              autoFocus
              onSubmit={async (body) => {
                await onCreate({
                  side: anchor.side,
                  startLine: anchor.startLine,
                  endLine: anchor.endLine,
                  body,
                });
                setComposer(null);
              }}
              onCancel={() => setComposer(null)}
            />
          </View>
        </View>
      );
    }
    const rowStyle = item.type === "add" ? styles.add : item.type === "del" ? styles.del : styles.row;
    const marker = item.type === "add" ? "+" : item.type === "del" ? "-" : " ";
    const markerColor =
      item.type === "add" ? colors.statusSuccess : item.type === "del" ? colors.statusDanger : colors.foregroundMuted;
    return (
      <View style={rowStyle}>
        {plain ? null : gutterCell("old", item.oldLine)}
        {gutterCell("new", item.newLine)}
        <Text style={[styles.marker, { color: markerColor }]}>{plain ? "" : marker}</Text>
        <Text style={styles.code} selectable>
          {item.text}
        </Text>
      </View>
    );
  }

  const header = (
    <View>
          {pending !== null ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 8 }}>
              <Text style={styles.hint}>{`Range starts at ${rangeLabel({ startLine: pending.line, side: pending.side })}; press the last line.`}</Text>
              <Button label="Just this line" theme={theme} onPress={() => pressLine(pending.side, pending.line)} />
              <Button label="Cancel" tone="quiet" theme={theme} onPress={() => setPending(null)} />
            </View>
          ) : embedded ? null : (
            <Text style={styles.hint}>Press a line number to comment; press another to make it a range.</Text>
          )}
          {unplacedNarration.map((annotation) => (
            <View key={annotation.id} style={styles.inset}>
              <NarrationBlock annotation={annotation} theme={theme} showLine />
            </View>
          ))}
          {unplaced.map((comment) => (
            <View key={comment.id} style={styles.inset}>
              <ThreadView comment={comment} theme={theme} actions={actions} />
            </View>
          ))}
          {rows.length === 0 ? <Text style={styles.hint}>No changes in this file.</Text> : null}
        </View>
  );

  if (embedded) {
    const shown = items.length > rowLimit ? items.slice(0, rowLimit) : items;
    return (
      <View>
        {header}
        {shown.map((item) => (
          <View key={item.key}>{renderItem({ item })}</View>
        ))}
        {shown.length < items.length ? (
          <View style={{ flexDirection: "row", padding: 8 }}>
            <Button
              label={`Show ${items.length - shown.length} more rows`}
              icon="ChevronsDown"
              theme={theme}
              onPress={() => setRowLimit((limit) => limit + EMBEDDED_ROWS * 2)}
            />
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      initialNumToRender={60}
      ListHeaderComponent={header}
    />
  );
}
