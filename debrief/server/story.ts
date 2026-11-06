/**
 * Stories: `reviews/<workspaceId>/story.json`, written by an agent through
 * `debrief_write_story`, read by the panel through `debrief.story.load`.
 *
 * Annotations follow their lines like review comments do, through the same
 * re-anchoring (`server/reanchor.ts`), with their own snapshot file,
 * `story-anchors.json`, so a story and the comments never move each other.
 * Every read-change-write runs in the workspace's `story:` queue.
 */
import { randomBytes } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { compareForScope, compareKey, sameCompare, type Compare } from "../shared/compare";
import { ScopeSchema, type Scope } from "../shared/review";
import { AnnotationSchema, StorySchema, StoryDraftSchema, type Annotation, type Coverage, type Story } from "../shared/story";
import { captureAnchor, computeLineMap, remapPosition, splitLines, type Movable } from "./anchor";
import { cachedCompare, compareDiffArgs, compareSources } from "./compare";
import { cleanRelative, readDiskText, readGitText } from "./files";
import { diffText, headSha, repoRoot } from "./git";
import { prepareMovableAnchor, reanchorMovables, writeSnapshots } from "./reanchor";
import { loadDiff } from "./review";
import { serialized } from "./serialize";
import { readJson, reviewDir, writeAtomic } from "./store";
import { checkCoverage, hunkIndex, hunkKey, scopeFingerprint, shapeDraft, StoryRejected } from "./story-coverage";
import { addedBody, buildPrep, hunkBodies } from "./story-prep";

export const STORY_SNAPSHOTS = "story-anchors.json";

function storyPath(workspaceId: string): string {
  return join(reviewDir(workspaceId), "story.json");
}

async function readStory(workspaceId: string): Promise<Story | null> {
  const path = storyPath(workspaceId);
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    raw = null;
  }
  if (raw === undefined) return null;
  const parsed = StorySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.error(`[debrief] ${path} is not a valid story; setting it aside.`, parsed.error);
  await rename(path, `${path}.invalid-${Date.now()}`).catch(() => {});
  return null;
}

async function saveStory(workspaceId: string, story: Story): Promise<Story> {
  const valid = StorySchema.parse(story);
  await writeAtomic(storyPath(workspaceId), `${JSON.stringify(valid, null, 2)}\n`);
  return valid;
}

function withStory<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  return serialized(`story:${workspaceId}`, task);
}

/** Each annotation as a one-line `Movable`, and a way to copy the moves back. */
function movables(story: Story): { items: Movable[]; apply: () => void } {
  const pairs: Array<{ annotation: Annotation; item: Movable }> = [];
  for (const chapter of story.chapters) {
    for (const file of chapter.files) {
      for (const annotation of file.annotations) {
        const item: Movable = {
          scope: "line",
          path: file.path,
          side: annotation.side,
          startLine: annotation.line,
          endLine: annotation.line,
          anchor: annotation.anchor === "" ? undefined : annotation.anchor,
          drifted: annotation.drifted,
        };
        pairs.push({ annotation, item });
      }
    }
  }
  return {
    items: pairs.map((pair) => pair.item),
    apply: () => {
      for (const { annotation, item } of pairs) {
        annotation.line = item.startLine ?? annotation.line;
        annotation.drifted = item.drifted;
      }
    },
  };
}

