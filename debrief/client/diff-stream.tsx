/**
 * The continuous diff: every file of the diff (or of a story chapter) as one
 * vertical list of sections, each a header and that file's editor, the way
 * Crit draws a review.
 *
 * It is a hand-rolled windowed list rather than the host `FlatList`, because
 * a section has to stay mounted while it has unsaved edits, and a CodeMirror
 * editor grows and shrinks under the list as it measures itself:
 *
 * - Every section is in normal flow. One near the viewport draws its header;
 *   one far away is a bare box of its height. Only sections within about a
 *   screen of the viewport mount a `FileView` (and so an editor); the rest
 *   hold their last measured height, or an estimate from their hunks before
 *   they have ever been drawn (`stream-model.ts`). Measured heights are kept
 *   per file and layout for the life of the connection.
 * - Contents are read ahead of a section mounting, a few at a time, through
 *   the cache in `file-view.tsx`, so scrolling back draws at once.
 * - A section that grows above the viewport would push what is on screen
 *   down: the browser's scroll anchoring holds the view on web, and
 *   `maintainVisibleContentPosition` does on iOS and Android.
 * - The section at the top of the viewport is reported as the active file.
 *   A scroll request (a file picked in the list, a comment, go to
 *   definition) holds that report on the requested file while the sections
 *   around it settle, re-aiming as their heights land, so the two never fight.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginTab, useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  type ScrollView as NativeScrollView,
  Text,
  View,
} from "react-native";

import { type Compare, compareKey } from "../shared/compare";
import type { Comment, DiffFile, FileStatus } from "../shared/review";
import { fileContents, type Location } from "../shared/rpc";
import type { LocationKind } from "./editor/lsp";
import type { EditorLayout } from "./editor/mode";
import {
  type CreateCommentInput,
  type FileTarget,
  FileView,
  prefetchDiffFile,
  type StoryFileView,
  useCodeSettings,
} from "./file-view";
import { splitPath, statusLetter } from "./format";
import {
  activeSection,
  estimateSectionHeight,
  nearestFirst,
  nextMounted,
  SECTION_HEADER_HEIGHT,
  sameSet,
  scrollTarget,
  sectionTops,
  windowRange,
} from "./stream-model";
import { ReviewedToggle } from "./reviewed";
import type { ThreadActions } from "./thread";
import { Badge, Button, MONOSPACE } from "./ui";

/** The native diff's row height (`native-diff.tsx`). */
const NATIVE_LINE_HEIGHT = 18;
/** How long a scroll request holds the active file while the sections around it settle. */
const REQUEST_HOLD_MS = 1500;
/** After a request, the scroll has to move this far before the list follows it again. */
const FOLLOW_SLACK = 40;
const POSITION_DEBOUNCE_MS = 400;
/** How long a request still holds the active file after the editor has moved to its line. */
const TARGET_SETTLE_MS = 250;

export interface StreamSection {
  file: DiffFile;
  /** Set in the story view: the chapter's narration and lines. */
  story: StoryFileView | null;
  /** The story's line about this file, drawn under its header. */
  note?: string;
  /** What else decides the section's height ("diff", a chapter id), for the height cache. */
  variant: string;
}

export interface ScrollRequest {
  path: string;
  /** A line to move the editor to; null scrolls to the file's header. */
  target: FileTarget | null;
  /** Pixels into the section, for restoring a position. */
  offset?: number;
  /** Bumped per request, so asking for the same place twice still moves there. */
  seq: number;
}

export interface StreamPosition {
  path: string;
  offset: number;
}

/** Measured section heights, per workspace, compare, layout, file and its shape, for the life of the connection. */
const measured = new Map<string, number>();
const MEASURED_LIMIT = 4000;

function remember(key: string, height: number): void {
  measured.delete(key);
  measured.set(key, height);
  if (measured.size > MEASURED_LIMIT) {
    const oldest = measured.keys().next().value;
    if (oldest !== undefined) measured.delete(oldest);
  }
}

function statusColor(theme: PluginTheme, status: FileStatus): string {
  const colors = theme.colors;
  if (status === "added" || status === "untracked") return colors.statusSuccess;
  if (status === "deleted") return colors.statusDanger;
  if (status === "renamed") return colors.accent;
  return colors.statusWarning;
}

