/**
 * Every crossing between the panel and the daemon. Wire names are `debrief.*`
 * and must match `/^[a-z][a-z0-9._-]*$/`.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { CompareSchema } from "./compare";
import {
  AgentChoiceSchema,
  CommentSchema,
  DiffFileSchema,
  ReviewSchema,
  ReviewStateSchema,
  ScopeSchema,
  SideSchema,
} from "./review";

/** Larger files are listed but not opened in the editor. */
export const MAX_EDITOR_BYTES = 2 * 1024 * 1024;

const workspace = { workspaceId: z.string().min(1) };

export const loadReview = defineRpc({
  name: "debrief.review.load",
  input: z.object({
    ...workspace,
    scope: ScopeSchema.default("all"),
    /** The explicit "from vs to" pair; wins over `scope` when present. */
    compare: CompareSchema.optional(),
  }),
  output: z.object({
    cwd: z.string(),
    branch: z.string().nullable(),
    /** What the old side is: a ref name and the commit it resolved to; null when there is no git repo. */
    base: z.object({ ref: z.string(), sha: z.string() }).nullable(),
    files: z.array(DiffFileSchema),
    review: ReviewSchema,
    agents: z.array(AgentChoiceSchema),
    /** The agent comments go to right now, after applying the default rule; null when none exists yet. */
    targetAgentId: z.string().nullable(),
    /** Whether `daemon.mcp.injectIntoAgents` is on; without it agents cannot see Debrief's tools. */
    agentToolsEnabled: z.boolean(),
    /** Error text when the directory is not a git repository or git failed. */
    error: z.string().nullable(),
    /** The repository's default branch (`main`), for labelling "vs main"; null outside git. */
    defaultBranch: z.string().nullable().optional(),
    /** The branch's remote branch (`origin/<branch>`), for labelling "vs origin/<branch>"; null when it has none. */
    upstream: z.string().nullable().optional(),
    /** The compare the diff was made with: `compare` from the input, else the scope's. */
    compare: CompareSchema.optional(),
    /** Each side resolved: "main @ b990f96", "origin/feature @ 1a2b3c4", "HEAD @ 1a2b3c4", "staged", "working tree". */
    fromLabel: z.string().optional(),
    toLabel: z.string().optional(),
    /** Whether the new side is the work tree, so files can be edited. */
    toWorktree: z.boolean().optional(),
  }),
});

/** Cheap: what the panel polls to know when to reload. */
export const pollReview = defineRpc({
  name: "debrief.review.poll",
  input: z.object({
    ...workspace,
    scope: ScopeSchema.default("all"),
    /** The explicit "from vs to" pair; wins over `scope` when present. */
    compare: CompareSchema.optional(),
  }),
  output: z.object({
    /** Changes whenever the review document or the work tree's diff changes. */
    fingerprint: z.string(),
  }),
});

export const fileContents = defineRpc({
  name: "debrief.file.contents",
  input: z.object({
    ...workspace,
    scope: ScopeSchema.default("all"),
    /** The explicit "from vs to" pair; wins over `scope` when present. */
    compare: CompareSchema.optional(),
    path: z.string().min(1),
  }),
  output: z.object({
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string().nullable(),
    /** The new side is the work tree and can be saved. */
    newEditable: z.boolean(),
    /** The work-tree file's mtime, for conflict detection on save; null when it does not exist. */
    mtimeMs: z.number().nullable(),
    language: z.string(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
  }),
});

/** Any file, for go-to-definition targets outside the diff. Inside the workspace it is editable. */
export const readFile = defineRpc({
  name: "debrief.file.read",
  input: z.object({ ...workspace, path: z.string().min(1) }),
  output: z.object({
    /** Workspace-relative when inside the workspace, absolute otherwise. */
    path: z.string(),
    absolutePath: z.string(),
    text: z.string().nullable(),
    editable: z.boolean(),
    mtimeMs: z.number().nullable(),
    language: z.string(),
    binary: z.boolean(),
    tooLarge: z.boolean(),
  }),
});

export const writeFile = defineRpc({
  name: "debrief.file.write",
  input: z.object({
    ...workspace,
    path: z.string().min(1),
    text: z.string(),
    /** The mtime the editor loaded; a different one on disk is a conflict unless `force`. */
    expectedMtimeMs: z.number().nullable(),
    force: z.boolean().default(false),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), mtimeMs: z.number() }),
    z.object({ status: z.literal("conflict"), mtimeMs: z.number().nullable() }),
  ]),
});

export const createComment = defineRpc({
  name: "debrief.comment.create",
  input: z.object({
    ...workspace,
    scope: z.enum(["line", "file", "review"]),
    path: z.string().optional(),
    side: SideSchema.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    quote: z.string().optional(),
    body: z.string().min(1),
    /**
     * The scope the panel showed when the lines were picked. Line numbers are
     * read on that scope's side (HEAD for branch, the index for staged, the
     * base, HEAD or the index for the old side) and stored moved onto the
     * work tree for the new side. Absent means `all`.
     */
    diffScope: ScopeSchema.optional(),
    /** The compare the panel showed; wins over `diffScope` when present. */
    diffCompare: CompareSchema.optional(),
  }),
  output: CommentSchema,
});

export const replyToComment = defineRpc({
  name: "debrief.comment.reply",
  input: z.object({ ...workspace, commentId: z.string(), body: z.string().min(1) }),
  output: CommentSchema,
});

