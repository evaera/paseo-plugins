import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { ToolbarSchema } from "../shared/toolbar";
import type { PaseoApi } from "./host-types";
import type { Runs } from "./runs";
import { hasToolbarAction, runToolbarAction, substituteToolbarVariables } from "./toolbar";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, output: string) => void;
      callback(null, "");
    }),
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      Object.assign(child, { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }),
  };
});

describe("toolbar configuration", () => {
  it("loads both placements and nested buttons with per-action terminal selection", () => {
    expect(ToolbarSchema.parse({})).toEqual({ missionControl: [], workspaces: [] });
    const action = { type: "run", label: "Build", command: "npm run build", terminal: "paseo" };
    const menu = { type: "menu", label: "Tools", items: [{ type: "group", items: [action] }] };
    expect(ToolbarSchema.parse({ workspaces: [menu] }).workspaces).toEqual([menu]);
    expect(ToolbarSchema.safeParse({ missionControl: [{ ...menu, command: "unexpected" }] }).success).toBe(false);
  });

  it("matches actions in nested menus and rejects stale or differently scoped commands", () => {
    const action = { type: "run", label: "Build", command: "npm run build" } as const;
    const toolbar = ToolbarSchema.parse({
      workspaces: [{ type: "menu", label: "Tools", items: [{ type: "group", items: [action] }] }],
    });
    expect(hasToolbarAction(toolbar.workspaces, { ...action })).toBe(true);
    expect(hasToolbarAction(toolbar.missionControl, action)).toBe(false);
    expect(hasToolbarAction(toolbar.workspaces, { ...action, command: "npm run publish" })).toBe(false);
  });

  it("quotes command variables for each shell and inserts plain text in prompts", () => {
    const variables = { "workspace.path": "some dir/Pat's app" };
    expect(substituteToolbarVariables("open {{workspace.path}}", variables)).toBe("open some dir/Pat's app");
    expect(substituteToolbarVariables("open {{workspace.path}}", variables, "powershell"))
      .toBe("open 'some dir/Pat''s app'");
    expect(substituteToolbarVariables("open {{workspace.path}}", variables, "posix"))
      .toBe("open 'some dir/Pat'\"'\"'s app'");
    expect(() => substituteToolbarVariables("open {{workspace.name}}", variables)).toThrow("workspace.name");
  });

  it("uses the current workspace as terminal owner and interpolates its name", async () => {
    const workspace = {
      id: "current", directory: "/scratch/current", name: "Current space", projectId: null,
      refresh: async () => ({}),
    };
    const paseo = { workspaces: { ref: () => workspace } } as unknown as PaseoApi;
    const startTerminal = vi.fn(async () => ({ workspaceId: "current", terminalId: "new-terminal" }));
    const runs = { startTerminal } as unknown as Runs;
    const sendPrompt = vi.fn(async () => {});
    await expect(runToolbarAction(paseo, runs, "/mc", "current", {
      type: "run", label: "Play", command: "echo {{workspace.name}}", terminal: "paseo",
    }, sendPrompt)).resolves.toEqual({ workspaceId: "current", terminalId: "new-terminal" });
    expect(startTerminal).toHaveBeenCalledWith(paseo, "/scratch/current", null, "echo 'Current space'", workspace, "Play");
    await runToolbarAction(paseo, runs, "/mc", "current", {
      type: "prompt", label: "Review", prompt: "Review {{workspace.name}}.",
    }, sendPrompt);
    expect(sendPrompt).toHaveBeenCalledWith("Review Current space.");
  });

  it("defaults to a visible system terminal and keeps none detached and hidden", async () => {
    const paseo = {} as PaseoApi;
    const runs = {} as Runs;
    const action = { type: "run", label: "Play", command: "echo ready" } as const;
    const notify = vi.fn(async () => {});
    vi.mocked(spawn).mockClear();
    vi.mocked(execFile).mockClear();

    await runToolbarAction(paseo, runs, "/mc", null, action, notify);
    await runToolbarAction(paseo, runs, "/mc", null, { ...action, terminal: "none" }, notify);

    if (process.platform === "win32") {
      const args = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
      const launcher = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
      expect(launcher).toContain("-WindowStyle Normal");
      expect(launcher).toContain("-WorkingDirectory '/mc'");
      expect(spawn).toHaveBeenCalledTimes(1);
    } else {
      expect(spawn).toHaveBeenNthCalledWith(1, expect.any(String), expect.any(Array),
        { cwd: "/mc", detached: true, stdio: "ignore", windowsHide: false });
    }
    expect(spawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array),
      { cwd: "/mc", detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
  });

});
