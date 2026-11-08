/**
 * What a `[[run: …]]` embed's terminal is started with, and which Paseo project it names. Pure.
 *
 * A Paseo terminal is removed the moment its process exits, output and all, and the SDK reports no exit
 * code. So the terminal runs a small wrapper in a shell: it runs the command exactly as written, writes
 * the exit code to `statusFile` (which `server/runs.ts` polls), prints a closing line, and then hands the
 * terminal to an interactive shell, so the output stays on screen and the terminal stays usable.
 *
 * - **macOS and Linux:** `$SHELL` when it speaks POSIX `sh`, else `/bin/sh`, as a login shell so the
 *   user's `PATH` is there. The command arrives as `$1`, never spliced into the script, and is `eval`ed
 *   in a subshell. `trap : INT` gives the wrapper a handler rather than ignoring the signal: the subshell
 *   and the command reset a handler to the default (they would inherit an ignore), so Ctrl+C still stops
 *   the command, and the wrapper lives on to record the 130.
 * - **Windows:** PowerShell (`pwsh` when it is installed), handed the script as `-EncodedCommand`, which
 *   is base64 and survives Windows' command-line quoting untouched. The command is a single-quoted
 *   literal for `Invoke-Expression`, so only `'` needs escaping. A `finally` records the code even when
 *   Ctrl+C stops the pipeline, and `-NoExit` keeps the shell afterwards.
 */
import { basename } from "node:path";

/** What the wrapper prints when the command exits; `server/runs.ts` cuts the tail there. */
export const RUN_EXIT_MARKER = "[mission-control] exited with code";

export interface RunLaunch {
  command: string;
  args: string[];
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"]);

const POSIX_WRAPPER = [
  "trap : INT",
  // A subshell, so the command's own `exit` or `cd` cannot end or move the wrapper.
  '(eval "$1")',
  "mc_code=$?",
  `printf '%s' "$mc_code" > "$2"`,
  `printf '\\n${RUN_EXIT_MARKER} %s\\n' "$mc_code"`,
  'exec "$3" -i',
].join("\n");

/** A PowerShell single-quoted string: nothing inside is expanded, and `'` is written twice. */
export function powershellLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

export function powershellWrapper(command: string, statusFile: string): string {
  return [
    // Stays 130 only when Ctrl+C stops the pipeline before the code is read.
    "$mcCode = 130",
    "try {",
    "  $global:LASTEXITCODE = 0",
    // `$?` after Invoke-Expression says only that Invoke-Expression ran; a cmdlet's failure shows as a new error.
    "  $mcErrors = $Error.Count",
    `  Invoke-Expression ${powershellLiteral(command)}`,
    "  $mcCode = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($Error.Count -gt $mcErrors) { 1 } else { 0 }",
    "} catch {",
    "  $mcCode = 1",
    "  Write-Host $_ -ForegroundColor Red",
    "} finally {",
    `  Set-Content -LiteralPath ${powershellLiteral(statusFile)} -Value $mcCode -NoNewline -Encoding ascii`,
    '  Write-Host ""',
    `  Write-Host "${RUN_EXIT_MARKER} $mcCode"`,
    "}",
  ].join("\n");
}

/**
 * The program and arguments for the run's terminal. `shell` is the user's shell (`$SHELL`) on macOS and
 * Linux, and the PowerShell to use on Windows.
 */
export function runLaunch(command: string, statusFile: string, platform: NodeJS.Platform, shell: string): RunLaunch {
  if (platform === "win32") {
    const encoded = Buffer.from(powershellWrapper(command, statusFile), "utf16le").toString("base64");
    return { command: shell, args: ["-NoLogo", "-NoExit", "-EncodedCommand", encoded] };
  }
  const user = shell.trim() === "" ? "/bin/sh" : shell;
  const wrapper = POSIX_SHELLS.has(basename(user)) ? user : "/bin/sh";
  // After the script, `$0` is the wrapper itself; `$1` the command, `$2` the status file, `$3` the shell to stay in.
  return { command: wrapper, args: ["-l", "-c", POSIX_WRAPPER, wrapper, command, statusFile, user] };
}

/** A Paseo project, as `projects.list()` describes one. */
export interface RunProject {
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null | undefined;
  projectRootPath: string;
}

export type ProjectMatch = { project: RunProject } | { error: string };

function namesOf(project: RunProject): string[] {
  const folder = basename(project.projectRootPath.replace(/[\\/]+$/, ""));
  return [project.projectCustomName ?? "", project.projectDisplayName, folder].filter((name) => name !== "");
}

/**
 * The one project Paseo knows by `name`: its custom name, display name or folder, exactly first, then
 * ignoring case. Two projects answering to it, or none, is an error that says which projects there are.
 */
export function matchProject(projects: readonly RunProject[], name: string): ProjectMatch {
  const wanted = name.trim();
  const exact = projects.filter((project) => namesOf(project).includes(wanted));
  const loose =
    exact.length > 0 ? exact : projects.filter((project) => namesOf(project).some((candidate) => candidate.toLowerCase() === wanted.toLowerCase()));
  if (loose.length === 1 && loose[0] !== undefined) return { project: loose[0] };
  if (loose.length > 1) {
    return { error: `More than one Paseo project is called "${wanted}": ${loose.map((project) => project.projectRootPath).join(", ")}.` };
  }
  const known = projects.map((project) => project.projectCustomName || project.projectDisplayName).sort((a, b) => a.localeCompare(b));
  return {
    error:
      known.length === 0
        ? `"${wanted}" is not a Paseo project, and Paseo has none registered.`
        : `"${wanted}" is not a Paseo project. Paseo has: ${known.join(", ")}.`,
  };
}

/** The terminal's last non-blank lines before the wrapper's closing line, at most `count`. */
export function runTail(lines: readonly string[], count: number): string[] {
  let marker = lines.length - 1;
  while (marker >= 0 && !(lines[marker] ?? "").startsWith(RUN_EXIT_MARKER)) marker -= 1;
  const output = marker === -1 ? lines : lines.slice(0, marker);
  return output.filter((line) => line.trim() !== "").slice(-count);
}

/** The exit code a status file holds, or null while it holds none. */
export function parseExitCode(text: string): number | null {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : null;
}
