/**
 * One open file: its two sides loaded from the daemon, drawn in the CodeMirror
 * editor on web and Electron or the native diff elsewhere, with the file's own
 * comments above it.
 *
 * It follows the disk: when the panel's poll sees a change it bumps
 * `refreshNonce`, and the file is re-read. Unsaved edits are never replaced;
 * a change underneath them shows "File changed on disk" with Reload instead,
 * and a save against a newer mtime is a conflict offering Reload or Overwrite.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginTab, useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { type Compare, compareKey } from "../shared/compare";
import type { Comment } from "../shared/review";
import type { Annotation } from "../shared/story";
import {
  fileContents,
  type Location,
  lspCompletion,
  lspDefinition,
  lspDiagnostics,
  lspHover,
  lspSync,
  readFile,
  writeFile,
} from "../shared/rpc";
import { ContentsCache } from "./contents-cache";
import { messageOf, threadsForFile } from "./format";
import { NarrationBlock } from "./narration";
import { NativeDiff } from "./native-diff";
import { annotationsOnSide, type Focus } from "./story";
import { readCodeSettings, watchCodeSettings } from "./web";
import { Composer, type ThreadActions, ThreadView } from "./thread";
import { Button, MONOSPACE } from "./ui";
import { type EditorLayout, editorMode, editorShowsOldThreads } from "./editor/mode";
import type { LocationKind } from "./editor/lsp";
import type { NewComment } from "./editor/threads";
import { type EditorCallbacks, type EditorHandle, mountEditor } from "./editor/web";

const DIAGNOSTICS_MS = 3000;

export interface FileSource {
  /** `diff`: a file in the review's diff; `file`: any file, opened by navigation. */
  kind: "diff" | "file";
  path: string;
}

export interface FileTarget {
  line: number;
  character: number;
  /** Bumped on every request, so asking for the same place twice still moves there. */
  seq: number;
}

export type CreateCommentInput =
  | { scope: "file"; path: string; body: string }
  | ({ scope: "line"; path: string } & NewComment);

interface Loaded {
  path: string;
  oldText: string | null;
  newText: string | null;
  newEditable: boolean;
  mtimeMs: number | null;
  language: string;
  binary: boolean;
  tooLarge: boolean;
  /** Not part of the diff: shown as a plain file. */
  plain: boolean;
}

type Banner = { kind: "disk"; next: Loaded } | { kind: "conflict" } | null;

/** What a story chapter adds to a file: its narration and the lines it places. */
export interface StoryFileView {
  annotations: readonly Annotation[];
  focus: Focus | null;
}

/** Paseo's code settings, re-read on every render and when another window changes them. */
export function useCodeSettings() {
  const [, setTick] = useState(0);
  useEffect(() => watchCodeSettings(() => setTick((tick) => tick + 1)), []);
  return readCodeSettings();
}

const NO_ANNOTATIONS: readonly Annotation[] = [];

/** Every file read, for the life of the host connection: a section scrolled back to draws at once. */
const contents = new ContentsCache<Loaded>();
/** Bumped per workspace when its diff moves; a cache entry read before is shown, then re-read. */
const generations = new Map<string, number>();

export function contentsGeneration(workspaceId: string): number {
  return generations.get(workspaceId) ?? 0;
}

/** The panel's poll saw the workspace change (or a panel just mounted): cached contents are stale. */
export function bumpContents(workspaceId: string): void {
  generations.set(workspaceId, contentsGeneration(workspaceId) + 1);
}

function cacheKey(workspaceId: string, compare: Compare, source: FileSource): string {
  return `${workspaceId}|${compareKey(compare)}|${source.kind}|${source.path}`;
}

type LoadDiffFile = (input: { workspaceId: string; compare: Compare; path: string }) => Promise<Omit<Loaded, "plain">>;

/** Reads a diff file into the cache ahead of its section mounting; a no-op when the cache is fresh. */
export function prefetchDiffFile(load: LoadDiffFile, workspaceId: string, compare: Compare, path: string): void {
  const key = cacheKey(workspaceId, compare, { kind: "diff", path });
  const generation = contentsGeneration(workspaceId);
  // A read that failed is not retried on every scroll; the section's own read (or the next generation) tries again.
  if (failedReads.get(key) === generation) return;
  contents
    .load(key, generation, async () => ({ ...(await load({ workspaceId, compare, path })), plain: false }))
    .catch(() => {
      failedReads.set(key, generation);
      if (failedReads.size > 1000) failedReads.clear();
    });
}
const failedReads = new Map<string, number>();

