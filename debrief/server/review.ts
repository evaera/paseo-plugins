/**
 * `debrief.review.load` and `debrief.review.poll`: the diff, the review and
 * the agents, and the cheap fingerprint that says when to load again.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { compareKey, type Compare, type Endpoint } from "../shared/compare";
import type { DiffFile, Review, Scope } from "../shared/review";
import { agentChoice, pickTarget, workspaceAgents } from "./agents";
import { parseUnifiedDiff, untrackedDiffFile } from "./diff";
import { fileContents, readDiskText } from "./files";
import { cachedCompare, compareDiffArgs, toCompare, toWorktree, type ResolvedCompare } from "./compare";
import { currentBranch, defaultBranch, diffText, headSha, repoRoot, statusPaths, statusPorcelain, untrackedFiles, upstreamBranch } from "./git";
import type { PaseoApi } from "./host-types";
import { reanchorReview } from "./reanchor";
import { diffFingerprints, setReviewedMark, untrackedFingerprint, withReviewStates } from "./reviewed";
import { loadReviewDoc, mutateReview } from "./store";
import { resolveWorkspace } from "./workspace";

/** Past this many untracked files the rest are listed without reading them. */
const MAX_UNTRACKED_READS = 500;
export async function readAgentTools(paseo: PaseoApi): Promise<boolean> {
  try {
    const { config } = await paseo.config.get();
    return config.mcp.injectIntoAgents === true;
  } catch (error) {
    console.error("[debrief] could not read the daemon config:", error);
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function untrackedEntries(root: string): Promise<{ file: DiffFile; fingerprint: string }[]> {
  const paths = await untrackedFiles(root);
  return Promise.all(
    paths.map(async (path, index) => {
      if (index >= MAX_UNTRACKED_READS) {
        return { file: { ...untrackedDiffFile(path, ""), additions: 0, hunks: [] }, fingerprint: await statFingerprint(join(root, path)) };
      }
      const disk = await readDiskText(join(root, path)).catch(() => null);
      if (disk === null || disk.binary) return { file: untrackedDiffFile(path, null), fingerprint: await statFingerprint(join(root, path)) };
      if (disk.tooLarge) return { file: { ...untrackedDiffFile(path, ""), hunks: [] }, fingerprint: await statFingerprint(join(root, path)) };
      return { file: untrackedDiffFile(path, disk.text ?? ""), fingerprint: untrackedFingerprint(disk.text ?? "", "") };
    }),
  );
}

/** An unread untracked file's fingerprint, from its size and mtime. */
async function statFingerprint(absolute: string): Promise<string> {
  try {
    const info = await stat(absolute);
    return untrackedFingerprint(null, `${info.size}:${info.mtimeMs}`);
  } catch {
    return untrackedFingerprint(null, "-");
  }
}

export interface DiffResult {
  branch: string | null;
  base: { ref: string; sha: string } | null;
  files: DiffFile[];
  error: string | null;
  compare: Compare;
  /** Null when the compare could not be resolved, or outside git. */
  resolved: ResolvedCompare | null;
  /** Each file's diff fingerprint (`reviewed.ts`), by path; empty when there is no diff. */
  fingerprints: Map<string, string>;
}

export async function loadDiff(root: string, compare: Compare, baseRef: string | null): Promise<DiffResult> {
  const result = (fields: Omit<DiffResult, "compare" | "fingerprints">, fingerprints = new Map<string, string>()): DiffResult => ({
    ...fields,
    compare,
    fingerprints,
  });
  if ((await repoRoot(root)) === null) {
    return result({ branch: null, base: null, files: [], error: `${root} is not inside a git repository.`, resolved: null });
  }
  const branch = await currentBranch(root);
  let resolved: ResolvedCompare;
  try {
    resolved = await cachedCompare(root, baseRef, compare);
  } catch (error) {
    return result({ branch, base: null, files: [], error: describe(error), resolved: null });
  }
  const base = { ref: resolved.fromRef, sha: resolved.fromSha };
  const args = compareDiffArgs(resolved);
  if (args === null) return result({ branch, base, files: [], error: null, resolved });
  try {
    const text = await diffText(root, args);
    const tracked = parseUnifiedDiff(text);
    const fingerprints = diffFingerprints(text);
    const untracked = toWorktree(resolved) ? await untrackedEntries(root) : [];
    const seen = new Set(tracked.map((file) => file.path));
    const fresh = untracked.filter((entry) => !seen.has(entry.file.path));
    fresh.forEach((entry) => fingerprints.set(entry.file.path, entry.fingerprint));
    const files = [...tracked, ...fresh.map((entry) => entry.file)].sort((a, b) => a.path.localeCompare(b.path));
    return result({ branch, base, files, error: null, resolved }, fingerprints);
  } catch (error) {
    return result({ branch, base, files: [], error: describe(error), resolved });
  }
}

/** The review with its comments brought up to the work tree; written only when one moved. */
export async function freshReview(workspaceId: string, root: string): Promise<Review> {
  const { review } = await mutateReview(workspaceId, root, (draft) => reanchorReview(draft, root), {
    skipWriteWhen: (moved) => !moved,
  });
  return review;
}

export async function loadReview(paseo: PaseoApi, input: { workspaceId: string; scope: Scope; compare?: Compare | undefined }) {
  const compare = toCompare(input.scope, input.compare);
  const { directory: root } = await resolveWorkspace(paseo, input.workspaceId);
  const review = await freshReview(input.workspaceId, root);
  const [diff, agents, agentToolsEnabled, branches] = await Promise.all([
    loadDiff(root, compare, review.baseRef),
    workspaceAgents(paseo, input.workspaceId).catch((error: unknown) => {
      console.error(`[debrief] could not list the agents of ${input.workspaceId}:`, error);
      return [];
    }),
    readAgentTools(paseo),
    branchNames(root),
  ]);
  return {
    cwd: root,
    branch: diff.branch,
    base: diff.base,
    files: withReviewStates(review, compareKey(compare), diff.files, diff.fingerprints),
    review,
    agents: agents.map(agentChoice),
    targetAgentId: pickTarget(review, agents)?.id ?? null,
    agentToolsEnabled,
    error: diff.error,
    defaultBranch: branches.defaultBranch,
    upstream: branches.upstream,
    compare,
    fromLabel: diff.resolved?.fromLabel ?? labelOf(compare.from),
    toLabel: diff.resolved?.toLabel ?? labelOf(compare.to),
    toWorktree: compare.to.kind === "worktree",
  };
}

/** What the scope buttons are labelled with: the default branch and the remote branch. */
export async function branchNames(root: string): Promise<{ defaultBranch: string | null; upstream: string | null }> {
  try {
    if ((await repoRoot(root)) === null) return { defaultBranch: null, upstream: null };
    const [main, upstream] = await Promise.all([defaultBranch(root), upstreamBranch(root)]);
    return { defaultBranch: main, upstream };
  } catch {
    return { defaultBranch: null, upstream: null };
  }
}

/**
 * Changes whenever the review document or the work tree's diff does: the
 * review's revision, HEAD, the base, `git status`, and the mtime and size of
 * every path status names (status alone does not change when an
 * already-modified file is edited again).
 */
export async function pollFingerprint(
  paseo: PaseoApi,
  input: { workspaceId: string; scope: Scope; compare?: Compare | undefined },
): Promise<string> {
  const { directory: root } = await resolveWorkspace(paseo, input.workspaceId);
  const review = await loadReviewDoc(input.workspaceId, root);
  const compare = toCompare(input.scope, input.compare);
  const hash = createHash("sha1");
  hash.update(`${review.revision}\0${compareKey(compare)}\0`);
  const top = await repoRoot(root);
  if (top === null) return hash.update("no-git").digest("hex");
  const [head, porcelain, base] = await Promise.all([
    headSha(root),
    statusPorcelain(root).catch(() => ""),
    cachedCompare(root, review.baseRef, compare).then(
      (resolved) => `${resolved.fromSha}\0${resolved.to.kind === "commit" ? resolved.to.sha : resolved.to.kind}`,
      (error: unknown) => describe(error),
    ),
  ]);
  hash.update(`${head ?? ""}\0${base}\0${porcelain}\0`);
  const stats = await Promise.all(
    statusPaths(porcelain).map(async (path) => {
      try {
        const info = await stat(join(top, path));
        return `${path}:${info.mtimeMs}:${info.size}`;
      } catch {
        return `${path}:-`;
      }
    }),
  );
  hash.update(stats.join("\0"));
  return hash.digest("hex");
}

/** `debrief.file.contents`: both sides of one file under a compare, with the review's base override. */
export async function compareContents(workspaceId: string, root: string, compare: Compare, path: string) {
  const review = await loadReviewDoc(workspaceId, root);
  const resolved = (await repoRoot(root)) === null ? null : await cachedCompare(root, review.baseRef, compare);
  return fileContents(root, resolved, path);
}

/**
 * `debrief.review.set-reviewed`: marks a file reviewed with the fingerprint
 * the panel loaded, or the diff's own when it sent none, or clears the mark.
 */
export async function setFileReviewed(
  workspaceId: string,
  root: string,
  input: { compare: Compare; path: string; reviewed: boolean; fingerprint?: string | undefined },
) {
  let fingerprint: string | null = null;
  if (input.reviewed) {
    if (input.fingerprint !== undefined) fingerprint = input.fingerprint;
    else {
      const review = await loadReviewDoc(workspaceId, root);
      const diff = await loadDiff(root, input.compare, review.baseRef);
      fingerprint = diff.fingerprints.get(input.path) ?? null;
      if (fingerprint === null) throw new Error(`${input.path} is not in this diff.`);
    }
  }
  const reviewState = await setReviewedMark(workspaceId, root, {
    key: compareKey(input.compare),
    path: input.path,
    reviewed: input.reviewed,
    fingerprint,
  });
  return { ok: true as const, reviewState };
}

/** A side's name when it could not be resolved (no repository, no remote branch). */
function labelOf(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "worktree":
      return "working tree";
    case "index":
      return "staged";
    case "head":
      return "HEAD";
    case "main":
      return "main";
    case "upstream":
      return "remote branch";
    case "ref":
      return endpoint.ref;
  }
}
