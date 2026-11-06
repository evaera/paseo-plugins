import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { debriefInfo, debriefInstalled, requestDebriefOpen } from "./debrief";
import type { PaseoApi } from "./host-types";

let paseoHome: string;
const previousHome = process.env.PASEO_HOME;

beforeEach(async () => {
  paseoHome = await mkdtemp(join(tmpdir(), "mission-control-debrief-"));
  process.env.PASEO_HOME = paseoHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(paseoHome, { recursive: true, force: true });
});

const debrief = () => join(paseoHome, "plugin-data", "debrief");

function fakePaseo(diffStat: { additions: number; deletions: number } | null): PaseoApi {
  return { workspaces: { ref: () => ({ refresh: async () => ({ diffStat }) }) } } as unknown as PaseoApi;
}

describe("Debrief from a card", () => {
  it("is offered only once Debrief has run on this Mac", async () => {
    expect(await debriefInstalled()).toBe(false);
    await mkdir(debrief(), { recursive: true });
    expect(await debriefInstalled()).toBe(true);
  });

  it("leaves Debrief one whole request to open its tab, and never a staged one", async () => {
    await requestDebriefOpen({ workspaceId: "wks_abc", agentId: "a1", view: "story" });
    const names = await readdir(join(debrief(), "open-requests"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f-]+\.json$/);
    const request = JSON.parse(await readFile(join(debrief(), "open-requests", names[0]!), "utf8"));
    expect(request).toMatchObject({ workspaceId: "wks_abc", agentId: "a1", view: "story" });
    expect(typeof request.createdAt).toBe("string");
  });

  it("refuses a workspace id that could leave Debrief's folder", async () => {
    await expect(requestDebriefOpen({ workspaceId: "../x", view: "diff" })).rejects.toThrow();
  });

  it("counts open comments and sees a story, and offers nothing for a workspace with no changes", async () => {
    const reviews = join(debrief(), "reviews", "wks_abc");
    await mkdir(reviews, { recursive: true });
    await writeFile(join(reviews, "review.json"), JSON.stringify({ comments: [{ resolved: true }, { resolved: false }, {}] }));
    await writeFile(join(reviews, "story.json"), "{}");
    expect(await debriefInfo(fakePaseo({ additions: 12, deletions: 3 }), "wks_abc", null, "t1")).toEqual({
      workspaceId: "wks_abc",
      serverId: null,
      additions: 12,
      deletions: 3,
      openComments: 2,
      story: true,
    });
    expect(await debriefInfo(fakePaseo({ additions: 0, deletions: 0 }), "wks_abc", null, "t2")).toBeNull();
    expect(await debriefInfo(fakePaseo(null), "wks_abc", null, "t3")).toBeNull();
  });

  it("reads a worker on another host by its own Paseo, without this Mac's badges, and asks again only once it moves", async () => {
    let reads = 0;
    const remote = { workspaces: { ref: () => ({ refresh: async () => (reads++, { diffStat: { additions: 5, deletions: 2 } }) }) } } as unknown as PaseoApi;
    expect(await debriefInfo(remote, "wks_far", "srv_x", "u1")).toEqual({
      workspaceId: "wks_far",
      serverId: "srv_x",
      additions: 5,
      deletions: 2,
      openComments: 0,
      story: false,
    });
    await debriefInfo(remote, "wks_far", "srv_x", "u1");
    expect(reads).toBe(1);
    await debriefInfo(remote, "wks_far", "srv_x", "u2");
    expect(reads).toBe(2);
  });
});
