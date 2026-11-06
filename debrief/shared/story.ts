/**
 * Stories: an agent's guided tour of a diff.
 *
 * Chapters, as in Crit, but each chapter lists its files in the author's
 * order, and the author can place prose annotations at lines in the source.
 * Annotations are never written to the file; they are drawn as separate
 * blocks. Hunks are identified by `(path, oldStart)`, with 0 for a new file.
 *
 * Stored by the daemon at `plugin-data/debrief/reviews/<workspaceId>/story.json`.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { CompareSchema } from "./compare";
import { ScopeSchema, SideSchema } from "./review";

export const AnnotationSchema = z.object({
  id: z.string(),
  /** 1-based line on `side`; the annotation is drawn above it. */
  line: z.number().int().positive(),
  side: SideSchema.default("new"),
  /** The text of the annotated line when placed; what re-anchoring searches for. */
  anchor: z.string().default(""),
  body: z.string().min(1),
  drifted: z.boolean().default(false),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const StoryFileSchema = z.object({
  path: z.string(),
  /** Short summary shown above the file. */
  summary: z.string().optional(),
  /** Hunk ids (oldStart) placed in this chapter; omitted means all of the file's hunks. */
  hunks: z.array(z.number().int().nonnegative()).optional(),
  annotations: z.array(AnnotationSchema).default([]),
});
export type StoryFile = z.infer<typeof StoryFileSchema>;

export const ChapterSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  summary: z.string().default(""),
  /** Display order is array order. */
  files: z.array(StoryFileSchema),
});
export type Chapter = z.infer<typeof ChapterSchema>;

export const CoverageSchema = z.object({
  indexed: z.number().int().nonnegative(),
  placed: z.number().int().nonnegative(),
  missing: z.array(z.object({ path: z.string(), oldStart: z.number() })),
  duplicated: z.array(z.object({ path: z.string(), oldStart: z.number() })),
  autoRepaired: z.number().int().nonnegative(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const StorySchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  agentId: z.string().nullable(),
  scope: ScopeSchema,
  /** The compare the story was written against; absent on older stories, which use `scope`'s. */
  compare: CompareSchema.optional(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  /** Hash of the hunk index the story was written against; a mismatch means the diff moved. */
  scopeFingerprint: z.string(),
  prologue: z.object({
    title: z.string(),
    overview: z.string().default(""),
    keyChanges: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
  }),
  chapters: z.array(ChapterSchema),
  /** Hunks that support the change without telling its story (lockfiles, renames, generated code). */
  support: z.array(z.object({ path: z.string(), hunks: z.array(z.number()).optional(), reason: z.string() })),
  coverage: CoverageSchema,
});
export type Story = z.infer<typeof StorySchema>;

/** What an agent sends to write a story; the daemon fills in the rest. */
export const StoryDraftSchema = z.object({
  prologue: StorySchema.shape.prologue,
  chapters: z.array(ChapterSchema.extend({ id: z.string().optional() })),
  support: StorySchema.shape.support.default([]),
});
export type StoryDraft = z.infer<typeof StoryDraftSchema>;

export const loadStory = defineRpc({
  name: "debrief.story.load",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    story: StorySchema.nullable(),
    /** The diff no longer matches the one the story was written against. */
    stale: z.boolean(),
  }),
});

/** Asks the review's agent to write (or rewrite) the story. */
export const requestStory = defineRpc({
  name: "debrief.story.request",
  input: z.object({
    workspaceId: z.string().min(1),
    scope: ScopeSchema.default("all"),
    /** Wins over `scope` when present. */
    compare: CompareSchema.optional(),
    guidance: z.string().optional(),
  }),
  output: z.object({ ok: z.literal(true), agentId: z.string() }),
});

export const clearStory = defineRpc({
  name: "debrief.story.clear",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
