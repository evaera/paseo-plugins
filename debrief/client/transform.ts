/**
 * Hides Debrief's own notes from the agent's timeline. Paseo 0.14 projects a
 * message sent with `sourceAgentId` into a `tool_call` named `agent_message`
 * carrying `agentMessage.sender.id`; the thread card Debrief appends stands in
 * for it, so the note itself is dropped by returning no items.
 */
import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";

import { DEBRIEF_SENDER_ID } from "../shared/timeline";

type ToolCallTransform = PluginTimelineTransformerContribution<"tool_call">["transform"];

export const AGENT_MESSAGE_TOOL = "agent_message";

export const hideDebriefNotes: ToolCallTransform = ({ item }) => {
  if (item.name !== AGENT_MESSAGE_TOOL) return undefined;
  if (item.agentMessage?.sender.id !== DEBRIEF_SENDER_ID) return undefined;
  return { items: [] };
};
