/**
 * Where a worker stands, as one icon, word and tone, shared by a card's state
 * line and the worker's header over its transcript. Pure.
 *
 * What Paseo knows wins while the worker is busy or stuck — an error, a
 * permission, a turn in flight — and once its turn has ended, the status line
 * it ended on says it: done, blocked, paused. A worker that stopped without
 * one is Idle.
 */
import type { AgentSummary, CrewReportSummary } from "../shared/fleet";

export type StateTone = "success" | "warning" | "danger" | "accent" | "muted";

export interface WorkerState {
  icon: string;
  label: string;
  tone: StateTone;
}

export function workerState(
  agent: Pick<AgentSummary, "status" | "pendingPermissions">,
  report: CrewReportSummary | null,
): WorkerState {
  if (agent.status === "error") return { icon: "CircleAlert", label: "Error", tone: "danger" };
  if (agent.pendingPermissions > 0) return { icon: "Hand", label: "Needs you", tone: "warning" };
  if (agent.status === "initializing") return { icon: "Zap", label: "Starting", tone: "success" };
  if (agent.status === "running") return { icon: "Zap", label: "Working", tone: "success" };
  switch (report?.state) {
    case "done":
      return { icon: "CircleCheck", label: "Done", tone: "accent" };
    case "resolved":
      return { icon: "CircleCheck", label: "Resolved", tone: "accent" };
    case "blocked":
      return { icon: "Hand", label: "Blocked", tone: "warning" };
    case "needs-decision":
      return { icon: "Hand", label: "Needs a decision", tone: "warning" };
    case "paused":
      return { icon: "CirclePause", label: "Paused", tone: "muted" };
    case "failed":
      return { icon: "CircleAlert", label: "Failed", tone: "danger" };
    // Paseo's `requiresAttention` is "finished, not looked at yet" — its Ready to review — not a request,
    // so it says nothing here: a worker needs the user only with a permission waiting, as the columns judge it.
    default:
      return { icon: "CirclePause", label: "Idle", tone: "muted" };
  }
}
