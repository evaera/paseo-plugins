import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CREW_LABELS } from "../shared/fleet";
import { readMissionControlConfig, resolveHome, updateMissionControlConfig } from "./config";
import type { PaseoApi } from "./host-types";
import { adoptCoordinator, askCoordinator, commandText, compactCoordinator, launchCoordinator, releaseCoordinator, restartCoordinator, restartNote } from "./coordinator";
import { prepareHome, readSuggestions } from "./home";
import { TEMPLATES, readTemplate, withoutNotes } from "./templates";

let paseoHome = "";
const previousHome = process.env.PASEO_HOME;

beforeEach(async () => {
  paseoHome = await mkdtemp(join(tmpdir(), "mission-control-coordinator-"));
  process.env.PASEO_HOME = paseoHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(paseoHome, { recursive: true, force: true });
});

interface Snapshot {
  id: string;
  provider: string;
  model: string | null;
  status: string;
  currentModeId: string | null;
  thinkingOptionId?: string | null;
  archivedAt: string | null;
}

/** Just enough of Paseo for Mission Control's lifecycle, recording what was asked of it in order. */
function fakePaseo(agents: Record<string, Snapshot>) {
  const calls: string[] = [];
  const sent: Array<{ agentId: string; text: string; options?: Record<string, unknown> | undefined }> = [];
  const created: Array<{ config: Record<string, unknown>; title?: string; labels?: Record<string, string>; prompt?: string }> = [];
  const paseo = {
    agents: {
      ref(id: string) {
        return {
          async refresh() {
            const agent = agents[id];
            if (agent === undefined) throw new Error(`Agent not found: ${id}`);
            return { agent };
          },
          async archive() {
            calls.push(`archive ${id}`);
            const agent = agents[id];
            if (agent !== undefined) agent.archivedAt = "2026-09-23T12:00:00.000Z";
          },
          async send(text: string, options?: Record<string, unknown>) {
            calls.push(`send ${id} ${text}`);
            sent.push({ agentId: id, text, options });
          },
        };
      },
    },
    workspaces: {
      // Naming the home's workspace is `home-name.test.ts`'s business; here it finds nothing to name.
      ref() {
        return { refresh: async () => null };
      },
      async open(cwd: string) {
        calls.push(`open ${cwd}`);
        return {
          id: "wks_home",
          agents: {
            async create(input: (typeof created)[number]) {
              calls.push("create");
              created.push(input);
              agents["new-coordinator"] = { ...oldCoordinator, id: "new-coordinator", status: "idle" };
              return { id: "new-coordinator" };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return { paseo, calls, created, sent };
}

const oldCoordinator: Snapshot = {
  id: "old-coordinator",
  provider: "claude",
  model: "claude-opus-5-5",
  status: "running",
  currentModeId: "bypassPermissions",
  thinkingOptionId: "high",
  archivedAt: null,
};

describe("restartCoordinator", () => {
  it("archives the old Mission Control before starting one set up the same way", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator", coordinatorProvider: "claude/claude-sonnet-5", coordinatorModeId: "" });
    const { paseo, calls, created } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });

    await expect(restartCoordinator(paseo)).resolves.toEqual({ agentId: "new-coordinator", workspaceId: "wks_home" });

    expect(calls[0]).toBe("archive old-coordinator");
    expect(calls.at(-1)).toBe("create");
    // The live agent's setup wins over the config's: it may have been changed in its own tab.
    expect(created[0]).toMatchObject({
      config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions", thinkingOptionId: "high" },
      labels: { [CREW_LABELS.role]: CREW_LABELS.coordinatorRole },
      prompt: `${withoutNotes(await readTemplate(TEMPLATES.opening))}\n\n${await restartNote()}`,
    });
    expect(await readMissionControlConfig()).toMatchObject({
      coordinatorAgentId: "new-coordinator",
      coordinatorProvider: "claude/claude-opus-5-5",
      coordinatorModeId: "bypassPermissions",
    });
  });

  it("refuses a Mission Control agent in the middle of a turn, and touches nothing", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const { paseo, calls } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "running" } });
    await expect(restartCoordinator(paseo)).rejects.toThrow("in the middle of a turn");
    expect(calls).toEqual([]);
    expect((await readMissionControlConfig()).coordinatorAgentId).toBe("old-coordinator");
  });

  it("says so when there is no Mission Control to restart", async () => {
    const { paseo, calls } = fakePaseo({});
    await expect(restartCoordinator(paseo)).rejects.toThrow("There is no Mission Control yet");
    expect(calls).toEqual([]);
  });
});

