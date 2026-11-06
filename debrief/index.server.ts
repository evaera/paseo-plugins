import type { PluginServerContext } from "@getpaseo/plugin/server";

import * as handlers from "./server/handlers";
import { cleanRelative } from "./server/files";
import { PlanReview } from "./server/plan-review";
import * as plans from "./server/plans";
import { markActive, markArchived, pruneArchived } from "./server/prune";
import { loadReviewDoc } from "./server/store";
import * as story from "./server/story";
import { readAnyFile, writeWorkspaceFile } from "./server/files";
import { LspPool } from "./server/lsp/pool";
import { Notes } from "./server/notes";
import { claimOpenRequests as claimRequests } from "./server/open-requests";
import { toCompare } from "./server/compare";
import { compareContents, loadReview as load, pollFingerprint, setFileReviewed } from "./server/review";
import { setReviewAgent as setAgent, setReviewBase as setBase } from "./server/comments";
import { debriefTools, withDebriefTools } from "./server/tools";
import { forgetWorkspace, resolveWorkspace } from "./server/workspace";
import {
  approveReview,
  claimOpenRequests,
  createComment,
  deleteComment,
  editComment,
  fileContents,
  loadReview,
  lspCompletion,
  lspDefinition,
  lspDiagnostics,
  lspHover,
  lspSync,
  pollReview,
  readFile,
  replyToComment,
  resolveComment,
  setReviewAgent,
  setReviewBase,
  setReviewed,
  writeFile,
} from "./shared/rpc";
import { annotatePlan, decidePlan, listPlans, loadPlan, openFilePlan, updatePlanAnnotation } from "./shared/plan";
import { debriefSettings } from "./shared/settings";
import { clearStory, loadStory, requestStory } from "./shared/story";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(debriefSettings);
  const notes = new Notes();
  const deps = { notes, settings };
  const lsp = new LspPool(async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values.languageServers : {};
  });
  const planReview = new PlanReview(notes);
  const tools = debriefTools(notes, planReview);
  const dir = async (paseo: Parameters<typeof resolveWorkspace>[0], workspaceId: string) =>
    (await resolveWorkspace(paseo, workspaceId)).directory;

  server.handle(loadReview, async (input, { paseo }) => {
    void notes.flush(paseo, input.workspaceId).catch(() => 0);
    const loaded = await load(paseo, input);
    void markActive(input.workspaceId).catch(() => {});
    return loaded;
  });
  server.handle(pollReview, async (input, { paseo }) => ({ fingerprint: await pollFingerprint(paseo, input) }));

  server.handle(fileContents, async (input, { paseo }) => {
    return compareContents(input.workspaceId, await dir(paseo, input.workspaceId), toCompare(input.scope, input.compare), input.path);
  });
  server.handle(readFile, async (input, { paseo }) => readAnyFile(await dir(paseo, input.workspaceId), input.path));
  server.handle(writeFile, async (input, { paseo }) => writeWorkspaceFile(await dir(paseo, input.workspaceId), input));

  server.handle(createComment, (input, { paseo }) => handlers.createComment(deps, paseo, input));
  server.handle(replyToComment, (input, { paseo }) => handlers.replyToComment(deps, paseo, input));
  server.handle(editComment, (input, { paseo }) => handlers.editComment(deps, paseo, input));
  server.handle(deleteComment, (input, { paseo }) => handlers.deleteComment(deps, paseo, input));
  server.handle(resolveComment, (input, { paseo }) => handlers.resolveComment(deps, paseo, input));
  server.handle(approveReview, (input, { paseo }) => handlers.approveReview(deps, paseo, input));
  server.handle(setReviewAgent, async ({ workspaceId, agentId }, { paseo }) => {
    await setAgent(workspaceId, await dir(paseo, workspaceId), agentId);
    return { ok: true as const };
  });
  server.handle(setReviewBase, async ({ workspaceId, baseRef }, { paseo }) => {
    await setBase(workspaceId, await dir(paseo, workspaceId), baseRef);
    return { ok: true as const };
  });

  server.handle(setReviewed, async ({ workspaceId, ...input }, { paseo }) =>
    setFileReviewed(workspaceId, await dir(paseo, workspaceId), input),
  );

  server.handle(lspSync, async ({ workspaceId, path, text }, { paseo }) =>
    lsp.sync(workspaceId, await dir(paseo, workspaceId), path, text),
  );
  server.handle(lspDefinition, async ({ workspaceId, path, position, kind }, { paseo }) =>
    lsp.definition(workspaceId, await dir(paseo, workspaceId), path, position, kind),
  );
  server.handle(lspHover, async ({ workspaceId, path, position }, { paseo }) =>
    lsp.hover(workspaceId, await dir(paseo, workspaceId), path, position),
  );
  server.handle(lspCompletion, async ({ workspaceId, path, position }, { paseo }) =>
    lsp.completion(workspaceId, await dir(paseo, workspaceId), path, position),
  );
  server.handle(lspDiagnostics, async ({ workspaceId, path }, { paseo }) =>
    lsp.diagnostics(workspaceId, await dir(paseo, workspaceId), path),
  );

  server.handle(claimOpenRequests, async () => ({ requests: await claimRequests() }));

  server.handle(loadStory, async ({ workspaceId }, { paseo }) => {
    const root = await dir(paseo, workspaceId);
    const { baseRef } = await loadReviewDoc(workspaceId, root);
    return story.loadStory(workspaceId, root, baseRef);
  });
  server.handle(requestStory, async ({ workspaceId, scope, compare, guidance }, { paseo }) => {
    const review = await loadReviewDoc(workspaceId, await dir(paseo, workspaceId));
    const text = story.storyRequestText(toCompare(scope, compare), guidance, await story.hasStory(workspaceId));
    const agentId = await notes.deliverText(paseo, review, text);
    return { ok: true as const, agentId };
  });
  server.handle(clearStory, async ({ workspaceId }) => {
    await story.clearStory(workspaceId);
    return { ok: true as const };
  });

  server.handle(listPlans, async ({ workspaceId }) => ({ plans: await plans.listPlans(workspaceId) }));
  server.handle(loadPlan, async ({ workspaceId, planId, version }) => {
    const loaded = await plans.loadPlan(workspaceId, planId, version);
    const { plan, markdown, blocks, previousMarkdown, annotations } = loaded;
    return { plan, version: loaded.version, markdown, blocks, previousMarkdown, annotations };
  });
  server.handle(openFilePlan, async ({ workspaceId, path, markdown }) => ({
    planId: await planReview.openFile(workspaceId, cleanRelative(path), markdown),
  }));
  server.handle(annotatePlan, async ({ workspaceId, planId, annotation }) =>
    plans.addAnnotation(workspaceId, planId, annotation, await handlers.reviewer(deps)),
  );
  server.handle(updatePlanAnnotation, async ({ workspaceId, planId, ...update }, { paseo }) => {
    const result = await plans.updateAnnotation(workspaceId, planId, update, await handlers.reviewer(deps));
    // After a verdict, a reply goes to the agent at once; before one, it waits with the rest of the drafts.
    if (result.kind === "updated" && result.replyId !== null && result.annotation.sentInVersion !== undefined) {
      void planReview.replied(paseo, workspaceId, planId, result.annotation.id, update.reply ?? "", result.annotation.originalText);
    }
    return { ok: true as const };
  });
  server.handle(decidePlan, (input, { paseo }) => planReview.decide(paseo, input));

  const unhooks = [
    server.before("agent.session_open", ({ request }) => withDebriefTools(request, tools)),
    server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
      notes.permissionRequested(agent.id, request.id);
      await planReview.permissionRequested(paseo, agent, request).catch((error: unknown) => {
        console.error(`[debrief] could not record the plan from ${agent.id}:`, error);
      });
    }),
    server.on("agent.permission_resolved", async ({ agent, requestId, resolution }, { paseo }) => {
      notes.permissionResolved(paseo, agent.id, agent.workspaceId, requestId);
      await planReview.permissionResolved(paseo, agent, requestId, resolution.behavior).catch((error: unknown) => {
        console.error(`[debrief] could not record how ${requestId} was answered:`, error);
      });
    }),
    server.on("agent.archived", ({ agent }) => notes.forgetAgent(agent.id)),
    server.on("agent.closed", ({ agent }) => notes.forgetAgent(agent.id)),
    server.on("workspace.archived", async ({ workspace }) => {
      forgetWorkspace(workspace.id);
      await markArchived(workspace.id, workspace.archivedAt).catch((error: unknown) => {
        console.error(`[debrief] could not record that ${workspace.id} was archived:`, error);
      });
      await lsp.stopWorkspace(workspace.id);
    }),
  ];

  void pruneArchived()
    .then((pruned) => {
      if (pruned.length > 0) console.log(`[debrief] pruned ${pruned.length} workspace(s) archived over 30 days ago`);
    })
    .catch((error: unknown) => console.error("[debrief] could not prune archived workspaces:", error));

  return async () => {
    for (const unhook of unhooks) unhook();
    notes.stop();
    await lsp.stopAll();
  };
}
