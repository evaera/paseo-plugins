/**
 * The story view: the agent's guided tour of the diff. The left column lists
 * the prologue, the chapters (the open one shows its files in the author's
 * order) and the support hunks; the main area shows the prologue, a
 * chapter (its summary, then its files as one continuous list, each cut down
 * to the chapter's hunks and narrated), or the support list. The files are
 * drawn by the panel's `DiffStream`, so comments work as they do in the diff
 * view.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import type { Chapter, Story } from "../shared/story";
import { splitPath } from "./format";
import type { StoryPlace } from "./story";
import { ItemCard, Page, usePageStyles } from "./page";
import { Badge, Button, MONOSPACE } from "./ui";

function useStoryStyles(theme: PluginTheme) {
  const colors = theme.colors;
  return useMemo(
    () => ({
      column: { flex: 1, minHeight: 0 },
      top: { padding: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
      row: { paddingHorizontal: 10, paddingVertical: 7, gap: 2 },
      selected: { paddingHorizontal: 10, paddingVertical: 7, gap: 2, backgroundColor: colors.surface2 },
      fileRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingLeft: 24, paddingRight: 10, paddingVertical: 4 },
      fileSelected: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingLeft: 24,
        paddingRight: 10,
        paddingVertical: 4,
        backgroundColor: colors.surface1,
      },
      title: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
      name: { color: colors.foreground, fontSize: 12, flex: 1 },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      warning: { color: colors.statusWarning, fontSize: 12 },
      section: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.5 },
      page: { padding: 16, gap: 12 },
      heading: { color: colors.foreground, fontSize: 17, fontWeight: "700" as const },
      chapterHead: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      },
      strip: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: {
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: colors.surface0,
      },
      chipSelected: {
        borderWidth: 1,
        borderColor: colors.accent,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: colors.accent,
      },
      chipText: { color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE },
      chipTextSelected: { color: colors.accentForeground, fontSize: 12, fontFamily: MONOSPACE },
      summary: { color: colors.foreground, fontSize: 13 },
      nav: { flexDirection: "row" as const, gap: 6, alignItems: "center" as const },
      support: { gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
      path: { color: colors.foreground, fontSize: 12, fontFamily: MONOSPACE },
    }),
    [colors],
  );
}

export function StorySidebar({
  story,
  stale,
  writing,
  place,
  path,
  openCounts,
  theme,
  onPlace,
  onFile,
  onWrite,
}: {
  story: Story | null;
  stale: boolean;
  /** A request is out and no story has come back yet. */
  writing: boolean;
  place: StoryPlace;
  path: string | null;
  openCounts: ReadonlyMap<string, number>;
  theme: PluginTheme;
  onPlace: (place: StoryPlace) => void;
  onFile: (chapterId: string, path: string) => void;
  onWrite: () => void;
}) {
  const styles = useStoryStyles(theme);
  const top = (
    <View style={styles.top}>
      {story === null ? (
        <>
          <Text style={styles.muted}>
            {writing ? "The agent is writing the story..." : "No story yet. The agent can write one: a tour of the change, chapter by chapter."}
          </Text>
          <View style={{ flexDirection: "row" }}>
            <Button label={writing ? "Ask again" : "Write story"} icon="BookOpenText" tone="accent" theme={theme} onPress={onWrite} />
          </View>
        </>
      ) : (
        <>
          {stale ? <Text style={styles.warning}>The diff changed since this story was written.</Text> : null}
          <View style={{ flexDirection: "row" }}>
            <Button
              label={writing ? "Rewriting..." : "Rewrite story"}
              icon="RefreshCw"
              tone={stale ? "accent" : "quiet"}
              disabled={writing}
              theme={theme}
              onPress={onWrite}
            />
          </View>
        </>
      )}
    </View>
  );
  if (story === null) return <View style={styles.column}>{top}</View>;
  return (
    <ScrollView style={styles.column}>
      {top}
      <Pressable
        accessibilityRole="button"
        style={place.kind === "prologue" ? styles.selected : styles.row}
        onPress={() => onPlace({ kind: "prologue" })}
      >
        <Text style={styles.section}>PROLOGUE</Text>
        <Text style={styles.title} numberOfLines={2}>
          {story.prologue.title}
        </Text>
      </Pressable>
      {story.chapters.map((chapter, index) => {
        const open = place.kind === "chapter" && place.chapterId === chapter.id;
        return (
          <View key={chapter.id}>
            <Pressable
              accessibilityRole="button"
              style={open ? styles.selected : styles.row}
              onPress={() => onPlace({ kind: "chapter", chapterId: chapter.id })}
            >
              <Text style={styles.section}>{`CHAPTER ${index + 1}`}</Text>
              <Text style={styles.title} numberOfLines={2}>
                {chapter.title}
              </Text>
              <Text style={styles.muted}>{`${chapter.files.length} file${chapter.files.length === 1 ? "" : "s"}`}</Text>
            </Pressable>
            {open
              ? chapter.files.map((file) => {
                  const count = openCounts.get(file.path) ?? 0;
                  return (
                    <Pressable
                      key={file.path}
                      accessibilityRole="button"
                      accessibilityLabel={file.path}
                      style={file.path === path ? styles.fileSelected : styles.fileRow}
                      onPress={() => onFile(chapter.id, file.path)}
                    >
                      <Text style={styles.name} numberOfLines={1}>
                        {splitPath(file.path).name}
                      </Text>
                      {count > 0 ? <Badge text={String(count)} tone="accent" theme={theme} /> : null}
                    </Pressable>
                  );
                })
              : null}
          </View>
        );
      })}
      {story.support.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          style={place.kind === "support" ? styles.selected : styles.row}
          onPress={() => onPlace({ kind: "support" })}
        >
          <Text style={styles.section}>SUPPORT</Text>
          <Text style={styles.muted}>{`${story.support.length} supporting change${story.support.length === 1 ? "" : "s"}`}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

export function StoryPrologue({
  story,
  theme,
  onStart,
}: {
  story: Story;
  theme: PluginTheme;
  onStart: () => void;
}) {
  const page = usePageStyles(theme);
  const { prologue, coverage } = story;
  const unplaced = coverage.missing.length;
  return (
    <Page>
      <View style={page.header}>
        <Text style={page.eyebrow}>STORY</Text>
        <Text style={page.title}>{prologue.title}</Text>
      </View>
      {prologue.overview !== "" ? <Markdown>{prologue.overview}</Markdown> : null}
      {prologue.keyChanges.length > 0 ? (
        <ItemCard title="KEY CHANGES" items={prologue.keyChanges} icon="dot" iconColor={theme.colors.accent} theme={theme} />
      ) : null}
      {prologue.risks.length > 0 ? (
        <ItemCard title="RISKS" items={prologue.risks} icon="TriangleAlert" iconColor={theme.colors.statusWarning} theme={theme} />
      ) : null}
      <View style={page.footer}>
        <Text style={page.meta}>
          {`${story.chapters.length} chapter${story.chapters.length === 1 ? "" : "s"} · ${coverage.placed} of ${coverage.indexed} hunks placed` +
            (unplaced > 0 ? ` · ${unplaced} not in any chapter` : "")}
        </Text>
        {story.chapters.length > 0 ? (
          <Button label="Start reading" icon="ArrowRight" tone="accent" theme={theme} onPress={onStart} />
        ) : null}
      </View>
    </Page>
  );
}

export function StoryChapter({
  story,
  chapter,
  path,
  theme,
  onFile,
  onStep,
  onPlace,
  renderFiles,
}: {
  story: Story;
  chapter: Chapter;
  /** The file at the top of the chapter's list. */
  path: string | null;
  theme: PluginTheme;
  /** Scrolls the chapter's list to a file. */
  onFile: (path: string) => void;
  /** Moves to the next or previous file across chapters. */
  onStep: (direction: 1 | -1) => void;
  /** Opens another part of the story: the prologue, a chapter, or the support files. */
  onPlace: (place: StoryPlace) => void;
  /** The chapter's files as one continuous list, `header` above the first and `footer` after the last. */
  renderFiles: (header: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const styles = useStoryStyles(theme);
  const index = story.chapters.findIndex((candidate) => candidate.id === chapter.id);
  const header = (
    <View style={styles.chapterHead}>
      <Text style={styles.heading}>{chapter.title}</Text>
      {chapter.summary !== "" ? <Markdown>{chapter.summary}</Markdown> : null}
      <View style={styles.strip}>
        {chapter.files.map((file) => {
          const selected = file.path === path;
          return (
            <Pressable
              key={file.path}
              accessibilityRole="button"
              accessibilityLabel={file.path}
              accessibilityState={{ selected }}
              style={selected ? styles.chipSelected : styles.chip}
              onPress={() => onFile(file.path)}
            >
              <Text style={selected ? styles.chipTextSelected : styles.chipText}>{splitPath(file.path).name}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[styles.chapterHead, styles.nav]}>
        <Text style={[styles.section, { flex: 1 }]}>{`CHAPTER ${index + 1} OF ${story.chapters.length}`}</Text>
        <Button label="Previous file" icon="ArrowLeft" showLabel={false} theme={theme} onPress={() => onStep(-1)} />
        <Button label="Next file" icon="ArrowRight" showLabel={false} theme={theme} onPress={() => onStep(1)} />
      </View>
      {renderFiles(header, <ChapterFooter story={story} index={index} theme={theme} onPlace={onPlace} />)}
    </View>
  );
}

export function StorySupport({
  story,
  theme,
  onOpen,
}: {
  story: Story;
  theme: PluginTheme;
  onOpen: (path: string) => void;
}) {
  const styles = useStoryStyles(theme);
  const page = usePageStyles(theme);
  return (
    <Page>
      <View style={page.header}>
        <Text style={page.eyebrow}>STORY</Text>
        <Text style={page.title}>Support files</Text>
        <Text style={page.lead}>Changes that support the story without telling it: lockfiles, renames, generated code.</Text>
      </View>
      <View style={page.card}>
        {story.support.map((entry, index) => (
          <Pressable
            key={`${entry.path}:${index}`}
            accessibilityRole="button"
            style={index === story.support.length - 1 ? { gap: 2 } : styles.support}
            onPress={() => onOpen(entry.path)}
          >
            <Text style={styles.path}>{entry.path}</Text>
            <Text style={page.meta}>
              {entry.reason + (entry.hunks !== undefined ? ` (${entry.hunks.length} hunk${entry.hunks.length === 1 ? "" : "s"})` : "")}
            </Text>
          </Pressable>
        ))}
      </View>
    </Page>
  );
}

/** The end of a chapter: where to read next, and where you came from. */
function ChapterFooter({
  story,
  index,
  theme,
  onPlace,
}: {
  story: Story;
  index: number;
  theme: PluginTheme;
  onPlace: (place: StoryPlace) => void;
}) {
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, gap: 12, padding: 16, borderTopWidth: 1, borderTopColor: colors.border },
      card: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      },
      spacer: { flex: 1 },
      label: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.5 },
      title: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
      text: { flex: 1, gap: 2 },
      end: { textAlign: "right" as const },
    }),
    [colors],
  );
  const previous: { place: StoryPlace; label: string; title: string } =
    index > 0
      ? { place: { kind: "chapter", chapterId: story.chapters[index - 1]!.id }, label: "PREVIOUS CHAPTER", title: story.chapters[index - 1]!.title }
      : { place: { kind: "prologue" }, label: "BACK TO", title: "Prologue" };
  const following = story.chapters[index + 1];
  const next: { place: StoryPlace; label: string; title: string } | null =
    following !== undefined
      ? { place: { kind: "chapter", chapterId: following.id }, label: "NEXT CHAPTER", title: following.title }
      : story.support.length > 0
        ? { place: { kind: "support" }, label: "NEXT", title: "Support files" }
        : null;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${previous.label.toLowerCase()}: ${previous.title}`}
        style={styles.card}
        onPress={() => onPlace(previous.place)}
      >
        <Icon name="ArrowLeft" size={16} color={colors.foregroundMuted} />
        <View style={styles.text}>
          <Text style={styles.label}>{previous.label}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {previous.title}
          </Text>
        </View>
      </Pressable>
      {next !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${next.label.toLowerCase()}: ${next.title}`}
          style={styles.card}
          onPress={() => onPlace(next.place)}
        >
          <View style={styles.text}>
            <Text style={[styles.label, styles.end]}>{next.label}</Text>
            <Text style={[styles.title, styles.end]} numberOfLines={1}>
              {next.title}
            </Text>
          </View>
          <Icon name="ArrowRight" size={16} color={colors.foregroundMuted} />
        </Pressable>
      ) : (
        <View style={[styles.card, { justifyContent: "center" as const }]}>
          <Text style={styles.label}>END OF THE STORY</Text>
        </View>
      )}
    </View>
  );
}
