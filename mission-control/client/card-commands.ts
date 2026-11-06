/**
 * What an open card offers, by the column it is in. Pure.
 *
 * Three tiers, drawn differently so the card reads as a decision rather than
 * a list:
 *
 * - **Choices**: what the column is asking the user to decide, first one
 *   the likeliest. Idle asks "keep going, wait on someone, or done?"; Inbox
 *   asks "start it?". Most are requests to Mission Control, worded
 *   `<task id> — <title>: <request>` so it knows which task is meant, because
 *   it owns the backlog and the briefs.
 * - **Tools**: what can be done to the worker itself: interrupt it, straight
 *   to it, or relaunch it, through Mission Control. Talking to it is the open
 *   card's chat box, and watching it is the open card.
 * - **Removal**: End the worker, or Drop a task that has none, set apart.
 */
import type { ColumnId, FleetCard } from "../shared/fleet";

export type Tool = "interrupt" | "relaunch";

export type Choice =
  | { kind: "ask"; icon: string; label: string; prompt: string }
  /** Asks who or what it waits on, then tells Mission Control. */
  | { kind: "wait"; icon: string; label: string }
  /** Asks for a note, then has Mission Control relaunch the worker (`relaunchCrew`). */
  | { kind: "relaunch"; icon: string; label: string };

export interface CardMenu {
  choices: Choice[];
  tools: Tool[];
  removal: "end" | "drop" | null;
}

const TOOLS: Readonly<Record<ColumnId, readonly Tool[]>> = {
  queued: [],
  working: ["interrupt"],
  blocked: [],
  idle: ["relaunch"],
  waiting: [],
  parked: ["relaunch"],
  failed: [],
  done: [],
};

/** How Mission Control is told which task a request is about: `<id> — <title>`, or the worker. */
export function subject(card: FleetCard): string {
  if (card.backlog !== null) return `${card.backlog.id} — ${card.backlog.title}`;
  const agent = card.agent;
  if (agent === null) return card.title;
  const where = agent.host === null ? "" : ` on ${agent.host}`;
  return `the worker "${card.title}" (agent ${agent.id}${where})`;
}

export function cardMenu(card: FleetCard): CardMenu {
  const about = subject(card);
  const ask = (icon: string, label: string, request: string): Choice => ({
    kind: "ask",
    icon,
    label,
    prompt: `${about}: ${request}`,
  });
  const wait: Choice = { kind: "wait", icon: "Hourglass", label: "Waiting on…" };
  const relaunch: Choice = { kind: "relaunch", icon: "RotateCcw", label: "Relaunch" };
  const done = (request: string) => ask("Check", "Mark done", request);
  const backToWork = ask("Play", "Back to work", "this is moving again. Check where it stands and take the next step.");

  if (card.agent === null) {
    const choices: Choice[] = (() => {
      switch (card.column) {
        case "queued":
          return [ask("Play", "Start", "start this now.")];
        case "idle":
          return [
            ask("RotateCcw", "Restart", "this is in flight but no worker is running it. Relaunch it from its brief."),
            wait,
            done("this is finished. Move it to Done."),
          ];
        case "waiting":
          return [backToWork, done("this is finished. Move it to Done.")];
        case "done":
          return [ask("Undo2", "Reopen", "this is not finished. Reopen it and move it back to Queued.")];
        default:
          return [];
      }
    })();
    return { choices, tools: [], removal: card.column === "done" ? null : "drop" };
  }

  const wrapUp = done("this is finished. Wrap it up: end the worker and move the task to Done.");
  const choices: Choice[] = (() => {
    switch (card.column) {
      case "idle":
        return [
          ask("Play", "Keep going", "the worker stopped. Check what it did and get it going on the next step."),
          wait,
          wrapUp,
        ];
      case "waiting":
        return [backToWork, wrapUp];
      case "parked":
        return [ask("Play", "Resume", "resume this, carrying on where the worker stopped."), wait];
      case "failed":
        return [relaunch];
      default:
        return [];
    }
  })();
  return { choices, tools: [...TOOLS[card.column]], removal: "end" };
}

