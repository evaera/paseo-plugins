/**
 * The `[[run: …]]` embeds' commands, each in a Paseo terminal of its own (see `./run-launch` for why the
 * terminal runs a wrapper, and what it is). The terminal belongs to the project's root workspace, or the
 * home's, so the user can open it in Paseo, watch it, type into it and close it; the chat's pill polls
 * `runStatus` for the exit code and the last lines.
 *
 * Runs are kept in memory: after a plugin reload a pill asks about a run this process never started and
 * hears `unknown`, while the terminal itself carries on in Paseo. Exit codes go to
 * `plugin-data/mission-control/runs/<run id>.code`, swept after a day.
 */
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { pluginDir } from "./data-dir";
import type { PaseoApi } from "./host-types";
import { matchProject, parseExitCode, runLaunch, runTail } from "./run-launch";

export const TAIL_LINES = 4;
/** How far back from the terminal's end the tail is read: enough for the closing line and what came before it. */
const CAPTURE_LINES = 80;
const STALE_MS = 24 * 60 * 60 * 1000;

interface Run {
  terminalId: string;
  workspaceId: string;
  statusFile: string;
  /** The last tail read, kept for when the terminal is gone and cannot be read again. */
  tail: string[];
  exitCode: number | null;
}

export interface RunStatus {
  state: "running" | "finished" | "closed" | "unknown";
  exitCode: number | null;
  tail: string[];
}

function runsDir(): string {
  return join(pluginDir(), "runs");
}

async function sweep(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - STALE_MS;
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info !== null && info.mtimeMs < cutoff) await rm(path, { force: true });
    }),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** PowerShell 7 when it is on `PATH`, else Windows PowerShell, which every Windows has. */
async function windowsPowerShell(env: NodeJS.ProcessEnv): Promise<string> {
  const dirs = (env.PATH ?? env.Path ?? "").split(";").filter((dir) => dir !== "");
  for (const dir of dirs) {
    const candidate = join(dir, "pwsh.exe");
    if (await exists(candidate)) return candidate;
  }
  return join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function terminalName(command: string): string {
  return command.length <= 40 ? `Run: ${command}` : `Run: ${command.slice(0, 39)}…`;
}

export class Runs {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly home: () => Promise<string>) {}

  async start(
    paseo: PaseoApi,
    project: string | null,
    command: string,
  ): Promise<{ runId: string; workspaceId: string; terminalId: string; cwd: string; projectName: string | null }> {
    let cwd: string;
    let projectName: string | null = null;
    if (project === null) {
      cwd = await this.home();
    } else {
      const match = matchProject((await paseo.projects.list()).projects, project);
      if ("error" in match) throw new Error(match.error);
      cwd = match.project.projectRootPath;
      projectName = match.project.projectCustomName || match.project.projectDisplayName;
    }

    const dir = runsDir();
    await mkdir(dir, { recursive: true });
    void sweep(dir);
    const runId = randomUUID();
    const statusFile = join(dir, `${runId}.code`);
    const shell = process.platform === "win32" ? await windowsPowerShell(process.env) : (process.env.SHELL ?? "/bin/sh");
    const launch = runLaunch(command, statusFile, process.platform, shell);

    const workspace = await paseo.workspaces.open(cwd);
    const terminal = await workspace.terminals.create({ cwd, name: terminalName(command), command: launch.command, args: launch.args });
    this.runs.set(runId, { terminalId: terminal.id, workspaceId: workspace.id, statusFile, tail: [], exitCode: null });
    return { runId, workspaceId: workspace.id, terminalId: terminal.id, cwd, projectName };
  }

  async status(paseo: PaseoApi, runId: string): Promise<RunStatus> {
    const run = this.runs.get(runId);
    if (run === undefined) return { state: "unknown", exitCode: null, tail: [] };
    if (run.exitCode === null) {
      run.exitCode = parseExitCode(await readFile(run.statusFile, "utf8").catch(() => ""));
    }
    const open = (await paseo.terminals.list({ workspaceId: run.workspaceId })).entries.some((entry) => entry.id === run.terminalId);
    if (open) {
      try {
        const captured = await paseo.terminals.ref(run.terminalId).capture({ start: -CAPTURE_LINES, stripAnsi: true });
        run.tail = runTail(captured.lines, TAIL_LINES);
      } catch {
        // Closed between the listing and the capture: the last tail read stands.
      }
    }
    if (run.exitCode !== null) return { state: "finished", exitCode: run.exitCode, tail: run.tail };
    return { state: open ? "running" : "closed", exitCode: null, tail: run.tail };
  }

  async stop(paseo: PaseoApi, runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error("This run was started before the plugin last reloaded. Close its terminal in Paseo.");
    await paseo.terminals.ref(run.terminalId).kill();
  }
}
