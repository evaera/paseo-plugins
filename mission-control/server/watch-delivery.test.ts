/** Portable delivery tests, independent of Windows script-execution fixtures. */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WatchRunner, type DeliveryOutcome, type WatchRunnerOptions } from "./watches";
import type { WatchFile } from "./watch-files";

let directory = "";
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "watch-batch-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
const watch = { name: "probe", path: "unused" } as WatchFile;
function create(deliver: WatchRunnerOptions["deliver"]) {
  let output = "first";
  const stateFile = join(directory, "watches.json");
  const runner = new WatchRunner({ home: async () => directory, disabled: async () => [], deliver,
    stateFile, scriptStateRoot: join(directory, "scripts"),
    run: async () => ({ code: 0, stdout: output, stderr: "", timedOut: false, truncated: false, spawnError: null }),
  });
  return { runner, stateFile, output: (next: string) => { output = next; } };
}

describe("frozen watch deliveries", () => {
  it("keeps one exact message across repeated flushes, new output, and a plugin reload", async () => {
    let outcome: DeliveryOutcome = "sending";
    const deliver = vi.fn<WatchRunnerOptions["deliver"]>(async () => outcome);
    const first = create(deliver);
    await first.runner.runOne(directory, watch, new Date("2026-11-14T10:00:00Z"));
    await first.runner.flush();
    const [text, messageId] = deliver.mock.calls[0]!;
    expect(messageId).toMatch(/^mission-control-watch-/);
    first.output("second");
    await first.runner.runOne(directory, watch, new Date("2026-11-14T10:01:00Z"));
    for (let index = 0; index < 6; index += 1) await first.runner.flush();
    const reloaded = create(deliver);
    await reloaded.runner.flush();
    expect(deliver.mock.calls.every((call) => call[0] === text && call[1] === messageId)).toBe(true);
    expect(text).not.toContain("second");
    expect(JSON.parse(await readFile(first.stateFile, "utf8")).queue).toHaveLength(1);
    outcome = "sent";
    await reloaded.runner.flush();
    await reloaded.runner.flush();
    const last = deliver.mock.calls.at(-1)!;
    expect(last[0]).toContain("second"); expect(last[0]).not.toContain("first"); expect(last[1]).not.toBe(messageId);
    expect(JSON.parse(await readFile(first.stateFile, "utf8")).delivery).toBeUndefined();
  });

  it("preserves identity after an ambiguous callback failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deliver = vi.fn<WatchRunnerOptions["deliver"]>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue("sending");
    const first = create(deliver);
    await first.runner.runOne(directory, watch); await first.runner.flush();
    const reloaded = create(deliver); await reloaded.runner.flush();
    expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0]);
  });

  it("combines notes while a pre-send check confirms the coordinator is busy", async () => {
    const deliver = vi.fn<WatchRunnerOptions["deliver"]>().mockResolvedValueOnce("wait").mockResolvedValue("sent");
    const test = create(deliver);
    await test.runner.runOne(directory, watch); await test.runner.flush();
    test.output("second"); await test.runner.runOne(directory, watch); await test.runner.flush();
    expect(deliver.mock.calls[1]![0]).toContain("first"); expect(deliver.mock.calls[1]![0]).toContain("second");
  });

  it("refuses to send if it cannot save the batch identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deliver = vi.fn<WatchRunnerOptions["deliver"]>(async () => "sent");
    const test = create(deliver);
    await test.runner.runOne(directory, watch);
    // Replacing the state path with a directory makes atomic rename fail on every platform.
    await rm(test.stateFile);
    await mkdir(test.stateFile);
    await expect(test.runner.flush()).rejects.toThrow(); expect(deliver).not.toHaveBeenCalled();
  });
});