/** Everything a mounted section's `FileView` needs that is the same for every section. */
interface SectionContext {
  workspaceId: string;
  compare: Compare;
  theme: PluginTheme;
  platform: "ios" | "android" | "web";
  tab: PluginTab;
  editorLayout: EditorLayout;
  refreshNonce: number;
  comments: readonly Comment[];
  actions: ThreadActions;
  onCreate: (input: CreateCommentInput) => Promise<void>;
  onLocations: (kind: LocationKind, locations: Location[]) => void;
}

interface SectionHandlers {
  layout(path: string, height: number, measuredBody: boolean): void;
  toggle(path: string): void;
  dirty(path: string, dirty: boolean): void;
  targetShown(path: string): void;
  comment(path: string): void;
  reviewed(path: string): void;
}

export function DiffStream({
  workspaceId,
  compare,
  theme,
  platform,
  tab,
  editorLayout,
  refreshNonce,
  sections,
  comments,
  openCounts,
  actions,
  onCreate,
  onLocations,
  collapsed,
  onToggleCollapsed,
  onToggleReviewed,
  request,
  initial = null,
  onRequestDone,
  onActive,
  onPosition,
  header,
  footer,
  empty = "No changes in this scope.",
}: {
  workspaceId: string;
  compare: Compare;
  theme: PluginTheme;
  platform: "ios" | "android" | "web";
  tab: PluginTab;
  editorLayout: EditorLayout;
  refreshNonce: number;
  sections: readonly StreamSection[];
  /** Every visible comment in the review; each section picks its own. */
  comments: readonly Comment[];
  openCounts: ReadonlyMap<string, number>;
  actions: ThreadActions;
  onCreate: (input: CreateCommentInput) => Promise<void>;
  onLocations: (kind: LocationKind, locations: Location[]) => void;
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (path: string) => void;
  /** The section header's "Reviewed" checkbox was pressed; absent hides it. */
  onToggleReviewed?: (file: DiffFile) => void;
  /** A scroll to make; handled when its `seq` changes, and on mount. */
  request: ScrollRequest | null;
  /** Where to start when mounted without a request (the tab's saved place). */
  initial?: StreamPosition | null;
  /** The request has been acted on, so a remount does not repeat it. */
  onRequestDone?: (seq: number) => void;
  /** The file at the top of the viewport changed (or a request moved to one). */
  onActive: (path: string) => void;
  /** Where the list is, debounced, for the tab state. */
  onPosition?: (position: StreamPosition) => void;
  /** Drawn above the first section and scrolled with it (a story chapter's heading). */
  header?: ReactNode;
  /** Drawn after the last section, above the room left for scrolling the last file up. */
  footer?: ReactNode;
  empty?: string;
}) {
  const loadDiffFile = useRpc(fileContents);
  const code = useCodeSettings();
  const web = platform === "web";
  const lineHeight = web ? code.lineHeight : NATIVE_LINE_HEIGHT;
  const layoutKey = web ? editorLayout : "native";

  const paths = useMemo(() => sections.map((section) => section.file.path), [sections]);
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    comments.forEach((comment) => {
      if (comment.path !== undefined && comment.scope !== "review") counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    });
    return counts;
  }, [comments]);

  const keyOf = useCallback(
    (section: StreamSection) => {
      const file = section.file;
      const shape = `${file.additions}/${file.deletions}/${file.hunks.length}/${threadCounts.get(file.path) ?? 0}`;
      return `${workspaceId}|${compareKey(compare)}|${layoutKey}|${section.variant}|${file.path}|${shape}`;
    },
    [workspaceId, compare, layoutKey, threadCounts],
  );

  /** The height each section holds before it is laid out: measured once, else estimated. */
  const expected = useMemo(
    () =>
      sections.map((section) => {
        if (collapsed.has(section.file.path)) return SECTION_HEADER_HEIGHT;
        const known = measured.get(keyOf(section));
        if (known !== undefined) return known;
        const focused = section.story?.focus ?? null;
        // A chapter's file shows only its own hunks; the estimate counts what the focus keeps.
        const file =
          focused === null
            ? section.file
            : {
                ...section.file,
                hunks: section.file.hunks.filter((hunk) =>
                  focused.new.some((span) => span.start <= hunk.newStart + hunk.newLines && span.end >= hunk.newStart),
                ),
              };
        return estimateSectionHeight(file, {
          layout: web ? editorLayout : "unified",
          lineHeight,
          threads: threadCounts.get(section.file.path) ?? 0,
          collapsed: false,
        });
      }),
    // `measured` is module state read at render; a new measurement re-renders through `laid`.
    [sections, collapsed, keyOf, web, editorLayout, lineHeight, threadCounts],
  );

  // What the list has actually laid out, per path; it wins over `expected`.
  const laid = useRef(new Map<string, number>());
  const scroller = useRef<NativeScrollView>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);
  const headerHeight = useRef(0);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const [target, setTarget] = useState<{ path: string; target: FileTarget } | null>(null);
  const [composers, setComposers] = useState<ReadonlyMap<string, number>>(() => new Map());

  const heights = useCallback(
    () => paths.map((path, index) => laid.current.get(path) ?? expected[index] ?? SECTION_HEADER_HEIGHT),
    [paths, expected],
  );

  // A request in flight: the list holds it until the sections around it settle.
  // `aim` is false once the file's editor has moved to the requested line itself.
  const pending = useRef<{ index: number; within: number; until: number; aim: boolean } | null>(null);
  const followFrom = useRef<number | null>(null);
  const active = useRef<string | null>(null);

  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const onRequestDoneRef = useRef(onRequestDone);
  onRequestDoneRef.current = onRequestDone;

  const report = useCallback((path: string | undefined) => {
    if (path === undefined || active.current === path) return;
    active.current = path;
    onActiveRef.current(path);
  }, []);

  const [view, setView] = useState<{ near: { first: number; last: number } | null; mounted: ReadonlySet<string> }>(() => ({
    near: null,
    mounted: new Set(),
  }));
  const viewRef = useRef(view);
  viewRef.current = view;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /** Recomputes what is near, what is mounted and what to read ahead, from the scroll position. */
  const recompute = useCallback(() => {
    const hs = heights();
    const tops = sectionTops(hs);
    const screen = viewport.current > 0 ? viewport.current : 800;
    const y = scrollY.current - headerHeight.current;
    const inner = windowRange(tops, hs, y, screen, 1, 1);
    const outer = windowRange(tops, hs, y, screen, 2, 2);
    const near = windowRange(tops, hs, y, screen, 3, 3);
    const keep = new Set(dirtyRef.current);
    const held = pending.current;
    if (held !== null) {
      const path = paths[held.index];
      if (path !== undefined) keep.add(path);
    }
    const candidates = nextMounted(paths, viewRef.current.mounted, inner, outer, keep);
    const mounted = new Set<string>();
    candidates.forEach((path) => {
      if (!collapsed.has(path) || dirtyRef.current.has(path)) mounted.add(path);
    });
    const before = viewRef.current;
    const nearSame = before.near?.first === near?.first && before.near?.last === near?.last;
    if (!nearSame || !sameSet(before.mounted, mounted)) {
      const next = { near, mounted };
      viewRef.current = next;
      setView(next);
    }

    // Read ahead, nearest first, so a section draws its file as it arrives.
    const ahead = windowRange(tops, hs, y, screen, 2, 3);
    if (ahead !== null) {
      const center = Math.max(0, activeSection(tops, y));
      nearestFirst(ahead, center).forEach((index) => {
        const section = sections[index];
        if (section === undefined || section.file.binary || collapsed.has(section.file.path)) return;
        prefetchDiffFile(loadDiffFile, workspaceId, compare, section.file.path);
      });
    }

    // The file on top: the requested one while a request holds, otherwise whatever is under the top edge.
    if (held !== null && Date.now() < held.until) {
      report(paths[held.index]);
      return;
    }
    if (held !== null) {
      pending.current = null;
      followFrom.current = scrollY.current;
    }
    if (followFrom.current !== null) {
      if (Math.abs(scrollY.current - followFrom.current) < FOLLOW_SLACK) return;
      followFrom.current = null;
    }
    report(paths[activeSection(tops, scrollY.current, headerHeight.current)]);
  }, [heights, paths, sections, collapsed, loadDiffFile, workspaceId, compare, report]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  /** Scrolls the held request's section to the top; re-run as heights above it land. */
  const aim = useCallback(() => {
    const held = pending.current;
    if (held === null) return;
    if (Date.now() >= held.until) {
      pending.current = null;
      followFrom.current = scrollY.current;
      return;
    }
    if (!held.aim) return;
    const hs = heights();
    const tops = sectionTops(hs);
    const content = headerHeight.current + hs.reduce((sum, height) => sum + height, 0) + bottomSpace(hs, viewport.current);
    const y = scrollTarget(tops, held.index, headerHeight.current, held.within, content, viewport.current);
    if (Math.abs(y - scrollY.current) >= 1) {
      scrollY.current = y;
      scroller.current?.scrollTo({ y, animated: false });
    }
  }, [heights]);
  const aimRef = useRef(aim);
  aimRef.current = aim;

  // Layout changes arrive one section at a time; they are handled once per tick.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settle = useCallback(() => {
    if (settleTimer.current !== undefined) return;
    settleTimer.current = setTimeout(() => {
      settleTimer.current = undefined;
      aimRef.current();
      recomputeRef.current();
    }, 0);
  }, []);
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // A request: scroll to the file, then hand its editor the line once the scroll has happened.
  const requestSeq = request?.seq ?? null;
  const firstRequest = useRef(true);
  useEffect(() => {
    const onMount = firstRequest.current;
    firstRequest.current = false;
    const asked: ScrollRequest | null =
      request ?? (onMount && initial !== null ? { path: initial.path, target: null, offset: initial.offset, seq: 0 } : null);
    if (asked === null) return;
    if (request !== null) onRequestDoneRef.current?.(request.seq);
    const index = paths.indexOf(asked.path);
    if (index < 0) return;
    pending.current = {
      index,
      within: asked.offset ?? 0,
      until: Date.now() + REQUEST_HOLD_MS,
      aim: true,
    };
    followFrom.current = null;
    report(asked.path);
    if (collapsed.has(asked.path) && asked.target !== null) onToggleCollapsed(asked.path);
    aim();
    recompute();
    if (asked.target !== null) setTarget({ path: asked.path, target: asked.target });
    // Keyed on the request's seq: a new `paths` alone is not a request.
  }, [requestSeq]);

  // The list's shape moved (a reload, a collapse, unsaved edits): recompute what is mounted.
  useEffect(() => {
    settle();
  }, [expected, dirty, settle]);

  // Where the list is, for the tab state, once scrolling stops.
  const positionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notePosition = useCallback(() => {
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(() => {
      const callback = onPositionRef.current;
      const path = active.current;
      if (callback === undefined || path === null) return;
      const index = paths.indexOf(path);
      if (index < 0) return;
      const tops = sectionTops(heights());
      callback({ path, offset: Math.max(0, Math.round(scrollY.current - headerHeight.current - (tops[index] ?? 0))) });
    }, POSITION_DEBOUNCE_MS);
  }, [paths, heights]);
  useEffect(() => () => clearTimeout(positionTimer.current), []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.current = event.nativeEvent.contentOffset.y;
      recompute();
      notePosition();
    },
    [recompute, notePosition],
  );

  const handlersState = useRef({ paths, onToggleCollapsed, onToggleReviewed, tab, keyOf, sections });
  handlersState.current = { paths, onToggleCollapsed, onToggleReviewed, tab, keyOf, sections };
  const handlers = useMemo<SectionHandlers>(
    () => ({
      layout: (path, height, measuredBody) => {
        if (laid.current.get(path) === height) return;
        laid.current.set(path, height);
        if (measuredBody) {
          const section = handlersState.current.sections.find((candidate) => candidate.file.path === path);
          if (section !== undefined) remember(handlersState.current.keyOf(section), height);
        }
        settle();
      },
      toggle: (path) => handlersState.current.onToggleCollapsed(path),
      dirty: (path, isDirty) => {
        setDirty((current) => {
          if (current.has(path) === isDirty) return current;
          const next = new Set(current);
          if (isDirty) next.add(path);
          else next.delete(path);
          handlersState.current.tab.setModified(next.size > 0);
          return next;
        });
      },
      targetShown: (path) => {
        const held = pending.current;
        if (held !== null && handlersState.current.paths[held.index] === path) {
          // The editor scrolls to its line on its next frame; hold the file a moment longer, without re-aiming.
          pending.current = { ...held, aim: false, until: Math.min(held.until, Date.now() + TARGET_SETTLE_MS) };
        }
        // The editor has its line; a later remount must not move it there again.
        setTarget((current) => (current?.path === path ? null : current));
      },
      comment: (path) =>
        setComposers((current) => {
          const next = new Map(current);
          next.set(path, (current.get(path) ?? 0) + 1);
          return next;
        }),
      reviewed: (path) => {
        const section = handlersState.current.sections.find((candidate) => candidate.file.path === path);
        if (section !== undefined) handlersState.current.onToggleReviewed?.(section.file);
      },
    }),
    [settle],
  );

  // The tab's modified dot is the union of the sections'; clear it when the list goes.
  useEffect(() => () => tab.setModified(false), [tab]);

  const context = useMemo<SectionContext>(
    () => ({ workspaceId, compare, theme, platform, tab, editorLayout, refreshNonce, comments, actions, onCreate, onLocations }),
    [workspaceId, compare, theme, platform, tab, editorLayout, refreshNonce, comments, actions, onCreate, onLocations],
  );

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      list: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
      empty: { color: colors.foregroundMuted, fontSize: 13, padding: 16 },
    }),
    [colors],
  );

  const hs = heights();
  const [footerHeight, setFooterHeight] = useState(0);
  const tail = Math.max(0, bottomSpace(hs, viewport.current) - footerHeight);

  return (
    <ScrollView
      ref={scroller}
      style={styles.list}
      scrollEventThrottle={16}
      onScroll={onScroll}
      onLayout={(event: LayoutChangeEvent) => {
        viewport.current = event.nativeEvent.layout.height;
        settle();
      }}
      onScrollBeginDrag={() => {
        // A finger on the list wins over a request still settling.
        pending.current = null;
        followFrom.current = null;
      }}
      {...(web ? {} : { maintainVisibleContentPosition: { minIndexForVisible: 0 } })}
    >
      {header !== undefined ? (
        <View
          onLayout={(event: LayoutChangeEvent) => {
            headerHeight.current = event.nativeEvent.layout.height;
            settle();
          }}
        >
          {header}
        </View>
      ) : null}
      {sections.length === 0 ? <Text style={styles.empty}>{empty}</Text> : null}
      {sections.map((section, index) => {
        const path = section.file.path;
        const near = view.near !== null && index >= view.near.first && index <= view.near.last;
        const mounted = view.mounted.has(path);
        return (
          <Section
            key={path}
            section={section}
            height={hs[index] ?? SECTION_HEADER_HEIGHT}
            near={near || mounted}
            mounted={mounted}
            collapsed={collapsed.has(path)}
            openCount={openCounts.get(path) ?? 0}
            target={target?.path === path ? target.target : null}
            composerNonce={composers.get(path) ?? 0}
            context={mounted ? context : null}
            handlers={handlers}
            showReviewed={onToggleReviewed !== undefined}
            theme={theme}
          />
        );
      })}
      {footer !== undefined ? (
        <View onLayout={(event: LayoutChangeEvent) => setFooterHeight(event.nativeEvent.layout.height)}>{footer}</View>
      ) : null}
      {tail > 0 ? <View style={{ height: tail }} /> : null}
    </ScrollView>
  );
}

