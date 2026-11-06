/**
 * The panel's left column: the review overview row, then every changed file
 * with its status letter, +/- counts and open-comment badge. Rows have one
 * fixed height, so the host `FlatList` can lay out a 300-file diff without
 * measuring it (`getItemLayout`) and draws only what is on screen.
 *
 * The selection follows the continuous diff's scroll, so the list keeps the
 * selected row in view, scrolling only as far as it has to.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef } from "react";
import { type FlatList as NativeFlatList, Pressable, Text, View } from "react-native";

import type { DiffFile, FileStatus } from "../shared/review";
import { splitPath, statusLetter } from "./format";
import { ReviewedMark } from "./reviewed";
import { Badge, MONOSPACE } from "./ui";

export const FILE_ROW_HEIGHT = 42;

function statusColor(theme: PluginTheme, status: FileStatus): string {
  const colors = theme.colors;
  if (status === "added" || status === "untracked") return colors.statusSuccess;
  if (status === "deleted") return colors.statusDanger;
  if (status === "renamed") return colors.accent;
  return colors.statusWarning;
}

export function FileList({
  files,
  selectedPath,
  overviewSelected,
  openCounts,
  reviewOpenCount,
  theme,
  onSelect,
  onOverview,
}: {
  files: readonly DiffFile[];
  selectedPath: string | null;
  overviewSelected: boolean;
  openCounts: ReadonlyMap<string, number>;
  reviewOpenCount: number;
  theme: PluginTheme;
  onSelect: (path: string) => void;
  onOverview: () => void;
}) {
  const list = useRef<NativeFlatList<DiffFile>>(null);
  const offset = useRef(0);
  const height = useRef(0);
  const selectedIndex = selectedPath === null ? -1 : files.findIndex((file) => file.path === selectedPath);
  useEffect(() => {
    if (selectedIndex < 0 || height.current <= 0) return;
    const top = selectedIndex * FILE_ROW_HEIGHT;
    const bottom = top + FILE_ROW_HEIGHT;
    if (top < offset.current) list.current?.scrollToOffset({ offset: top, animated: false });
    else if (bottom > offset.current + height.current) {
      list.current?.scrollToOffset({ offset: bottom - height.current, animated: false });
    }
  }, [selectedIndex]);

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      row: { height: FILE_ROW_HEIGHT, flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: 10 },
      selected: {
        height: FILE_ROW_HEIGHT,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        backgroundColor: colors.surface2,
      },
      overview: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      letter: { width: 14, fontFamily: MONOSPACE, fontSize: 12, fontWeight: "700" as const },
      names: { flex: 1, minWidth: 0 },
      name: { color: colors.foreground, fontSize: 13 },
      dir: { color: colors.foregroundMuted, fontSize: 11 },
      add: { color: colors.statusSuccess, fontFamily: MONOSPACE, fontSize: 11 },
      del: { color: colors.statusDanger, fontFamily: MONOSPACE, fontSize: 11 },
      empty: { color: colors.foregroundMuted, fontSize: 12, padding: 12 },
    }),
    [colors],
  );

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onOverview}
        style={[styles.overview, overviewSelected ? { backgroundColor: colors.surface2 } : null]}
      >
        <View style={styles.names}>
          <Text style={styles.name}>Review overview</Text>
          <Text style={styles.dir}>{`${files.length} file${files.length === 1 ? "" : "s"} changed`}</Text>
        </View>
        {reviewOpenCount > 0 ? <Badge text={String(reviewOpenCount)} tone="accent" theme={theme} /> : null}
      </Pressable>
    <FlatList
      ref={list}
      data={files}
      onLayout={(event) => {
        height.current = event.nativeEvent.layout.height;
      }}
      onScroll={(event) => {
        offset.current = event.nativeEvent.contentOffset.y;
      }}
      scrollEventThrottle={32}
      keyExtractor={(file) => file.path}
      getItemLayout={(_, index) => ({ length: FILE_ROW_HEIGHT, offset: FILE_ROW_HEIGHT * index, index })}
      initialNumToRender={30}
      windowSize={11}
      // Rows read the selection and the counts from props, so a change to either re-renders the visible ones.
      extraData={[selectedPath, openCounts]}
      style={{ flex: 1 }}
      ListEmptyComponent={<Text style={styles.empty}>No changes in this scope.</Text>}
      renderItem={({ item }) => {
        const { name, dir } = splitPath(item.path);
        const count = openCounts.get(item.path) ?? 0;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              item.reviewState === "reviewed"
                ? `${item.path}, approved`
                : item.reviewState === "changed"
                  ? `${item.path}, changed since approved`
                  : item.path
            }
            onPress={() => onSelect(item.path)}
            style={item.path === selectedPath ? styles.selected : styles.row}
          >
            <Text style={[styles.letter, { color: statusColor(theme, item.status) }]}>{statusLetter(item.status)}</Text>
            <View style={styles.names}>
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
              {dir !== "" ? (
                <Text style={styles.dir} numberOfLines={1}>
                  {item.oldPath !== undefined && item.oldPath !== item.path ? `${dir} (from ${item.oldPath})` : dir}
                </Text>
              ) : null}
            </View>
            {item.binary ? (
              <Text style={styles.dir}>bin</Text>
            ) : (
              <>
                <Text style={styles.add}>{`+${item.additions}`}</Text>
                <Text style={styles.del}>{`-${item.deletions}`}</Text>
              </>
            )}
            {count > 0 ? <Badge text={String(count)} tone="accent" theme={theme} /> : null}
            <ReviewedMark state={item.reviewState} theme={theme} />
          </Pressable>
        );
      }}
    />
    </View>
  );
}
