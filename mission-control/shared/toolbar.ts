import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const text = z.string().trim().min(1);
const button = { label: text, icon: text.optional() };

export const ToolbarActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("run"), ...button, command: text, project: text.optional(),
    terminal: z.enum(["paseo", "floating", "none"]).optional(),
  }),
  z.strictObject({ type: z.literal("prompt"), ...button, prompt: text }),
]);
export type ToolbarAction = z.infer<typeof ToolbarActionSchema>;
export type ToolbarMenu = { type: "menu"; label: string; icon?: string | undefined; items: ToolbarItem[] };
export type ToolbarItem =
  | ToolbarAction
  | ToolbarMenu
  | { type: "group"; label?: string | undefined; icon?: string | undefined; items: ToolbarItem[] };

const item: z.ZodType<ToolbarItem> = z.lazy(() => z.union([
  ToolbarActionSchema,
  z.strictObject({ type: z.literal("menu"), ...button, items: z.array(item).min(1) }),
  z.strictObject({ type: z.literal("group"), label: text.optional(), icon: text.optional(), items: z.array(item).min(1) }),
]));

export const ToolbarSchema = z.strictObject({
  missionControl: z.array(item).default([]),
  workspaces: z.array(item).default([]),
});
export type Toolbar = z.infer<typeof ToolbarSchema>;

export const readWorkspaceToolbar = defineRpc({
  name: "mission-control.toolbar.read",
  input: z.object({}),
  output: z.object({ items: z.array(item) }),
});

export const activateToolbarAction = defineRpc({
  name: "mission-control.toolbar.activate",
  input: z.object({
    action: ToolbarActionSchema,
    workspaceId: z.string().nullable(),
    placement: z.enum(["missionControl", "workspaces"]),
  }),
  output: z.object({ workspaceId: z.string().nullable(), terminalId: z.string().nullable() }),
});

export function toolbarIcon(item: ToolbarItem): string {
  return item.icon ?? (item.type === "run" ? "Terminal" : item.type === "prompt" ? "MessageSquare" : "List");
}
