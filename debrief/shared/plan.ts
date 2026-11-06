/**
 * Plan review: Plannotator's annotation mode.
 *
 * A plan arrives from Claude's ExitPlanMode permission request, from the
 * `debrief_submit_plan` agent tool, or from a Markdown file opened with
 * "Open with...". Every submission of the same plan is a new version; the
 * reviewer annotates it and either approves or sends feedback, which leaves
 * in Plannotator's export format. Plan feedback is the one place Debrief
 * batches: the agent is waiting on the verdict.
 *
 * Stored by the daemon under `plugin-data/debrief/plans/<workspaceId>/<planId>/`.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { AuthorSchema, ReplySchema } from "./review";

export const PlanAnnotationTypeSchema = z.enum(["deletion", "comment", "global"]);
export type PlanAnnotationType = z.infer<typeof PlanAnnotationTypeSchema>;

export const PlanAnnotationSchema = z.object({
  id: z.string(),
  type: PlanAnnotationTypeSchema,
  /** The block the annotation sits in; absent for a global comment. */
  blockId: z.string().optional(),
  /** Source lines of the block, 1-based, for the export. */
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  /** Character offsets inside the block's source text, when a span was selected. */
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  /** The selected text, or the whole block's text for a block annotation. Restores the anchor across versions. */
  originalText: z.string().default(""),
  /** Comment text; empty for a bare deletion. */
  body: z.string().default(""),
  /** Quick label ids applied to this annotation. */
  labels: z.array(z.string()).default([]),
  /** Made in the diff view between versions. */
  inDiff: z.boolean().default(false),
  author: AuthorSchema,
  createdAt: z.string(),
  replies: z.array(ReplySchema).default([]),
  /** Already sent in a feedback round; kept for history, not re-sent. */
  sentInVersion: z.number().int().positive().optional(),
  /** The version the annotation was made on; set by the daemon. */
  version: z.number().int().positive().optional(),
});
export type PlanAnnotation = z.infer<typeof PlanAnnotationSchema>;

export const PlanSourceSchema = z.discriminatedUnion("kind", [
  /** Claude's ExitPlanMode; answered through respondToPermission. */
  z.object({ kind: z.literal("exit-plan-mode"), agentId: z.string(), permissionId: z.string().nullable() }),
  /** The debrief_submit_plan tool; answered with a note. */
  z.object({ kind: z.literal("tool"), agentId: z.string() }),
  /** A Markdown file in the workspace; feedback goes to the review's agent. */
  z.object({ kind: z.literal("file"), path: z.string() }),
]);
export type PlanSource = z.infer<typeof PlanSourceSchema>;

export const PlanStatusSchema = z.enum(["pending", "approved", "changes-requested"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  source: PlanSourceSchema,
  status: PlanStatusSchema,
  versions: z.number().int().positive(),
  updatedAt: z.string(),
  /** Unsent annotations on the latest version. */
  drafts: z.number().int().nonnegative(),
  /**
   * The ExitPlanMode request was answered outside Debrief (Paseo's own
   * approve control, or the agent moved on), so there is no permission left
   * to answer; `status` then says how it was answered, when that is known.
   */
  answeredElsewhere: z.boolean().optional(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const PlanBlockSchema = z.object({
  id: z.string(),
  /** heading, paragraph, list-item, code, quote, table, rule, html */
  kind: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  /** The block's source lines, verbatim: what the host Markdown draws and what offsets index. */
  text: z.string(),
  /** Heading level (1-6), or list nesting depth (0-based). */
  level: z.number().int().nonnegative().optional(),
});
export type PlanBlock = z.infer<typeof PlanBlockSchema>;

export const listPlans = defineRpc({
  name: "debrief.plan.list",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ plans: z.array(PlanSummarySchema) }),
});

export const loadPlan = defineRpc({
  name: "debrief.plan.load",
  input: z.object({ workspaceId: z.string().min(1), planId: z.string(), version: z.number().int().positive().optional() }),
  output: z.object({
    plan: PlanSummarySchema,
    version: z.number().int().positive(),
    markdown: z.string(),
    blocks: z.array(PlanBlockSchema),
    /** The previous version's markdown, for the diff view; null on the first. */
    previousMarkdown: z.string().nullable(),
    annotations: z.array(PlanAnnotationSchema),
  }),
});

/** Opens (or refreshes) a plan for a Markdown file in the workspace, for the file panel. */
export const openFilePlan = defineRpc({
  name: "debrief.plan.open-file",
  input: z.object({ workspaceId: z.string().min(1), path: z.string().min(1), markdown: z.string() }),
  output: z.object({ planId: z.string() }),
});

export const annotatePlan = defineRpc({
  name: "debrief.plan.annotate",
  input: z.object({
    workspaceId: z.string().min(1),
    planId: z.string(),
    annotation: PlanAnnotationSchema.omit({ id: true, author: true, createdAt: true, replies: true, sentInVersion: true }),
  }),
  output: PlanAnnotationSchema,
});

export const updatePlanAnnotation = defineRpc({
  name: "debrief.plan.annotation-update",
  input: z.object({
    workspaceId: z.string().min(1),
    planId: z.string(),
    annotationId: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    delete: z.boolean().default(false),
    reply: z.string().optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
});

/** Approve or send feedback: the batched decision. */
export const decidePlan = defineRpc({
  name: "debrief.plan.decide",
  input: z.object({
    workspaceId: z.string().min(1),
    planId: z.string(),
    decision: z.enum(["approve", "approve-with-notes", "feedback"]),
  }),
  output: z.object({
    ok: z.literal(true),
    exported: z.string(),
    /** Set when the decision could not go the usual way, e.g. the plan was already answered in Paseo. */
    note: z.string().optional(),
  }),
});

/** Plannotator-style one-tap labels; their tip is sent to the agent, not shown in the plan. */
export const QuickLabelSchema = z.object({ id: z.string(), label: z.string(), tip: z.string() });
export type QuickLabel = z.infer<typeof QuickLabelSchema>;

export const DEFAULT_QUICK_LABELS: QuickLabel[] = [
  { id: "verify", label: "Verify this", tip: "This seems like an assumption. Verify it by reading the actual code before relying on it." },
  { id: "simpler", label: "Simpler", tip: "There is likely a simpler approach. Reconsider before building this." },
  { id: "why", label: "Why?", tip: "Explain the reasoning for this step; it is not obvious from the plan." },
  { id: "scope", label: "Out of scope", tip: "This goes beyond what was asked. Drop it or ask first." },
  { id: "tests", label: "Needs tests", tip: "Say how this will be tested." },
  { id: "unclear", label: "Unclear", tip: "This step is ambiguous. Make it concrete: which files, which functions, what changes." },
];

/** The plan card on the submitting agent's timeline: "Plan ready for review" with an Open button. */
export const PLAN_KIND = "debrief-plan";
export const PLAN_VERSION = 1;

export const PlanRowSchema = z.object({
  workspaceId: z.string(),
  planId: z.string(),
  title: z.string(),
  version: z.number().int().positive(),
  status: PlanStatusSchema,
  answeredElsewhere: z.boolean().default(false),
});
export type PlanRow = z.infer<typeof PlanRowSchema>;

/** One card per plan, upserted in place as versions arrive and decisions land. */
export function planRowId(planId: string): string {
  return `debrief-plan:${planId}`;
}