describe("changing Mission Control", () => {
  const other: Snapshot = { ...oldCoordinator, id: "other", status: "idle" };

  it("refuses an adoption that lands while a launch is starting a Mission Control agent", async () => {
    const { paseo, created } = fakePaseo({ other: { ...other } });
    const results = await Promise.allSettled([
      launchCoordinator(paseo, { provider: "claude/claude-sonnet-5", modeId: "" }),
      adoptCoordinator(paseo, "other"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/already running/);
    expect(created).toHaveLength(1);
    expect((await readMissionControlConfig()).coordinatorAgentId).toBe("new-coordinator");
  });

  it("applies a release that lands during a restart after it, not before", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const { paseo } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });
    await Promise.all([restartCoordinator(paseo), releaseCoordinator()]);
    expect((await readMissionControlConfig()).coordinatorAgentId).toBe("");
  });

  it("adopts an agent when the configured Mission Control is gone", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const { paseo } = fakePaseo({ other: { ...other } });
    await expect(adoptCoordinator(paseo, "other")).resolves.toMatchObject({ coordinatorAgentId: "other" });
  });
});

describe("the opening", () => {
  it("launches with the plugin's opening", async () => {
    const { paseo, created } = fakePaseo({});
    await launchCoordinator(paseo, { provider: "claude/claude-sonnet-5", modeId: "" });
    expect(created[0]?.prompt).toBe(withoutNotes(await readTemplate(TEMPLATES.opening)));
  });
});

describe("commandText", () => {
  it("words Status and Catch up as plain requests, with what followed the command", async () => {
    expect(await commandText("status", "")).toBe("Status, please.");
    expect(await commandText("status", " file include PRs ")).toBe("Status, please: file include PRs.");
    expect(await commandText("catch-up", "  ")).toBe("Catch me up.");
    expect(await commandText("catch-up", "and the deploy?")).toBe("Catch me up: and the deploy?");
  });
});

describe("compactCoordinator", () => {
  it("sends /compact to an idle Mission Control and refuses one mid-turn", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const idle = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });
    await expect(compactCoordinator(idle.paseo)).resolves.toBe("old-coordinator");
    expect(idle.calls).toEqual(["send old-coordinator /compact"]);

    const busy = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "running" } });
    await expect(compactCoordinator(busy.paseo)).rejects.toThrow("in the middle of a turn");
    expect(busy.calls).toEqual([]);
  });
});

describe("askCoordinator", () => {
  it("sends the words alone, without interrupting, when nothing is attached", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const { paseo, sent } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });
    await expect(askCoordinator(paseo, { text: "  fix the login  " })).resolves.toBe("old-coordinator");
    expect(sent).toEqual([{ agentId: "old-coordinator", text: "fix the login", options: { activeTurnBehavior: "steer" } }]);
  });

  it("sends images as images and files as Paseo uploads, the way Paseo's composer does", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const { paseo, sent } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });
    const png = { data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" };
    const notes = { fileName: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") };

    await askCoordinator(paseo, { text: "", images: [png], files: [notes] });

    expect(sent).toHaveLength(1);
    const options = sent[0]?.options ?? {};
    expect(sent[0]?.text).toBe("");
    expect(options.images).toEqual([png]);
    expect(options.activeTurnBehavior).toBe("steer");
    const [upload] = options.attachments as Array<Record<string, unknown>>;
    expect(upload).toMatchObject({ type: "uploaded_file", fileName: "notes.txt", mimeType: "text/plain", size: 5 });
    expect(String(upload?.path)).toBe(join(paseoHome, "uploads", String(upload?.id), "notes.txt"));
    await expect(readFile(String(upload?.path), "utf8")).resolves.toBe("hello");
  });

  it("leaves a pressed suggestion on the list and out of the dismissed ones", async () => {
    await updateMissionControlConfig({ coordinatorAgentId: "old-coordinator" });
    const config = await readMissionControlConfig();
    const home = resolveHome(config);
    await prepareHome(home, config);
    await writeFile(join(home, TEMPLATES.suggestions), "- Land :: Merge it\n");
    const dismissed = await readFile(join(home, TEMPLATES.suggestionsDismissed), "utf8");

    // A card's press is the chat's own send of its prompt.
    const { paseo, sent } = fakePaseo({ "old-coordinator": { ...oldCoordinator, status: "idle" } });
    await askCoordinator(paseo, { text: "Merge it" });

    expect(sent.map((message) => message.text)).toEqual(["Merge it"]);
    expect(await readSuggestions(home)).toEqual([{ label: "Land", prompt: "Merge it" }]);
    expect(await readFile(join(home, TEMPLATES.suggestionsDismissed), "utf8")).toBe(dismissed);
  });

  it("writes nothing when there is no Mission Control to send to", async () => {
    const { paseo, sent } = fakePaseo({});
    const notes = { fileName: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=" };
    await expect(askCoordinator(paseo, { text: "hi", files: [notes] })).rejects.toThrow();
    expect(sent).toEqual([]);
    await expect(readdir(join(paseoHome, "uploads"))).rejects.toThrow("ENOENT");
  });
});
