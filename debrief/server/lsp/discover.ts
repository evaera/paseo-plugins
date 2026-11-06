/**
 * Finding a language server. Per language, the first match wins:
 *
 * 1. a command line set in Debrief's settings (split on whitespace, no shell);
 * 2. Mason's bin, `~/.local/share/nvim/mason/bin`, where Neovim users keep them;
 * 3. PATH as a login shell sees it, resolved once, because the daemon's own
 *    PATH is minimal;
 * 4. the project's own `node_modules/.bin`.
 *
 * The search itself is pure over an injected `isExecutable`, so the order is
 * tested without touching the disk.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import type { LanguageId } from "../../shared/settings";

export interface ServerCommand {
  command: string;
  args: string[];
}

export const DEFAULT_SERVERS: Record<LanguageId, ServerCommand[]> = {
  typescript: [
    { command: "vtsls", args: ["--stdio"] },
    { command: "typescript-language-server", args: ["--stdio"] },
  ],
  go: [{ command: "gopls", args: [] }],
  python: [
    { command: "basedpyright-langserver", args: ["--stdio"] },
    { command: "pyright-langserver", args: ["--stdio"] },
  ],
  rust: [{ command: "rust-analyzer", args: [] }],
  cpp: [{ command: "clangd", args: [] }],
  lua: [{ command: "lua-language-server", args: [] }],
};

export const LANGUAGE_NAMES: Record<LanguageId, string> = {
  typescript: "TypeScript",
  go: "Go",
  python: "Python",
  rust: "Rust",
  cpp: "C/C++",
  lua: "Lua",
};

export function masonBin(home: string = homedir()): string {
  return join(home, ".local", "share", "nvim", "mason", "bin");
}

export function parseCommandLine(line: string): ServerCommand | null {
  const parts = line.trim().split(/\s+/).filter((part) => part !== "");
  const [command, ...args] = parts;
  return command === undefined ? null : { command, args };
}

export interface DiscoverOptions {
  override: string | undefined;
  /** Directories searched in order, after the override. */
  searchDirs: readonly string[];
  isExecutable: (path: string) => Promise<boolean>;
}

/** The command to start, or null when no server for `language` was found. */
export async function discoverServer(language: LanguageId, options: DiscoverOptions): Promise<ServerCommand | null> {
  if (options.override !== undefined && options.override.trim() !== "") {
    const parsed = parseCommandLine(options.override);
    if (parsed === null) return null;
    if (isAbsolute(parsed.command)) return (await options.isExecutable(parsed.command)) ? parsed : null;
    for (const dir of options.searchDirs) {
      const full = join(dir, parsed.command);
      if (await options.isExecutable(full)) return { command: full, args: parsed.args };
    }
    return null;
  }
  for (const dir of options.searchDirs) {
    for (const candidate of DEFAULT_SERVERS[language]) {
      const full = join(dir, candidate.command);
      if (await options.isExecutable(full)) return { command: full, args: candidate.args };
    }
  }
  return null;
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let loginPath: Promise<string> | null = null;

/** PATH as the user's login shell sets it, asked once per daemon. Falls back to the daemon's own. */
export function resolveLoginPath(): Promise<string> {
  loginPath ??= new Promise((resolve) => {
    const fallback = process.env.PATH ?? "";
    const shell = process.env.SHELL ?? "/bin/zsh";
    let out = "";
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(shell, ["-lc", 'printf %s "$PATH"'], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      child.on("error", () => done(fallback));
      child.on("close", (code) => {
        const path = out.trim().split("\n").pop() ?? "";
        done(code === 0 && path !== "" ? path : fallback);
      });
    } catch {
      done(fallback);
    }
  });
  return loginPath;
}

/** The search directories for a workspace, in discovery order. */
export async function searchDirs(root: string): Promise<string[]> {
  const path = await resolveLoginPath();
  const dirs = [masonBin(), ...path.split(delimiter).filter((dir) => dir !== ""), join(root, "node_modules", ".bin")];
  return [...new Set(dirs)];
}
