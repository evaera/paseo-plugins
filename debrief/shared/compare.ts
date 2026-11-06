/**
 * What a review compares: an explicit "from vs to" pair of endpoints.
 *
 * This replaces the bare scope names in the panel. Every scope maps onto a
 * compare (`compareForScope`), so stored reviews, stories and the agent tools
 * that still say `scope` keep working.
 */
import { z } from "zod";

import type { Scope } from "./review";

export const EndpointSchema = z.discriminatedUnion("kind", [
  /** The default branch (origin/HEAD, then main, then master). As `from`, its merge-base with `to`. */
  z.object({ kind: z.literal("main") }),
  /** The branch's remote branch (@{upstream}, then origin/<branch>). As `from`, its merge-base with `to`. */
  z.object({ kind: z.literal("upstream") }),
  /** The last commit. */
  z.object({ kind: z.literal("head") }),
  /** What is staged. */
  z.object({ kind: z.literal("index") }),
  /** The files on disk, untracked files included. Only valid as `to`. */
  z.object({ kind: z.literal("worktree") }),
  /** Any branch, tag or commit. */
  z.object({ kind: z.literal("ref"), ref: z.string().min(1) }),
]);
export type Endpoint = z.infer<typeof EndpointSchema>;

export const CompareSchema = z.object({ from: EndpointSchema, to: EndpointSchema });
export type Compare = z.infer<typeof CompareSchema>;

/** The three comparisons the switcher offers first. */
export const PRESET_COMPARES: ReadonlyArray<{ id: string; compare: Compare }> = [
  { id: "main-worktree", compare: { from: { kind: "main" }, to: { kind: "worktree" } } },
  { id: "upstream-worktree", compare: { from: { kind: "upstream" }, to: { kind: "worktree" } } },
  { id: "main-upstream", compare: { from: { kind: "main" }, to: { kind: "upstream" } } },
];

export const DEFAULT_COMPARE: Compare = { from: { kind: "main" }, to: { kind: "worktree" } };

export function compareForScope(scope: Scope): Compare {
  switch (scope) {
    case "all":
      return { from: { kind: "main" }, to: { kind: "worktree" } };
    case "branch":
      return { from: { kind: "main" }, to: { kind: "head" } };
    case "staged":
      return { from: { kind: "head" }, to: { kind: "index" } };
    case "unstaged":
      return { from: { kind: "index" }, to: { kind: "worktree" } };
    case "uncommitted":
      return { from: { kind: "head" }, to: { kind: "worktree" } };
    case "unpushed":
      return { from: { kind: "upstream" }, to: { kind: "head" } };
  }
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return a.kind === b.kind && (a.kind !== "ref" || (b.kind === "ref" && a.ref === b.ref));
}

export function sameCompare(a: Compare, b: Compare): boolean {
  return sameEndpoint(a.from, b.from) && sameEndpoint(a.to, b.to);
}

/** A stable string for caches, fingerprints and tab state. */
export function compareKey(c: Compare): string {
  const part = (e: Endpoint) => (e.kind === "ref" ? `ref:${e.ref}` : e.kind);
  return `${part(c.from)}..${part(c.to)}`;
}
