/**
 * Mission Control: launching one, adopting one, and carrying the user's
 * words to it.
 *
 * The plugin never dispatches a crewmate. It gives Mission Control a home and a
 * charter and starts it there; from then on Mission Control owns intake,
 * dispatch and supervision, with Paseo's own tools.
 */
import type { UserMessage } from "../shared/attachments";
import { CREW_LABELS, type AgentSummary, type MissionControlConfig, type CoordinatorCommand } from "../shared/fleet";
import { readMissionControlConfig, resolveHome, updateMissionControlConfig } from "./config";
import { fetchLiveAgent, listAgents, resolveCoordinator, summarizeAgent } from "./fleet";
import { prepareHome } from "./home";
import { TEMPLATES, message } from "./templates";
import { nameHomeOnce } from "./home-name";
import type { PaseoApi } from "./host-types";
import { sendSessionRequest } from "./daemon-session";
import { sendWithoutInterrupting } from "./send";
import { writeUpload } from "./uploads";

export const COORDINATOR_TITLE = "Mission Control";

/** What a Mission Control agent is started with. Empty strings leave the provider's default. */
interface CoordinatorSetup {
  provider: string;
  modeId: string;
  thinkingOptionId: string;
}

const NO_COORDINATOR = "There is no Mission Control yet. Open the Mission Control board and launch one.";

/**
 * The change of Mission Control in progress, if any — a launch, restart, adoption or
 * release. The "already running" check below reads the config, which is only
 * written once the agent exists, so two launches that overlap — a double press,
 * the desktop and a phone — would both pass it, and an adoption or release
 * landing mid-launch would be overwritten by it. Every client of this daemon reaches the same plugin process, so
 * holding the change here is enough to make the second one wait for the first
 * — and then refuse, or restart Mission Control the first one started.
 */
let changing: Promise<unknown> | null = null;

async function oneAtATime<T>(change: () => Promise<T>): Promise<T> {
  while (changing !== null) await changing.catch(() => {});
  const run = change();
  changing = run;
  try {
    return await run;
  } finally {
    if (changing === run) changing = null;
  }
}

/** Refused when a Mission Control agent is already running, so a second launch cannot start a second one. */
export async function launchCoordinator(
  paseo: PaseoApi,
  input: { provider: string; modeId: string },
): Promise<{ agentId: string; workspaceId: string | null }> {
  return oneAtATime(async () => {
    const config = await readMissionControlConfig();
    const current = await resolveCoordinator(paseo, config);
    if (current.agent !== null) {
      throw new Error(
        `A Mission Control agent is already running (${current.agent.title ?? current.agent.id}). Open it, or release it in the Mission Control settings first.`,
      );
    }
    return startCoordinator(paseo, config, { ...input, thinkingOptionId: "" }, "launch");
  });
}

const MID_TURN = "Mission Control is in the middle of a turn.";

export function isMidTurn(agent: { status: string }): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

/**
 * Archives Mission Control and launches a new one set up the same way, from
 * the live agent rather than the config: its model, mode or thinking may have
 * been changed in its own tab since launch, and an adopted one has nothing in
 * the config at all. Refused mid-turn, as Compact is: a turn cut off halfway
 * through a dispatch can leave a crewmate the records never heard of.
 *
 * The old one is archived before the new one starts, so two Mission Control agents never
 * run at once. Archiving stops its turn and ends its wake heartbeat —
 * Paseo retires a schedule whose agent is archived — and leaves its
 * conversation readable in Paseo's history. A launch that fails after that
 * leaves no Mission Control, which the board shows with its launch panel.
 */
