import type { PluginClientContext } from "@getpaseo/plugin/client";

import { startHeaderButtons } from "./client/header-buttons";
import { requestIntent } from "./client/hub";
import { startOpenRequestPoller } from "./client/open-requests";
import { registerOpener } from "./client/openers";
import { ReviewPanel } from "./client/panel";
import { createPlanCard } from "./client/plan-card";
import { PlanFilePanel } from "./client/plan-file-panel";
import { DebriefSettings } from "./client/settings-screen";
import { createThreadCard } from "./client/timeline-card";
import { hideDebriefNotes } from "./client/transform";
import { PLAN_KIND, PLAN_VERSION, PlanRowSchema } from "./shared/plan";
import { THREAD_KIND, THREAD_VERSION, ThreadRowSchema } from "./shared/timeline";

const PANEL_ID = "review";
const ICON = "MessageSquareDiff";
const PLAN_ICON = "MessageSquareText";

export default function contribute(client: PluginClientContext) {
  // A workspace panel is opened by workspace alone; `agentId` in openPanel's options targets agent panels.
  // What the panel should show travels through the hub, since a workspace panel takes no params.
  const openReview = (workspaceId: string) => {
    client.openPanel(PANEL_ID, { workspaceId });
  };
  const openPlan = (workspaceId: string, planId: string) => {
    requestIntent(workspaceId, { view: "plans", planId });
    openReview(workspaceId);
  };

  const cleanups = [
    client.addWorkspacePanel({
      id: PANEL_ID,
      title: "Debrief",
      icon: ICON,
      locations: ["workspace"],
      Component: ReviewPanel,
    }),
    client.addFilePanel({
      id: "plan",
      title: "Debrief",
      icon: PLAN_ICON,
      files: { extensions: ["md", "markdown"] },
      Component: PlanFilePanel,
    }),
    client.addSettingsScreen({
      id: "settings",
      title: "Debrief",
      icon: ICON,
      Component: DebriefSettings,
    }),
    client.addCommandCenterItem({
      id: "open",
      title: "Open Debrief",
      icon: ICON,
      keywords: ["debrief", "review", "diff", "comments", "code review"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addCommandCenterItem({
      id: "story",
      title: "Debrief: read the story",
      icon: "BookOpenText",
      keywords: ["debrief", "story", "chapters", "walkthrough"],
      context: "workspace",
      onSelect({ workspace, openPanel }) {
        requestIntent(workspace.id, { view: "story" });
        openPanel(PANEL_ID);
      },
    }),
    client.addCommandCenterItem({
      id: "plans",
      title: "Debrief: review plans",
      icon: "ClipboardList",
      keywords: ["debrief", "plan", "plans", "plan mode"],
      context: "workspace",
      onSelect({ workspace, openPanel }) {
        requestIntent(workspace.id, { view: "plans" });
        openPanel(PANEL_ID);
      },
    }),
    client.addCommandCenterItem({
      id: "settings",
      title: "Debrief settings",
      icon: "Settings2",
      keywords: ["debrief", "settings", "language server", "lsp"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings("settings");
      },
    }),
    client.addSlashCommand({
      name: "debrief",
      description: "Open Debrief, the review of this workspace's changes",
      argumentHint: "",
      context: "agent",
      onSubmit({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addTimelineRenderer({
      kind: THREAD_KIND,
      version: THREAD_VERSION,
      schema: ThreadRowSchema,
      // Timeline props carry no navigation, so the card is lent the entry's openPanel.
      Component: createThreadCard(openReview),
    }),
    client.addTimelineRenderer({
      kind: PLAN_KIND,
      version: PLAN_VERSION,
      schema: PlanRowSchema,
      Component: createPlanCard(openPlan),
    }),
    client.addTimelineTransformer({
      id: "hide-notes",
      query: { itemType: "tool_call" },
      transform: hideDebriefNotes,
    }),
    startOpenRequestPoller(client, (request) => {
      requestIntent(request.workspaceId, {
        view: request.view,
        ...(request.planId !== undefined ? { planId: request.planId } : {}),
        ...(request.path !== undefined ? { path: request.path } : {}),
        ...(request.chapterId !== undefined ? { chapterId: request.chapterId } : {}),
        ...(request.line !== undefined ? { line: request.line } : {}),
      });
      openReview(request.workspaceId);
    }),
    // Mission Control opens Debrief on a worker's own host through this (contract in client/openers.ts).
    registerOpener(client, (request) => {
      requestIntent(request.workspaceId, {
        view: request.view ?? "diff",
        ...(request.planId !== undefined ? { planId: request.planId } : {}),
        ...(request.path !== undefined ? { path: request.path } : {}),
        ...(request.chapterId !== undefined ? { chapterId: request.chapterId } : {}),
      });
      openReview(request.workspaceId);
    }),
    startHeaderButtons(client, {
      icon: ICON,
      openAt: (workspaceId, intent) => {
        if (intent !== null) requestIntent(workspaceId, intent);
        openReview(workspaceId);
      },
    }),
  ];

  return () => {
    cleanups.forEach((cleanup) => void cleanup());
  };
}
