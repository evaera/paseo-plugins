/**
 * The tools Debrief gives agents, injected through
 * `before("agent.session_open")` for every interactive agent with a
 * workspace. They act on the calling agent's workspace review. An agent's
 * own reply or comment never comes back to it as a note; only its thread
 * card is refreshed.
 */
import { defineAgentTool, type AgentToolDefinition, type PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";

import { CompareSchema } from "../shared/compare";
import { ScopeSchema, type Author, type Comment } from "../shared/review";
import { toCompare } from "./compare";
import * as comments from "./comments";
import type { PaseoApi } from "./host-types";
import type { Notes } from "./notes";
import type { PlanReview } from "./plan-review";
import { replyAsAgent } from "./plans";
import { freshReview } from "./review";
import { loadReviewDoc } from "./store";
import { annotateStory, storyPrep, ToolDraftSchema, writeStory } from "./story";
import { resolveWorkspace } from "./workspace";

interface CallingAgent {
  id: string;
  workspaceId: string | null;
  title: string | null;
  /** The agent's provider ("claude", "codex"); the client shows it as the harness name. */
  provider?: string;
}

function requireWorkspace(agent: CallingAgent): string {
  if (agent.workspaceId === null) throw new Error("This agent is not in a Paseo workspace, so it has no Debrief review.");
  return agent.workspaceId;
}

function agentAuthor(agent: CallingAgent): Author {
  return {
    kind: "agent",
    name: agent.title ?? "Agent",
    agentId: agent.id,
    ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
  };
}

/** A thread as the agent reads it. */
export function threadView(comment: Comment) {
  return {
    commentId: comment.id,
    scope: comment.scope,
    path: comment.path ?? null,
    side: comment.side ?? null,
    startLine: comment.startLine ?? null,
    endLine: comment.endLine ?? null,
    anchor: comment.anchor ?? null,
    quote: comment.quote ?? null,
    body: comment.body,
    author: comment.author,
    resolved: comment.resolved,
    drifted: comment.drifted,
    replies: comment.replies.map((reply) => ({ replyId: reply.id, body: reply.body, author: reply.author, createdAt: reply.createdAt })),
  };
}

async function workspaceRoot(paseo: PaseoApi, workspaceId: string): Promise<string> {
  return (await resolveWorkspace(paseo, workspaceId)).directory;
}

const COMPARE_INPUT = CompareSchema.optional().describe(
  'Which diff, as from vs to; wins over scope. Endpoints: {kind:"main"}, {kind:"upstream"}, {kind:"head"}, {kind:"index"}, {kind:"worktree"} (to only), {kind:"ref", ref}',
);

async function reviewContext(paseo: PaseoApi, agent: CallingAgent) {
  const workspaceId = requireWorkspace(agent);
  const root = await workspaceRoot(paseo, workspaceId);
  const { baseRef } = await loadReviewDoc(workspaceId, root);
  return { workspaceId, root, baseRef };
}

export function debriefTools(notes: Notes, planReview: PlanReview): AgentToolDefinition[] {
  const reply = defineAgentTool({
    name: "debrief_reply",
    title: "Reply to a Debrief comment",
    description:
      "Reply in a Debrief review thread, after acting on the reviewer's comment. Say what you changed, or why you did not. You cannot resolve a thread; the reviewer does.",
    input: z.object({
      commentId: z.string().min(1).describe("The comment id from the Debrief note, like c_ab12cd"),
      body: z.string().min(1).describe("Your reply, in Markdown"),
    }),
    async execute({ commentId, body }, { agent, paseo }) {
      const workspaceId = requireWorkspace(agent);
      const root = await workspaceRoot(paseo, workspaceId);
      const saved = await comments.replyToComment(workspaceId, root, commentId, body, agentAuthor(agent));
      await notes.upsertRow(paseo, saved.review, saved.comment, agent.id);
      return { text: `Replied on ${commentId}.`, structuredContent: { commentId, replyId: saved.replyId } };
    },
  });

  const list = defineAgentTool({
    name: "debrief_list_comments",
    title: "List Debrief review comments",
    description:
      "List the threads of this workspace's Debrief review, with their current line positions (re-anchored to the work tree). drifted means the commented code could not be found any more.",
    input: z.object({
      path: z.string().optional().describe("Only threads on this workspace-relative path"),
      unresolvedOnly: z.boolean().optional().describe("Only threads the reviewer has not resolved"),
    }),
    async execute({ path, unresolvedOnly }, { agent, paseo }) {
      const workspaceId = requireWorkspace(agent);
      const review = await freshReview(workspaceId, await workspaceRoot(paseo, workspaceId));
      const threads = review.comments
        .filter((comment) => path === undefined || comment.path === path)
        .filter((comment) => unresolvedOnly !== true || !comment.resolved)
        .map(threadView);
      const structured = { approvedAt: review.approvedAt, threads };
      return { text: JSON.stringify(structured, null, 2), structuredContent: structured };
    },
  });

  const comment = defineAgentTool({
    name: "debrief_comment",
    title: "File a Debrief comment",
    description:
      "File your own finding in this workspace's Debrief review, on lines of a file. It shows with an agent badge for the reviewer.",
    input: z.object({
      path: z.string().min(1).describe("Workspace-relative file path"),
      startLine: z.number().int().positive().describe("First line, 1-based"),
      endLine: z.number().int().positive().describe("Last line, 1-based, inclusive"),
      side: z.enum(["old", "new"]).optional().describe("new (the work tree, default) or old (the base)"),
      body: z.string().min(1).describe("The finding, in Markdown"),
    }),
    async execute(input, { agent, paseo }) {
      const workspaceId = requireWorkspace(agent);
      const root = await workspaceRoot(paseo, workspaceId);
      const saved = await comments.createComment(workspaceId, root, { scope: "line", ...input }, agentAuthor(agent));
      await notes.upsertRow(paseo, saved.review, saved.comment, agent.id);
      return { text: `Filed ${saved.comment.id}.`, structuredContent: threadView(saved.comment) };
    },
  });

  const storyPrepTool = defineAgentTool({
    name: "debrief_story_prep",
    title: "Prepare a Debrief story",
    description:
      "Start writing a Debrief story: a guided tour of this workspace's diff for the reviewer. Returns the authoring rules and the full diff with every hunk's id, and a fingerprint to pass to debrief_write_story.",
    input: z.object({
      scope: ScopeSchema.optional().describe("Which diff, by name: all (default), branch, staged, unstaged, uncommitted or unpushed"),
      compare: COMPARE_INPUT,
    }),
    async execute({ scope, compare }, { agent, paseo }) {
      const { workspaceId, root, baseRef } = await reviewContext(paseo, agent);
      const prep = await storyPrep(workspaceId, root, baseRef, toCompare(scope, compare));
      return { text: prep.text, structuredContent: prep.structured };
    },
  });

  const writeStoryTool = defineAgentTool({
    name: "debrief_write_story",
    title: "Write a Debrief story",
    description:
      "Save a story for this workspace's diff, after debrief_story_prep. Every hunk must be placed exactly once across chapters and support. Returns the coverage report; a rejected story says what to fix.",
    input: z.object({
      story: ToolDraftSchema.describe("{ prologue: { title, overview, keyChanges[], risks[] }, chapters: [{ title, summary, files: [{ path, summary?, hunks?: number[], annotations?: [{ line, side?, body }] }] }], support: [{ path, hunks?, reason }] }"),
      scope: ScopeSchema.optional().describe("The scope you prepared; all by default"),
      compare: COMPARE_INPUT,
      fingerprint: z.string().optional().describe("The fingerprint debrief_story_prep returned"),
      replace: z.boolean().optional().describe("Required to overwrite an existing story"),
    }),
    async execute(input, { agent, paseo }) {
      const { workspaceId, root, baseRef } = await reviewContext(paseo, agent);
      const result = await writeStory(workspaceId, root, baseRef, {
        draft: input.story,
        compare: toCompare(input.scope, input.compare),
        replace: input.replace === true,
        fingerprint: input.fingerprint,
        agentId: agent.id,
      });
      if (!result.ok) return { text: result.report, structuredContent: { saved: false, coverage: result.coverage }, isError: true };
      return { text: result.report, structuredContent: { saved: true, coverage: result.story.coverage } };
    },
  });

  const annotate = defineAgentTool({
    name: "debrief_annotate",
    title: "Annotate the Debrief story",
    description:
      "Add, edit or delete one annotation in this workspace's Debrief story without rewriting it: a prose note drawn above a line. Pass annotationId to edit one; an empty body deletes it.",
    input: z.object({
      path: z.string().min(1).describe("Workspace-relative file path"),
      line: z.number().int().positive().describe("1-based line the note sits above"),
      side: z.enum(["old", "new"]).optional().describe("new (the work tree, default) or old (the base)"),
      body: z.string().describe("The note, in Markdown; empty deletes the annotation named by annotationId"),
      chapterId: z.string().optional().describe("The chapter to put a new annotation in; defaults to the first chapter showing the file"),
      annotationId: z.string().optional().describe("An existing annotation to edit or delete"),
    }),
    async execute(input, { agent, paseo }) {
      const { workspaceId, root, baseRef } = await reviewContext(paseo, agent);
      const result = await annotateStory(workspaceId, root, baseRef, input);
      const anchored = result.action === "deleted" || result.anchored ? "" : " The line could not be read, so it will not follow edits.";
      return { text: `${result.action[0]?.toUpperCase()}${result.action.slice(1)} ${result.annotationId} in chapter ${result.chapterId}.${anchored}`, structuredContent: result };
    },
  });

  const submitPlan = defineAgentTool({
    name: "debrief_submit_plan",
    title: "Submit a plan for review",
    description:
      "Submit a plan to the reviewer in Debrief before implementing it. Returns at once; the verdict (approved, or feedback to address) arrives later as a Debrief note. Submit the revised plan again after feedback; it becomes the next version.",
    input: z.object({
      title: z.string().describe("A short title for the plan"),
      markdown: z.string().min(1).describe("The whole plan, in Markdown"),
    }),
    async execute(input, { agent, paseo }) {
      const workspaceId = requireWorkspace(agent);
      const submission = await planReview.submitFromTool(paseo, { id: agent.id, workspaceId }, input);
      const what = submission.created ? "Submitted" : submission.changed ? `Submitted version ${submission.version} of` : "Resubmitted (unchanged)";
      return {
        text: `${what} plan ${submission.planId} for review. The verdict arrives as a note from Debrief; wait for it before implementing.`,
        structuredContent: { planId: submission.planId, version: submission.version },
      };
    },
  });

  const planReply = defineAgentTool({
    name: "debrief_plan_reply",
    title: "Reply to a plan annotation",
    description: "Reply to the reviewer's annotation on a plan in Debrief, e.g. to explain a step or say how the next version addresses it.",
    input: z.object({
      planId: z.string().min(1).describe("The plan id from the Debrief note, like p_ab12cd"),
      annotationId: z.string().min(1).describe("The annotation id, like pa_ab12cd"),
      body: z.string().min(1).describe("Your reply, in Markdown"),
    }),
    async execute({ planId, annotationId, body }, { agent }) {
      const workspaceId = requireWorkspace(agent);
      const result = await replyAsAgent(workspaceId, planId, annotationId, body, agentAuthor(agent));
      return { text: `Replied on ${annotationId}.`, structuredContent: { planId, annotationId, replyId: result.kind === "updated" ? result.replyId : null } };
    },
  });

  return [reply, list, comment, storyPrepTool, writeStoryTool, annotate, submitPlan, planReply];
}

/** The `agent.session_open` transform: interactive agents in a workspace get the tools. */
export function withDebriefTools(request: PluginSessionOpenRequest, tools: readonly AgentToolDefinition[]): PluginSessionOpenRequest | undefined {
  if (request.workspaceId === null || request.purpose !== "interactive") return undefined;
  const names = new Set(request.tools.map((tool) => tool.name));
  const missing = tools.filter((tool) => !names.has(tool.name));
  if (missing.length === 0) return undefined;
  return { ...request, tools: [...request.tools, ...missing] };
}
