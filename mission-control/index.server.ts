import type { PluginServerContext } from "@getpaseo/plugin/server";

import { readMissionControlConfig, resolveHome, updateMissionControlConfig } from "./server/config";
import { deliverCardChoice, recordCardTurn } from "./server/task-card";
import { recoveryId, RestartRecovery } from "./server/restart-recovery";
import { randomUUID } from "node:crypto";
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
import { listDirectory, readTextFile, requireHome, writeTextFile } from "./server/files";
import { findLinkedFiles, linkedFilesNeedProjects, readLocalImage, revealLocalFile } from "./server/local-files";
import { readVideoChunk } from "./server/videos";
import { videoChunk } from "./shared/videos";
import { chatImageSources } from "./server/chat-images";
import { CHARTER_FILE, NEW_CHARTER_FILE, acknowledgeCharter, writeNewCharter } from "./server/charter-file";
import { isHomeReady, prepareHome, readBacklog, removeSuggestion } from "./server/home";
import { writeBoardOrder } from "./server/board-order";
import { readNotes, writeNotes } from "./server/notes";
import { renameTask } from "./server/rename";
import { requestDebriefOpen } from "./server/debrief";
import { readToolbar } from "./server/home";
import { hasToolbarAction, runToolbarAction } from "./server/toolbar";
import { activateToolbarAction, readWorkspaceToolbar } from "./shared/toolbar";
import { Runs } from "./server/runs";
import { HostClients, withTimeout } from "./server/hosts";
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
  chatImages as chatImagesRpc,
  askCoordinatorCommand as askCoordinatorCommandRpc,
  compactCoordinator as compactCoordinatorRpc,
  compareCharter as compareCharterRpc,
  enableAgentTools,
  exitCrew as exitCrewRpc,
  interruptCrew as interruptCrewRpc,
  launchCoordinator as launchCoordinatorRpc,
  listCandidates as listCandidatesRpc,
  loadFleet as loadFleetRpc,
  staleFleet,
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
  runStatus,
  startRun,
  stopRun,
  toggleWatch,
  writeConfig,
} from "./shared/fleet";
import { findHomeFiles, listHomeFiles, readHomeFile, readImage, revealFile, writeHomeFile } from "./shared/files";
import { startWatches } from "./server/watch-service";
import { displaySettings } from "./shared/settings";
import { readProjects } from "./server/daemon-reads";
import { measureRpcHandlers } from "./server/rpc-metrics";