export async function restartCoordinator(paseo: PaseoApi): Promise<{ agentId: string; workspaceId: string | null }> {
  return oneAtATime(async () => {
    const config = await readMissionControlConfig();
    const { agent } = await resolveCoordinator(paseo, config);
    if (agent === null) throw new Error(NO_COORDINATOR);
    if (isMidTurn(agent)) throw new Error(`${MID_TURN} Restart it once it is idle.`);
    const setup: CoordinatorSetup = {
      provider: agent.model === null ? agent.provider : `${agent.provider}/${agent.model}`,
      modeId: agent.currentModeId ?? "",
      thinkingOptionId: agent.thinkingOptionId ?? "",
    };
    await paseo.agents.ref(agent.id).archive();
    try {
      return await startCoordinator(paseo, config, setup, "restart");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The old Mission Control was archived, but the new one did not start: ${reason}`);
    }
  });
}

/**
 * The note a restart adds after the opening (`templates/messages/restart-note.md`): the wake it asks for
 * is how a new Mission Control hears about crewmates its predecessor started, which will not wake it.
 */
export function restartNote(): Promise<string> {
  return message(TEMPLATES.restartNote);
}

/**
 * Writes the home and starts a Mission Control agent in it, with the opening — and, after a restart, the
 * note about Mission Control before. Callers hold `oneAtATime` and have checked that none is running.
 */
async function startCoordinator(
  paseo: PaseoApi,
  config: MissionControlConfig,
  setup: CoordinatorSetup,
  start: "launch" | "restart",
): Promise<{ agentId: string; workspaceId: string | null }> {
  const home = resolveHome(config);
  await prepareHome(home, config);
  const opening = await message(TEMPLATES.opening);
  const prompt = start === "restart" ? `${opening}\n\n${await restartNote()}` : opening;

  const workspace = await paseo.workspaces.open(home);
  nameHomeOnce(paseo, workspace.id, home);
  const modeId = setup.modeId.trim();
  const thinkingOptionId = setup.thinkingOptionId.trim();
  const agent = await workspace.agents.create({
    config: {
      provider: setup.provider,
      ...(modeId === "" ? {} : { modeId }),
      ...(thinkingOptionId === "" ? {} : { thinkingOptionId }),
    },
    title: COORDINATOR_TITLE,
    labels: { [CREW_LABELS.role]: CREW_LABELS.coordinatorRole },
    prompt,
  });
  await updateMissionControlConfig({ coordinatorAgentId: agent.id, coordinatorProvider: setup.provider, coordinatorModeId: modeId });
  return { agentId: agent.id, workspaceId: workspace.id };
}

/**
 * Makes an existing agent Mission Control. The charter is written into the
 * home either way, so an agent already working there picks it up on its next
 * session; one working elsewhere never sees it, which the board points out.
 */
export async function adoptCoordinator(paseo: PaseoApi, agentId: string): Promise<MissionControlConfig> {
  return oneAtATime(async () => {
    if ((await fetchLiveAgent(paseo, agentId)) === null) throw new Error(`Paseo has no live agent ${agentId}.`);
    const config = await readMissionControlConfig();
    // Checked here rather than trusted from the launch panel: a launch may have finished while this waited.
    const current = await resolveCoordinator(paseo, config);
    if (current.agent !== null && current.agent.id !== agentId) {
      throw new Error(
        `A Mission Control agent is already running (${current.agent.title ?? current.agent.id}). Release it in the Mission Control settings first.`,
      );
    }
    await prepareHome(resolveHome(config), config);
    return updateMissionControlConfig({ coordinatorAgentId: agentId });
  });
}

export async function releaseCoordinator(): Promise<MissionControlConfig> {
  return oneAtATime(() => updateMissionControlConfig({ coordinatorAgentId: "" }));
}

/** Every live agent that could be adopted, those already working in the home first. */
export async function listCandidates(paseo: PaseoApi): Promise<{ home: string; agents: AgentSummary[] }> {
  const home = resolveHome(await readMissionControlConfig());
  const agents = (await listAgents(paseo))
    .filter((agent) => agent.labels[CREW_LABELS.role] !== CREW_LABELS.crewRole)
    .map((agent) => summarizeAgent(agent))
    .sort((a, b) => {
      const inHome = Number(b.cwd === home) - Number(a.cwd === home);
      return inHome !== 0 ? inHome : b.updatedAt.localeCompare(a.updatedAt);
    });
  return { home, agents };
}

/** Mission Control's id, or a sentence saying there is none. */
export async function requireCoordinator(paseo: PaseoApi): Promise<string> {
  const coordinator = await resolveCoordinator(paseo, await readMissionControlConfig());
  if (coordinator.agent === null) throw new Error(NO_COORDINATOR);
  return coordinator.agent.id;
}

/**
 * Sends `/compact`, the command Paseo's own composer sends: Claude Code,
 * Codex and OpenCode each compact on it. A plain send, since a slash command
 * must be a turn of its own — so it is refused while a turn is running, where
 * a send would interrupt it, and a steer would bury the command in a message.
 */
export async function compactCoordinator(paseo: PaseoApi): Promise<string> {
  const { agent } = await resolveCoordinator(paseo, await readMissionControlConfig());
  if (agent === null) throw new Error(NO_COORDINATOR);
  if (isMidTurn(agent)) throw new Error(`${MID_TURN} Compact it once it is idle.`);
  await paseo.agents.ref(agent.id).send("/compact");
  return agent.id;
}

/** The template for each request, with nothing after it and with something. */
const COMMANDS = {
  status: [TEMPLATES.status, TEMPLATES.statusArgs],
  "catch-up": [TEMPLATES.catchUp, TEMPLATES.catchUpArgs],
} as const;

/**
 * What Status and Catch up send — the buttons, ⌘K, `/mc-status` and `/mc-catch-up` — from `templates/messages/`:
 * plain requests, which charter §10 defines, rather than slash commands, which Mission Control's own
 * harness would take as its own. `args` is whatever the user typed after the command.
 */
export function commandText(command: CoordinatorCommand, args: string): Promise<string> {
  const extra = args.trim();
  const [plain, withArgs] = COMMANDS[command];
  return extra === "" ? message(plain) : message(withArgs, { args: extra });
}

/**
 * Delivers the user's words, joining Mission Control's turn if it is mid-way through one.
 * Images go with the message; files are written to Paseo's uploads first and go as their paths —
 * see `shared/attachments.ts`. Nothing is written until Mission Control is known to exist.
 */
export async function askCoordinator(paseo: PaseoApi, message: UserMessage): Promise<string> {
  const agentId = await requireCoordinator(paseo);
  const images = message.images ?? [];
  const attachments = await Promise.all((message.files ?? []).map((file) => writeUpload(file)));
  await sendWithoutInterrupting(paseo, agentId, message.text.trim(), {
    ...(images.length > 0 ? { images } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  return agentId;
}

/**
 * Clears Mission Control's attention flag while the user has the Mission Control
 * panel open, as looking at the agent in Paseo would. The SDK has no call for
 * it, so it goes over the plugin's own channel (`daemon-session.ts`). Skipped
 * for a Mission Control agent waiting on a permission, as Paseo's own "mark as read"
 * skips one: the flag is the only prompt to answer it.
 */
export async function markCoordinatorSeen(paseo: PaseoApi): Promise<{ cleared: boolean }> {
  const { agent } = await resolveCoordinator(paseo, await readMissionControlConfig());
  if (agent === null || agent.requiresAttention !== true) return { cleared: false };
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") return { cleared: false };
  await sendSessionRequest({ type: "clear_agent_attention", agentId: agent.id }, "clear_agent_attention_response");
  return { cleared: true };
}
