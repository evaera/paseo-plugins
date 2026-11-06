/**
 * One resolver for what a diff compares: a `Compare` (`shared/compare.ts`)
 * turned into git revisions, `git diff` arguments, and labels.
 *
 * The `to` side is the work tree (untracked files included, and editable),
 * the index, or a commit. The `from` side is a commit or the index; the work
 * tree cannot be `from`. `main` and `upstream` as `from` are the merge-base
 * of that branch with the `to` commit (HEAD when `to` is the work tree or the
 * index), so "main vs upstream" is exactly what the remote branch adds over
 * main. `head`, `index` and `ref` are used as they are. The same endpoint on
 * both sides is an empty diff.
 *
 * `main` is the review's base override when it has one, else the default
 * branch, preferring its `origin/` copy, as Crit does. A repository with no
 * commits has the empty tree wherever a commit is asked for.
 */
import { compareForScope, compareKey, sameEndpoint, type Compare, type Endpoint } from "../shared/compare";
import type { Scope } from "../shared/review";
import { defaultBranch, EMPTY_TREE, GitError, gitOptional, headSha, NoUpstream, refExists, upstreamBranch } from "./git";

export type ToSide = { kind: "worktree" } | { kind: "index" } | { kind: "commit"; ref: string; sha: string };

export interface ResolvedCompare {
  compare: Compare;
  /** The same endpoint on both sides: there is nothing to diff. */
  empty: boolean;
  /** The old side's name and commit (`index` and HEAD for the index). */
  fromRef: string;
  fromSha: string;
  /** Where old-side text is read: a commit, `""` for the index, null when there is none (no commits). */
  fromRev: string | null;
  to: ToSide;
  fromLabel: string;
  toLabel: string;
  /** False in a repository with no commits. */
  hasCommits: boolean;
}

export function toCompare(scope: Scope | undefined, compare: Compare | undefined): Compare {
  return compare ?? compareForScope(scope ?? "all");
}

const WORKTREE_LABEL = "working tree";
const INDEX_LABEL = "staged";

function short(sha: string): string {
  return sha.slice(0, 7);
}

