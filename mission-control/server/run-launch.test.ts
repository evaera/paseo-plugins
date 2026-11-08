import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_EXIT_MARKER, matchProject, parseExitCode, powershellLiteral, powershellWrapper, runLaunch, runTail, type RunProject } from "./run-launch";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-run-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a run's launch on macOS and Linux", () => {
  it("hands the command over as its own argument, never inside the script", () => {
    const command = `echo "it's $HOME" && exit 3`;
    const launch = runLaunch(command, "/tmp/x.code", "darwin", "/bin/zsh");
    expect(launch.command).toBe("/bin/zsh");
    expect(launch.args.slice(0, 2)).toEqual(["-l", "-c"]);
    expect(launch.args[2]).not.toContain(command);
    expect(launch.args.slice(3)).toEqual(["/bin/zsh", command, "/tmp/x.code", "/bin/zsh"]);
  });

  it("wraps in /bin/sh for a shell that does not speak sh, and stays in the user's shell after", () => {
    const launch = runLaunch("ls", "/tmp/x.code", "linux", "/usr/bin/fish");
    expect(launch.command).toBe("/bin/sh");
    expect(launch.args.at(-1)).toBe("/usr/bin/fish");
    expect(runLaunch("ls", "/tmp/x.code", "linux", "").command).toBe("/bin/sh");
  });

  it.skipIf(process.platform === "win32")("runs the command exactly, records its exit code and prints the closing line", () => {
    const dir = scratch();
    const status = join(dir, "run.code");
    // `exit` inside the command ends only the command, not the wrapper that records it.
    const command = `printf '%s\\n' 'a "quoted" $word' && cd / && exit 7`;
    const launch = runLaunch(command, status, process.platform, "/bin/sh");
    // `true` in place of the interactive shell the terminal is handed afterwards.
    const args = [...launch.args.slice(0, -1), "true"];
    const result = spawnSync(launch.command, args, { cwd: dir, encoding: "utf8" });
    expect(result.stdout).toContain('a "quoted" $word');
    expect(result.stdout).toContain(`${RUN_EXIT_MARKER} 7`);
    expect(readFileSync(status, "utf8")).toBe("7");
  });
});

describe("a run's launch on Windows", () => {
  it("is PowerShell with the script base64-encoded, so no quoting reaches the command line", () => {
    const launch = runLaunch(`echo "a" 'b'`, "C:\\x\\run.code", "win32", "C:\\pwsh\\pwsh.exe");
    expect(launch.command).toBe("C:\\pwsh\\pwsh.exe");
    expect(launch.args.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-EncodedCommand"]);
    const script = Buffer.from(launch.args[3] ?? "", "base64").toString("utf16le");
    expect(script).toBe(powershellWrapper(`echo "a" 'b'`, "C:\\x\\run.code"));
    expect(launch.args[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("quotes the command as a literal nothing in it can escape", () => {
    expect(powershellLiteral("it's $env:HOME `n")).toBe("'it''s $env:HOME `n'");
    expect(powershellWrapper("echo 'x'; exit 2", "C:\\a'b\\run.code")).toContain(
      "Invoke-Expression 'echo ''x''; exit 2'",
    );
    expect(powershellWrapper("x", "C:\\a'b\\run.code")).toContain("-LiteralPath 'C:\\a''b\\run.code'");
  });

  it.skipIf(process.platform !== "win32")("runs the command exactly and records a native program's exit code", () => {
    const dir = scratch();
    const status = join(dir, "run.code");
    const command = "Write-Output \"a 'quoted' `$word\"; cmd /c exit 5";
    const encoded = Buffer.from(powershellWrapper(command, status), "utf16le").toString("base64");
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded], { cwd: dir, encoding: "utf8" });
    expect(result.stdout).toContain("a 'quoted' $word");
    expect(result.stdout).toContain(`${RUN_EXIT_MARKER} 5`);
    expect(readFileSync(status, "utf8")).toBe("5");
  });

  it.skipIf(process.platform !== "win32")("records a failing cmdlet as 1 and a clean run as 0", () => {
    const dir = scratch();
    const run = (command: string) => {
      const status = join(dir, `${Math.random()}.code`);
      const encoded = Buffer.from(powershellWrapper(command, status), "utf16le").toString("base64");
      spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-EncodedCommand", encoded], { cwd: dir, encoding: "utf8" });
      return readFileSync(status, "utf8");
    };
    expect(run("Get-Item -LiteralPath 'Z:\\nowhere\\at-all'")).toBe("1");
    expect(run("Write-Output ok")).toBe("0");
  });
});

describe("a run's project", () => {
  const project = (name: string, root: string, custom: string | null = null): RunProject => ({
    projectId: root,
    projectDisplayName: name,
    projectCustomName: custom,
    projectRootPath: root,
  });
  const projects = [project("fleetbound-godot", "C:\\dev\\fleetbound-godot"), project("home", "/x/plugin-data/mission-control/home", "Mission Control")];

  it("is found by its custom name, display name or folder, ignoring case", () => {
    expect(matchProject(projects, "Mission Control")).toEqual({ project: projects[1] });
    expect(matchProject(projects, "FLEETBOUND-godot")).toEqual({ project: projects[0] });
    expect(matchProject(projects, "home")).toEqual({ project: projects[1] });
  });

  it("is refused, naming Paseo's projects, when Paseo has none by that name", () => {
    const missing = matchProject(projects, "fleetbound");
    expect(missing).toEqual({ error: `"fleetbound" is not a Paseo project. Paseo has: fleetbound-godot, Mission Control.` });
  });

  it("is refused when two projects answer to the name", () => {
    const twins = [project("app", "/a/app"), project("app", "/b/app")];
    expect("error" in matchProject(twins, "app") && matchProject(twins, "app")).toBeTruthy();
    expect(matchProject([...twins, project("App", "/c/x")], "App")).toEqual({ project: expect.objectContaining({ projectRootPath: "/c/x" }) });
  });
});

describe("a run's status", () => {
  it("reads the tail up to the closing line, blank lines left out", () => {
    const lines = ["$ godot", "Godot Engine v4.4", "", "Loaded scene", `${RUN_EXIT_MARKER} 0`, "PS C:\\dev>"];
    expect(runTail(lines, 4)).toEqual(["$ godot", "Godot Engine v4.4", "Loaded scene"]);
    expect(runTail(["a", "b", "c", "d", "e"], 2)).toEqual(["d", "e"]);
  });

  it("reads an exit code only once the file holds one", () => {
    expect(parseExitCode("")).toBeNull();
    expect(parseExitCode("0")).toBe(0);
    expect(parseExitCode("-1073741510\r\n")).toBe(-1073741510);
    expect(parseExitCode("12x")).toBeNull();
  });
});
