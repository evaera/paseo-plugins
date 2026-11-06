import type { PluginClientContext, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";

import { FleetSurface, bindSettingsOpener } from "./client/fleet";
import { AgentPanel, WorkspacePanel } from "./client/panels";
import { FLEET_SCREEN_ID } from "./client/screen";
import { SettingsScreen } from "./client/settings-screen";
import { FleetSidebarItem } from "./client/sidebar";
import { askCoordinator, askCoordinatorCommand, type CoordinatorCommand } from "./shared/fleet";

type CommandRpc = PluginWorkspaceCommandContext["rpc"];

/**
 * Every command goes to Mission Control, never to a crewmate: it owns intake,
 * and the user has one person to talk to. An async function rather than an
 * async arrow — Hermes evaluates an async arrow in an eval'd bundle to
 * `undefined`.
 */
async function tellMissionControl(rpc: CommandRpc, text: string): Promise<void> {
  if (text.trim() === "") throw new Error("Say something to Mission Control: /mc <message>");
  await rpc(askCoordinator, { text });
}

/** Status or Catch up, worded by the daemon from its templates; `args` is what followed the command. */
async function askMissionControl(rpc: CommandRpc, command: CoordinatorCommand, args: string): Promise<void> {
  await rpc(askCoordinatorCommand, { command, args });
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: FLEET_SCREEN_ID, title: "Mission Control", Component: FleetSurface });
  // The board's gear. A surface is given no way to open a settings screen, so
  // the capability is lent to it from here.
  bindSettingsOpener((id) => {
    client.openSettings(id);
  });
  client.addSidebarHeaderItem({ id: FLEET_SCREEN_ID, title: "Mission Control", Component: FleetSidebarItem });
  client.addSettingsScreen({ id: "mission-control", title: "Mission Control", icon: "SatelliteDish", Component: SettingsScreen });

  client.addWorkspacePanel({
    id: "mission-control-workspace",
    title: "Mission Control",
    icon: "SatelliteDish",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addWorkspacePanel({
    id: "mission-control-agent",
    title: "Mission Control",
    icon: "SatelliteDish",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: AgentPanel,
  });

  client.addCommandCenterItem({
    id: "open-fleet",
    title: "Open Mission Control",
    icon: "SatelliteDish",
    keywords: ["mission-control", "Mission Control", "fleet", "crew", "board"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: FLEET_SCREEN_ID });
    },
  });
  client.addCommandCenterItem({
    id: "status",
    title: "Mission Control: status",
    icon: "Compass",
    keywords: ["mission-control", "status", "catch up", "digest"],
    context: "global",
    onSelect({ rpc, openScreen }) {
      openScreen({ screenId: FLEET_SCREEN_ID });
      void rpc(askCoordinatorCommand, { command: "status", args: "" }).catch((caught: unknown) => {
        console.warn("[mission-control] status could not be asked for:", caught);
      });
    },
  });
  client.addCommandCenterItem({
    id: "settings",
    title: "Mission Control settings",
    icon: "Settings",
    keywords: ["mission-control", "Mission Control", "home", "crew model", "agent tools"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("mission-control");
    },
  });

  client.addSlashCommand({
    name: "mc",
    description: "Tell Mission Control",
    argumentHint: "<message>",
    context: "workspace",
    onSubmit({ args, rpc }) {
      return tellMissionControl(rpc, args);
    },
  });
  client.addSlashCommand({
    name: "mc-status",
    description: "Mission Control: where everything stands",
    argumentHint: "[file] [include PRs]",
    context: "workspace",
    onSubmit({ args, rpc, openScreen }) {
      openScreen({ screenId: FLEET_SCREEN_ID });
      return askMissionControl(rpc, "status", args);
    },
  });
  client.addSlashCommand({
    name: "mc-catch-up",
    description: "Mission Control: what happened, and what needs your call",
    argumentHint: "",
    context: "workspace",
    onSubmit({ args, rpc, openScreen }) {
      openScreen({ screenId: FLEET_SCREEN_ID });
      return askMissionControl(rpc, "catch-up", args);
    },
  });

  return () => {
    bindSettingsOpener(null);
  };
}
