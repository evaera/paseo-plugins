/**
 * Every crossing between the board and the daemon, and the vocabulary both
 * sides — and Mission Control's charter — share.
 *
 * The plugin never dispatches a crewmate itself. Mission Control does, with
 * Paseo's own tools; the plugin sets up its home, starts it, carries the
 * user's words to it, and draws what it and its crew are doing.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { UserMessageSchema } from "./attachments";

/**
 * The labels a crewmate is created with. The charter tells Mission Control to
 * set them, and the board finds the crew by them, so both read this one
 * object rather than spelling the keys twice.
 */
export const CREW_LABELS = {
  role: "pmc.role",
  crewRole: "crew",
  coordinatorRole: "mission-control",
  task: "pmc.task",
  kind: "pmc.kind",
  project: "pmc.project",
} as const;

/** The words a crewmate ends every turn with: `<state>: <one short line>`. */
export const CrewStateSchema = z.enum([
  "working",
  "needs-decision",
  "blocked",
  "paused",
  "done",
  "failed",
  "resolved",
]);
export type CrewState = z.infer<typeof CrewStateSchema>;

export const COLUMN_IDS = ["queued", "working", "blocked", "parked", "done", "failed", "idle", "waiting"] as const;
export const ColumnIdSchema = z.enum(COLUMN_IDS);
export type ColumnId = z.infer<typeof ColumnIdSchema>;