function newAnnotationId(taken: Set<string>): string {
  for (;;) {
    const id = `a_${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function annotationIds(story: Pick<Story, "chapters">): Set<string> {
  return new Set(story.chapters.flatMap((chapter) => chapter.files.flatMap((file) => file.annotations.map((annotation) => annotation.id))));
}

// ---- loadStory / clearStory ------------------------------------------------

export async function loadStory(workspaceId: string, root: string, baseRef: string | null): Promise<{ story: Story | null; stale: boolean }> {
  const story = await withStory(workspaceId, async () => {
    const current = await readStory(workspaceId);
    if (current === null) return null;
    const { items, apply } = movables(current);
    if (await reanchorMovables(workspaceId, STORY_SNAPSHOTS, items, root)) {
      apply();
      return saveStory(workspaceId, current);
    }
    return current;
  });
  if (story === null) return { story: null, stale: false };
  const diff = await loadDiff(root, storyCompare(story), baseRef);
  // A diff that cannot be read says nothing about the story; it is not called stale for it.
  const stale = diff.error === null && scopeFingerprint(diff.files) !== story.scopeFingerprint;
  return { story, stale };
}

export async function clearStory(workspaceId: string): Promise<void> {
  await withStory(workspaceId, async () => {
    await rm(storyPath(workspaceId), { force: true });
    await rm(join(reviewDir(workspaceId), STORY_SNAPSHOTS), { force: true });
  });
}

export async function hasStory(workspaceId: string): Promise<boolean> {
  return (await readStory(workspaceId)) !== null;
}

// ---- requestStory ----------------------------------------------------------

export function storyRequestText(compare: Compare, guidance: string | undefined, exists: boolean): string {
  const extra = guidance === undefined || guidance.trim() === "" ? "" : `\n\nThe reviewer adds:\n${guidance.trim()}`;
  const replace = exists ? " A story already exists; pass replace: true to overwrite it." : "";
  const json = JSON.stringify(compare);
  return (
    `Debrief: the reviewer asked you to write a story for this workspace's diff (${compareKey(compare)}): a guided tour that tells them what changed, in the order to read it.\n\n` +
    `Call debrief_story_prep with compare ${json} to get the diff with its hunk ids and the authoring rules, then debrief_write_story with the same compare and the fingerprint the prep gave you.${replace}` +
    extra
  );
}

/** What a story was written against: its compare, or for an older story its scope's. */
export function storyCompare(story: Pick<Story, "scope" | "compare">): Compare {
  return story.compare ?? compareForScope(story.scope);
}

/** The scope a compare is, for the story's required `scope`; `all` when it is none of them. */
function scopeOf(compare: Compare): Scope {
  return ScopeSchema.options.find((scope) => sameCompare(compareForScope(scope), compare)) ?? "all";
}

/**
 * A new-side line the author picked in `compare`'s new side, as a line of the
 * work tree and the anchor text it was picked on. When the new side is HEAD,
 * a ref or the index, the line is carried over the way comments are.
 */
async function placeNewSide(
  root: string,
  shownRev: string | null,
  path: string,
  line: number,
  work: string | null,
): Promise<{ line: number; anchor: string; drifted: boolean }> {
  if (shownRev === null) {
    return { line, anchor: work === null ? "" : (captureAnchor(work, line, line) ?? ""), drifted: false };
  }
  const shown = (await readGitText(root, shownRev, path).catch(() => ({ text: null }))).text;
  const anchor = shown === null ? undefined : captureAnchor(shown, line, line);
  if (shown === null || work === null) return { line, anchor: anchor ?? "", drifted: false };
  const moved = remapPosition({ startLine: line, endLine: line, anchor }, computeLineMap(shown, work), splitLines(work));
  return { line: moved.startLine, anchor: anchor ?? "", drifted: anchor === undefined ? false : moved.drifted };
}

async function storySources(root: string, baseRef: string | null, compare: Compare): Promise<{ old: string | null; new: string | null }> {
  if ((await repoRoot(root)) === null) return { old: null, new: null };
  const resolved = await cachedCompare(root, baseRef, compare).catch(() => null);
  return resolved === null ? { old: null, new: null } : compareSources(resolved);
}

// ---- debrief_story_prep ----------------------------------------------------

