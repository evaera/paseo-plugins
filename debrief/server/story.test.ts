import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_COMPARE } from "../shared/compare";
import { forgetCompares } from "./compare";
import { annotateStory, clearStory, loadStory, storyPrep, writeStory, type ToolDraft } from "./story";

vi.setConfig({ testTimeout: 30_000 });

let repo: string;
let home: string;
const saved = process.env.PASEO_HOME;
const ws = "ws-story";

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "debrief-story-home-"));
  repo = await mkdtemp(join(tmpdir(), "debrief-story-"));
  process.env.PASEO_HOME = home;
  forgetCompares();
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "a.ts"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-qm", "base");
  await writeFile(join(repo, "a.ts"), "one\ntwo changed\nthree\n");
  await writeFile(join(repo, "new.ts"), "fresh\n");
});

afterEach(async () => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const draft: ToolDraft = {
  prologue: { title: "Change two", overview: "Changes line two.", keyChanges: ["two"], risks: ["three"] },
  chapters: [
    {
      title: "The change",
      summary: "",
      files: [{ path: "a.ts", annotations: [{ line: 2, side: "new", body: "This is the line." }] }],
    },
  ],
  support: [{ path: "new.ts", reason: "scaffolding" }],
};

describe("stories against a real repository", () => {
  it("preps, writes, re-anchors annotations, goes stale, and needs replace", async () => {
    const prep = await storyPrep(ws, repo, null, DEFAULT_COMPARE);
    expect(prep.text).toContain("--- hunk a.ts 1");
    expect(prep.text).toContain("--- hunk new.ts 0\n@@ -0,0 +1,1 @@\n+fresh");

    const written = await writeStory(ws, repo, null, { draft, compare: DEFAULT_COMPARE, replace: false, fingerprint: prep.structured.fingerprint, agentId: "agent" });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.story.coverage).toMatchObject({ indexed: 2, placed: 2, autoRepaired: 0 });
    const annotation = written.story.chapters[0]?.files[0]?.annotations[0];
    expect(annotation).toMatchObject({ line: 2, anchor: "two changed" });

    expect((await loadStory(ws, repo, null)).stale).toBe(false);

    // Lines above the annotated one: it follows its text, and the hunk's shape changed.
    await writeFile(join(repo, "a.ts"), "zero\none\ntwo changed\nthree\n");
    const after = await loadStory(ws, repo, null);
    expect(after.story?.chapters[0]?.files[0]?.annotations[0]).toMatchObject({ line: 3, drifted: false });
    expect(after.stale).toBe(true);

    const again = await writeStory(ws, repo, null, { draft, compare: DEFAULT_COMPARE, replace: false, agentId: "agent" });
    expect(again).toMatchObject({ ok: false, report: expect.stringMatching(/replace: true/) });
    const stalePrep = await writeStory(ws, repo, null, { draft, compare: DEFAULT_COMPARE, replace: true, fingerprint: prep.structured.fingerprint, agentId: "agent" });
    expect(stalePrep).toMatchObject({ ok: false, report: expect.stringMatching(/changed since/) });
  });

  it("adds, edits and deletes one annotation", async () => {
    await writeStory(ws, repo, null, { draft, compare: DEFAULT_COMPARE, replace: false, agentId: "agent" });
    const added = await annotateStory(ws, repo, null, { path: "new.ts", line: 1, body: "New file.", chapterId: "the-change" });
    expect(added).toMatchObject({ action: "added", chapterId: "the-change", anchored: true });
    const edited = await annotateStory(ws, repo, null, { path: "new.ts", line: 1, body: "Edited.", annotationId: added.annotationId });
    expect(edited.action).toBe("edited");
    let story = (await loadStory(ws, repo, null)).story;
    const entry = story?.chapters[0]?.files.find((file) => file.path === "new.ts");
    // Shown for its annotation only, so coverage is untouched.
    expect(entry).toMatchObject({ hunks: [], annotations: [{ body: "Edited.", anchor: "fresh" }] });
    await annotateStory(ws, repo, null, { path: "new.ts", line: 1, body: "", annotationId: added.annotationId });
    story = (await loadStory(ws, repo, null)).story;
    expect(story?.chapters[0]?.files.find((file) => file.path === "new.ts")?.annotations).toEqual([]);
    await expect(annotateStory(ws, repo, null, { path: "other.ts", line: 1, body: "x" })).rejects.toThrow(/chapterId/);
    await clearStory(ws);
    expect((await loadStory(ws, repo, null)).story).toBeNull();
  });

  it("writes against a commit compare and carries new-side lines onto the work tree", async () => {
    const base = git("rev-parse", "HEAD").trim();
    git("add", ".");
    git("commit", "-qm", "change");
    await writeFile(join(repo, "a.ts"), "zero\none\ntwo changed\nthree\n");
    const compare = { from: { kind: "ref" as const, ref: base }, to: { kind: "head" as const } };
    const prep = await storyPrep(ws, repo, null, compare);
    const written = await writeStory(ws, repo, null, { draft, compare, replace: false, fingerprint: prep.structured.fingerprint, agentId: null });
    expect(written.ok).toBe(true);
    const loaded = await loadStory(ws, repo, null);
    expect(loaded.story?.compare).toEqual(compare);
    expect(loaded.stale).toBe(false);
    // Line 2 of HEAD is line 3 of the work tree.
    expect(loaded.story?.chapters[0]?.files[0]?.annotations[0]).toMatchObject({ line: 3, anchor: "two changed", drifted: false });
  });

  it("rejects a story that places too little, with the coverage", async () => {
    const result = await writeStory(ws, repo, null, {
      draft: { ...draft, chapters: [], support: [] },
      compare: DEFAULT_COMPARE,
      replace: false,
      agentId: null,
    });
    expect(result).toMatchObject({ ok: false, coverage: { placed: 0, indexed: 2 } });
  });
});
