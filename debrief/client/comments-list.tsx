/**
 * The comments dropdown, after Crit's comments panel: an open/all filter,
 * then every thread grouped by file, each row with its author, line, the
 * first line of the body, its reply count and whether it is resolved. Used in
 * the panel's header and in the workspace header button's popover. Virtualized,
 * so a review with hundreds of threads opens at once.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { Comment } from "../shared/review";
import {
  type CommentFilter,
  type CommentListItem,
  commentListItems,
  FILE_ROW_HEIGHT,
  firstLine,
  itemOffsets,
  THREAD_ROW_HEIGHT,
} from "./comments-model";
import { authorLabel, rangeLabel, splitPath } from "./format";
import { MONOSPACE, Segmented } from "./ui";

export function CommentsList({
  comments,
  fileOrder,
  filter,
  theme,
  maxHeight,
  onFilter,
  onOpen,
  agentProvider,
}: {
  comments: readonly Comment[];
  fileOrder: readonly string[];
  filter: CommentFilter;
  theme: PluginTheme;
  maxHeight: number;
  onFilter: (filter: CommentFilter) => void;
  onOpen: (comment: Comment) => void;
  /** An agent's provider, so agent authors read as their harness ("Claude Code"). */
  agentProvider?: ((agentId: string) => string | undefined) | undefined;
}) {
  const colors = theme.colors;
  const items = useMemo(() => commentListItems(comments, fileOrder, filter), [comments, fileOrder, filter]);
  const offsets = useMemo(() => itemOffsets(items), [items]);
  const open = comments.filter((comment) => !comment.resolved).length;
  const styles = useMemo(
    () => ({
      head: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      title: { flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
      file: {
        height: FILE_ROW_HEIGHT,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 12,
        backgroundColor: colors.surface2,
      },
      fileName: { flex: 1, color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE },
      fileCount: { color: colors.foregroundMuted, fontSize: 11 },
      thread: { height: THREAD_ROW_HEIGHT, paddingHorizontal: 12, paddingVertical: 6, gap: 2, justifyContent: "center" as const },
      threadHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      author: { color: colors.foreground, fontSize: 12, fontWeight: "600" as const },
      agent: { color: colors.accent, fontSize: 12, fontWeight: "600" as const },
      ref: { color: colors.accent, fontSize: 11, fontFamily: MONOSPACE },
      meta: { color: colors.foregroundMuted, fontSize: 11 },
      body: { color: colors.foreground, fontSize: 12 },
      resolvedBody: { color: colors.foregroundMuted, fontSize: 12, textDecorationLine: "line-through" as const },
      empty: { color: colors.foregroundMuted, fontSize: 12, padding: 16 },
    }),
    [colors],
  );

  const renderItem = ({ item }: { item: CommentListItem }) => {
    if (item.kind === "file") {
      const label = item.path === null ? "Review" : splitPath(item.path).name;
      return (
        <View style={styles.file}>
          <Icon name={item.path === null ? "MessagesSquare" : "FileText"} size={12} color={colors.foregroundMuted} />
          <Text style={styles.fileName} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.fileCount}>{item.open === item.total ? String(item.total) : `${item.open} of ${item.total} open`}</Text>
        </View>
      );
    }
    const comment = item.comment;
    const range = rangeLabel(comment);
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${authorLabel(comment.author, agentProvider)}: ${firstLine(comment.body)}`}
        style={({ pressed }: { pressed: boolean }) => [styles.thread, pressed ? { backgroundColor: colors.surface2 } : null]}
        onPress={() => onOpen(comment)}
      >
        <View style={styles.threadHead}>
          <Text style={comment.author.kind === "agent" ? styles.agent : styles.author} numberOfLines={1}>
            {authorLabel(comment.author, agentProvider)}
          </Text>
          {range !== "" ? <Text style={styles.ref}>{range}</Text> : null}
          <View style={{ flex: 1 }} />
          {comment.replies.length > 0 ? (
            <>
              <Icon name="MessageSquare" size={11} color={colors.foregroundMuted} />
              <Text style={styles.meta}>{String(comment.replies.length)}</Text>
            </>
          ) : null}
          {comment.resolved ? <Icon name="CircleCheck" size={12} color={colors.statusSuccess} /> : null}
        </View>
        <Text style={comment.resolved ? styles.resolvedBody : styles.body} numberOfLines={1}>
          {firstLine(comment.body)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ maxHeight }}>
      <View style={styles.head}>
        <Text style={styles.title}>{`${open} open of ${comments.length}`}</Text>
        <Segmented
          value={filter}
          options={[
            { value: "open", label: "Open" },
            { value: "all", label: "All" },
          ]}
          theme={theme}
          onChange={onFilter}
        />
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        getItemLayout={(_, index) => ({ ...(offsets[index] ?? { length: THREAD_ROW_HEIGHT, offset: 0 }), index })}
        initialNumToRender={16}
        ListEmptyComponent={<Text style={styles.empty}>{filter === "open" ? "No open threads." : "No comments yet."}</Text>}
      />
    </View>
  );
}
