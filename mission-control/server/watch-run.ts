/**
 * Runs one watch script: as it is, by its `#!` line, with its own process group so a timeout takes its
 * children (`gh`, `curl`) with it. Once a run is stopped — timed out, or the plugin shutting down — the
 * group gets SIGTERM and, after the grace period, SIGKILL whatever has happened in between: the script
 * exiting on SIGTERM does not mean a child that ignores it, and has let go of the pipes, is gone too.
 *
 * Windows has neither `#!` support nor process groups, so there the script is handed to the interpreter its
 * `#!` line names (`shebang.ts`), and a stop takes the whole process tree at once with `taskkill /T /F`.
 *
 * What it prints is kept up to a cap and read to the end regardless, so a chatty script never blocks on
 * a full pipe; stderr is kept as its last lines, which is where an error usually is.
 */
import { spawn, type spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import crossSpawn from "cross-spawn";

import { windowsLauncher, type Launcher } from "./shebang";

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** The most of stdout kept, in bytes. */
  maxOutputBytes: number;
  /** The most of stderr kept, from its end, in bytes. */
  maxErrorBytes: number;
  /** After a timeout's SIGTERM, how long before SIGKILL. */
  killGraceMs?: number;
  /** Stops the script as a timeout would, for a plugin that is shutting down. */
  signal?: AbortSignal;
}

export interface RunResult {
  /** The exit code, or null when a signal ended it or it never started. */
  code: number | null;
  timedOut: boolean;
  stdout: string;
  /** stdout went past `maxOutputBytes` and was cut there. */
  truncated: boolean;
  stderr: string;
  /** Why it did not start — not found, not executable — or null. */
  spawnError: string | null;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Forced from the first signal: a console program ignores taskkill's polite close, and /T can find
    // the children only while their parent is still alive to link them.
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

const NOT_STARTED = { code: null, timedOut: false, stdout: "", truncated: false, stderr: "" } as const;

export async function runWatchScript(path: string, options: RunOptions): Promise<RunResult> {
  if (process.platform !== "win32") return runProcess({ command: path, args: [] }, options);
  let head: string;
  try {
    head = (await readFile(path, "utf8")).slice(0, 4096);
  } catch (error) {
    return { ...NOT_STARTED, spawnError: error instanceof Error ? error.message : String(error) };
  }
  const launcher = await windowsLauncher(head, path, options.env);
  if ("invalid" in launcher) return { ...NOT_STARTED, spawnError: `it cannot run: ${launcher.invalid}` };
  return runProcess(launcher, options);
}

function runProcess(launcher: Launcher, options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    // An abort that has already happened is never replayed to a listener added now, so check it here.
    if (options.signal?.aborted === true) {
      resolve({ ...NOT_STARTED, spawnError: "the plugin stopped" });
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const windows = process.platform === "win32";
    // cross-spawn runs a .cmd or .bat interpreter through cmd.exe, which plain spawn refuses to.
    const child = (windows ? (crossSpawn as typeof nodeSpawn) : spawn)(launcher.command, launcher.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // On Windows a detached child gets a console of its own, and there are no groups to lead.
      detached: !windows,
      windowsHide: true,
    });

    let killTimer: NodeJS.Timeout | undefined;
    function stop(): void {
      if (killTimer !== undefined) return;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), options.killGraceMs ?? 2000);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const room = options.maxOutputBytes - stdoutBytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      stdout.push(kept);
      stdoutBytes += kept.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > options.maxErrorBytes) stderr = stderr.subarray(stderr.length - options.maxErrorBytes);
    });

    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A pending SIGKILL is left to fire: it is for the group, not for the script alone.
      options.signal?.removeEventListener("abort", abort);
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        truncated,
        stderr: stderr.toString("utf8"),
        spawnError,
      });
    }

    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    // taskkill /F leaves exit code 1 where a POSIX signal leaves none; a stopped run reports null either way.
    child.on("close", (code) => finish(windows && killTimer !== undefined ? null : code));
    if (windows) {
      // An MSYS shell's forked children record parents that have already exited, so /T misses them and
      // they can hold the pipes open long after the script is gone. A stopped run ends with the script.
      child.on("exit", () => {
        if (killTimer === undefined) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      });
    }
  });
}