export const AgentStatusSchema = z.enum(["initializing", "idle", "running", "error", "closed"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** What the board needs of one Paseo agent — Mission Control or a crewmate. */
export const AgentSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: AgentStatusSchema,
  cwd: z.string(),
  pendingPermissions: z.number().int(),
  requiresAttention: z.boolean(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
  /** When the agent was created; null where Paseo did not say. */
  createdAt: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  /** The connected host the agent runs on, or null for this daemon. */
  serverId: z.string().nullable(),
  /** That host's label, or null for this daemon. */
  host: z.string().nullable(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const CrewReportSchema = z.object({
  state: CrewStateSchema,
  text: z.string(),
});
export type CrewReportSummary = z.infer<typeof CrewReportSchema>;

export const BacklogSectionSchema = z.enum(["in-flight", "queued", "done"]);
export type BacklogSection = z.infer<typeof BacklogSectionSchema>;

/**
 * One of the user's likely answers to a held item, written by Mission
 * Control on its backlog line as `(actions: <label> => <prompt> | …)`: the card
 * draws the label as a button that sends the prompt.
 */
export const CardActionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type CardAction = z.infer<typeof CardActionSchema>;

export const BacklogItemSchema = z.object({
  section: BacklogSectionSchema,
  id: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  kind: z.string().nullable(),
  mode: z.string().nullable(),
  agentId: z.string().nullable(),
  /** `(host: <label>)`: the connected host the item's agent runs on. */
  host: z.string().nullable(),
  hold: z.string().nullable(),
  /** `(waiting: a code review)`: nothing left to do here, the next move is someone else's; a leading "on" is dropped. */
  waiting: z.string().nullable(),
  actions: z.array(CardActionSchema),
  blockedBy: z.string().nullable(),
  since: z.string().nullable(),
  /** The first link on the line. */
  url: z.string().nullable(),
  /** Every link on the line, in order, without repeats. */
  links: z.array(z.string()),
  reportPath: z.string().nullable(),
  outcome: z.string().nullable(),
});
export type BacklogItem = z.infer<typeof BacklogItemSchema>;

/**
 * One card on the board: a backlog item, a crewmate, or — the usual case once
 * work is in progress — both, joined by task id.
 */
/**
 * What a worker has changed, for the card's Diff and Story buttons, which open the Debrief plugin on its
 * workspace on whichever host it runs: the size of its diff (Paseo's `diffStat`), and, for a worker on
 * this Mac, how many Debrief comments are still open and whether Debrief has a story for it (those are
 * Debrief's files, readable only here). Absent for a worker with nothing changed.
 */
export const DebriefInfoSchema = z.object({
  workspaceId: z.string(),
  /** The host the workspace is on; null for this Mac. */
  serverId: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  openComments: z.number(),
  story: z.boolean(),
});
export type DebriefInfo = z.infer<typeof DebriefInfoSchema>;

export const FleetCardSchema = z.object({
  key: z.string(),
  column: ColumnIdSchema,
  taskId: z.string().nullable(),
  title: z.string(),
  project: z.string().nullable(),
  kind: z.string().nullable(),
  backlog: BacklogItemSchema.nullable(),
  agent: AgentSummarySchema.nullable(),
  /** The status line the crewmate ended its last turn with. */
  report: CrewReportSchema.nullable(),
  /** Pull requests, tasks and pages: the report's link first, then the backlog line's. */
  links: z.array(z.string()),
  debrief: DebriefInfoSchema.optional(),
});
export type FleetCard = z.infer<typeof FleetCardSchema>;

export const ProjectSchema = z.object({
  name: z.string(),
  mode: z.string().nullable(),
  yolo: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A next step Mission Control suggests, from `state/suggestions.md`: a button's
 * label and what pressing it puts in the composer.
 */
export const SuggestionSchema = z.object({
  label: z.string(),
  prompt: z.string(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

/**
 * How a watch message is told from the user's words in a timeline: the plugin sends it with a
 * `messageId` starting with this, which the daemon records as the timeline item's `clientMessageId`.
 * Text alone cannot tell them apart — the user can paste a watch block — so the chat folds a message
 * as a watch message only when it carries this id.
 */
export const WATCH_MESSAGE_ID_PREFIX = "mission-control-watch-";

export function isWatchMessageId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(WATCH_MESSAGE_ID_PREFIX);
}

/** The home's folder of watch scripts, relative to the home. */
export const WATCHES_DIR = "watches";

/** A watch script's path in the home, as the Files view opens it. */
export function watchPath(name: string): string {
  return `${WATCHES_DIR}/${name}`;
}

/**
 * What a watch's last run came to: `silent` printed nothing; `queued` printed something that waits for
 * Mission Control to be idle; `delivered` printed something Mission Control has been sent; `dropped`
 * printed something a full queue pushed out before it could be sent; `failed` exited non-zero or ran out
 * of time; `invalid` cannot run at all; `never` has not run since it appeared.
 */
export const WatchResultSchema = z.enum(["never", "silent", "queued", "delivered", "dropped", "failed", "invalid"]);
export type WatchResult = z.infer<typeof WatchResultSchema>;

/**
 * One script in the home's `watches/` folder, as the board's Watches card shows it. The runner
 * (`server/watches.ts`) runs it on its schedule and sends Mission Control whatever it prints.
 */
export const WatchSummarySchema = z.object({
  /** Its file name in `watches/`. */
  name: z.string(),
  /** The schedule as its header writes it, or null when it has none. */
  schedule: z.string().nullable(),
  /** False once the user has switched it off on the card. */
  enabled: z.boolean(),
  /** Why it cannot run — no schedule, a bad one, not executable — or null when it can. */
  invalid: z.string().nullable(),
  running: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastResult: WatchResultSchema,
  /** What it last printed, clipped, and when; kept while later runs are silent. */
  lastOutput: z.string().nullable(),
  lastOutputAt: z.string().nullable(),
  /** Why its last run failed, with the end of what it wrote to stderr. */
  lastError: z.string().nullable(),
  /** One of the plugin's own watches. */
  builtIn: z.boolean(),
  /** A built-in the user has edited, whose plugin version has changed since. */
  outdated: z.boolean(),
});
export type WatchSummary = z.infer<typeof WatchSummarySchema>;

export const FleetSchema = z.object({
  home: z.string(),
  /** False until the first launch has written the charter and records. */
  homeReady: z.boolean(),
  coordinator: AgentSummarySchema.nullable(),
  /** A Mission Control agent is configured but Paseo no longer has it (archived, deleted). */
  coordinatorMissing: z.boolean(),
  /**
   * Whether Mission Control runs in its home, where its charter is. False for
   * an adopted agent working elsewhere, which has never read the charter.
   * Compared as real paths, since `/tmp` is `/private/tmp` on a Mac.
   */
  coordinatorInHome: z.boolean(),
  cards: z.array(FleetCardSchema),
  projects: z.array(ProjectSchema),
  /** What the user might do next, most likely first; empty hides the card and the tab. */
  suggestions: z.array(SuggestionSchema),
  /** The home's watch scripts, by name; empty hides the card. */
  watches: z.array(WatchSummarySchema),
  /**
   * Whether the daemon gives agents Paseo's own tools (`mcp.injectIntoAgents`),
   * which is how Mission Control starts and hears from its crew. Off by default
   * in Paseo; `null` when the daemon would not say.
   */
  agentTools: z.boolean().nullable(),
  /**
   * The user has edited the home's charter (`prompts/charter.md`), and the plugin's own has changed
   * since the version they started from. The board offers to compare the two.
   */
  charterOutdated: z.boolean(),
  /** Things worth a line on the board: an unreadable backlog, a failed agent listing. */
  warnings: z.array(z.string()),
});
export type Fleet = z.infer<typeof FleetSchema>;

// ---------------------------------------------------------------------------
// The daemon's own file: what handlers act on
// ---------------------------------------------------------------------------

export const MissionControlConfigSchema = z.object({
  /** Mission Control's home; empty means `$PASEO_HOME/plugin-data/mission-control/home`. */
  home: z.string().default(""),
  /** The Paseo agent that is Mission Control; empty until one is launched or adopted. */
  coordinatorAgentId: z.string().default(""),
  /** `provider/model` Mission Control is launched with. */
  coordinatorProvider: z.string().default(""),
  coordinatorModeId: z.string().default(""),
  /** `provider/model` the charter tells Mission Control to give crewmates; empty leaves it to Mission Control. */
  crewProvider: z.string().default(""),
  crewModeId: z.string().default(""),
  /** Whether the charter tells Mission Control to give crewmates fast mode, where their model has it. */
  crewFastMode: z.boolean().default(false),
  /** Watch scripts the user has switched off on the board, by file name. */
  disabledWatches: z.array(z.string()).default([]),
});
export type MissionControlConfig = z.infer<typeof MissionControlConfigSchema>;

/**
 * A change to the config: only the fields it names. Not `MissionControlConfigSchema.partial()` — zod 4 fills
 * a default in for every missing field even there, so a save of one setting would arrive carrying all
 * the others blank, and release Mission Control on its way.
 */
export const MissionControlConfigPatchSchema = z.object({
  home: z.string().optional(),
  coordinatorAgentId: z.string().optional(),
  coordinatorProvider: z.string().optional(),
  coordinatorModeId: z.string().optional(),
  crewProvider: z.string().optional(),
  crewModeId: z.string().optional(),
  crewFastMode: z.boolean().optional(),
  disabledWatches: z.array(z.string()).optional(),
});

export const readConfig = defineRpc({
  name: "mission-control.config.read",
  input: z.object({}),
  output: z.object({ config: MissionControlConfigSchema, resolvedHome: z.string() }),
});

export const writeConfig = defineRpc({
  name: "mission-control.config.write",
  input: MissionControlConfigPatchSchema,
  output: z.object({ config: MissionControlConfigSchema, resolvedHome: z.string() }),
});

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export const loadFleet = defineRpc({
  name: "mission-control.fleet.load",
  input: z.object({}),
  output: FleetSchema,
});

/**
 * Writes the plugin's current charter beside the user's edited one, as `prompts/charter.new.md`, and
 * says where — for the board's Compare. `null` when there is nothing to compare.
 */
export const compareCharter = defineRpc({
  name: "mission-control.charter.compare",
  input: z.object({}),
  output: z.object({ path: z.string().nullable() }),
});

/** The user has taken what they want from the plugin's new charter; stop pointing at it. */
export const acknowledgeCharter = defineRpc({
  name: "mission-control.charter.acknowledge",
  input: z.object({}),
  output: z.object({}),
});

/** Switches a watch script on or off, without touching the script: the daemon's config lists the ones that are off. */
export const toggleWatch = defineRpc({
  name: "mission-control.watch.toggle",
  input: z.object({ name: z.string().min(1), enabled: z.boolean() }),
  output: z.object({}),
});

/**
 * Takes one suggestion off the board: records it in `state/suggestions-dismissed.md`, so the board hides
 * its prompt from then on, and removes its line from `state/suggestions.md`, matched by label and prompt;
 * one the file no longer has is left alone. Answers with the suggestions the board shows now.
 */
/** Which of Debrief's views a card's button opens. */
export const DebriefViewSchema = z.enum(["diff", "story", "plans"]);
export type DebriefView = z.infer<typeof DebriefViewSchema>;

/**
 * Asks Debrief to open its tab on a workspace: a request file in Debrief's `open-requests/`, which its
 * panel claims (Debrief's `OpenRequestSchema`; one plugin cannot open another's panel). The client then
 * opens the workspace itself.
 */
export const openInDebrief = defineRpc({
  name: "mission-control.debrief.open",
  input: z.object({
    workspaceId: z.string().regex(/^[\w-]{1,128}$/),
    agentId: z.string().min(1).max(128).optional(),
    view: DebriefViewSchema,
    /** The file to show: in the diff, or in the story's chapter. */
    path: z.string().min(1).max(1024).optional(),
  }),
  output: z.object({}),
});

/** Renames a task: its title on its backlog line, rewritten in place. */
export const renameTask = defineRpc({
  name: "mission-control.task.rename",
  input: z.object({ taskId: z.string().min(1).max(64), title: z.string().min(1).max(500) }),
  output: z.object({}),
});

/** The user's notes on one task, which Mission Control reads (`tasks/<task id>/user-notes.md`). */
export const readTaskNotes = defineRpc({
  name: "mission-control.notes.read",
  input: z.object({ taskId: z.string().min(1).max(64) }),
  output: z.object({ text: z.string() }),
});

/** Saves them; empty notes remove the file. */
export const writeTaskNotes = defineRpc({
  name: "mission-control.notes.write",
  input: z.object({ taskId: z.string().min(1).max(64), text: z.string().max(200_000) }),
  output: z.object({}),
});

/** One card as Mission Control reads it in `state/board-order.md`. */
export const OrderedCardSchema = z.object({
  taskId: z.string().nullable(),
  title: z.string(),
  agentId: z.string().nullable(),
  host: z.string().nullable(),
});

/**
 * Writes the user's card order into the home, for Mission Control: each
 * column the user arranged, its cards top first.
 */
export const saveBoardOrder = defineRpc({
  name: "mission-control.order.save",
  input: z.object({
    columns: z.array(z.object({ title: z.string(), cards: z.array(OrderedCardSchema) })),
  }),
  output: z.object({}),
});

export const removeSuggestion = defineRpc({
  name: "mission-control.suggestion.remove",
  input: SuggestionSchema,
  output: z.object({ suggestions: z.array(SuggestionSchema) }),
});

/**
 * Turns on `mcp.injectIntoAgents` in the daemon's config. Only agents started
 * or resumed afterwards get the tools, which is why the board asks before the
 * Mission Control is launched rather than after.
 */
export const enableAgentTools = defineRpc({
  name: "mission-control.tools.enable",
  input: z.object({}),
  output: z.object({ agentTools: z.boolean() }),
});

// ---------------------------------------------------------------------------
// Mission Control
// ---------------------------------------------------------------------------

/**
 * Writes the charter and records into the home, then starts Mission Control
 * there. Launching again while one is running is refused; adopt or archive it
 * first.
 */
export const launchCoordinator = defineRpc({
  name: "mission-control.coordinator.launch",
  input: z.object({
    provider: z.string().min(1),
    modeId: z.string().default(""),
  }),
  output: z.object({ agentId: z.string(), workspaceId: z.string().nullable() }),
});

/** Makes an existing agent Mission Control. Its cwd should be the home; the board says so when it is not. */
export const adoptCoordinator = defineRpc({
  name: "mission-control.coordinator.adopt",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ config: MissionControlConfigSchema }),
});

/** Forgets Mission Control without touching the agent. */
export const releaseCoordinator = defineRpc({
  name: "mission-control.coordinator.release",
  input: z.object({}),
  output: z.object({ config: MissionControlConfigSchema }),
});

/** Agents that could be adopted: every live agent, those in the home first. */
export const listCandidates = defineRpc({
  name: "mission-control.coordinator.candidates",
  input: z.object({}),
  output: z.object({ home: z.string(), agents: z.array(AgentSummarySchema) }),
});

/**
 * Marks Mission Control as seen, the way looking at it in Paseo does: its
 * "finished" or "error" flag is cleared, so its workspace reads as done in
 * the sidebar. A Mission Control agent waiting on a permission keeps its flag — that is
 * the user's prompt to answer it.
 */
export const markCoordinatorSeen = defineRpc({
  name: "mission-control.coordinator.seen",
  input: z.object({}),
  output: z.object({ cleared: z.boolean() }),
});

/**
 * Starts Mission Control afresh: the current one is archived — its
 * conversation stays in Paseo's history — and a new one is launched in the
 * home with the same model, mode and thinking, told that it is taking over.
 * Its records carry what the old one knew.
 */
export const restartCoordinator = defineRpc({
  name: "mission-control.coordinator.restart",
  input: z.object({}),
  output: z.object({ agentId: z.string(), workspaceId: z.string().nullable() }),
});

/**
 * Asks Mission Control's provider to compact its context, with the same
 * `/compact` Paseo's own composer sends. Refused while a turn is running: a
 * slash command is a turn of its own, not a message to join one.
 */
export const compactCoordinator = defineRpc({
  name: "mission-control.coordinator.compact",
  input: z.object({}),
  output: z.object({ agentId: z.string() }),
});

/** Delivers the user's words, and anything attached to them, to Mission Control. */
export const askCoordinator = defineRpc({
  name: "mission-control.coordinator.ask",
  input: UserMessageSchema,
  output: z.object({ agentId: z.string() }),
});

/** The requests the plugin words for the user; the server fills each from its template. */
export const CoordinatorCommandSchema = z.enum(["status", "catch-up"]);
export type CoordinatorCommand = z.infer<typeof CoordinatorCommandSchema>;

/**
 * Status or Catch up, from a button, ⌘K or a slash command. The words are the server's
 * (`templates/messages/`), which the app cannot read; `args` is what the user typed after the command.
 */
export const askCoordinatorCommand = defineRpc({
  name: "mission-control.coordinator.command",
  input: z.object({ command: CoordinatorCommandSchema, args: z.string().default("") }),
  output: z.object({ agentId: z.string() }),
});

// ---------------------------------------------------------------------------
// One crewmate
// ---------------------------------------------------------------------------

const crewInput = z.object({ agentId: z.string().min(1), serverId: z.string().min(1).nullable().default(null) });

/** Words straight to a crewmate. Authoritative, like the user typing into its tab. */
export const steerCrew = defineRpc({
  name: "mission-control.crew.steer",
  input: crewInput.extend({ text: z.string().min(1) }),
  output: z.object({}),
});

/** Stops the crewmate's current turn; the agent and its worktree stay. */
export const interruptCrew = defineRpc({
  name: "mission-control.crew.interrupt",
  input: crewInput,
  output: z.object({}),
});

/**
 * Ends the crewmate: Paseo archives the agent. Its workspace and worktree are
 * left exactly as they are — nothing is torn down or discarded.
 */
export const exitCrew = defineRpc({
  name: "mission-control.crew.exit",
  input: crewInput,
  output: z.object({}),
});

/**
 * A fresh crewmate in the same worktree. Mission Control does it, because it
 * owns the brief and the backlog; this only carries the user's note.
 */
export const relaunchCrew = defineRpc({
  name: "mission-control.crew.relaunch",
  input: crewInput.extend({ note: z.string().min(1) }),
  output: z.object({ agentId: z.string() }),
});
