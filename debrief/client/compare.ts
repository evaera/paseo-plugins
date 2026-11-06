/**
 * The client half of "from vs to": reading a compare back from tab state,
 * labelling its endpoints, which picks are valid on each side, and the scope
 * a compare corresponds to (sent alongside it while a daemon still reads
 * `scope`). Pure, so it is tested directly.
 */
import {
  type Compare,
  compareForScope,
  compareKey,
  DEFAULT_COMPARE,
  type Endpoint,
  sameCompare,
  sameEndpoint,
} from "../shared/compare";
import { type Scope, ScopeSchema } from "../shared/review";

export type Side = "from" | "to";

/** The inverse of `compareKey`; null for anything it would not have written. */
export function parseCompareKey(key: string | null | undefined): Compare | null {
  if (typeof key !== "string") return null;
  const index = key.indexOf("..");
  if (index < 0) return null;
  const from = parseEndpoint(key.slice(0, index));
  const to = parseEndpoint(key.slice(index + 2));
  return from !== null && to !== null ? { from, to } : null;
}

function parseEndpoint(part: string): Endpoint | null {
  if (part.startsWith("ref:")) {
    const ref = part.slice(4);
    return ref === "" ? null : { kind: "ref", ref };
  }
  switch (part) {
    case "main":
    case "upstream":
    case "head":
    case "index":
    case "worktree":
      return { kind: part };
    default:
      return null;
  }
}

/** The tab's compare: its stored key, else the compare its old stored scope meant. */
export function storedCompare(key: string | null | undefined, scope: Scope | null | undefined): Compare {
  return parseCompareKey(key) ?? (scope !== null && scope !== undefined ? compareForScope(scope) : DEFAULT_COMPARE);
}

/** The scope a compare is, when it is one; what an older daemon is sent. */
export function scopeForCompare(compare: Compare): Scope | null {
  return ScopeSchema.options.find((scope) => sameCompare(compareForScope(scope), compare)) ?? null;
}

export interface EndpointNames {
  defaultBranch: string | null;
  upstream: string | null;
}

export function endpointName(endpoint: Endpoint, names: EndpointNames): string {
  switch (endpoint.kind) {
    case "main":
      return names.defaultBranch ?? "main";
    case "upstream":
      return names.upstream ?? "upstream";
    case "head":
      return "HEAD";
    case "index":
      return "staged";
    case "worktree":
      return "working tree";
    case "ref":
      return endpoint.ref;
  }
}

/** Why an endpoint cannot be picked on a side, or null when it can. */
export function endpointProblem(side: Side, endpoint: Endpoint, other: Endpoint, names: EndpointNames): string | null {
  if (endpoint.kind === "upstream" && names.upstream === null) return "This branch has no upstream";
  if (side === "from" && endpoint.kind === "worktree") return "The working tree can only be compared to";
  if (sameEndpoint(endpoint, other)) return "Already the other side";
  return null;
}

/** The endpoints each menu lists, in order; a custom ref is added by the menu. */
export const ENDPOINT_CHOICES: readonly Endpoint[] = [
  { kind: "main" },
  { kind: "upstream" },
  { kind: "head" },
  { kind: "index" },
  { kind: "worktree" },
];

export function endpointHint(endpoint: Endpoint): string {
  switch (endpoint.kind) {
    case "main":
      return "The default branch (its merge-base, as the from side)";
    case "upstream":
      return "The branch's remote branch";
    case "head":
      return "The last commit";
    case "index":
      return "What is staged";
    case "worktree":
      return "The files on disk, untracked included";
    case "ref":
      return "A branch, tag or commit";
  }
}

/** Picking `endpoint` on `side`; a pick that collides with the other side swaps them when that is valid. */
export function pickEndpoint(compare: Compare, side: Side, endpoint: Endpoint): Compare {
  const other = side === "from" ? compare.to : compare.from;
  if (sameEndpoint(endpoint, other)) {
    const swapped = side === "from" ? { from: endpoint, to: compare.from } : { from: compare.to, to: endpoint };
    return swapped.from.kind === "worktree" ? compare : swapped;
  }
  return side === "from" ? { from: endpoint, to: compare.to } : { from: compare.from, to: endpoint };
}

export { compareKey };
