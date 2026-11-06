import type { PluginServerContext } from "@getpaseo/plugin/server";

import { readMissionControlConfig, resolveHome, updateMissionControlConfig } from "./server/config";
import { nameHomeOnce } from "./server/home-name";
import {
  UserSteers,
  type CrewTarget,
  exitCrew,
  interruptCrew,
  registerSteerRelay,
  relayText,
  relaunchCrew,
  steerCrew,
} from "./server/crew";
import { registerCrewSeen } from "./server/crew-seen";
import { type CrewLocations, ReportCache, loadFleet, namedCrew, readAgentTools, resolveCoordinator } from "./server/fleet";
import { findFiles, listDirectory, readTextFile, requireHome, writeTextFile } from "./server/files";
import { CHARTER_FILE, NEW_CHARTER_FILE, acknowledgeCharter, writeNewCharter } from "./server/charter-file";
import { isHomeReady, prepareHome, readBacklog, removeSuggestion } from "./server/home";
import { writeBoardOrder } from "./server/board-order";
import { readNotes, writeNotes } from "./server/notes";
import { renameTask } from "./server/rename";
import { requestDebriefOpen } from "./server/debrief";
import { HostClients } from "./server/hosts";
import { sendWithoutInterrupting } from "./server/send";
import type { PaseoApi } from "./server/host-types";
import {
  adoptCoordinator,
  askCoordinator,
  commandText,
  compactCoordinator,
  launchCoordinator,
  listCandidates,
  markCoordinatorSeen,
  releaseCoordinator,
  restartCoordinator,
} from "./server/coordinator";
import {
  acknowledgeCharter as acknowledgeCharterRpc,
  adoptCoordinator as adoptCoordinatorRpc,
  askCoordinator as askCoordinatorRpc,
  askCoordinatorCommand as askCoordinatorCommandRpc,
  compactCoordinator as compactCoordinatorRpc,
  compareCharter as compareCharterRpc,
  enableAgentTools,
  exitCrew as exitCrewRpc,
  interruptCrew as interruptCrewRpc,
  launchCoordinator as launchCoordinatorRpc,
  listCandidates as listCandidatesRpc,
  loadFleet as loadFleetRpc,
  markCoordinatorSeen as markCoordinatorSeenRpc,
  readConfig,
  relaunchCrew as relaunchCrewRpc,
  releaseCoordinator as releaseCoordinatorRpc,
  removeSuggestion as removeSuggestionRpc,
  saveBoardOrder,
  readTaskNotes,
  writeTaskNotes,
  renameTask as renameTaskRpc,
  openInDebrief,
  restartCoordinator as restartCoordinatorRpc,
  steerCrew as steerCrewRpc,
  toggleWatch,
  writeConfig,
} from "./shared/fleet";
import { findHomeFiles, listHomeFiles, readHomeFile, writeHomeFile } from "./shared/files";
import { startWatches } from "./server/watch-service";
import { displaySettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const reports = new ReportCache();
  const steers = new UserSteers();
  // The connected hosts crewmates can run on; see server/hosts.ts.
  const hosts = new HostClients();
  const locations: CrewLocations = new Map();
  // The scripts in the home's watches/ folder, run on their schedules; see server/watches.ts.
  const watches = startWatches(server, readMissionControlConfig);

  server.handle(readConfig, async () => {
    const config = await readMissionControlConfig();
    return { config, resolvedHome: resolveHome(config) };
  });
  server.handle(writeConfig, async (patch) => {
    const config = await updateMissionControlConfig(patch);
    const home = resolveHome(config);
    // The charter names the crew's model, so a saved change reaches the file
    // at once; a home nobody has launched in yet is left for the launch.
    if (await isHomeReady(home)) await prepareHome(home, config);
    return { config, resolvedHome: home };
  });

  server.handle(loadFleetRpc, async (_input, { paseo }) => {
    watches.remember(paseo);
    const fleet = await loadFleet(
      paseo,
      hosts,
      await readMissionControlConfig(),
      reports,
      () => watches.runner.summaries(),
      locations,
    );
    // A Mission Control agent launched before the plugin named its home gets its name the first time the board looks.
    const workspaceId = fleet.coordinator?.workspaceId ?? null;
    if (workspaceId !== null && fleet.coordinatorInHome) nameHomeOnce(paseo, workspaceId, fleet.home);
    return fleet;
  });
  server.handle(enableAgentTools, async (_input, { paseo }) => {
    await paseo.config.patch({ mcp: { injectIntoAgents: true } });
    return { agentTools: (await readAgentTools(paseo)) === true };
  });

  server.handle(launchCoordinatorRpc, (input, { paseo }) => launchCoordinator(paseo, input));
  server.handle(adoptCoordinatorRpc, async ({ agentId }, { paseo }) => ({ config: await adoptCoordinator(paseo, agentId) }));
  server.handle(releaseCoordinatorRpc, async () => ({ config: await releaseCoordinator() }));
  server.handle(restartCoordinatorRpc, (_input, { paseo }) => restartCoordinator(paseo));
  server.handle(compactCoordinatorRpc, async (_input, { paseo }) => ({ agentId: await compactCoordinator(paseo) }));
  server.handle(listCandidatesRpc, (_input, { paseo }) => listCandidates(paseo));
  server.handle(askCoordinatorRpc, async (message, { paseo }) => ({ agentId: await askCoordinator(paseo, message) }));
  server.handle(askCoordinatorCommandRpc, async ({ command, args }, { paseo }) => ({
    agentId: await askCoordinator(paseo, { text: await commandText(command, args) }),
  }));
  server.handle(markCoordinatorSeenRpc, (_input, { paseo }) => markCoordinatorSeen(paseo));
  server.handle(toggleWatch, async ({ name, enabled }, { paseo }) => {
    watches.remember(paseo);
    await watches.toggle(name, enabled);
    return {};
  });

  // A crewmate's host, and the agents the backlog names, which the board shows as crew too.
  async function crewTarget(paseo: PaseoApi, serverId: string | null): Promise<CrewTarget> {
    const config = await readMissionControlConfig();
    const backlog = await readBacklog(resolveHome(config)).catch(() => []);
    const named = new Set(namedCrew(backlog, config.coordinatorAgentId).keys());
    return { api: await hosts.api(paseo, serverId), serverId, named };
  }
  server.handle(steerCrewRpc, async ({ agentId, serverId, text }, { paseo }) => {
    await steerCrew(await crewTarget(paseo, serverId), steers, agentId, text, async (agent, said, answer) => {
      const coordinator = await resolveCoordinator(paseo, await readMissionControlConfig());
      if (coordinator.agent !== null) await sendWithoutInterrupting(paseo, coordinator.agent.id, await relayText(agent, said, answer));
    });
    return {};
  });
  server.handle(interruptCrewRpc, async ({ agentId, serverId }, { paseo }) => {
    await interruptCrew(await crewTarget(paseo, serverId), agentId);
    return {};
  });
  server.handle(exitCrewRpc, async ({ agentId, serverId }, { paseo }) => {
    await exitCrew(await crewTarget(paseo, serverId), agentId);
    return {};
  });
  server.handle(relaunchCrewRpc, async ({ agentId, serverId, note }, { paseo }) => ({
    agentId: await relaunchCrew(paseo, await crewTarget(paseo, serverId), agentId, note),
  }));

  // The home as files, for the panel's file view. Confined to the home; see server/files.ts.
  async function home(): Promise<string> {
    return requireHome(resolveHome(await readMissionControlConfig()));
  }
  server.handle(listHomeFiles, async ({ path }) => {
    const root = await home();
    return { home: root, ...(await listDirectory(root, path)) };
  });
  server.handle(readHomeFile, async ({ path }) => readTextFile(await home(), path));
  server.handle(findHomeFiles, async ({ paths }) => ({ files: await findFiles(await home(), paths) }));
  server.handle(writeHomeFile, async (input) => {
    const written = await writeTextFile(await home(), input);
    // The charter's source, saved in the panel, reaches AGENTS.md at once rather than at the next reload.
    if (written.path === CHARTER_FILE) await refreshCharter();
    return written;
  });

  server.handle(openInDebrief, async (input) => {
    await requestDebriefOpen(input);
    return {};
  });
  server.handle(renameTaskRpc, async ({ taskId, title }) => {
    await renameTask(await home(), taskId, title);
    return {};
  });
  server.handle(readTaskNotes, async ({ taskId }) => ({ text: await readNotes(await home(), taskId) }));
  server.handle(writeTaskNotes, async ({ taskId, text }) => {
    await writeNotes(await home(), taskId, text);
    return {};
  });
  server.handle(saveBoardOrder, async ({ columns }) => {
    await writeBoardOrder(await home(), columns);
    return {};
  });
  server.handle(removeSuggestionRpc, async (suggestion) => ({
    suggestions: await removeSuggestion(await home(), suggestion),
  }));

  server.handle(compareCharterRpc, async () => ({
    path: (await writeNewCharter(await home())) ? NEW_CHARTER_FILE : null,
  }));
  server.handle(acknowledgeCharterRpc, async () => {
    await acknowledgeCharter(await home());
    return {};
  });

  // Storage lives on the host; registering the definition is what makes the
  // board's `useSettings` reads and writes valid for this installation.
  server.registerSettings(displaySettings);

  const unregisterRelay = registerSteerRelay(server, steers, readMissionControlConfig);
  // A crewmate whose finish Mission Control has been told about leaves Paseo's "Ready to review"; see server/crew-seen.ts.
  const unregisterCrewSeen = registerCrewSeen(server, readMissionControlConfig);

  // A charter change reaches a home already in use on the next reload, rather
  // than waiting for the next launch. Only a home a launch has prepared: this
  // never creates one.
  void refreshCharter().catch((error: unknown) => {
    console.error("[mission-control] could not rewrite the charter:", error);
  });

  return () => {
    unregisterRelay();
    unregisterCrewSeen();
    watches.stop();
    return hosts.dispose();
  };
}

async function refreshCharter(): Promise<void> {
  const config = await readMissionControlConfig();
  const home = resolveHome(config);
  if (await isHomeReady(home)) await prepareHome(home, config);
}