export default function contribute(server: PluginServerContext) {
  const metrics = measureRpcHandlers(server, "mission-control");
  const reports = new ReportCache();
  const steers = new UserSteers();
  // The connected hosts crewmates can run on; see server/hosts.ts.
  const hosts = new HostClients();
  const locations: CrewLocations = new Map();
  // The scripts in the home's watches/ folder, run on their schedules; see server/watches.ts.
  const recovery = new RestartRecovery();
  const watches = startWatches(server, readMissionControlConfig, () => recovery.request());

  metrics.handle(readConfig, async () => {
    const config = await readMissionControlConfig();
    return { config, resolvedHome: resolveHome(config) };
  });
  metrics.handle(writeConfig, async (patch) => {
    const config = await updateMissionControlConfig(patch);
    const home = resolveHome(config);
    // The charter names the crew's model, so a saved change reaches the file
    // at once; a home nobody has launched in yet is left for the launch.
    if (await isHomeReady(home)) await prepareHome(home, config);
    return { config, resolvedHome: home };
  });

  let pendingFleet: ReturnType<typeof loadFleet> | undefined;
  let lastGoodFleet: Awaited<ReturnType<typeof loadFleet>> | undefined;
  let fleetGeneration = 0;
  let lastGoodGeneration = 0;
  metrics.handle(loadFleetRpc, (_input, { paseo }) => {
    watches.remember(paseo);
    const generation = ++fleetGeneration;
    // Release a stuck shared assembly before the host's 30-second plugin RPC deadline.
    pendingFleet ??= withTimeout(readMissionControlConfig().then((config) => loadFleet(
      paseo,
      hosts,
      config,
      reports,
      () => watches.runner.summaries(),
      locations,
    )).then((fleet) => {
      if (fleet.homeReady && fleet.coordinator) fleet = { ...fleet, restartId: recoveryId };
      // A late success still seeds the cache, but must not overwrite a newer successful assembly.
      if (generation >= lastGoodGeneration) {
        lastGoodFleet = fleet;
        lastGoodGeneration = generation;
      }
      return fleet;
    }), 20_000, "The board").then((fleet) => {
      // A Mission Control agent launched before the plugin named its home gets its name the first time the board looks.
      const workspaceId = fleet.coordinator?.workspaceId ?? null;
      void recovery.inspect(fleet, paseo).catch((error) => console.warn("[mission-control] restart reconciliation:", error));
      if (workspaceId !== null && fleet.coordinatorInHome) nameHomeOnce(paseo, workspaceId, fleet.home);
      return fleet;
    }).catch((error: unknown) => {
      if (lastGoodFleet === undefined) throw error;
      return staleFleet(lastGoodFleet, error);
    }).finally(() => { pendingFleet = undefined; });
    return pendingFleet;
  });
  metrics.handle(enableAgentTools, async (_input, { paseo }) => {
    await paseo.config.patch({ mcp: { injectIntoAgents: true } });
    return { agentTools: (await readAgentTools(paseo)) === true };
  });

  metrics.handle(launchCoordinatorRpc, (input, { paseo }) => launchCoordinator(paseo, input));
  metrics.handle(adoptCoordinatorRpc, async ({ agentId }, { paseo }) => ({ config: await adoptCoordinator(paseo, agentId) }));
  metrics.handle(releaseCoordinatorRpc, async () => ({ config: await releaseCoordinator() }));
  metrics.handle(restartCoordinatorRpc, (_input, { paseo }) => restartCoordinator(paseo));
  metrics.handle(compactCoordinatorRpc, async (_input, { paseo }) => ({ agentId: await compactCoordinator(paseo) }));
  metrics.handle(listCandidatesRpc, (_input, { paseo }) => listCandidates(paseo));
  const decisionFleet = async (paseo: PaseoApi) => loadFleet(paseo, hosts, await readMissionControlConfig(), reports, undefined, locations);
  metrics.handle(askCoordinatorRpc, async (message, { paseo }) => ({
    agentId: await deliverCardChoice(message.text, () => decisionFleet(paseo),
      (text) => askCoordinator(paseo, { ...message, text })),
  }));
  metrics.handle(chatImagesRpc, async ({ messageId }) => ({ sources: await chatImageSources(await home(), messageId) }));
  metrics.handle(askCoordinatorCommandRpc, async ({ command, args }, { paseo }) => ({
    agentId: await askCoordinator(paseo, { text: await commandText(command, args) }),
  }));
  metrics.handle(markCoordinatorSeenRpc, (_input, { paseo }) => markCoordinatorSeen(paseo));
  metrics.handle(toggleWatch, async ({ name, enabled }, { paseo }) => {
    watches.remember(paseo);
    await watches.toggle(name, enabled);
    return {};
  });

  // A crewmate's host, and the agents the backlog names, which the board shows as crew too.
  async function crewTarget(paseo: PaseoApi, serverId: string | null): Promise<CrewTarget> {
    const config = await readMissionControlConfig();
    const backlog = await readBacklog(resolveHome(config)).catch(() => []);
    const named = new Set(namedCrew(backlog, config.coordinatorAgentId).keys());
    return { api: await hosts.api(paseo, serverId), serverId, named, coordinatorAgentId: config.coordinatorAgentId.trim() };
  }
  metrics.handle(steerCrewRpc, async ({ agentId, serverId, text }, { paseo }) => {
    const target = await crewTarget(paseo, serverId);
    await deliverCardChoice(text, () => decisionFleet(paseo), (choice) => steerCrew(target, steers, agentId, choice, async (agent, said, answer) => {
      const coordinator = await resolveCoordinator(paseo, await readMissionControlConfig());
      if (coordinator.agent !== null) await sendWithoutInterrupting(paseo, coordinator.agent.id, await relayText(agent, said, answer));
    }), { agentId, serverId });
    return {};
  });
  metrics.handle(interruptCrewRpc, async ({ agentId, serverId }, { paseo }) => {
    await interruptCrew(await crewTarget(paseo, serverId), agentId);
    return {};
  });
  metrics.handle(exitCrewRpc, async ({ agentId, serverId }, { paseo }) => {
    await exitCrew(await crewTarget(paseo, serverId), agentId);
    return {};
  });
  metrics.handle(relaunchCrewRpc, async ({ agentId, serverId, note }, { paseo }) => ({
    agentId: await relaunchCrew(paseo, await crewTarget(paseo, serverId), agentId, note),
  }));

  // The home as files, for the panel's file view. Confined to the home; see server/files.ts.
  async function home(): Promise<string> {
    return requireHome(resolveHome(await readMissionControlConfig()));
  }
  metrics.handle(listHomeFiles, async ({ path }) => {
    const root = await home();
    return { home: root, ...(await listDirectory(root, path)) };
  });
  metrics.handle(readHomeFile, async ({ path }) => readTextFile(await home(), path));
  // The project roots a reply's links and images may reach besides the home; see server/local-files.ts.
  // A listing that fails leaves the home alone reachable rather than failing the chat.
  async function projectRoots(paseo: PaseoApi): Promise<string[]> {
    try {
      return (await readProjects(paseo)).projects.map((project) => project.projectRootPath);
    } catch (caught) {
      console.warn("[mission-control] projects could not be listed for file links:", caught);
      return [];
    }
  }
  metrics.handle(findHomeFiles, async ({ paths }, { paseo }) => {
    const root = await home();
    const roots = linkedFilesNeedProjects(root, paths) ? await projectRoots(paseo) : [];
    return findLinkedFiles(root, roots, paths);
  });
  metrics.handle(readImage, async ({ src }, { paseo }) => readLocalImage(await home(), await projectRoots(paseo), src));
  metrics.handle(videoChunk, async ({ src, offset }, { paseo }) => readVideoChunk(await home(), await projectRoots(paseo), src, offset));
  metrics.handle(revealFile, async ({ path }, { paseo }) => {
    await revealLocalFile(await home(), await projectRoots(paseo), path);
    return {};
  });
  metrics.handle(writeHomeFile, async (input) => {
    const written = await writeTextFile(await home(), input);
    // The charter's source, saved in the panel, reaches AGENTS.md at once rather than at the next reload.
    if (written.path === CHARTER_FILE) await refreshCharter();
    return written;
  });

  // The chat's [[run: ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦]] embeds; see server/runs.ts.
  const runs = new Runs(home);
  metrics.handle(readWorkspaceToolbar, async () => ({ items: (await readToolbar(await home())).workspaces }));
  metrics.handle(activateToolbarAction, async ({ action, workspaceId, placement }, { paseo }) => {
    const directory = await home();
    if (placement === "workspaces" && workspaceId === null) throw new Error("A workspace toolbar action needs a workspace.");
    const toolbar = await readToolbar(directory);
    if (!hasToolbarAction(toolbar[placement], action)) throw new Error("This toolbar button changed. Use the current toolbar.");
    return runToolbarAction(paseo, runs, directory, workspaceId, action, (text) => askCoordinator(paseo, { text }));
  });
  metrics.handle(startRun, ({ project, command }, { paseo }) => runs.start(paseo, project, command));
  metrics.handle(runStatus, ({ runId }, { paseo }) => runs.status(paseo, runId));
  metrics.handle(stopRun, async ({ runId }, { paseo }) => {
    await runs.stop(paseo, runId);
    return {};
  });

  metrics.handle(openInDebrief, async (input) => {
    await requestDebriefOpen(input);
    return {};
  });
  metrics.handle(renameTaskRpc, async ({ taskId, title }) => {
    await renameTask(await home(), taskId, title);
    return {};
  });
  metrics.handle(readTaskNotes, async ({ taskId }) => ({ text: await readNotes(await home(), taskId) }));
  metrics.handle(writeTaskNotes, async ({ taskId, text }) => {
    await writeNotes(await home(), taskId, text);
    return {};
  });
  metrics.handle(saveBoardOrder, async ({ columns }) => {
    await writeBoardOrder(await home(), columns);
    return {};
  });
  metrics.handle(removeSuggestionRpc, async (suggestion) => ({
    suggestions: await removeSuggestion(await home(), suggestion),
  }));

  metrics.handle(compareCharterRpc, async () => ({
    path: (await writeNewCharter(await home())) ? NEW_CHARTER_FILE : null,
  }));
  metrics.handle(acknowledgeCharterRpc, async () => {
    await acknowledgeCharter(await home());
    return {};
  });

  // Storage lives on the host; registering the definition is what makes the
  // board's `useSettings` reads and writes valid for this installation.
  server.registerSettings(displaySettings);

  const unregisterCardTurn = server.on("agent.turn_started", async (event) => {
    const config = await readMissionControlConfig();
    if (event.agent.id === config.coordinatorAgentId) return;
    const root = resolveHome(config);
    const rows = await readBacklog(root);
    if (rows.some((row) => row.cardEpoch && row.section === "in-flight" && row.agentId === event.agent.id)) {
      await recordCardTurn(root, event.agent.id, event.turnId ?? randomUUID());
    }
  });
  const unregisterRelay = registerSteerRelay(server, steers, readMissionControlConfig);
  // A crewmate whose finish Mission Control has been told about leaves Paseo's "Ready to review"; see server/crew-seen.ts.
  const unregisterCrewSeen = registerCrewSeen(server, readMissionControlConfig);

  // A charter change reaches a home already in use on the next reload, rather
  // than waiting for the next launch. Only a home a launch has prepared: this
  // never creates one.
  recovery.request();
  void refreshCharter().catch((error: unknown) => {
    console.error("[mission-control] could not rewrite the charter:", error);
  });

  return () => {
    metrics.stop();
    unregisterCardTurn();
    unregisterRelay();
    unregisterCrewSeen();
    recovery.stop();
    watches.stop();
    return hosts.dispose();
  };
}

async function refreshCharter(): Promise<void> {
  const config = await readMissionControlConfig();
  const home = resolveHome(config);
  if (await isHomeReady(home)) await prepareHome(home, config);
}
