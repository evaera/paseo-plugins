import { describe, expect, it } from "vitest";

import { parseShebang, windowsLauncher } from "./shebang";

describe("parseShebang", () => {
  it("reads env programs, env -S, absolute paths and their arguments", () => {
    expect(parseShebang("#!/usr/bin/env node\n// schedule: * * * * *\n")).toEqual({ program: "node", args: [], viaEnv: true });
    expect(parseShebang("#!/usr/bin/env -S deno run -A\r\n")).toEqual({ program: "deno", args: ["run", "-A"], viaEnv: true });
    expect(parseShebang("#! /bin/sh -e\n")).toEqual({ program: "/bin/sh", args: ["-e"], viaEnv: false });
    expect(parseShebang("#!/usr/local/bin/python3")).toEqual({ program: "/usr/local/bin/python3", args: [], viaEnv: false });
  });

  it("has nothing for a script without a usable #! line", () => {
    expect(parseShebang("# schedule: * * * * *\n")).toBeNull();
    expect(parseShebang("#!\n")).toBeNull();
    expect(parseShebang("#!/usr/bin/env\n")).toBeNull();
    expect(parseShebang("#!/usr/bin/env -i node\n")).toBeNull();
  });
});

describe("windowsLauncher", () => {
  const files = (...paths: string[]) => {
    const set = new Set(paths.map((path) => path.toLowerCase()));
    return async (path: string) => set.has(path.toLowerCase());
  };
  const env = { Path: String.raw`C:\nodejs;C:\Windows\System32`, PATHEXT: ".exe;.cmd", ProgramFiles: String.raw`C:\Program Files` };
  const node = String.raw`C:\nodejs\node.exe`;
  const gitSh = String.raw`C:\Program Files\Git\bin\sh.exe`;
  const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
  const wslBash = String.raw`C:\Windows\System32\bash.exe`;

  it("runs an env program from PATH, with its arguments before the script", async () => {
    expect(await windowsLauncher("#!/usr/bin/env node --no-warnings\n", "pr-watch", env, files(node))).toEqual({
      command: node,
      args: ["--no-warnings", "pr-watch"],
    });
  });

  it("runs sh and bash with Git for Windows' shell, never WSL's bash", async () => {
    const has = files(wslBash, gitBash, gitSh);
    expect(await windowsLauncher("#!/bin/sh\n", "s", env, has)).toEqual({ command: gitSh, args: ["s"] });
    expect(await windowsLauncher("#!/usr/bin/env bash\n", "s", env, has)).toEqual({ command: gitBash, args: ["s"] });
    expect(await windowsLauncher("#!/bin/bash\n", "s", env, files(wslBash, gitSh))).toEqual({ command: gitSh, args: ["s"] });
  });

  it("says why when no shell, program or #! line is there", async () => {
    expect(await windowsLauncher("#!/bin/sh\n", "s", env, files(wslBash))).toEqual({
      invalid: expect.stringMatching(/no sh was found/),
    });
    expect(await windowsLauncher("#!/usr/bin/env ruby\n", "s", env, files())).toEqual({
      invalid: expect.stringMatching(/ruby, which is not on PATH/),
    });
    expect(await windowsLauncher("echo hi\n", "s", env, files())).toEqual({ invalid: expect.stringMatching(/no #! line/) });
  });

  it("runs an absolute path that exists, else its basename from PATH", async () => {
    const lua = String.raw`C:\Tools\lua.exe`;
    expect(await windowsLauncher(`#!${lua}\n`, "s", env, files(lua))).toEqual({ command: lua, args: ["s"] });
    expect(await windowsLauncher("#!/usr/bin/node\n", "s", env, files(node))).toEqual({ command: node, args: ["s"] });
  });
});