export async function storyPrep(workspaceId: string, root: string, baseRef: string | null, compare: Compare) {
  const diff = await loadDiff(root, compare, baseRef);
  if (diff.error !== null) throw new Error(diff.error);
  const args = diff.resolved === null ? null : compareDiffArgs(diff.resolved);
  const bodies = hunkBodies(args === null ? "" : await diffText(root, args));
  for (const file of diff.files) {
    if (file.status !== "untracked" || file.hunks.length === 0) continue;
    const disk = await readDiskText(join(root, file.path)).catch(() => null);
    if (disk?.text != null) bodies.set(file.path, new Map([[0, addedBody(disk.text)]]));
  }
  const fingerprint = scopeFingerprint(diff.files);
  const label = diff.resolved === null ? compareKey(compare) : `${diff.resolved.fromLabel} vs ${diff.resolved.toLabel}`;
  const prep = buildPrep({ compareLabel: label, files: diff.files, bodies, fingerprint });
  return {
    text: prep.text,
    structured: {
      compare,
      fingerprint,
      omittedBodies: prep.omitted,
      hunks: hunkIndex(diff.files),
    },
  };
}

// ---- debrief_write_story ---------------------------------------------------

/** The tool's draft: annotation ids and anchors are the daemon's to fill in. */
const ToolAnnotationSchema = AnnotationSchema.pick({ line: true, side: true, body: true }).extend({ id: z.string().optional() });
export const ToolDraftSchema = StoryDraftSchema.extend({
  chapters: z.array(
    StoryDraftSchema.shape.chapters.element.extend({
      files: z.array(
        StoryDraftSchema.shape.chapters.element.shape.files.element.extend({
          annotations: z.array(ToolAnnotationSchema).default([]),
        }),
      ),
    }),
  ),
});
export type ToolDraft = z.infer<typeof ToolDraftSchema>;

export type WriteResult =
  | { ok: true; story: Story; report: string }
  | { ok: false; coverage: Coverage | null; report: string };