export function FileView({
  workspaceId,
  compare,
  source,
  theme,
  platform,
  tab,
  editorLayout,
  refreshNonce,
  target,
  comments,
  actions,
  onCreate,
  onLocations,
  story = null,
  embedded = false,
  onDirtyChange,
  composerNonce = 0,
  placeholderHeight,
  onTargetShown,
}: {
  workspaceId: string;
  compare: Compare;
  source: FileSource;
  theme: PluginTheme;
  platform: "ios" | "android" | "web";
  tab: PluginTab;
  editorLayout: EditorLayout;
  refreshNonce: number;
  target: FileTarget | null;
  /** Every visible comment in the review; this view picks its own. */
  comments: readonly Comment[];
  actions: ThreadActions;
  onCreate: (input: CreateCommentInput) => Promise<void>;
  onLocations: (kind: LocationKind, locations: Location[]) => void;
  /** Set in the story view. */
  story?: StoryFileView | null;
  /**
   * A section of the continuous diff: no bar of its own (the section header
   * is the bar), no inner scrolling, and the editor grows to its content.
   */
  embedded?: boolean;
  /** Set by the continuous diff, which owns the tab's modified dot across files; otherwise the tab is told. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Bumped by the section header's "Comment on file". */
  composerNonce?: number;
  /** Height to hold while the contents load, so the section does not jump. */
  placeholderHeight?: number;
  /** The editor has moved to `target`, so whoever scrolled to this file can stop. */
  onTargetShown?: () => void;
}) {
  const loadDiffFile = useRpc(fileContents);
  const loadAnyFile = useRpc(readFile);
  const write = useRpc(writeFile);
  const sync = useRpc(lspSync);
  const hover = useRpc(lspHover);
  const complete = useRpc(lspCompletion);
  const define = useRpc(lspDefinition);
  const diagnose = useRpc(lspDiagnostics);

  const web = platform === "web";
  const code = useCodeSettings();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [lspMessage, setLspMessage] = useState<string | null>(null);
  const [fileComposer, setFileComposer] = useState(false);
  const host = useRef<View>(null);
  const editor = useRef<EditorHandle | null>(null);
  const current = useRef<Loaded | null>(null);
  const mtime = useRef<number | null>(null);
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  const setDirty = useCallback(
    (dirty: boolean) => {
      if (reportDirty.current !== undefined) reportDirty.current(dirty);
      else tab.setModified(dirty);
    },
    [tab],
  );
  const key = cacheKey(workspaceId, compare, source);

  // "Comment on file" from the section header.
  const lastComposer = useRef(composerNonce);
  useEffect(() => {
    if (lastComposer.current === composerNonce) return;
    lastComposer.current = composerNonce;
    setFileComposer(true);
  }, [composerNonce]);

  const fetchLoaded = useCallback(async (): Promise<Loaded> => {
    if (source.kind === "diff") {
      const file = await loadDiffFile({ workspaceId, compare, path: source.path });
      return { ...file, plain: false };
    }
    const file = await loadAnyFile({ workspaceId, path: source.path });
    return {
      path: file.path,
      oldText: null,
      newText: file.text,
      newEditable: file.editable,
      mtimeMs: file.mtimeMs,
      language: file.language,
      binary: file.binary,
      tooLarge: file.tooLarge,
      plain: true,
    };
  }, [loadDiffFile, loadAnyFile, workspaceId, compare, source.kind, source.path]);

  const apply = useCallback((next: Loaded) => {
    current.current = next;
    mtime.current = next.mtimeMs;
    setLoaded(next);
    setBanner(null);
    editor.current?.setDocs(next.oldText, next.newText);
  }, []);

  /** A fresh read landed: apply it, but never over unsaved edits. */
  const reconcile = useCallback(
    (next: Loaded) => {
      const before = current.current;
      if (before === null) {
        apply(next);
        return;
      }
      const same = before.oldText === next.oldText && before.newText === next.newText;
      if (same) {
        mtime.current = editor.current?.isDirty() ? mtime.current : next.mtimeMs;
        return;
      }
      if (editor.current?.isDirty()) {
        if (before.newText !== next.newText) setBanner({ kind: "disk", next });
        return;
      }
      apply(next);
    },
    [apply],
  );

  // A new file (or compare): draw what the cache has at once, and read it again if the diff has moved since.
  useEffect(() => {
    let cancelled = false;
    current.current = null;
    setLoaded(null);
    setError(null);
    setBanner(null);
    setFileComposer(false);
    const cached = contents.get(key);
    if (cached !== null) apply(cached.value);
    const generation = contentsGeneration(workspaceId);
    if (cached !== null && cached.nonce >= generation) return;
    contents
      .load(key, generation, fetchLoaded)
      .then((next) => {
        if (!cancelled) reconcile(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled && current.current === null) setError(messageOf(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, fetchLoaded, apply, reconcile]);

  // The poll saw a change: re-read, but never over unsaved edits.
  const lastNonce = useRef(refreshNonce);
  useEffect(() => {
    if (lastNonce.current === refreshNonce) return;
    lastNonce.current = refreshNonce;
    let cancelled = false;
    contents
      .load(key, contentsGeneration(workspaceId), fetchLoaded)
      .then((next) => {
        if (!cancelled) reconcile(next);
      })
      .catch(() => {
        // A failed refresh keeps what is shown; the next poll tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce, key, workspaceId, fetchLoaded, reconcile]);

  const path = loaded?.path ?? source.path;
  const lspEnabled = loaded !== null && loaded.newText !== null && !loaded.binary && !loaded.tooLarge;

  const save = useCallback(
    async (text: string, force: boolean) => {
      const result = await write({ workspaceId, path, text, expectedMtimeMs: mtime.current, force });
      if (result.status === "conflict") {
        setBanner({ kind: "conflict" });
        return false;
      }
      mtime.current = result.mtimeMs;
      if (current.current !== null) {
        current.current = { ...current.current, newText: text, mtimeMs: result.mtimeMs };
        // A section scrolled away and back draws from the cache: it has to hold what was saved.
        contents.set(key, current.current, contentsGeneration(workspaceId));
      }
      editor.current?.markSaved();
      setBanner(null);
      return true;
    },
    [write, workspaceId, path, key],
  );

  const { newSide, oldSide, file: fileThreads } = useMemo(() => threadsForFile(comments, path), [comments, path]);

  // The editor reads these through a ref, so new closures never remount it.
  const callbacks = useRef<EditorCallbacks>(null as unknown as EditorCallbacks);
  // The last document sync; language requests wait for it so the server answers about the text on screen.
  const lastSync = useRef<Promise<unknown>>(Promise.resolve());
  const synced = async () => {
    editor.current?.flushChange();
    await lastSync.current;
  };
  callbacks.current = {
    onDirty: setDirty,
    onSave: (text) => {
      save(text, false).catch((cause: unknown) => setError(messageOf(cause)));
    },
    onChange: (text) => {
      lastSync.current = sync({ workspaceId, path, text }).catch(() => undefined);
    },
    reply: actions.reply,
    resolve: actions.resolve,
    edit: actions.edit,
    remove: actions.remove,
    ...(actions.agentProvider !== undefined ? { agentProvider: actions.agentProvider } : {}),
    ...(actions.openAgent !== undefined ? { openAgent: actions.openAgent } : {}),
    create: (input) => onCreate({ scope: "line", path, ...input }),
    hover: async (position) => {
      await synced();
      return (await hover({ workspaceId, path, position })).markdown;
    },
    completion: async (position) => {
      await synced();
      return complete({ workspaceId, path, position });
    },
    locations: async (position, kind) => {
      await synced();
      return (await define({ workspaceId, path, position, kind })).locations;
    },
    showLocations: onLocations,
  };

  const mode = loaded === null ? null : editorMode(loaded.oldText, loaded.newText, editorLayout);
  const mountKey =
    loaded === null || loaded.binary || loaded.tooLarge
      ? null
      : `${mode}|${loaded.path}|${loaded.newEditable}|${loaded.language}|${code.fontFamily}|${code.fontSize}|${code.syntaxTheme}`;

  // Mount the editor for this file and mode; tear it down (saving what is unsaved) when either changes.
  useLayoutEffect(() => {
    if (!web || mountKey === null || current.current === null) return;
    const file = current.current;
    const cacheAt = key;
    const handle = mountEditor(host.current, {
      oldText: file.oldText,
      newText: file.newText,
      layout: editorLayout,
      editable: file.newEditable,
      language: file.language,
      theme,
      code,
      collapse: !file.plain,
      lsp: file.newText !== null,
      embedded,
      callbacks,
    });
    editor.current = handle;
    if (handle === null) return;
    if (file.newText !== null) {
      lastSync.current = sync({ workspaceId, path: file.path, text: file.newText })
        .then((answer) => setLspMessage(answer.available ? null : answer.message))
        .catch(() => setLspMessage(null));
    }
    return () => {
      editor.current = null;
      if (handle.isDirty()) {
        // The view is going (another file, another layout); keep the edit by writing it, as Paseo's own editors do.
        const text = handle.getText();
        write({ workspaceId, path: file.path, text, expectedMtimeMs: mtime.current, force: false })
          .then((result) => {
            if (result.status === "conflict") {
              console.warn(`[debrief] unsaved edits to ${file.path} conflicted on disk`);
              return;
            }
            setDirty(false);
            contents.set(cacheAt, { ...file, newText: text, mtimeMs: result.mtimeMs }, contentsGeneration(workspaceId));
          })
          .catch((cause: unknown) => console.warn(`[debrief] unsaved edits to ${file.path} were not written:`, cause));
      }
      handle.destroy();
      if (file.newText !== null) sync({ workspaceId, path: file.path, text: null }).catch(() => undefined);
    };
    // `callbacks` is a ref and `current` is read on mount only, by design.
  }, [web, mountKey, theme, editorLayout, workspaceId, embedded]);

  useEffect(() => {
    editor.current?.setComments(newSide, oldSide);
  }, [newSide, oldSide, mountKey]);

  const narration = useMemo(
    () => ({
      newSide: annotationsOnSide(story?.annotations ?? [], "new"),
      oldSide: annotationsOnSide(story?.annotations ?? [], "old"),
    }),
    [story],
  );
  const focus = story?.focus ?? null;
  useEffect(() => {
    editor.current?.setStory(narration.newSide, narration.oldSide, focus);
  }, [narration, focus, mountKey]);

  const targetShown = useRef(onTargetShown);
  targetShown.current = onTargetShown;
  useEffect(() => {
    if (target === null || editor.current === null) return;
    editor.current.goTo({ line: target.line, character: target.character });
    targetShown.current?.();
  }, [target, mountKey]);

  useEffect(() => {
    if (!web || !lspEnabled) return;
    let inFlight = false;
    const poll = () => {
      if (inFlight || editor.current === null) return;
      inFlight = true;
      diagnose({ workspaceId, path })
        .then((answer) => editor.current?.setDiagnostics(answer.diagnostics))
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    poll();
    const timer = setInterval(poll, DIAGNOSTICS_MS);
    return () => clearInterval(timer);
  }, [web, lspEnabled, diagnose, workspaceId, path, mountKey]);

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      root: embedded ? { backgroundColor: colors.surface0 } : { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      path: { flex: 1, color: colors.foreground, fontFamily: MONOSPACE, fontSize: 12 },
      banner: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: colors.statusWarning,
      },
      bannerText: { flex: 1, color: colors.foreground, fontSize: 12 },
      muted: { color: colors.foregroundMuted, fontSize: 12, paddingHorizontal: 12, paddingVertical: 4 },
      error: { color: colors.statusDanger, fontSize: 12, paddingHorizontal: 12, paddingVertical: 6 },
      above: embedded
        ? { borderBottomWidth: 1, borderBottomColor: colors.border }
        : { maxHeight: "40%" as const, borderBottomWidth: 1, borderBottomColor: colors.border },
      aboveContent: { padding: 10, gap: 8 },
      sectionTitle: { color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      editor: embedded ? { minHeight: 24 } : { flex: 1, minHeight: 0 },
      placeholder: { height: placeholderHeight ?? 80 },
      message: { color: colors.foregroundMuted, padding: 16 },
    }),
    [colors, embedded, placeholderHeight],
  );

  const oldInEditor = mode !== null && web && editorShowsOldThreads(mode);
  const listedOld = mode !== null && web && !oldInEditor ? oldSide : [];
  const listedNarration = mode !== null && web && !oldInEditor ? narration.oldSide : [];
  const hasAbove = fileComposer || fileThreads.length > 0 || listedOld.length > 0 || listedNarration.length > 0;

  let body;
  if (error !== null && loaded === null) body = <Text style={styles.error}>{error}</Text>;
  else if (loaded === null) body = embedded ? <View style={styles.placeholder} /> : <Loading />;
  else if (loaded.binary) body = <Text style={styles.message}>Binary file; nothing to show.</Text>;
  else if (loaded.tooLarge) body = <Text style={styles.message}>This file is too large to open in the editor.</Text>;
  else if (web) body = <View ref={host} style={styles.editor} />;
  else
    body = (
      <NativeDiff
        oldText={loaded.oldText}
        newText={loaded.newText}
        plain={loaded.plain}
        comments={[...newSide, ...oldSide]}
        theme={theme}
        actions={actions}
        onCreate={(input) => onCreate({ scope: "line", path, ...input })}
        annotations={story?.annotations ?? NO_ANNOTATIONS}
        focus={focus}
        embedded={embedded}
      />
    );

  return (
    <View style={styles.root}>
      {embedded ? null : (
        <View style={styles.bar}>
          <Text style={styles.path} numberOfLines={1}>
            {path}
          </Text>
          {loaded !== null && web && loaded.newEditable ? <Text style={styles.muted}>editable</Text> : null}
          <Button label="Comment on file" icon="MessageSquarePlus" theme={theme} onPress={() => setFileComposer(true)} />
        </View>
      )}
      {banner?.kind === "disk" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>File changed on disk. Your edits are unsaved.</Text>
          <Button label="Reload" theme={theme} onPress={() => apply(banner.next)} />
          <Button label="Keep mine" tone="quiet" theme={theme} onPress={() => setBanner(null)} />
        </View>
      ) : null}
      {banner?.kind === "conflict" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>The file changed on disk since it was opened.</Text>
          <Button
            label="Reload"
            theme={theme}
            onPress={() => {
              fetchLoaded()
                .then(apply)
                .catch((cause: unknown) => setError(messageOf(cause)));
            }}
          />
          <Button
            label="Overwrite"
            tone="danger"
            theme={theme}
            onPress={() => {
              const text = editor.current?.getText();
              if (text !== undefined) save(text, true).catch((cause: unknown) => setError(messageOf(cause)));
            }}
          />
        </View>
      ) : null}
      {error !== null && loaded !== null ? <Text style={styles.error}>{error}</Text> : null}
      {lspMessage !== null && web ? <Text style={styles.muted}>{lspMessage}</Text> : null}
      {hasAbove ? (
        <AboveBox embedded={embedded} style={styles.above} contentStyle={styles.aboveContent}>
          {fileComposer ? (
            <Composer
              theme={theme}
              placeholder="Comment on this file"
              submitLabel="Comment"
              autoFocus
              onSubmit={async (text) => {
                await onCreate({ scope: "file", path, body: text });
                setFileComposer(false);
              }}
              onCancel={() => setFileComposer(false)}
            />
          ) : null}
          {fileThreads.map((comment) => (
            <ThreadView key={comment.id} comment={comment} theme={theme} actions={actions} showRange={false} />
          ))}
          {listedOld.length > 0 || listedNarration.length > 0 ? (
            <Text style={styles.sectionTitle}>ON REMOVED LINES</Text>
          ) : null}
          {listedNarration.map((annotation) => (
            <NarrationBlock key={annotation.id} annotation={annotation} theme={theme} showLine />
          ))}
          {listedOld.map((comment) => (
            <ThreadView key={comment.id} comment={comment} theme={theme} actions={actions} />
          ))}
        </AboveBox>
      ) : null}
      {body}
    </View>
  );
}


/** The file's own threads above the editor: scrolled on its own in the single-file view, part of the section in the continuous one. */
function AboveBox({
  embedded,
  style,
  contentStyle,
  children,
}: {
  embedded: boolean;
  style: object;
  contentStyle: object;
  children: ReactNode;
}) {
  if (embedded) return <View style={[style, contentStyle]}>{children}</View>;
  return (
    <ScrollView style={style} contentContainerStyle={contentStyle}>
      {children}
    </ScrollView>
  );
}