/** Room under the last section, so even a short last file can be scrolled to the top. */
function bottomSpace(heights: readonly number[], viewport: number): number {
  const last = heights[heights.length - 1];
  if (last === undefined || viewport <= 0) return 0;
  return Math.max(0, viewport - last);
}

/** Paseo's web renderer passes CSS through; a header that sticks to the top of its section while it scrolls. */
const STICKY = Platform.OS === "web" ? ({ position: "sticky", top: 0, zIndex: 2 } as unknown as object) : {};

const Section = memo(function Section({
  section,
  height,
  near,
  mounted,
  collapsed,
  openCount,
  target,
  composerNonce,
  context,
  handlers,
  showReviewed,
  theme,
}: {
  section: StreamSection;
  /** The height to hold while not mounted (or not yet loaded). */
  height: number;
  /** Near the viewport: draw the header. */
  near: boolean;
  /** Draw the file. */
  mounted: boolean;
  collapsed: boolean;
  openCount: number;
  target: FileTarget | null;
  composerNonce: number;
  /** Only for a mounted section, so a far one does not re-render with every comment. */
  context: SectionContext | null;
  handlers: SectionHandlers;
  showReviewed: boolean;
  theme: PluginTheme;
}) {
  const file = section.file;
  const path = file.path;
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      header: {
        height: SECTION_HEADER_HEIGHT,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 8,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderTopColor: colors.border,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
        ...STICKY,
      },
      changedHeader: { borderLeftWidth: 3, borderLeftColor: colors.statusWarning, paddingLeft: 5 },
      changedTint: {
        position: "absolute" as const,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: colors.statusWarning,
        opacity: 0.12,
      },
      changedText: { color: colors.statusWarning, fontSize: 11, flexShrink: 1 },
      chevron: { padding: 2 },
      letter: { width: 12, fontFamily: MONOSPACE, fontSize: 12, fontWeight: "700" as const },
      names: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 6 },
      name: { color: colors.foreground, fontSize: 13, fontFamily: MONOSPACE, flexShrink: 0 },
      dir: { color: colors.foregroundMuted, fontSize: 11, fontFamily: MONOSPACE, flexShrink: 1 },
      add: { color: colors.statusSuccess, fontFamily: MONOSPACE, fontSize: 11 },
      del: { color: colors.statusDanger, fontFamily: MONOSPACE, fontSize: 11 },
      note: {
        color: colors.foreground,
        fontSize: 12,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
    }),
    [colors],
  );

  const onLayout = (event: LayoutChangeEvent) =>
    handlers.layout(path, event.nativeEvent.layout.height, mounted && !collapsed);

  if (!near) return <View style={{ height }} onLayout={onLayout} />;

  const { name, dir } = splitPath(path);
  const renamed = file.oldPath !== undefined && file.oldPath !== path;
  const changed = showReviewed && file.reviewState === "changed";
  const headerRow = (
    <View style={changed ? [styles.header, styles.changedHeader] : styles.header}>
      {changed ? <View pointerEvents="none" style={styles.changedTint} /> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        style={styles.chevron}
        onPress={() => handlers.toggle(path)}
      >
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
      </Pressable>
      <Text style={[styles.letter, { color: statusColor(theme, file.status) }]}>{statusLetter(file.status)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={path} style={styles.names} onPress={() => handlers.toggle(path)}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {dir !== "" || renamed ? (
          <Text style={styles.dir} numberOfLines={1}>
            {renamed ? `${dir} (from ${file.oldPath})` : dir}
          </Text>
        ) : null}
      </Pressable>
      {changed ? (
        <Text style={styles.changedText} numberOfLines={1}>
          Changed since approved
        </Text>
      ) : null}
      {file.binary ? (
        <Text style={styles.dir}>bin</Text>
      ) : (
        <>
          <Text style={styles.add}>{`+${file.additions}`}</Text>
          <Text style={styles.del}>{`-${file.deletions}`}</Text>
        </>
      )}
      {openCount > 0 ? <Badge text={String(openCount)} tone="accent" theme={theme} /> : null}
      {mounted && !collapsed ? (
        <Button label="Comment on file" icon="MessageSquarePlus" showLabel={false} tone="quiet" theme={theme} onPress={() => handlers.comment(path)} />
      ) : null}
      {showReviewed ? (
        <ReviewedToggle state={file.reviewState ?? null} path={path} theme={theme} onPress={() => handlers.reviewed(path)} />
      ) : null}
    </View>
  );

  const body =
    mounted && context !== null ? (
      <View style={collapsed ? { display: "none" as const } : null}>
        {section.note !== undefined && section.note !== "" ? <Text style={styles.note}>{section.note}</Text> : null}
        <FileView
          workspaceId={context.workspaceId}
          compare={context.compare}
          source={{ kind: "diff", path }}
          theme={context.theme}
          platform={context.platform}
          tab={context.tab}
          editorLayout={context.editorLayout}
          refreshNonce={context.refreshNonce}
          target={target}
          comments={context.comments}
          actions={context.actions}
          onCreate={context.onCreate}
          onLocations={context.onLocations}
          story={section.story}
          embedded
          onDirtyChange={(isDirty) => handlers.dirty(path, isDirty)}
          composerNonce={composerNonce}
          placeholderHeight={Math.max(24, height - SECTION_HEADER_HEIGHT)}
          onTargetShown={() => handlers.targetShown(path)}
        />
      </View>
    ) : collapsed ? null : (
      <View style={{ height: Math.max(0, height - SECTION_HEADER_HEIGHT) }} />
    );

  return (
    <View onLayout={onLayout}>
      {headerRow}
      {body}
    </View>
  );
});