/** Reads one side of a file for anchoring, once per path and side. */
function anchorReader(root: string, oldRev: string | null) {
  const cache = new Map<string, Promise<string | null>>();
  return (path: string, side: "old" | "new") => {
    const key = `${side}\0${path}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      hit =
        side === "new"
          ? readDiskText(join(root, path)).then((disk) => disk.text, () => null)
          : oldRev === null
            ? Promise.resolve(null)
            : readGitText(root, oldRev, path).then((git) => git.text, () => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

export function coverageReport(story: Pick<Story, "chapters" | "coverage">): string {
  const { coverage } = story;
  const lines = [`Story saved: ${story.chapters.length} chapter${story.chapters.length === 1 ? "" : "s"}, ${coverage.placed} of ${coverage.indexed} hunks placed by you.`];
  if (coverage.autoRepaired > 0) {
    lines.push(
      `${coverage.autoRepaired} missing hunk${coverage.autoRepaired === 1 ? " was" : "s were"} moved into support as auto-repaired: ${coverage.missing.map(hunkKey).join(", ")}. Place them in a chapter and write again with replace: true if they belong in the story.`,
    );
  }
  return lines.join("\n");
}

export async function writeStory(
  workspaceId: string,
  root: string,
  baseRef: string | null,
  input: { draft: ToolDraft; compare: Compare; replace: boolean; fingerprint?: string | undefined; agentId: string | null },
): Promise<WriteResult> {
  const diff = await loadDiff(root, input.compare, baseRef);
  if (diff.error !== null) return { ok: false, coverage: null, report: `Could not read the diff: ${diff.error}` };
  const live = scopeFingerprint(diff.files);
  if (input.fingerprint !== undefined && input.fingerprint !== live) {
    return {
      ok: false,
      coverage: null,
      report: "The diff changed since debrief_story_prep. Run debrief_story_prep again and write the story against the new hunks.",
    };
  }

  // Ids first, so shaping sees a complete draft.
  const taken = new Set<string>();
  const draft = {
    ...input.draft,
    chapters: input.draft.chapters.map((chapter) => ({
      ...chapter,
      files: chapter.files.map((file) => ({
        ...file,
        path: cleanRelative(file.path),
        annotations: file.annotations.map((annotation) => {
          const id = annotation.id !== undefined && !taken.has(annotation.id) ? annotation.id : newAnnotationId(taken);
          taken.add(id);
          return { id, line: annotation.line, side: annotation.side, body: annotation.body, anchor: "", drifted: false };
        }),
      })),
    })),
  };

  let shaped: ReturnType<typeof shapeDraft>;
  let result: ReturnType<typeof checkCoverage>;
  try {
    shaped = shapeDraft(draft);
    result = checkCoverage(shaped, hunkIndex(diff.files));
  } catch (error) {
    if (error instanceof StoryRejected) {
      const missing = error.coverage.missing.length > 0 ? `\nMissing: ${error.coverage.missing.map(hunkKey).join(", ")}` : "";
      return { ok: false, coverage: error.coverage, report: `Story rejected: ${error.message}${missing}` };
    }
    throw error;
  }

  const inGit = (await repoRoot(root)) !== null;
  const sources = await storySources(root, baseRef, input.compare);
  const read = anchorReader(root, sources.old);
  for (const chapter of shaped.chapters) {
    for (const file of chapter.files) {
      for (const annotation of file.annotations) {
        if (annotation.side === "old") {
          const text = await read(file.path, "old");
          annotation.anchor = text === null ? "" : (captureAnchor(text, annotation.line, annotation.line) ?? "");
          continue;
        }
        const placed = await placeNewSide(root, sources.new, file.path, annotation.line, await read(file.path, "new"));
        annotation.line = placed.line;
        annotation.anchor = placed.anchor;
        annotation.drifted = placed.drifted;
      }
    }
  }

  return withStory(workspaceId, async () => {
    if (!input.replace && (await readStory(workspaceId)) !== null) {
      return { ok: false, coverage: result.coverage, report: "A story already exists for this workspace. Pass replace: true to overwrite it." };
    }
    const story = await saveStory(workspaceId, {
      version: 1,
      generatedAt: new Date().toISOString(),
      agentId: input.agentId,
      scope: scopeOf(input.compare),
      compare: input.compare,
      baseSha: diff.base?.sha ?? null,
      headSha: inGit ? await headSha(root) : null,
      scopeFingerprint: live,
      prologue: shaped.prologue,
      chapters: shaped.chapters,
      support: result.support,
      coverage: result.coverage,
    });
    // The snapshot the annotations were just anchored against, for every new-side path.
    const snapshots: Record<string, { text: string; mtimeMs: number | null; size: number }> = {};
    const paths = new Set(story.chapters.flatMap((chapter) => chapter.files.filter((file) => file.annotations.some((a) => a.side !== "old")).map((file) => file.path)));
    for (const path of paths) {
      const disk = await readDiskText(join(root, path)).catch(() => null);
      if (disk?.text != null) snapshots[path] = { text: disk.text, mtimeMs: disk.mtimeMs, size: Buffer.byteLength(disk.text) };
    }
    await writeSnapshots(workspaceId, snapshots, STORY_SNAPSHOTS);
    return { ok: true, story, report: coverageReport(story) };
  });
}

// ---- debrief_annotate ------------------------------------------------------

export interface AnnotateInput {
  path: string;
  line: number;
  side?: "old" | "new" | undefined;
  body: string;
  chapterId?: string | undefined;
  annotationId?: string | undefined;
}

export type AnnotateResult = { action: "added" | "edited" | "deleted"; annotationId: string; chapterId: string; anchored: boolean };

export async function annotateStory(workspaceId: string, root: string, baseRef: string | null, input: AnnotateInput): Promise<AnnotateResult> {
  const path = cleanRelative(input.path);
  const side = input.side ?? "new";
  const body = input.body.trim();
  return withStory(workspaceId, async () => {
    const story = await readStory(workspaceId);
    if (story === null) throw new Error("This workspace has no story yet. Write one with debrief_write_story first.");

    // Find what is being edited, or where a new one goes.
    let chapterIndex = -1;
    let fileIndex = -1;
    let annotationIndex = -1;
    if (input.annotationId !== undefined) {
      story.chapters.forEach((chapter, c) =>
        chapter.files.forEach((file, f) =>
          file.annotations.forEach((annotation, a) => {
            if (annotation.id === input.annotationId) [chapterIndex, fileIndex, annotationIndex] = [c, f, a];
          }),
        ),
      );
      if (annotationIndex === -1) throw new Error(`There is no annotation ${input.annotationId} in the story.`);
    } else {
      if (body === "") throw new Error("A new annotation needs a body.");
      chapterIndex =
        input.chapterId === undefined
          ? story.chapters.findIndex((chapter) => chapter.files.some((file) => file.path === path))
          : story.chapters.findIndex((chapter) => chapter.id === input.chapterId);
      if (chapterIndex === -1) {
        throw new Error(
          input.chapterId === undefined
            ? `No chapter shows ${path}; pass chapterId to say which chapter the annotation belongs to.`
            : `There is no chapter ${input.chapterId}. Chapters: ${story.chapters.map((chapter) => chapter.id).join(", ")}.`,
        );
      }
    }
    const chapter = story.chapters[chapterIndex];
    if (chapter === undefined) throw new Error("The chapter disappeared.");

    if (annotationIndex !== -1 && body === "") {
      const file = chapter.files[fileIndex];
      const [removed] = file?.annotations.splice(annotationIndex, 1) ?? [];
      await saveStory(workspaceId, story);
      return { action: "deleted", annotationId: removed?.id ?? input.annotationId ?? "", chapterId: chapter.id, anchored: false };
    }

    // Bring the file's annotations up to date, and the snapshot with them, before placing on its current lines.
    let anchor = "";
    let line = input.line;
    if (side === "new") {
      const { items, apply } = movables(story);
      const text = await prepareMovableAnchor(workspaceId, STORY_SNAPSHOTS, items, root, path);
      apply();
      const placed = await placeNewSide(root, (await storySources(root, baseRef, storyCompare(story))).new, path, input.line, text);
      line = placed.line;
      anchor = placed.anchor;
    } else {
      const oldRev = (await storySources(root, baseRef, storyCompare(story))).old;
      if (oldRev !== null) {
        const text = (await readGitText(root, oldRev, path).catch(() => ({ text: null }))).text;
        anchor = text === null ? "" : (captureAnchor(text, input.line, input.line) ?? "");
      }
    }

    let result: AnnotateResult;
    if (annotationIndex !== -1) {
      const annotation = chapter.files[fileIndex]?.annotations[annotationIndex];
      if (annotation === undefined) throw new Error("The annotation disappeared.");
      // Editing keeps the annotation's file; the path given only matters for a new one.
      if (chapter.files[fileIndex]?.path === path) {
        annotation.line = line;
        annotation.side = side;
        annotation.anchor = anchor;
        annotation.drifted = false;
      }
      annotation.body = body;
      result = { action: "edited", annotationId: annotation.id, chapterId: chapter.id, anchored: annotation.anchor !== "" };
    } else {
      let file = chapter.files.find((entry) => entry.path === path);
      if (file === undefined) {
        // Shown for its annotation only: an empty hunk list places none, so coverage is unchanged.
        file = { path, hunks: [], annotations: [] };
        chapter.files.push(file);
      }
      const id = newAnnotationId(annotationIds(story));
      file.annotations.push({ id, line, side, anchor, body, drifted: false });
      result = { action: "added", annotationId: id, chapterId: chapter.id, anchored: anchor !== "" };
    }
    await saveStory(workspaceId, story);
    return result;
  });
}