export const editComment = defineRpc({
  name: "debrief.comment.edit",
  input: z.object({
    ...workspace,
    commentId: z.string(),
    /** A reply's id to edit that reply instead of the comment. */
    replyId: z.string().optional(),
    body: z.string().min(1),
  }),
  output: CommentSchema,
});

export const deleteComment = defineRpc({
  name: "debrief.comment.delete",
  input: z.object({ ...workspace, commentId: z.string(), replyId: z.string().optional() }),
  output: z.object({ ok: z.literal(true) }),
});

export const resolveComment = defineRpc({
  name: "debrief.comment.resolve",
  input: z.object({ ...workspace, commentId: z.string(), resolved: z.boolean() }),
  output: CommentSchema,
});

export const approveReview = defineRpc({
  name: "debrief.review.approve",
  input: z.object({ ...workspace, note: z.string().optional() }),
  output: z.object({ ok: z.literal(true) }),
});

export const setReviewAgent = defineRpc({
  name: "debrief.review.set-agent",
  input: z.object({ ...workspace, agentId: z.string().nullable() }),
  output: z.object({ ok: z.literal(true) }),
});

export const setReviewBase = defineRpc({
  name: "debrief.review.set-base",
  input: z.object({ ...workspace, baseRef: z.string().nullable() }),
  output: z.object({ ok: z.literal(true) }),
});

/**
 * Marks one file reviewed (or not) under a compare. `fingerprint` is the one
 * `debrief.review.load` gave the file, so a file that changed since the panel
 * last loaded still shows as changed; without it the daemon reads the diff.
 */
export const setReviewed = defineRpc({
  name: "debrief.review.set-reviewed",
  input: z.object({
    ...workspace,
    compare: CompareSchema,
    path: z.string().min(1),
    reviewed: z.boolean(),
    fingerprint: z.string().optional(),
  }),
  output: z.object({ ok: z.literal(true), reviewState: ReviewStateSchema.nullable() }),
});

/** Language intelligence. Positions are LSP's: 0-based line, UTF-16 character. */
const PositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const RangeSchema = z.object({ start: PositionSchema, end: PositionSchema });
export const LocationSchema = z.object({
  /** Workspace-relative when inside the workspace, absolute otherwise. */
  path: z.string(),
  insideWorkspace: z.boolean(),
  range: RangeSchema,
});
export type Location = z.infer<typeof LocationSchema>;

/** Keeps the language server's copy of a document in step with the editor. */
export const lspSync = defineRpc({
  name: "debrief.lsp.sync",
  input: z.object({
    ...workspace,
    path: z.string().min(1),
    /** The full text; sent on open and, debounced, on change. Null closes the document. */
    text: z.string().nullable(),
  }),
  output: z.object({ language: z.string().nullable(), available: z.boolean(), message: z.string().nullable() }),
});

export const lspDefinition = defineRpc({
  name: "debrief.lsp.definition",
  input: z.object({
    ...workspace,
    path: z.string().min(1),
    position: PositionSchema,
    kind: z.enum(["definition", "typeDefinition", "implementation", "references"]).default("definition"),
  }),
  output: z.object({ locations: z.array(LocationSchema), message: z.string().nullable() }),
});

export const lspHover = defineRpc({
  name: "debrief.lsp.hover",
  input: z.object({ ...workspace, path: z.string().min(1), position: PositionSchema }),
  output: z.object({ markdown: z.string().nullable(), range: RangeSchema.nullable() }),
});

export const CompletionItemSchema = z.object({
  label: z.string(),
  detail: z.string().nullable(),
  /** LSP's CompletionItemKind number. */
  kind: z.number().nullable(),
  insertText: z.string(),
  /** Range to replace, when the server gave one. */
  range: RangeSchema.nullable(),
  sortText: z.string().nullable(),
});
export type CompletionItem = z.infer<typeof CompletionItemSchema>;

export const lspCompletion = defineRpc({
  name: "debrief.lsp.completion",
  input: z.object({ ...workspace, path: z.string().min(1), position: PositionSchema }),
  output: z.object({ items: z.array(CompletionItemSchema), isIncomplete: z.boolean() }),
});

export const DiagnosticSchema = z.object({
  range: RangeSchema,
  severity: z.number().nullable(),
  message: z.string(),
  source: z.string().nullable(),
});

export const lspDiagnostics = defineRpc({
  name: "debrief.lsp.diagnostics",
  input: z.object({ ...workspace, path: z.string().min(1) }),
  output: z.object({ diagnostics: z.array(DiagnosticSchema) }),
});

/**
 * The open-request mailbox. Another plugin (Mission Control) writes
 * `$PASEO_HOME/plugin-data/debrief/open-requests/<nonce>.json` holding
 * `OpenRequest`; the client claims each one and opens the panel.
 */
export const OpenRequestSchema = z.object({
  workspaceId: z.string(),
  serverId: z.string().optional(),
  agentId: z.string().optional(),
  view: z.enum(["diff", "story", "plans"]).default("diff"),
  /** Diff view: the workspace-relative file to show. Story view: the file within the chapter. */
  path: z.string().optional(),
  /** Story view: the chapter to open. */
  chapterId: z.string().optional(),
  /** Plans view: the plan to open. */
  planId: z.string().optional(),
  /** Diff view: the new-side line in `path` to scroll to (1-based). */
  line: z.number().int().positive().optional(),
  createdAt: z.string().optional(),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export const claimOpenRequests = defineRpc({
  name: "debrief.open.claim",
  input: z.object({}),
  output: z.object({ requests: z.array(OpenRequestSchema) }),
});