async function commitSha(cwd: string, ref: string): Promise<string | null> {
  return gitOptional(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/** A named ref, or its `origin/` copy; throws naming it when it is neither. */
async function namedRef(cwd: string, ref: string, what: string): Promise<string> {
  if (await refExists(cwd, ref)) return ref;
  if (await refExists(cwd, `origin/${ref}`)) return `origin/${ref}`;
  throw new GitError(`The ${what} "${ref}" is not a commit in this repository.`, null);
}

/** A commit endpoint's ref name and commit. */
async function resolveCommit(cwd: string, endpoint: Endpoint, override: string | null): Promise<{ ref: string; sha: string }> {
  let ref: string;
  switch (endpoint.kind) {
    case "head":
      ref = "HEAD";
      break;
    case "ref":
      ref = await namedRef(cwd, endpoint.ref.trim(), "ref");
      break;
    case "main": {
      if (override !== null && override.trim() !== "") {
        ref = await namedRef(cwd, override.trim(), "base");
        break;
      }
      const branch = await defaultBranch(cwd);
      ref = (await refExists(cwd, `refs/remotes/origin/${branch}`)) ? `origin/${branch}` : (await refExists(cwd, branch)) ? branch : "HEAD";
      break;
    }
    case "upstream": {
      const upstream = await upstreamBranch(cwd);
      if (upstream === null) throw new NoUpstream();
      ref = upstream;
      break;
    }
    case "index":
    case "worktree":
      throw new Error(`${endpoint.kind} is not a commit`);
  }
  const sha = await commitSha(cwd, ref);
  if (sha === null) throw new GitError(`The ref "${ref}" is not a commit in this repository.`, null);
  return { ref, sha };
}

function endpointName(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "worktree":
      return WORKTREE_LABEL;
    case "index":
      return INDEX_LABEL;
    case "head":
      return "HEAD";
    case "main":
      return "main";
    case "upstream":
      return "upstream";
    case "ref":
      return endpoint.ref;
  }
}

export async function resolveCompare(cwd: string, compare: Compare, override: string | null): Promise<ResolvedCompare> {
  if (compare.from.kind === "worktree") {
    throw new GitError('The working tree can only be the "to" side of a compare.', null);
  }
  const head = await headSha(cwd);
  const hasCommits = head !== null;

  if (!hasCommits) {
    // Nothing is committed: every commit is the empty tree, and there is no remote branch to speak of.
    if (compare.from.kind === "upstream" || compare.to.kind === "upstream") throw new NoUpstream();
    const to: ToSide =
      compare.to.kind === "worktree" || compare.to.kind === "index" ? { kind: compare.to.kind } : { kind: "commit", ref: "(no commits)", sha: EMPTY_TREE };
    const fromIndex = compare.from.kind === "index";
    return {
      compare,
      empty: sameEndpoint(compare.from, compare.to) || (!fromIndex && to.kind === "commit"),
      fromRef: fromIndex ? "index" : "(no commits)",
      fromSha: EMPTY_TREE,
      fromRev: fromIndex ? "" : null,
      to,
      fromLabel: fromIndex ? INDEX_LABEL : "(no commits)",
      toLabel: to.kind === "worktree" ? WORKTREE_LABEL : to.kind === "index" ? INDEX_LABEL : "(no commits)",
      hasCommits,
    };
  }

  // The to side first: a merge-base on the from side depends on it.
  let to: ToSide;
  if (compare.to.kind === "worktree" || compare.to.kind === "index") to = { kind: compare.to.kind };
  else to = { kind: "commit", ...(await resolveCommit(cwd, compare.to, override)) };
  const toLabel = to.kind === "commit" ? `${to.ref} @ ${short(to.sha)}` : to.kind === "worktree" ? WORKTREE_LABEL : INDEX_LABEL;

  if (sameEndpoint(compare.from, compare.to)) {
    const fromLabel = compare.from.kind === "index" ? INDEX_LABEL : toLabel;
    const sha = to.kind === "commit" ? to.sha : head;
    return { compare, empty: true, fromRef: to.kind === "commit" ? to.ref : endpointName(compare.from), fromSha: sha, fromRev: compare.from.kind === "index" ? "" : sha, to, fromLabel, toLabel, hasCommits };
  }

  if (compare.from.kind === "index") {
    return { compare, empty: false, fromRef: "index", fromSha: head, fromRev: "", to, fromLabel: INDEX_LABEL, toLabel, hasCommits };
  }

  const target = await resolveCommit(cwd, compare.from, override);
  let fromSha = target.sha;
  if (compare.from.kind === "main" || compare.from.kind === "upstream") {
    const against = to.kind === "commit" ? to.sha : head;
    fromSha = (await gitOptional(cwd, ["merge-base", against, target.sha])) ?? target.sha;
  }
  return {
    compare,
    empty: false,
    fromRef: target.ref,
    fromSha,
    fromRev: fromSha,
    to,
    fromLabel: `${target.ref} @ ${short(fromSha)}`,
    toLabel,
    hasCommits,
  };
}

/** The `git diff` arguments, after `diff`, for a compare's tracked changes; null when it is empty. */
export function compareDiffArgs(resolved: ResolvedCompare): string[] | null {
  if (resolved.empty) return null;
  const fromIndex = resolved.fromRev === "";
  switch (resolved.to.kind) {
    case "worktree":
      return fromIndex ? [] : [resolved.fromSha];
    case "index":
      return fromIndex ? null : ["--cached", resolved.fromSha];
    case "commit":
      // Index to a commit is the commit-to-index diff turned around. `-R` swaps
      // the prefixes too, so they are given swapped to come out as a/ and b/.
      return fromIndex ? ["-R", "--src-prefix=b/", "--dst-prefix=a/", "--cached", resolved.to.sha] : [resolved.fromSha, resolved.to.sha];
  }
}

/** Where each side's text comes from: a git revision, the index (`""`), or the work tree (`null`). */
export function compareSources(resolved: ResolvedCompare): { old: string | null; new: string | null } {
  const next = resolved.to.kind === "worktree" ? null : resolved.to.kind === "index" ? "" : resolved.to.sha;
  return { old: resolved.fromRev, new: next };
}

export function toWorktree(resolved: Pick<ResolvedCompare, "to">): boolean {
  return resolved.to.kind === "worktree";
}

const TTL_MS = 5_000;
const cache = new Map<string, { resolved: ResolvedCompare; at: number }>();

/**
 * Resolved, cached for a few seconds per (directory, HEAD, override,
 * compare): the poll asks every two seconds. The TTL is also what notices a
 * fetch or push moving a remote branch.
 */
export async function cachedCompare(root: string, baseRef: string | null, compare: Compare): Promise<ResolvedCompare> {
  const head = (await headSha(root)) ?? "none";
  const key = `${root}\0${head}\0${baseRef ?? ""}\0${compareKey(compare)}`;
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.resolved;
  const resolved = await resolveCompare(root, compare, baseRef);
  cache.set(key, { resolved, at: Date.now() });
  if (cache.size > 200) cache.clear();
  return resolved;
}

export function forgetCompares(): void {
  cache.clear();
}
