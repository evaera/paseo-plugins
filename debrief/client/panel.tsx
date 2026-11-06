/**
 * The Debrief workspace panel. A header of review controls, then one of three
 * views, each with a left column and a main area:
 *
 * - **Diff:** the changed files, and the open file (or the review overview).
 * - **Story:** the agent's tour (prologue, chapters, support), and one
 *   chapter's file at a time, cut down to the chapter's hunks.
 * - **Plans:** the workspace's plans, and the plan under review.
 *
 * There is no server push in 0.14, so the panel polls `pollReview` every two
 * seconds while mounted; a changed fingerprint reloads the review (and the
 * story) and bumps `refreshNonce`, which makes the open file re-read itself.
 * Plans are polled on their own, more slowly. What to show can also arrive
 * from outside (a timeline card, the open-request mailbox) through `hub.ts`.
 */
import { type PluginWorkspacePanelProps, useRpc, useSettings, useTabState } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";

import { listPlans, type PlanSummary } from "../shared/plan";
import { type Compare, compareForScope, compareKey } from "../shared/compare";
import type { Comment, DiffFile } from "../shared/review";
import { ScopeSchema } from "../shared/review";
import {
  approveReview,
  createComment,
  deleteComment,
  editComment,
  loadReview,
  type Location,
  pollReview,
  replyToComment,
  resolveComment,
  setReviewAgent,
  setReviewed,
} from "../shared/rpc";
import { debriefSettings } from "../shared/settings";
import { loadStory, requestStory, type Story } from "../shared/story";
import { endpointName, type Side, storedCompare } from "./compare";
import { CompareControl, CompareMenu } from "./compare-picker";
import { CommentsList } from "./comments-list";
import type { CommentFilter } from "./comments-model";
import type { LocationKind } from "./editor/lsp";
import { FileList } from "./file-list";
import { DiffStream, type ScrollRequest, type StreamPosition, type StreamSection } from "./diff-stream";
import { bumpContents, type CreateCommentInput, type FileSource, type FileTarget, FileView, type StoryFileView } from "./file-view";
import { locationLabel, messageOf, openCount, openCountsByPath, reviewLevelComments, visibleComments } from "./format";
import { hasIntent, type PanelView, publishCounts, subscribe, takeIntent } from "./hub";
import { PlanList } from "./plan-list";
import { PlanView } from "./plan-view";
import { MoreMenu } from "./more-menu";
import { Page, usePageStyles } from "./page";
import { type Anchor, measureAnchor, Popover } from "./popover";
import { chapterFocus, parsePlace, placeKey, type StoryPlace, stepSequence, storySequence } from "./story";
import { StoryChapter, StoryPrologue, StorySidebar, StorySupport } from "./story-view";
import { ReviewedPrompt, ReviewProgress, reviewProgress } from "./reviewed";
import { Composer, type ThreadActions, ThreadView } from "./thread";
import { Button, MONOSPACE, Segmented } from "./ui";
import { watchReviewKeys } from "./web";

const POLL_MS = 2000;
const PLANS_POLL_MS = 5000;
const STORY_POLL_MS = 5000;

const TabStateSchema = z.object({
  scope: ScopeSchema,
  path: z.string().nullable(),
  layout: z.enum(["unified", "split"]).nullable(),
  hideResolved: z.boolean().nullable(),
  sidebar: z.boolean(),
  // Added after 0.1's state was persisted; the defaults let an older tab's state validate.
  view: z.enum(["diff", "story", "plans"]).nullable().default(null),
  /** `placeKey` of the story place. */
  place: z.string().nullable().default(null),
  storyPath: z.string().nullable().default(null),
  planId: z.string().nullable().default(null),
  /** `compareKey` of the compare; null falls back to the compare `scope` meant. */
  compare: z.string().nullable().default(null),
  /** With `path`, the file at the top of the continuous diff: how far into its section the view was. */
  offset: z.number().default(0),
  /** Files folded away by their section's chevron. */
  collapsed: z.array(z.string()).default([]),
});
type TabState = z.infer<typeof TabStateSchema>;
const DEFAULT_TAB_STATE: TabState = {
  scope: "all",
  path: null,
  layout: null,
  hideResolved: null,
  sidebar: true,
  view: null,
  place: null,
  storyPath: null,
  planId: null,
  compare: null,
  offset: 0,
  collapsed: [],
};

type Review = z.output<typeof loadReview.output>;

/**
 * Where the main area is. `diff` is the continuous diff, scrolled to `path`
 * (null: wherever it is); `file` is one file outside the diff, opened by
 * navigation, with Back to return.
 */
type Entry =
  | { kind: "overview" }
  | { kind: "diff"; path: string | null; target: FileTarget | null; offset?: number }
  | { kind: "file"; path: string; target: FileTarget | null };

interface Nav {
  stack: Entry[];
  index: number;
}

let targetSeq = 0;

