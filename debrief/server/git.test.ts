import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileContents, writeWorkspaceFile } from "./files";
import { compareForScope, type Compare } from "../shared/compare";
import type { Scope } from "../shared/review";
import { cachedCompare, forgetCompares, resolveCompare } from "./compare";
import { parseNameStatus, statusPaths, stripAnsi, upstreamBranch } from "./git";
import { branchNames, loadDiff } from "./review";

// Real git subprocesses, dozens per test; slow when the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "debrief-git-"));
  git("init", "-q", "-b", "main");
  // A user configuration that would otherwise break parsing.
  git("config", "commit.gpgsign", "false");
  git("config", "color.diff", "always");
  git("config", "diff.noprefix", "true");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const main = { kind: "main" } as const;
const upstream = { kind: "upstream" } as const;
const head = { kind: "head" } as const;
const index = { kind: "index" } as const;
const worktree = { kind: "worktree" } as const;

async function paths(compare: Compare): Promise<string[]> {
  const diff = await loadDiff(repo, compare, null);
  expect(diff.error).toBeNull();
  return diff.files.map((file) => `${file.path}:${file.status}`);
}

describe("git against a real repository", () => {
  beforeEach(() => forgetCompares());

  it("reports a repository with no commits, untracked files included", async () => {
    await writeFile(join(repo, "new.ts"), "a\nb\n");
    expect(await resolveCompare(repo, compareForScope("all"), null)).toMatchObject({ hasCommits: false });
    const diff = await loadDiff(repo, compareForScope("all"), null);
    expect(diff.error).toBeNull();
    expect(diff.files).toEqual([expect.objectContaining({ path: "new.ts", status: "untracked", additions: 2 })]);
  });

  it("diffs a feature branch against its merge-base with main, for every old scope", async () => {
    await writeFile(join(repo, "a.ts"), "one\ntwo\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();
    git("checkout", "-qb", "feature");
    await writeFile(join(repo, "a.ts"), "one\nTWO\n");
    git("commit", "-qam", "change");
    await writeFile(join(repo, "b.ts"), "staged\n");
    git("add", "b.ts");
    await writeFile(join(repo, "a.ts"), "one\nTWO\nthree\n");
    await writeFile(join(repo, "c.ts"), "untracked\n");

    const all = await resolveCompare(repo, compareForScope("all"), null);
    expect(all).toMatchObject({ fromRef: "main", fromSha: baseSha, fromLabel: `main @ ${baseSha.slice(0, 7)}`, toLabel: "working tree" });

    const scoped = (scope: Scope) => paths(compareForScope(scope));
    expect(await scoped("all")).toEqual(["a.ts:modified", "b.ts:added", "c.ts:untracked"]);
    expect(await scoped("branch")).toEqual(["a.ts:modified"]);
    expect(await scoped("staged")).toEqual(["b.ts:added"]);
    expect(await scoped("unstaged")).toEqual(["a.ts:modified", "c.ts:untracked"]);
    expect(await scoped("uncommitted")).toEqual(["a.ts:modified", "b.ts:added", "c.ts:untracked"]);

    expect(await fileContents(repo, all, "a.ts")).toMatchObject({ oldText: "one\ntwo\n", newText: "one\nTWO\nthree\n", newEditable: true, language: "typescript" });
    const branch = await resolveCompare(repo, compareForScope("branch"), null);
    expect(await fileContents(repo, branch, "a.ts")).toMatchObject({ oldText: "one\ntwo\n", newText: "one\nTWO\n", newEditable: false });
    const unstaged = await resolveCompare(repo, compareForScope("unstaged"), null);
    expect(unstaged).toMatchObject({ fromLabel: "staged", toLabel: "working tree" });
    expect((await fileContents(repo, unstaged, "a.ts")).oldText).toBe("one\nTWO\n");
    const staged = await resolveCompare(repo, compareForScope("staged"), null);
    expect(staged.toLabel).toBe("staged");
    expect(await fileContents(repo, staged, "b.ts")).toMatchObject({ oldText: null, newText: "staged\n", newEditable: false });
    // The index against a commit is the commit-to-index diff turned around.
    expect(await paths({ from: index, to: head })).toEqual(["b.ts:deleted"]);
  });

  it("resolves main to itself on the default branch, honours an override, and names a bad ref", async () => {
    await writeFile(join(repo, "a.ts"), "x\n");
    git("add", ".");
    git("commit", "-qm", "one");
    const sha = git("rev-parse", "HEAD").trim();
    expect(await resolveCompare(repo, compareForScope("all"), null)).toMatchObject({ fromRef: "main", fromSha: sha });
    expect(await resolveCompare(repo, compareForScope("all"), "main")).toMatchObject({ fromRef: "main", fromSha: sha });
    await expect(resolveCompare(repo, compareForScope("all"), "nope")).rejects.toThrow(/"nope" is not a commit/);
    expect((await loadDiff(repo, { from: { kind: "ref", ref: "nope" }, to: head }, null)).error).toMatch(/"nope"/);
    expect((await loadDiff(repo, { from: worktree, to: head }, null)).error).toMatch(/working tree can only be the "to" side/);
  });

  it("diffs unpushed commits against the remote branch, and says when there is none", async () => {
    await writeFile(join(repo, "a.ts"), "one\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");

    expect(await upstreamBranch(repo)).toBeNull();
    const none = await loadDiff(repo, compareForScope("unpushed"), null);
    expect(none.error).toMatch(/This branch has no remote branch/);
    expect(none.files).toEqual([]);
    expect(await branchNames(repo)).toEqual({ defaultBranch: "main", upstream: null });

    const remote = await mkdtemp(join(tmpdir(), "debrief-remote-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      git("push", "-q", "-u", "origin", "feature");
      const pushed = git("rev-parse", "HEAD").trim();
      await writeFile(join(repo, "a.ts"), "one\nlocal\n");
      git("commit", "-qam", "not pushed");
      await writeFile(join(repo, "a.ts"), "one\nlocal\nuncommitted\n");
      await writeFile(join(repo, "c.ts"), "untracked\n");

      forgetCompares();
      const diff = await loadDiff(repo, compareForScope("unpushed"), null);
      expect(diff.error).toBeNull();
      expect(diff.base).toEqual({ ref: "origin/feature", sha: pushed });
      // Committed changes only: no untracked file, no uncommitted line.
      expect(diff.files.map((file) => `${file.path}:${file.status}:+${file.additions}`)).toEqual(["a.ts:modified:+1"]);
      const resolved = await cachedCompare(repo, null, compareForScope("unpushed"));
      expect(await fileContents(repo, resolved, "a.ts")).toMatchObject({ oldText: "one\n", newText: "one\nlocal\n", newEditable: false });
      expect(await branchNames(repo)).toEqual({ defaultBranch: "main", upstream: "origin/feature" });

      // Without upstream configuration, origin/<branch> is still found.
      git("branch", "--unset-upstream");
      expect(await upstreamBranch(repo)).toBe("origin/feature");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  describe("explicit compares, with main and the branch both pushed", () => {
    let remote: string;
    let c1: string;
    let c2: string;

    beforeEach(async () => {
      remote = await mkdtemp(join(tmpdir(), "debrief-remote-"));
      execFileSync("git", ["init", "-q", "--bare", remote]);
      git("remote", "add", "origin", remote);
      await writeFile(join(repo, "a.ts"), "1\n");
      await writeFile(join(repo, "m.ts"), "m\n");
      git("add", ".");
      git("commit", "-qm", "c1");
      c1 = git("rev-parse", "HEAD").trim();
      git("push", "-q", "-u", "origin", "main");
      git("checkout", "-qb", "feature");
      await writeFile(join(repo, "p.ts"), "pushed\n");
      git("add", ".");
      git("commit", "-qm", "c2");
      c2 = git("rev-parse", "HEAD").trim();
      git("push", "-q", "-u", "origin", "feature");
      // Main moves on after the branch left it.
      git("checkout", "-q", "main");
      await writeFile(join(repo, "m.ts"), "m2\n");
      git("commit", "-qam", "c4");
      git("push", "-q", "origin", "main");
      git("checkout", "-q", "feature");
      await writeFile(join(repo, "l.ts"), "local\n");
      git("add", ".");
      git("commit", "-qm", "c3");
      await writeFile(join(repo, "a.ts"), "1\nwip\n");
      await writeFile(join(repo, "u.ts"), "untracked\n");
      forgetCompares();
    });

    afterEach(async () => {
      await rm(remote, { recursive: true, force: true });
    });

    it("main vs upstream is what the remote branch adds over main", async () => {
      expect(await paths({ from: main, to: upstream })).toEqual(["p.ts:added"]);
      const resolved = await resolveCompare(repo, { from: main, to: upstream }, null);
      expect(resolved).toMatchObject({
        fromSha: c1,
        fromLabel: `origin/main @ ${c1.slice(0, 7)}`,
        toLabel: `origin/feature @ ${c2.slice(0, 7)}`,
      });
      expect(await fileContents(repo, resolved, "p.ts")).toMatchObject({ oldText: null, newText: "pushed\n", newEditable: false });
    });

    it("upstream vs worktree is the unpushed commits plus uncommitted work", async () => {
      expect(await paths({ from: upstream, to: worktree })).toEqual(["a.ts:modified", "l.ts:added", "u.ts:untracked"]);
    });

    it("main vs worktree includes the remote branch's commits and the uncommitted work", async () => {
      expect(await paths({ from: main, to: worktree })).toEqual(["a.ts:modified", "l.ts:added", "p.ts:added", "u.ts:untracked"]);
      const resolved = await resolveCompare(repo, { from: main, to: worktree }, null);
      expect(await fileContents(repo, resolved, "a.ts")).toMatchObject({ oldText: "1\n", newText: "1\nwip\n", newEditable: true });
    });

    it("ref vs head uses the ref as it is, with no merge-base", async () => {
      expect(await paths({ from: { kind: "ref", ref: c1 }, to: head })).toEqual(["l.ts:added", "p.ts:added"]);
      // main itself has moved on, so as a plain ref it also shows m.ts going back.
      expect(await paths({ from: { kind: "ref", ref: "main" }, to: head })).toEqual(["l.ts:added", "m.ts:modified", "p.ts:added"]);
    });

    it("the same endpoint on both sides is empty, not an error", async () => {
      expect(await paths({ from: head, to: head })).toEqual([]);
      expect(await paths({ from: upstream, to: upstream })).toEqual([]);
      expect(await paths({ from: index, to: index })).toEqual([]);
      expect(await paths({ from: { kind: "ref", ref: "main" }, to: { kind: "ref", ref: "main" } })).toEqual([]);
    });
  });
});

describe("outside a repository", () => {
  it("reports a directory that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "debrief-plain-"));
    try {
      expect((await loadDiff(plain, compareForScope("all"), null)).error).toMatch(/not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("writes", () => {
  it("saves, refuses a stale mtime, and overwrites when forced", async () => {
    await writeFile(join(repo, "f.txt"), "v1");
    const loaded = (await stat(join(repo, "f.txt"))).mtimeMs;
    const first = await writeWorkspaceFile(repo, { path: "f.txt", text: "v2", expectedMtimeMs: loaded, force: false });
    expect(first.status).toBe("saved");
    expect(await writeWorkspaceFile(repo, { path: "f.txt", text: "v3", expectedMtimeMs: loaded, force: false })).toMatchObject({ status: "conflict" });
    expect((await writeWorkspaceFile(repo, { path: "f.txt", text: "v3", expectedMtimeMs: loaded, force: true })).status).toBe("saved");
    await expect(writeWorkspaceFile(repo, { path: "../escape.txt", text: "x", expectedMtimeMs: null, force: false })).rejects.toThrow();
  });
});

describe("parsing helpers", () => {
  it("reads -z name-status with renames", () => {
    expect(parseNameStatus("M\0a.ts\0R100\0old.ts\0new.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", path: "new.ts", oldPath: "old.ts" },
    ]);
  });

  it("reads the paths out of porcelain v2", () => {
    const porcelain = [
      "1 .M N... 100644 100644 100644 abc abc src/a b.ts",
      "2 R. N... 100644 100644 100644 abc abc R100 new.ts",
      "old.ts",
      "? untracked.ts",
      "",
    ].join("\0");
    expect(statusPaths(porcelain)).toEqual(["src/a b.ts", "new.ts", "untracked.ts"]);
  });

  it("strips ANSI escapes", () => {
    expect(stripAnsi("\u001b[31m-a\u001b[m")).toBe("-a");
  });
});
