import { execFile, spawn } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";

import type { ToolbarAction, ToolbarItem } from "../shared/toolbar";
import type { PaseoApi } from "./host-types";
import { matchProject, powershellLiteral } from "./run-launch";
import { windowsPowerShell, type Runs } from "./runs";

const runLauncher = promisify(execFile);

export function hasToolbarAction(items: readonly ToolbarItem[], action: ToolbarAction): boolean {
  return items.some((item) => item.type === "menu" || item.type === "group"
    ? hasToolbarAction(item.items, action)
    : isDeepStrictEqual(item, action));
}

function shellLiteral(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function substituteToolbarVariables(
  text: string,
  variables: Record<string, string | null | undefined>,
  shell?: "powershell" | "posix",
): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_placeholder, key: string) => {
    const value = Object.hasOwn(variables, key) ? variables[key] : undefined;
    if (value == null) throw new Error("Toolbar variable is unavailable: " + key);
    return shell === "powershell" ? powershellLiteral(value) : shell === "posix" ? shellLiteral(value) : value;
  });
}

function launchProcess(command: string, args: string[], cwd: string, visible: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: process.platform !== "win32", stdio: "ignore", windowsHide: !visible });
    child.on("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function launchSystem(command: string, cwd: string, mode: "floating" | "none"): Promise<void> {
  const visible = mode === "floating";
  if (process.platform === "win32") {
    const shell = await windowsPowerShell(process.env);
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    if (visible) {
      const args = ["-NoLogo", "-NoExit", "-EncodedCommand", encoded].map(powershellLiteral).join(", ");
      const start = `Start-Process -FilePath ${powershellLiteral(shell)} -WorkingDirectory ${powershellLiteral(cwd)} -ArgumentList @(${args}) -WindowStyle Normal -ErrorAction Stop`;
      await runLauncher(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(start, "utf16le").toString("base64")], {
        cwd, windowsHide: true, timeout: 15_000,
      });
    } else {
      // Windows PowerShell can exit without running its command when started detached.
      await launchProcess(shell, ["-NoLogo", "-NonInteractive", "-EncodedCommand", encoded], cwd, false);
    }
    return;
  }
  const shell = process.env.SHELL || "/bin/sh";
  if (!visible) {
    await launchProcess(shell, ["-lc", command], cwd, false);
    return;
  }
  if (process.platform === "darwin") {
    const launch = "cd " + shellLiteral(cwd) + " && " + shellLiteral(shell) + " -lc " + shellLiteral(command);
    const script = [
      "on run argv",
      'tell application "Terminal"',
      "do script (item 1 of argv)",
      "activate",
      "end tell",
      "end run",
    ];
    await launchProcess("/usr/bin/osascript", [...script.flatMap((line) => ["-e", line]), launch], cwd, true);
    return;
  }
  const launch = ["/bin/sh", "-c", '"$1" -lc "$2"; exec "$1" -i', "toolbar", shell, command];
  const emulators = [
    ["xdg-terminal-exec", "--"],
    ["x-terminal-emulator", "-e"],
    ["gnome-terminal", "--"],
    ["konsole", "-e"],
    ["xterm", "-e"],
  ] as const;
  for (const [program, separator] of emulators) {
    try {
      await launchProcess(program, [separator, ...launch], cwd, true);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("A floating terminal needs a desktop terminal emulator on the Paseo host.");
}

export async function runToolbarAction(
  paseo: PaseoApi,
  runs: Runs,
  home: string,
  workspaceId: string | null,
  action: ToolbarAction,
  sendPrompt: (text: string) => Promise<unknown>,
): Promise<{ workspaceId: string | null; terminalId: string | null }> {
  const workspace = workspaceId === null ? null : paseo.workspaces.ref(workspaceId);
  if (workspace !== null && await workspace.refresh() === null) throw new Error("This workspace is no longer available.");
  const projectName = action.type === "run" ? action.project : undefined;
  const projects = projectName !== undefined || workspace?.projectId
    ? (await paseo.projects.list()).projects
    : [];
  const match = projectName === undefined ? null : matchProject(projects, projectName);
  if (match !== null && "error" in match) throw new Error(match.error);
  const project = match?.project ?? projects.find((candidate) => candidate.projectId === workspace?.projectId);
  const cwd = match?.project.projectRootPath ?? workspace?.directory ?? home;
  const variables = {
    "workspace.id": workspace?.id,
    "workspace.path": workspace?.directory,
    "workspace.name": workspace?.name,
    "project.id": project?.projectId,
    "project.path": project?.projectRootPath,
    "project.name": project?.projectCustomName || project?.projectDisplayName,
    cwd,
    home,
  };

  if (action.type === "prompt") {
    await sendPrompt(substituteToolbarVariables(action.prompt, variables));
    return { workspaceId: null, terminalId: null };
  }
  const command = substituteToolbarVariables(action.command, variables, process.platform === "win32" ? "powershell" : "posix");
  const terminal = action.terminal ?? "floating";
  if (terminal === "paseo") {
    const started = await runs.startTerminal(paseo, cwd, variables["project.name"] ?? null, command, workspace, action.label);
    return { workspaceId: started.workspaceId, terminalId: started.terminalId };
  }
  await launchSystem(command, cwd, terminal);
  return { workspaceId: null, terminalId: null };
}