export function ReviewPanel({ workspaceId, theme, layout, tab, navigation }: PluginWorkspacePanelProps) {
  const load = useRpc(loadReview);
  const poll = useRpc(pollReview);
  const create = useRpc(createComment);
  const reply = useRpc(replyToComment);
  const edit = useRpc(editComment);
  const remove = useRpc(deleteComment);
  const resolve = useRpc(resolveComment);
  const approve = useRpc(approveReview);
  const setAgent = useRpc(setReviewAgent);
  const markReviewedRpc = useRpc(setReviewed);
  const fetchStory = useRpc(loadStory);
  const askStory = useRpc(requestStory);
  const fetchPlans = useRpc(listPlans);
  const toast = useToast();
  const settings = useSettings(debriefSettings);
  const [tabState, setTabState] = useTabState(tab, TabStateSchema, DEFAULT_TAB_STATE);

  const defaults = settings.status === "ready" ? settings.values : null;
  const editorLayout = tabState.layout ?? defaults?.layout ?? "split";
  const hideResolved = tabState.hideResolved ?? defaults?.hideResolved ?? false;
  const view: PanelView = tabState.view ?? "diff";

  const [review, setReview] = useState<Review | null>(null);
  const [pendingComments, setPendingComments] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [story, setStory] = useState<{ story: Story | null; stale: boolean } | null>(null);
  const [writingSince, setWritingSince] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [nav, setNav] = useState<Nav>(() => ({
    stack: [{ kind: "diff", path: tabState.path, target: null, offset: tabState.offset }],
    index: 0,
  }));
  // A panel that mounts shows cached contents at once, then reads them again.
  useState(() => bumpContents(workspaceId));
  /** A scroll the continuous diff has yet to make; cleared once it has. */
  const [request, setRequest] = useState<ScrollRequest | null>(null);
  const [storyRequest, setStoryRequest] = useState<ScrollRequest | null>(null);
  /** The file at the top of the continuous diff, and how far into it. */
  const [activePath, setActivePath] = useState<string | null>(tabState.path);
  const position = useRef<StreamPosition | null>(tabState.path !== null ? { path: tabState.path, offset: tabState.offset } : null);
  const [locationList, setLocationList] = useState<{ kind: LocationKind; locations: Location[] } | null>(null);
  const [reviewComposer, setReviewComposer] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(!layout.compact && tabState.sidebar);
  const fingerprint = useRef<string | null>(null);
  const page = usePageStyles(theme);
  const root = useRef<View>(null);
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;

  const updateTab = useCallback(
    (patch: Partial<TabState>) => setTabState({ ...tabStateRef.current, ...patch }),
    [setTabState],
  );

  // The story is read against the compare it was written for.
  const currentStory = story?.story ?? null;
  const tabCompare = useMemo(() => storedCompare(tabState.compare, tabState.scope), [tabState.compare, tabState.scope]);
  const storyCompare = currentStory !== null ? (currentStory.compare ?? compareForScope(currentStory.scope)) : null;
  const shownCompare = view === "story" && storyCompare !== null ? storyCompare : tabCompare;
  // Keyed, so a new object for the same compare does not reload anything.
  const shownKey = compareKey(shownCompare);
  const compare = useMemo<Compare>(() => shownCompare, [shownKey]);

  const reload = useCallback(async () => {
    try {
      const next = await load({ workspaceId, compare });
      setReview(next);
      setLoadError(null);
    } catch (cause) {
      setLoadError(messageOf(cause));
    }
  }, [load, workspaceId, compare]);

  const reloadStory = useCallback(async () => {
    try {
      const next = await fetchStory({ workspaceId });
      setStory(next);
      if (next.story !== null) setWritingSince((since) => (since !== null && next.story !== null && next.story.generatedAt > since ? null : since));
    } catch {
      // The daemon may not answer stories yet (an older server half); the view says there is none.
      setStory((current) => current ?? { story: null, stale: false });
    }
  }, [fetchStory, workspaceId]);

  // Load on mount and scope change; then poll the fingerprint.
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    fingerprint.current = null;
    setReview(null);
    void reload();
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      poll({ workspaceId, compare })
        .then((answer) => {
          if (stopped) return;
          const changed = fingerprint.current !== null && fingerprint.current !== answer.fingerprint;
          fingerprint.current = answer.fingerprint;
          if (changed) {
            void reload();
            void reloadStory();
            bumpContents(workspaceId);
            setRefreshNonce((nonce) => nonce + 1);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [poll, reload, reloadStory, workspaceId, compare]);

  // The story: on mount, and while the view is open (an agent writing one does not move the diff).
  useEffect(() => {
    void reloadStory();
    if (view !== "story") return;
    const timer = setInterval(() => void reloadStory(), STORY_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadStory, view]);

  // Plans: always, for the header count; they are a small file read.
  useEffect(() => {
    let stopped = false;
    const refreshPlans = () => {
      fetchPlans({ workspaceId })
        .then((answer) => {
          if (!stopped) setPlans(answer.plans);
        })
        .catch(() => undefined);
    };
    refreshPlans();
    const timer = setInterval(refreshPlans, PLANS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fetchPlans, workspaceId]);


  const refresh = useCallback(() => {
    void reload();
    void reloadStory();
    bumpContents(workspaceId);
    setRefreshNonce((nonce) => nonce + 1);
  }, [reload, reloadStory, workspaceId]);

  const run = useCallback(
    async (action: Promise<unknown>) => {
      await action;
      await reload();
    },
    [reload],
  );

  // Read through a ref so the actions (and the editor's widgets) don't rebuild on every reload.
  const agentsRef = useRef<Review["agents"]>([]);
  agentsRef.current = review?.agents ?? [];
  const openAgent = navigation?.openAgent;
  const actions: ThreadActions = useMemo(
    () => ({
      agentProvider: (agentId: string) => agentsRef.current.find((agent) => agent.id === agentId)?.provider,
      ...(openAgent !== undefined ? { openAgent: (agentId: string) => openAgent({ agentId }) } : {}),
      reply: (commentId, body) => run(reply({ workspaceId, commentId, body })),
      resolve: (commentId, resolved) => run(resolve({ workspaceId, commentId, resolved })),
      edit: (commentId, replyId, body) =>
        run(edit(replyId === undefined ? { workspaceId, commentId, body } : { workspaceId, commentId, replyId, body })),
      remove: (commentId, replyId) =>
        run(remove(replyId === undefined ? { workspaceId, commentId } : { workspaceId, commentId, replyId })),
    }),
    [run, reply, resolve, edit, remove, workspaceId, openAgent],
  );

  const onCreate = useCallback(
    (input: CreateCommentInput) => {
      if (input.scope === "file") return run(create({ workspaceId, scope: "file", path: input.path, body: input.body }));
      return run(
        create({
          workspaceId,
          scope: "line",
          path: input.path,
          side: input.side,
          startLine: input.startLine,
          endLine: input.endLine,
          ...(input.quote !== undefined ? { quote: input.quote } : {}),
          body: input.body,
          diffCompare: compare,
        }),
      );
    },
    [run, create, workspaceId, compare],
  );

  const entry = nav.stack[nav.index] ?? { kind: "overview" as const };
  const navRef = useRef(nav);
  navRef.current = nav;

  /** Asks the continuous diff to scroll to an entry's place. */
  const aimAt = useCallback((next: Entry) => {
    if (next.kind !== "diff" || next.path === null) return;
    setRequest({
      path: next.path,
      target: next.target,
      ...(next.offset !== undefined ? { offset: next.offset } : {}),
      seq: (targetSeq += 1),
    });
  }, []);

  const go = useCallback(
    (next: Entry) => {
      const current = navRef.current;
      const stack = current.stack.slice(0, current.index + 1);
      // Remember where the continuous diff was, so Back returns there rather than to where it was opened.
      const here = stack[current.index];
      if (here?.kind === "diff" && position.current !== null) {
        stack[current.index] = { kind: "diff", path: position.current.path, target: null, offset: position.current.offset };
      }
      setNav({ stack: [...stack, next], index: stack.length });
      aimAt(next);
      setLocationList(null);
      // Navigation (go to definition, a support file) always lands in the diff view.
      updateTab({ view: "diff", ...(next.kind === "diff" && next.path !== null ? { path: next.path, offset: 0 } : {}) });
      if (layout.compact) setSidebarOpen(false);
    },
    [updateTab, layout.compact, aimAt],
  );
  const step = (delta: number) => {
    const index = Math.min(nav.stack.length - 1, Math.max(0, nav.index + delta));
    if (index === nav.index) return;
    setNav({ ...nav, index });
    const next = nav.stack[index];
    if (next !== undefined) aimAt(next);
    setLocationList(null);
  };

  /** Scrolls the continuous diff to a file (from the list, j and k): no history, unless the diff is not showing. */
  const showFile = useCallback(
    (path: string, target: FileTarget | null = null) => {
      const here = navRef.current.stack[navRef.current.index];
      if (here?.kind !== "diff") {
        go({ kind: "diff", path, target });
        return;
      }
      setActivePath(path);
      aimAt({ kind: "diff", path, target });
      if (layout.compact) setSidebarOpen(false);
    },
    [go, aimAt, layout.compact],
  );

  // What to show, asked for from outside: on mount, and whenever it is asked while mounted.
  useEffect(() => {
    const take = () => {
      const intent = takeIntent(workspaceId);
      if (intent === null) return;
      if (intent.comments === true) setPendingComments(true);
      updateTab({
        view: intent.view,
        ...(intent.planId !== undefined ? { planId: intent.planId } : {}),
        ...(intent.view === "story" && intent.chapterId !== undefined
          ? { place: placeKey({ kind: "chapter", chapterId: intent.chapterId }), storyPath: intent.path ?? null }
          : {}),
      });
      if (intent.view === "diff" && intent.path !== undefined) {
        const target = intent.line !== undefined ? { line: intent.line - 1, character: 0, seq: (targetSeq += 1) } : null;
        go({ kind: "diff", path: intent.path, target });
      }
    };
    // Paseo keeps earlier copies of a workspace screen mounted but hidden; only a copy that is
    // actually on screen takes the intent, or a hidden one would act on it instead.
    // A copy that just mounted may not be laid out yet, so a zero size is retried for a moment.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (attempt = 0) => {
      if (!hasIntent(workspaceId)) return;
      const node = root.current;
      const retry = () => {
        if (attempt < 20) timer = setTimeout(() => apply(attempt + 1), 100);
      };
      if (node === null) return retry();
      node.measureInWindow((_x, _y, width, height) => {
        if (width > 0 && height > 0) take();
        else retry();
      });
    };
    apply();
    const unsubscribe = subscribe(() => apply());
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [workspaceId, updateTab, go]);

  const diffPaths = useMemo(() => new Set(review?.files.map((file) => file.path) ?? []), [review]);

  const openLocation = useCallback(
    (location: Location) => {
      const target: FileTarget = {
        line: location.range.start.line,
        character: location.range.start.character,
        seq: (targetSeq += 1),
      };
      if (view === "diff" && entry.kind === "file" && entry.path === location.path) {
        // The same file: jump in place, replacing the target rather than growing the stack.
        setNav((current) => {
          const stack = [...current.stack];
          stack[current.index] = { ...entry, target };
          return { ...current, stack };
        });
        setLocationList(null);
        return;
      }
      const kind = location.insideWorkspace && diffPaths.has(location.path) ? "diff" : "file";
      go({ kind, path: location.path, target });
    },
    [view, entry, diffPaths, go],
  );

  const onLocations = useCallback(
    (kind: LocationKind, locations: Location[]) => {
      if (locations.length === 0) {
        toast.show(kind === "definition" ? "No definition found" : "No references found");
        return;
      }
      const [only] = locations;
      if (kind === "definition" && locations.length === 1 && only !== undefined) openLocation(only);
      else setLocationList({ kind, locations });
    },
    [toast, openLocation],
  );

  const comments = useMemo(() => visibleComments(review?.review.comments ?? [], hideResolved), [review, hideResolved]);
  const allComments = review?.review.comments ?? [];
  const openCounts = useMemo(() => openCountsByPath(allComments), [allComments]);
  const reviewThreads = useMemo(() => reviewLevelComments(comments), [comments]);
  const totalOpen = openCount(allComments);
  const reviewOpen = openCount(reviewLevelComments(allComments));
  const pendingPlans = plans.filter((plan) => plan.status === "pending").length;

  useEffect(() => {
    if (review !== null) publishCounts(workspaceId, { openComments: totalOpen, pendingPlans });
  }, [review, workspaceId, totalOpen, pendingPlans]);

  // Story navigation.
  const place: StoryPlace = parsePlace(tabState.place, currentStory);
  const placeChapter = place.kind === "chapter" ? currentStory?.chapters.find((chapter) => chapter.id === place.chapterId) : undefined;
  const storyPath =
    placeChapter !== undefined
      ? (placeChapter.files.find((file) => file.path === tabState.storyPath)?.path ?? placeChapter.files[0]?.path ?? null)
      : null;
  const goPlace = useCallback(
    (next: StoryPlace, path?: string) => {
      updateTab({ view: "story", place: placeKey(next), ...(path !== undefined ? { storyPath: path } : {}) });
      // The chapter's files are one continuous list; a file asked for is scrolled to.
      if (path !== undefined) setStoryRequest({ path, target: null, seq: (targetSeq += 1) });
      if (layout.compact) setSidebarOpen(false);
    },
    [updateTab, layout.compact],
  );
  const stepStory = useCallback(
    (direction: 1 | -1) => {
      if (currentStory === null) return;
      const sequence = storySequence(currentStory);
      const index = sequence.findIndex(
        (item) => place.kind === "chapter" && item.chapterId === place.chapterId && item.path === storyPath,
      );
      const next = stepSequence(sequence, index, direction);
      if (next !== null) goPlace({ kind: "chapter", chapterId: next.chapterId }, next.path);
    },
    [currentStory, place, storyPath, goPlace],
  );

  const writeStory = useCallback(() => {
    askStory({ workspaceId, compare: tabCompare })
      .then(() => {
        setWritingSince(currentStory?.generatedAt ?? "");
        toast.show("Asked the agent to write the story", { variant: "success" });
      })
      .catch((cause: unknown) => toast.error(messageOf(cause)));
  }, [askStory, workspaceId, tabCompare, currentStory, toast]);

  // j and k: the next and previous file, in the diff list or the story's reading order.
  const keyHandler = useRef<(key: "j" | "k") => void>(() => undefined);
  keyHandler.current = (key) => {
    const direction = key === "j" ? 1 : -1;
    if (view === "story") {
      stepStory(direction);
      return;
    }
    if (view !== "diff" || review === null) return;
    const paths = review.files.map((file) => file.path);
    const current = entry.kind === "diff" && activePath !== null ? paths.indexOf(activePath) : -1;
    const next = stepSequence(paths, current, direction);
    if (next !== null) showFile(next);
  };
  const hasReview = review !== null;
  useEffect(() => {
    if (!hasReview || layout.platform !== "web") return;
    return watchReviewKeys(root.current, (key) => keyHandler.current(key));
  }, [hasReview, layout.platform]);

  // The header's menus, drawn in one popover over the panel.
  const [menu, setMenu] = useState<{ kind: Side | "more" | "comments"; anchor: Anchor } | null>(null);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>("open");
  const fromAnchor = useRef<View>(null);
  const toAnchor = useRef<View>(null);
  const moreAnchor = useRef<View>(null);
  const commentsAnchor = useRef<View>(null);
  const openMenu = (kind: Side | "more" | "comments", control: { current: View | null }) => {
    if (menu?.kind === kind) {
      setMenu(null);
      return;
    }
    measureAnchor(root, control, (anchor) => {
      setMenu({ kind, anchor: anchor ?? { x: 8, y: 44, width: 0, rootWidth: 600 } });
    });
  };
  // The header button asks for the comments list; open it once the review (and its button) is drawn.
  useEffect(() => {
    if (!pendingComments || review === null) return;
    setPendingComments(false);
    // Not cleared on re-render: clearing the flag above re-renders at once, which would cancel it.
    setTimeout(() => openMenu("comments", commentsAnchor), 50);
  });
  const filePaths = useMemo(() => review?.files.map((file) => file.path) ?? [], [review]);
  const openThread = (comment: Comment) => {
    if (comment.scope === "review" || comment.path === undefined) {
      go({ kind: "overview" });
      return;
    }
    const line = comment.endLine ?? comment.startLine;
    go({
      kind: "diff",
      path: comment.path,
      target: line !== undefined ? { line: line - 1, character: 0, seq: (targetSeq += 1) } : null,
    });
  };

  // The continuous diff's sections: every file in diff order, or the open chapter's in the author's order.
  const diffSections = useMemo<StreamSection[]>(
    () => (review?.files ?? []).map((file) => ({ file, story: null, variant: "diff" })),
    [review],
  );
  const chapterSections = useMemo<StreamSection[]>(() => {
    if (placeChapter === undefined || review === null) return [];
    return placeChapter.files.flatMap((chapterFile) => {
      const file = review.files.find((candidate) => candidate.path === chapterFile.path);
      if (file === undefined) return [];
      return [
        {
          file,
          story: { annotations: chapterFile.annotations, focus: chapterFocus(file, chapterFile.hunks) },
          ...(chapterFile.summary !== undefined && chapterFile.summary !== "" ? { note: chapterFile.summary } : {}),
          variant: `chapter:${placeChapter.id}`,
        },
      ];
    });
  }, [placeChapter, review]);
  const collapsed = useMemo(() => new Set(tabState.collapsed), [tabState.collapsed]);
  const toggleCollapsed = useCallback(
    (path: string) => {
      const current = tabStateRef.current.collapsed;
      updateTab({ collapsed: current.includes(path) ? current.filter((item) => item !== path) : [...current, path] });
    },
    [updateTab],
  );

  // "Reviewed": marking folds the file away, as GitHub does; unmarking opens it again.
  const setCollapsedFor = useCallback(
    (path: string, fold: boolean) => {
      const current = tabStateRef.current.collapsed;
      if (fold === current.includes(path)) return;
      updateTab({ collapsed: fold ? [...current, path] : current.filter((item) => item !== path) });
    },
    [updateTab],
  );
  const [confirmReviewed, setConfirmReviewed] = useState<{ file: DiffFile; open: Comment[] } | null>(null);
  const markReviewed = useCallback(
    async (file: DiffFile, reviewed: boolean, resolveFirst: readonly Comment[] = []) => {
      const path = file.path;
      // Drawn at once; the reload that follows brings the daemon's answer.
      setReview((current) =>
        current === null
          ? current
          : {
              ...current,
              files: current.files.map((entry) => (entry.path === path ? { ...entry, reviewState: reviewed ? "reviewed" : null } : entry)),
            },
      );
      setCollapsedFor(path, reviewed);
      try {
        await Promise.all(resolveFirst.map((comment) => resolve({ workspaceId, commentId: comment.id, resolved: true })));
        await markReviewedRpc({
          workspaceId,
          compare,
          path,
          reviewed,
          ...(reviewed && file.fingerprint !== undefined ? { fingerprint: file.fingerprint } : {}),
        });
      } catch (cause) {
        toast.error(messageOf(cause));
      }
      await reload();
    },
    [setCollapsedFor, resolve, markReviewedRpc, workspaceId, compare, toast, reload],
  );
  const allCommentsRef = useRef<readonly Comment[]>([]);
  allCommentsRef.current = review?.review.comments ?? [];
  const toggleReviewed = useCallback(
    (file: DiffFile) => {
      if (file.reviewState === "reviewed") {
        void markReviewed(file, false);
        return;
      }
      const open = allCommentsRef.current.filter((comment) => !comment.resolved && comment.scope !== "review" && comment.path === file.path);
      if (open.length > 0) setConfirmReviewed({ file, open });
      else void markReviewed(file, true);
    },
    [markReviewed],
  );
  // A reviewed file that changed opens again, so the change is seen; the chevron still folds it after.
  const lastStates = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (review === null) return;
    const key = compareKey(review.compare ?? compare);
    review.files.forEach((file) => {
      const id = `${key}\0${file.path}`;
      const before = lastStates.current.get(id);
      const now = file.reviewState ?? null;
      if (before === "reviewed" && now === "changed") setCollapsedFor(file.path, false);
      lastStates.current.set(id, now);
    });
  }, [review, compare, setCollapsedFor]);

  const onDiffActive = useCallback((path: string) => {
    setActivePath(path);
    if (position.current?.path !== path) position.current = { path, offset: 0 };
  }, []);
  const onDiffPosition = useCallback(
    (next: StreamPosition) => {
      position.current = next;
      const saved = tabStateRef.current;
      if (saved.path !== next.path || saved.offset !== next.offset) updateTab({ path: next.path, offset: next.offset });
    },
    [updateTab],
  );
  const diffDone = useCallback((seq: number) => setRequest((current) => (current?.seq === seq ? null : current)), []);
  const storyDone = useCallback((seq: number) => setStoryRequest((current) => (current?.seq === seq ? null : current)), []);
  const onStoryActive = useCallback(
    (path: string) => {
      if (tabStateRef.current.storyPath !== path) updateTab({ storyPath: path });
    },
    [updateTab],
  );

  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      root: { flex: 1, minHeight: 0, backgroundColor: colors.surface0 },
      header: {
        flexDirection: "row" as const,
        flexWrap: layout.compact ? ("wrap" as const) : ("nowrap" as const),
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
      },
      spacer: { flex: 1 },
      base: { color: colors.foregroundMuted, fontSize: 12, fontFamily: MONOSPACE },
      banner: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: colors.statusWarning,
      },
      bannerText: { color: colors.foreground, fontSize: 12 },
      error: { color: colors.statusDanger, padding: 16 },
      body: { flex: 1, minHeight: 0, flexDirection: "row" as const },
      sidebar: {
        width: layout.compact ? ("100%" as const) : 280,
        borderRightWidth: layout.compact ? 0 : 1,
        borderRightColor: colors.border,
        backgroundColor: colors.surface0,
      },
      main: { flex: 1, minWidth: 0, minHeight: 0 },
      overview: { padding: 16, gap: 10 },
      title: { color: colors.foreground, fontSize: 15, fontWeight: "600" as const },
      muted: { color: colors.foregroundMuted, fontSize: 12 },
      empty: { color: colors.foregroundMuted, fontSize: 13, padding: 16 },
      list: {
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface1,
        maxHeight: 220,
      },
      listRow: { paddingHorizontal: 12, paddingVertical: 6 },
      listText: { color: colors.foreground, fontFamily: MONOSPACE, fontSize: 12 },
      listHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 12,
        paddingTop: 6,
      },
    }),
    [colors, layout.compact],
  );

  if (review === null) {
    return (
      <View style={styles.root}>{loadError !== null ? <Text style={styles.error}>{loadError}</Text> : <Loading />}</View>
    );
  }

  const web = layout.platform === "web";
  const showSidebar = sidebarOpen;
  const showMain = !(layout.compact && sidebarOpen);
  const selectedPath = entry.kind === "diff" ? activePath : entry.kind === "file" ? entry.path : null;
  const defaultBranch = review.defaultBranch ?? null;
  const upstream = review.upstream ?? null;
  const names = { defaultBranch, upstream };
  // The daemon's labels describe the compare it answered; until it answers a new one, name the endpoints.
  const answered = review.compare !== undefined && compareKey(review.compare) === shownKey;
  const fromLabel = (answered ? review.fromLabel : undefined) ?? endpointName(compare.from, names);
  const toLabel = (answered ? review.toLabel : undefined) ?? endpointName(compare.to, names);
  const selectedPlanId = tabState.planId !== null && plans.some((plan) => plan.id === tabState.planId) ? tabState.planId : (plans[0]?.id ?? null);

  const renderFile = (source: FileSource, target: FileTarget | null, storyView: StoryFileView | null) => (
    <FileView
      key={`${view}:${source.kind}:${source.path}`}
      workspaceId={workspaceId}
      compare={compare}
      source={source}
      theme={theme}
      platform={layout.platform}
      tab={tab}
      editorLayout={editorLayout}
      refreshNonce={refreshNonce}
      target={target}
      comments={comments}
      actions={actions}
      onCreate={onCreate}
      onLocations={onLocations}
      story={storyView}
    />
  );

  // Back in the story view, the chapter opens where the reader was, unless that was its first file.
  const restoreStory: StreamPosition | null =
    storyPath !== null && storyPath !== placeChapter?.files[0]?.path ? { path: storyPath, offset: 0 } : null;

  const renderStream = (
    sections: readonly StreamSection[],
    scroll: ScrollRequest | null,
    onActive: (path: string) => void,
    onPosition: ((next: StreamPosition) => void) | undefined,
    initial: StreamPosition | null,
    onDone: (seq: number) => void,
    header?: ReactNode,
    footer?: ReactNode,
  ) => (
    <DiffStream
      key={view === "story" ? `story:${placeChapter?.id ?? ""}` : "diff"}
      workspaceId={workspaceId}
      compare={compare}
      theme={theme}
      platform={layout.platform}
      tab={tab}
      editorLayout={editorLayout}
      refreshNonce={refreshNonce}
      sections={sections}
      comments={comments}
      openCounts={openCounts}
      actions={actions}
      onCreate={onCreate}
      onLocations={onLocations}
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
      onToggleReviewed={toggleReviewed}
      request={scroll}
      initial={initial}
      onRequestDone={onDone}
      onActive={onActive}
      {...(onPosition !== undefined ? { onPosition } : {})}
      {...(header !== undefined ? { header } : {})}
      {...(footer !== undefined ? { footer } : {})}
      empty={view === "story" ? "This chapter has no files in the diff." : "No changes in this scope."}
    />
  );

  let sidebar;
  if (view === "story") {
    sidebar = (
      <StorySidebar
        story={currentStory}
        stale={story?.stale ?? false}
        writing={writingSince !== null}
        place={place}
        path={storyPath}
        openCounts={openCounts}
        theme={theme}
        onPlace={(next) => goPlace(next)}
        onFile={(chapterId, path) => goPlace({ kind: "chapter", chapterId }, path)}
        onWrite={writeStory}
      />
    );
  } else if (view === "plans") {
    sidebar = (
      <PlanList
        plans={plans}
        selectedId={selectedPlanId}
        theme={theme}
        onSelect={(planId) => {
          updateTab({ planId });
          if (layout.compact) setSidebarOpen(false);
        }}
      />
    );
  } else {
    sidebar = (
      <FileList
        files={review.files}
        selectedPath={selectedPath}
        overviewSelected={entry.kind === "overview"}
        openCounts={openCounts}
        reviewOpenCount={reviewOpen}
        theme={theme}
        onSelect={(path) => showFile(path)}
        onOverview={() => go({ kind: "overview" })}
      />
    );
  }

  let main;
  if (view === "story") {
    if (currentStory === null) {
      main = (
        <Text style={styles.empty}>
          {writingSince !== null
            ? "The agent is writing the story. It appears here when it is done."
            : "There is no story for this review yet. Write story asks the review's agent for one."}
        </Text>
      );
    } else if (place.kind === "chapter" && placeChapter !== undefined) {
      main = (
        <StoryChapter
          story={currentStory}
          chapter={placeChapter}
          path={storyPath}
          theme={theme}
          onFile={(path) => goPlace(place, path)}
          onStep={stepStory}
          onPlace={(next) => goPlace(next, next.kind === "chapter" ? currentStory.chapters.find((c) => c.id === next.chapterId)?.files[0]?.path : undefined)}
          renderFiles={(header, footer) =>
            renderStream(chapterSections, storyRequest, onStoryActive, undefined, restoreStory, storyDone, header, footer)
          }
        />
      );
    } else if (place.kind === "support") {
      main = <StorySupport story={currentStory} theme={theme} onOpen={(path) => go({ kind: "diff", path, target: null })} />;
    } else {
      main = (
        <StoryPrologue
          story={currentStory}
          theme={theme}
          onStart={() => {
            const first = currentStory.chapters[0];
            if (first !== undefined) goPlace({ kind: "chapter", chapterId: first.id }, first.files[0]?.path);
          }}
        />
      );
    }
  } else if (view === "plans") {
    main =
      selectedPlanId !== null ? (
        <PlanView
          key={selectedPlanId}
          workspaceId={workspaceId}
          planId={selectedPlanId}
          theme={theme}
          platform={layout.platform}
          compact={layout.compact}
        />
      ) : (
        <Text style={styles.empty}>No plans in this workspace yet.</Text>
      );
  } else if (entry.kind === "overview") {
    main = (
      <Page compact={layout.compact}>
        <View style={page.header}>
          <Text style={page.eyebrow}>REVIEW</Text>
          <Text style={page.title}>{review.branch ?? "Review"}</Text>
          <Text style={page.lead}>
            {`${review.files.length} file${review.files.length === 1 ? "" : "s"} · ${totalOpen} open comment${totalOpen === 1 ? "" : "s"}. ` +
              "Comments go to the agent as soon as they are posted."}
          </Text>
        </View>
        {reviewComposer ? (
          <Composer
            theme={theme}
            placeholder="A comment on the review as a whole"
            submitLabel="Comment"
            autoFocus
            onSubmit={async (body) => {
              await run(create({ workspaceId, scope: "review", body }));
              setReviewComposer(false);
            }}
            onCancel={() => setReviewComposer(false)}
          />
        ) : (
          <View style={{ flexDirection: "row" }}>
            <Button label="Comment on review" icon="MessageSquarePlus" theme={theme} onPress={() => setReviewComposer(true)} />
          </View>
        )}
        {reviewThreads.map((comment) => (
          <ThreadView key={comment.id} comment={comment} theme={theme} actions={actions} showRange={false} />
        ))}
      </Page>
    );
  } else if (entry.kind === "diff") {
    main = renderStream(diffSections, request, onDiffActive, onDiffPosition, position.current, diffDone);
  } else {
    main = renderFile({ kind: "file", path: entry.path }, entry.target, null);
  }

  return (
    <View ref={root} style={styles.root}>
      <View style={styles.header}>
        <Button
          label={showSidebar ? "Hide list" : "List"}
          icon={showSidebar ? "PanelLeftClose" : "PanelLeftOpen"}
          showLabel={layout.compact}
          theme={theme}
          onPress={() => {
            setSidebarOpen(!showSidebar);
            if (!layout.compact) updateTab({ sidebar: !showSidebar });
          }}
        />
        <Segmented
          value={view}
          options={[
            { value: "diff", label: "Diff" },
            { value: "story", label: "Story" },
            { value: "plans", label: pendingPlans > 0 ? `Plans (${pendingPlans})` : "Plans" },
          ]}
          theme={theme}
          onChange={(next) => updateTab({ view: next })}
        />
        {view === "diff" ? (
          <>
            <Button label="Back" icon="ArrowLeft" showLabel={false} disabled={nav.index === 0} theme={theme} onPress={() => step(-1)} />
            <Button
              label="Forward"
              icon="ArrowRight"
              showLabel={false}
              disabled={nav.index >= nav.stack.length - 1}
              theme={theme}
              onPress={() => step(1)}
            />
          </>
        ) : null}
        {view !== "plans" ? (
          view === "story" && storyCompare !== null ? (
            <Text style={styles.base} numberOfLines={1}>
              {`story of ${fromLabel} vs ${toLabel}`}
            </Text>
          ) : (
            <CompareControl
              fromLabel={fromLabel}
              toLabel={toLabel}
              open={menu?.kind === "from" || menu?.kind === "to" ? menu.kind : null}
              fromAnchor={fromAnchor}
              toAnchor={toAnchor}
              theme={theme}
              onOpen={(side) => openMenu(side, side === "from" ? fromAnchor : toAnchor)}
            />
          )
        ) : null}
        <View style={styles.spacer} />
        {view !== "plans" && review.files.length > 0 ? (
          <ReviewProgress {...reviewProgress(review.files)} theme={theme} />
        ) : null}
        {view !== "plans" && web ? (
          <Segmented
            value={editorLayout}
            options={[
              { value: "unified", label: "Unified", icon: "Rows2" },
              { value: "split", label: "Split", icon: "Columns2" },
            ]}
            theme={theme}
            onChange={(next) => updateTab({ layout: next })}
          />
        ) : null}
        {view !== "plans" ? (
          <Button
            label={hideResolved ? "Show resolved" : "Hide resolved"}
            icon={hideResolved ? "EyeOff" : "Eye"}
            showLabel={!layout.compact}
            selected={hideResolved}
            theme={theme}
            onPress={() => updateTab({ hideResolved: !hideResolved })}
          />
        ) : null}
        <Button label="Refresh" icon="RefreshCw" showLabel={false} theme={theme} onPress={refresh} />
        {view !== "plans" ? (
          <View ref={commentsAnchor} collapsable={false}>
            <Button
              label={`${totalOpen} comment${totalOpen === 1 ? "" : "s"}`}
              icon="MessageSquare"
              tone={totalOpen > 0 ? "default" : "quiet"}
              selected={menu?.kind === "comments"}
              theme={theme}
              onPress={() => openMenu("comments", commentsAnchor)}
            />
          </View>
        ) : null}
        {view !== "plans" ? (
          <Button
            label={review.review.approvedAt !== null ? "Approved" : "Approve"}
            icon="CircleCheck"
            tone="accent"
            showLabel={!layout.compact}
            theme={theme}
            onPress={() => {
              run(approve({ workspaceId }))
                .then(() => toast.show("Approved; the agent has been told", { variant: "success" }))
                .catch((cause: unknown) => toast.error(messageOf(cause)));
            }}
          />
        ) : null}
        {view !== "plans" ? (
        <View ref={moreAnchor} collapsable={false}>
          <Button
            label="More"
            icon="Ellipsis"
            showLabel={false}
            selected={menu?.kind === "more"}
            theme={theme}
            onPress={() => openMenu("more", moreAnchor)}
          />
        </View>
        ) : null}
      </View>
      {!review.agentToolsEnabled ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Agents can't reply until Paseo's agent tools are on (daemon.mcp.injectIntoAgents in the daemon's
            config.json). Turn it on, then start or reload the agent; comments still reach it as notes meanwhile.
          </Text>
        </View>
      ) : null}
      {review.error !== null ? <Text style={styles.error}>{review.error}</Text> : null}
      {loadError !== null ? <Text style={styles.error}>{loadError}</Text> : null}
      <View style={styles.body}>
        {showSidebar ? <View style={styles.sidebar}>{sidebar}</View> : null}
        {showMain ? (
          <View style={styles.main}>
            {locationList !== null ? (
              <View style={styles.list}>
                <View style={styles.listHead}>
                  <Text style={styles.muted}>
                    {`${locationList.locations.length} ${locationList.kind === "references" ? "references" : "definitions"}`}
                  </Text>
                  <Button label="Close" tone="quiet" theme={theme} onPress={() => setLocationList(null)} />
                </View>
                <ScrollView>
                  {locationList.locations.map((location, index) => (
                    <Pressable
                      key={`${location.path}:${location.range.start.line}:${location.range.start.character}:${index}`}
                      accessibilityRole="button"
                      style={styles.listRow}
                      onPress={() => openLocation(location)}
                    >
                      <Text style={styles.listText} numberOfLines={1}>
                        {locationLabel(location.path, { startLine: location.range.start.line + 1 })}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
            {main}
          </View>
        ) : null}
      </View>
      <ReviewedPrompt
        path={confirmReviewed?.file.path ?? null}
        open={confirmReviewed?.open.length ?? 0}
        theme={theme}
        onResolve={() => {
          const asked = confirmReviewed;
          setConfirmReviewed(null);
          if (asked !== null) void markReviewed(asked.file, true, asked.open);
        }}
        onKeep={() => {
          const asked = confirmReviewed;
          setConfirmReviewed(null);
          if (asked !== null) void markReviewed(asked.file, true);
        }}
        onCancel={() => setConfirmReviewed(null)}
      />
      {menu !== null ? (
        <Popover
          anchor={menu.anchor}
          align={menu.kind === "from" || menu.kind === "to" ? "left" : "right"}
          width={menu.kind === "comments" ? 440 : menu.kind === "more" ? 300 : 340}
          maxHeight={menu.kind === "comments" ? 520 : 480}
          theme={theme}
          onClose={() => setMenu(null)}
        >
          {menu.kind === "from" || menu.kind === "to" ? (
            <CompareMenu
              side={menu.kind}
              compare={tabCompare}
              names={names}
              theme={theme}
              onPick={(next) => {
                setMenu(null);
                updateTab({ compare: compareKey(next) });
              }}
            />
          ) : menu.kind === "more" ? (
            <MoreMenu
              agents={review.agents}
              selectedAgent={review.review.agentId}
              targetAgent={review.targetAgentId}
              showReviewOptions={view !== "plans"}
              theme={theme}
              onAgent={(agentId) => {
                setMenu(null);
                if (agentId === review.review.agentId) return;
                run(setAgent({ workspaceId, agentId })).catch((cause: unknown) => toast.error(messageOf(cause)));
              }}
            />
          ) : (
            <CommentsList
              agentProvider={actions.agentProvider}
              comments={allComments}
              fileOrder={filePaths}
              filter={commentFilter}
              theme={theme}
              maxHeight={520}
              onFilter={setCommentFilter}
              onOpen={(comment) => {
                setMenu(null);
                openThread(comment);
              }}
            />
          )}
        </Popover>
      ) : null}
    </View>
  );
}
