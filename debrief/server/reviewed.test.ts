import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareForScope, compareKey } from "../shared/compare";
import type { DiffFile } from "../shared/review";
import { forgetCompares } from "./compare";
import { loadDiff, setFileReviewed } from "./review";
import { diffFingerprints, reviewedCount, reviewStateOf, setReviewedMark, untrackedFingerprint, withReviewStates } from "./reviewed";
import { loadReviewDoc, reviewPath } from "./store";

vi.setConfig({ testTimeout: 30_000 });

const TWO_FILES = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.ts b/b.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/b.ts",
  "@@ -0,0 +1 @@",
  "+diff --git a/x b/x",
  "",
].join("\n");

function file(path: string): DiffFile {
  return { path, status: "modified", binary: false, additions: 1, deletions: 1, hunks: [] };
}

describe("diff fingerprints", () => {
  it("gives each file its own, and ignores a content line that looks like a header", () => {
    const prints = diffFingerprints(TWO_FILES);
    expect([...prints.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(prints.get("a.ts")).not.toBe(prints.get("b.ts"));
  });

  it("moves with the file's own diff and not with another file's", () => {
    const before = diffFingerprints(TWO_FILES);
    const after = diffFingerprints(TWO_FILES.replace("+new", "+newer"));
    expect(after.get("a.ts")).not.toBe(before.get("a.ts"));
    expect(after.get("b.ts")).toBe(before.get("b.ts"));
  });

  it("hashes untracked text, and stands in for text it did not read", () => {
    expect(untrackedFingerprint("a\n", "")).toBe(untrackedFingerprint("a\n", ""));
    expect(untrackedFingerprint("a\n", "")).not.toBe(untrackedFingerprint("b\n", ""));
    expect(untrackedFingerprint(null, "3:1")).not.toBe(untrackedFingerprint(null, "3:2"));
  });
});

describe("review states", () => {
  it("is null without a mark, reviewed when the fingerprint matches, changed otherwise", () => {
    expect(reviewStateOf(undefined, "f1")).toBeNull();
    expect(reviewStateOf({ fingerprint: "f1" }, "f1")).toBe("reviewed");
    expect(reviewStateOf({ fingerprint: "f1" }, "f2")).toBe("changed");
    expect(reviewStateOf({ fingerprint: "f1" }, undefined)).toBe("changed");
  });

  it("reads the marks of the compare asked for only, and counts changed files as not reviewed", () => {
    const review = {
      reviewed: {
        "main..worktree": { "a.ts": { at: "t", fingerprint: "fa" }, "b.ts": { at: "t", fingerprint: "old" } },
        "head..worktree": { "c.ts": { at: "t", fingerprint: "fc" } },
      },
    };
    const prints = new Map([
      ["a.ts", "fa"],
      ["b.ts", "fb"],
      ["c.ts", "fc"],
    ]);
    const files = withReviewStates(review, "main..worktree", [file("a.ts"), file("b.ts"), file("c.ts")], prints);
    expect(files.map((entry) => entry.reviewState)).toEqual(["reviewed", "changed", null]);
    expect(files[0]?.fingerprint).toBe("fa");
    expect(reviewedCount(files)).toBe(1);
    expect(withReviewStates({}, "main..worktree", [file("a.ts")], prints)[0]?.reviewState).toBeNull();
  });
});

describe("the reviewed marks in the store", () => {
  let home: string;
  let work: string;
  const saved = process.env.PASEO_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "debrief-home-"));
    work = await mkdtemp(join(tmpdir(), "debrief-work-"));
    process.env.PASEO_HOME = home;
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = saved;
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it("stores a mark per compare and path, replaces it, and clears it", async () => {
    expect(await setReviewedMark("ws1", work, { key: "k1", path: "a.ts", reviewed: true, fingerprint: "f1" })).toBe("reviewed");
    await setReviewedMark("ws1", work, { key: "k2", path: "a.ts", reviewed: true, fingerprint: "f9" });
    await setReviewedMark("ws1", work, { key: "k1", path: "a.ts", reviewed: true, fingerprint: "f2" });
    let review = await loadReviewDoc("ws1", work);
    expect(review.reviewed?.k1?.["a.ts"]?.fingerprint).toBe("f2");
    expect(review.reviewed?.k2?.["a.ts"]?.fingerprint).toBe("f9");

    expect(await setReviewedMark("ws1", work, { key: "k1", path: "a.ts", reviewed: false, fingerprint: null })).toBeNull();
    review = await loadReviewDoc("ws1", work);
    expect(review.reviewed?.k1).toBeUndefined();
    expect(review.reviewed?.k2?.["a.ts"]).toBeDefined();
  });

  it("writes nothing when clearing a mark that is not there", async () => {
    await setReviewedMark("ws1", work, { key: "k1", path: "a.ts", reviewed: false, fingerprint: null });
    await expect(readFile(reviewPath("ws1"), "utf8")).rejects.toThrow();
  });

  it("still reads a review written before marks existed", async () => {
    const review = await loadReviewDoc("ws1", work);
    expect(review.reviewed).toBeUndefined();
  });
});

describe("reviewed against a real repository", () => {
  let repo: string;
  let home: string;
  const saved = process.env.PASEO_HOME;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });

  beforeEach(async () => {
    forgetCompares();
    repo = await mkdtemp(join(tmpdir(), "debrief-git-"));
    home = await mkdtemp(join(tmpdir(), "debrief-home-"));
    process.env.PASEO_HOME = home;
    git("init", "-q", "-b", "main");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.ts"), "one\n");
    await writeFile(join(repo, "b.ts"), "two\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = saved;
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("turns a reviewed file changed when it is edited again, and only that file", async () => {
    const compare = compareForScope("uncommitted");
    await writeFile(join(repo, "a.ts"), "one\nmore\n");
    await writeFile(join(repo, "b.ts"), "two\nmore\n");
    await writeFile(join(repo, "c.ts"), "new\n");
    await setFileReviewed("ws1", repo, { compare, path: "a.ts", reviewed: true });
    await setFileReviewed("ws1", repo, { compare, path: "c.ts", reviewed: true });

    const states = async () => {
      const review = await loadReviewDoc("ws1", repo);
      const diff = await loadDiff(repo, compare, null);
      return withReviewStates(review, compareKey(compare), diff.files, diff.fingerprints).map((entry) => `${entry.path}:${entry.reviewState}`);
    };
    expect(await states()).toEqual(["a.ts:reviewed", "b.ts:null", "c.ts:reviewed"]);

    await writeFile(join(repo, "a.ts"), "one\nmore\nagain\n");
    await writeFile(join(repo, "c.ts"), "newer\n");
    expect(await states()).toEqual(["a.ts:changed", "b.ts:null", "c.ts:changed"]);

    await setFileReviewed("ws1", repo, { compare, path: "a.ts", reviewed: true });
    expect((await states())[0]).toBe("a.ts:reviewed");

    // Another compare keeps its own marks.
    const other = await loadDiff(repo, compareForScope("all"), null);
    const review = await loadReviewDoc("ws1", repo);
    expect(withReviewStates(review, compareKey(compareForScope("all")), other.files, other.fingerprints).every((entry) => entry.reviewState === null)).toBe(true);
  });

  it("refuses to mark a file that is not in the diff without a fingerprint", async () => {
    await expect(setFileReviewed("ws1", repo, { compare: compareForScope("uncommitted"), path: "a.ts", reviewed: true })).rejects.toThrow(/not in this diff/);
  });
});