/** What Mission Control is told when the user says a task waits on someone. */
export function waitingPrompt(card: FleetCard, on: string): string {
  return `${subject(card)}: nothing is left for us to do; it is waiting on ${on.trim()}. Mark it waiting.`;
}

/** What Mission Control is told when the user drops a task. */
export function dropPrompt(card: FleetCard): string {
  return `${subject(card)}: drop this task and take it off the backlog.`;
}

/** A draft an action needs before it goes: words, or a confirmation. The card's view opens on it. */
export type DraftKind = "wait" | "relaunch" | "end" | "drop";

export type MenuAct =
  | { kind: "ask"; prompt: string }
  | { kind: "interrupt" }
  | { kind: "draft"; draft: DraftKind }
  | { kind: "debrief"; view: "diff" | "story" };

export interface MenuItem {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  act: MenuAct;
}

/**
 * A card's context menu: everything its open view offers, in groups. What
 * needs words or a confirmation opens the view on that draft, so nothing that
 * ends or drops anything happens from a stray click.
 */
export function contextMenu(card: FleetCard, canTell: boolean): MenuItem[][] {
  const menu = cardMenu(card);
  const actions = canTell ? (card.backlog?.actions ?? []) : [];
  const decide: MenuItem[] = [
    ...actions.map((action, index) => ({
      id: `action:${index}`,
      icon: "Send",
      label: action.label,
      act: { kind: "ask" as const, prompt: action.prompt },
    })),
    ...menu.choices.flatMap((choice): MenuItem[] => {
      if (choice.kind === "ask") {
        return canTell ? [{ id: `ask:${choice.label}`, icon: choice.icon, label: choice.label, act: { kind: "ask", prompt: choice.prompt } }] : [];
      }
      if (choice.kind === "wait" && !canTell) return [];
      const label = choice.kind === "relaunch" ? "Relaunch…" : choice.label;
      return [{ id: `draft:${choice.kind}`, icon: choice.icon, label, act: { kind: "draft", draft: choice.kind } }];
    }),
  ];
  const tools: MenuItem[] = menu.tools.map((tool) =>
    tool === "interrupt"
      ? { id: "interrupt", icon: "Square", label: "Interrupt", act: { kind: "interrupt" } }
      : { id: "draft:relaunch", icon: "RotateCcw", label: "Relaunch…", act: { kind: "draft", draft: "relaunch" } },
  );
  const removal: MenuItem[] =
    menu.removal === "end"
      ? [{ id: "end", icon: "Power", label: "End worker…", danger: true, act: { kind: "draft", draft: "end" } }]
      : menu.removal === "drop" && canTell
        ? [{ id: "drop", icon: "Trash2", label: "Drop task…", danger: true, act: { kind: "draft", draft: "drop" } }]
        : [];
  // What the worker changed, in Debrief, for a worker on this Mac with changes.
  const review: MenuItem[] =
    card.debrief === undefined
      ? []
      : [
          { id: "debrief:diff", icon: "FileDiff", label: "View diff", act: { kind: "debrief", view: "diff" } },
          ...(card.debrief.story ? [{ id: "debrief:story", icon: "BookOpen", label: "View story", act: { kind: "debrief" as const, view: "story" as const } }] : []),
        ];
  // Opening and the chat are a click and the card's own button away, so the menu keeps to what acts.
  return [review, decide, tools, removal].filter((group) => group.length > 0);
}

/** What Mission Control is told when the user marks a task blocked by another. */
export function dependPrompt(card: FleetCard, other: { taskId: string; title: string }): string {
  return `${subject(card)}: this is blocked by ${other.taskId} — ${other.title}. Record it as (blocked-by: ${other.taskId}).`;
}

/** What it is told when the user removes the blocker. */
export function undependPrompt(card: FleetCard, otherId: string): string {
  return `${subject(card)}: this is no longer blocked by ${otherId}. Take the blocked-by off its line.`;
}
