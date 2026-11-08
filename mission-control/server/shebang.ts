/**
 * What runs a watch on Windows, which has no `#!` support of its own: the script's `#!` line, read and
 * resolved to a program the plugin launches with the script as its argument.
 *
 * - `#!/usr/bin/env <prog> [args]` (and `env -S`) runs `<prog>` found on PATH.
 * - `sh`, `bash` and `dash`, however named, run Git for Windows' shell: from PATH, else its usual
 *   install folders. `C:\Windows\System32\bash.exe` is skipped, since it is WSL's, and sees another
 *   filesystem.
 * - `#!<absolute path>` runs that path when it exists on this machine, else its basename from PATH.
 */
import { access, constants } from "node:fs/promises";
import { basename, join, win32 } from "node:path";

export interface Shebang {
  /** The program as written: a path, or a bare name for `env`. */
  program: string;
  args: string[];
  /** It was named through `env`, so it is looked up on PATH. */
  viaEnv: boolean;
}

/** The interpreter a script's first line names, or null when it has no usable `#!` line. */
export function parseShebang(text: string): Shebang | null {
  if (!text.startsWith("#!")) return null;
  const line = text.slice(2).split(/\r?\n/, 1)[0] ?? "";
  const words = line.trim().split(/\s+/).filter((word) => word !== "");
  const first = words[0];
  if (first === undefined) return null;
  if (basename(first.replace(/\\/g, "/")) === "env") {
    const rest = words.slice(1);
    // `env -S` splits the rest into words, which this already has; other env flags are not supported.
    if (rest[0] === "-S") rest.shift();
    const program = rest[0];
    if (program === undefined || program.startsWith("-")) return null;
    return { program, args: rest.slice(1), viaEnv: true };
  }
  return { program: first, args: words.slice(1), viaEnv: false };
}

const SHELLS = new Set(["sh", "bash", "dash"]);

/** Git for Windows' install folders, where `sh.exe` and `bash.exe` live under `bin\`. */
function gitShellDirs(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
  return roots
    .filter((root): root is string => root !== undefined && root !== "")
    .flatMap((root) => [win32.join(root, "Git", "bin"), win32.join(root, "Git", "usr", "bin")]);
}

/** An environment variable by name, case-insensitively, as Windows treats them (`Path`, `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type Exists = (path: string) => Promise<boolean>;

/** `name` in the first of `dirs` that has it, trying each PATHEXT extension; null when none does. */
async function findIn(dirs: string[], name: string, env: NodeJS.ProcessEnv, has: Exists): Promise<string | null> {
  const extensions = /\.[^\\/.]+$/.test(name)
    ? [""]
    : (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = win32.join(dir, name + ext);
      if (await has(candidate)) return candidate;
    }
  }
  return null;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, "PATH") ?? "").split(";").filter((dir) => dir !== "");
}

export interface Launcher {
  command: string;
  args: string[];
}

/**
 * The command that runs `script` on Windows by its `#!` line, or the reason it cannot be run there.
 * `has` is the filesystem check, swapped out by tests.
 */
export async function windowsLauncher(
  head: string,
  script: string,
  env: NodeJS.ProcessEnv,
  has: Exists = exists,
): Promise<Launcher | { invalid: string }> {
  const shebang = parseShebang(head);
  if (shebang === null) return { invalid: "it has no #! line saying what runs it" };
  const name = basename(shebang.program.replace(/\\/g, "/")).replace(/\.exe$/i, "");
  let command: string | null;
  if (SHELLS.has(name.toLowerCase())) {
    const onPath = pathDirs(env).filter((dir) => !/\\windows\\system32\\?$/i.test(dir));
    command = (await findIn(onPath, name, env, has)) ?? (await findIn(gitShellDirs(env), name, env, has));
    if (command === null && name !== "sh") {
      command = (await findIn(onPath, "sh", env, has)) ?? (await findIn(gitShellDirs(env), "sh", env, has));
    }
    if (command === null) {
      return { invalid: `its #! line asks for ${name}, and no sh was found (install Git for Windows, or put its sh on PATH)` };
    }
  } else if (!shebang.viaEnv && win32.isAbsolute(shebang.program) && (await has(shebang.program))) {
    command = shebang.program;
  } else {
    command = await findIn(pathDirs(env), name, env, has);
    if (command === null) return { invalid: `its #! line asks for ${name}, which is not on PATH` };
  }
  return { command, args: [...shebang.args, script] };
}
