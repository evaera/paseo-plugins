/**
 * Plan storage and versioning, with no Paseo in it:
 * `plugin-data/debrief/plans/<workspaceId>/<planId>/` holds `meta.json`,
 * one `v001.md`, `v002.md`... per submitted version, and `annotations.json`.
 *
 * A submission joins an existing plan when it is the same plan coming back:
 * the same agent through the same route (ExitPlanMode or the tool) while that
 * plan is not yet approved, or the same file. Identical text adds no version;
 * it only refreshes the permission to answer. A new version carries the
 * unsent annotations over, moved onto whichever block still contains their
 * quoted text.
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  PlanAnnotationSchema,
  PlanSourceSchema,
  PlanStatusSchema,
  type PlanAnnotation,
  type PlanBlock,
  type PlanSource,
  type PlanStatus,
  type PlanSummary,
} from "../shared/plan";
import type { Author } from "../shared/review";
import { dataPath } from "./data-dir";
import { parsePlanBlocks } from "./plan-blocks";
import { serialized } from "./serialize";
import { readJson, writeAtomic } from "./store";

const PlanMetaSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  source: PlanSourceSchema,
  status: PlanStatusSchema,
  versions: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answeredElsewhere: z.boolean().default(false),
});
export type PlanMeta = z.infer<typeof PlanMetaSchema>;

const AnnotationsFileSchema = z.object({ version: z.literal(1), annotations: z.array(PlanAnnotationSchema) });

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function safeSegment(value: string, what: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`"${value}" is not a ${what}.`);
  return value;
}

export function plansRoot(workspaceId: string): string {
  if (workspaceId === "" || workspaceId === "." || workspaceId === ".." || /[/\\\0]/.test(workspaceId)) {
    throw new Error(`"${workspaceId}" is not a workspace id.`);
  }
  return dataPath("plans", workspaceId);
}

export function planDir(workspaceId: string, planId: string): string {
  return join(plansRoot(workspaceId), safeSegment(planId, "plan id"));
}

export function versionFile(version: number): string {
  return `v${String(version).padStart(3, "0")}.md`;
}

function now(): string {
  return new Date().toISOString();
}

function withPlans<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  return serialized(`plans:${workspaceId}`, task);
}

async function readMeta(workspaceId: string, planId: string): Promise<PlanMeta | null> {
  const parsed = PlanMetaSchema.safeParse(await readJson(join(planDir(workspaceId, planId), "meta.json")).catch(() => undefined));
  return parsed.success ? parsed.data : null;
}

async function requireMeta(workspaceId: string, planId: string): Promise<PlanMeta> {
  const meta = await readMeta(workspaceId, planId);
  if (meta === null) throw new Error(`There is no plan ${planId} in this workspace.`);
  return meta;
}

function writeMeta(meta: PlanMeta): Promise<void> {
  return writeAtomic(join(planDir(meta.workspaceId, meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

async function readAnnotations(workspaceId: string, planId: string): Promise<PlanAnnotation[]> {
  const path = join(planDir(workspaceId, planId), "annotations.json");
  const raw = await readJson(path).catch(() => undefined);
  if (raw === undefined) return [];
  const parsed = AnnotationsFileSchema.safeParse(raw);
  if (parsed.success) return parsed.data.annotations;
  console.error(`[debrief] ${path} is not valid; setting it aside.`, parsed.error);
  await rename(path, `${path}.invalid-${Date.now()}`).catch(() => {});
  return [];
}

function writeAnnotations(workspaceId: string, planId: string, annotations: PlanAnnotation[]): Promise<void> {
  return writeAtomic(
    join(planDir(workspaceId, planId), "annotations.json"),
    `${JSON.stringify({ version: 1, annotations }, null, 2)}\n`,
  );
}

export async function readVersion(workspaceId: string, planId: string, version: number): Promise<string | null> {
  try {
    return await readFile(join(planDir(workspaceId, planId), versionFile(version)), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function allMetas(workspaceId: string): Promise<PlanMeta[]> {
  let names: string[];
  try {
    names = await readdir(plansRoot(workspaceId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const metas = await Promise.all(names.filter((name) => SAFE_ID.test(name)).map((name) => readMeta(workspaceId, name)));
  return metas.filter((meta): meta is PlanMeta => meta !== null);
}

export function summarize(meta: PlanMeta, annotations: readonly PlanAnnotation[]): PlanSummary {
  return {
    id: meta.id,
    workspaceId: meta.workspaceId,
    title: meta.title,
    source: meta.source,
    status: meta.status,
    versions: meta.versions,
    updatedAt: meta.updatedAt,
    drafts: annotations.filter((annotation) => annotation.sentInVersion === undefined).length,
    answeredElsewhere: meta.answeredElsewhere,
  };
}

/** The first `#` heading, or the fallback. */
export function planTitle(markdown: string, fallback: string): string {
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown);
  const title = (heading?.[1] ?? "").trim();
  return (title === "" ? fallback : title).slice(0, 120);
}

/** Whether a submission from `source` continues `meta`. */
function continues(meta: PlanMeta, source: PlanSource): boolean {
  if (meta.source.kind !== source.kind) return false;
  if (source.kind === "file") return meta.source.kind === "file" && meta.source.path === source.path;
  if (meta.source.kind === "file" || meta.source.agentId !== source.agentId) return false;
  return meta.status !== "approved";
}

/**
 * Moves each unsent annotation onto the new version's blocks: the block with
 * the same id when it still contains the quoted text, else the first block
 * that does. One found nowhere loses its block and keeps its quote and its
 * old line numbers, so it still exports; a global comment is untouched.
 */
export function carryAnnotations(annotations: readonly PlanAnnotation[], blocks: readonly PlanBlock[]): PlanAnnotation[] {
  return annotations.map((annotation) => {
    if (annotation.sentInVersion !== undefined || annotation.type === "global" || annotation.inDiff) return annotation;
    const quote = annotation.originalText;
    const same = blocks.find((block) => block.id === annotation.blockId);
    const target = quote === "" ? same : same?.text.includes(quote) ? same : blocks.find((block) => block.text.includes(quote));
    const next: PlanAnnotation = { ...annotation };
    if (target === undefined) {
      delete next.blockId;
      return next;
    }
    next.blockId = target.id;
    next.startLine = target.startLine;
    next.endLine = target.endLine;
    if (annotation.startOffset !== undefined && quote !== "") {
      const at = target.text.indexOf(quote);
      next.startOffset = at;
      next.endOffset = at + quote.length;
    }
    return next;
  });
}

export interface Submission {
  planId: string;
  version: number;
  /** A new plan, rather than another version of one. */
  created: boolean;
  /** A new version was written; false when the text matched the latest. */
  changed: boolean;
  meta: PlanMeta;
}

function newPlanId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `p_${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Records a submitted plan: a new plan, a new version of one, or the same text again. */
export function submitPlan(workspaceId: string, input: { title: string; markdown: string; source: PlanSource }): Promise<Submission> {
  return withPlans(workspaceId, async () => {
    const metas = await allMetas(workspaceId);
    const existing = metas
      .filter((meta) => continues(meta, input.source))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const at = now();

    if (existing === undefined) {
      const meta: PlanMeta = {
        version: 1,
        id: newPlanId(new Set(metas.map((entry) => entry.id))),
        workspaceId,
        title: input.title,
        source: input.source,
        status: "pending",
        versions: 1,
        createdAt: at,
        updatedAt: at,
        answeredElsewhere: false,
      };
      await writeAtomic(join(planDir(workspaceId, meta.id), versionFile(1)), input.markdown);
      await writeAnnotations(workspaceId, meta.id, []);
      await writeMeta(meta);
      return { planId: meta.id, version: 1, created: true, changed: true, meta };
    }

    const latest = await readVersion(workspaceId, existing.id, existing.versions);
    const meta: PlanMeta = { ...existing, title: input.title, source: input.source, status: "pending", answeredElsewhere: false, updatedAt: at };
    if (latest === input.markdown) {
      await writeMeta(meta);
      return { planId: meta.id, version: meta.versions, created: false, changed: false, meta };
    }
    meta.versions += 1;
    await writeAtomic(join(planDir(workspaceId, meta.id), versionFile(meta.versions)), input.markdown);
    const annotations = await readAnnotations(workspaceId, meta.id);
    await writeAnnotations(workspaceId, meta.id, carryAnnotations(annotations, parsePlanBlocks(input.markdown)));
    await writeMeta(meta);
    return { planId: meta.id, version: meta.versions, created: false, changed: true, meta };
  });
}

export async function listPlans(workspaceId: string): Promise<PlanSummary[]> {
  const metas = await allMetas(workspaceId);
  const summaries = await Promise.all(metas.map(async (meta) => summarize(meta, await readAnnotations(workspaceId, meta.id))));
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export interface LoadedPlan {
  meta: PlanMeta;
  plan: PlanSummary;
  version: number;
  markdown: string;
  blocks: PlanBlock[];
  previousMarkdown: string | null;
  annotations: PlanAnnotation[];
}

export async function loadPlan(workspaceId: string, planId: string, version?: number): Promise<LoadedPlan> {
  const meta = await requireMeta(workspaceId, planId);
  const shown = Math.min(Math.max(version ?? meta.versions, 1), meta.versions);
  const markdown = (await readVersion(workspaceId, planId, shown)) ?? "";
  const previousMarkdown = shown > 1 ? await readVersion(workspaceId, planId, shown - 1) : null;
  const annotations = await readAnnotations(workspaceId, planId);
  return {
    meta,
    plan: summarize(meta, annotations),
    version: shown,
    markdown,
    blocks: parsePlanBlocks(markdown),
    previousMarkdown,
    annotations,
  };
}

function newAnnotationId(annotations: readonly PlanAnnotation[]): string {
  const taken = new Set(annotations.map((annotation) => annotation.id));
  for (;;) {
    const id = `pa_${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function newReplyId(annotations: readonly PlanAnnotation[]): string {
  const taken = new Set(annotations.flatMap((annotation) => annotation.replies.map((reply) => reply.id)));
  for (;;) {
    const id = `rp_${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

export type NewPlanAnnotation = Omit<PlanAnnotation, "id" | "author" | "createdAt" | "replies" | "sentInVersion" | "version"> & {
  version?: number | undefined;
};

export function addAnnotation(workspaceId: string, planId: string, input: NewPlanAnnotation, author: Author): Promise<PlanAnnotation> {
  return withPlans(workspaceId, async () => {
    const meta = await requireMeta(workspaceId, planId);
    if (input.type !== "global" && input.blockId === undefined && !input.inDiff) {
      throw new Error(`A ${input.type} annotation needs the block it is on.`);
    }
    if (input.type !== "deletion" && input.body.trim() === "" && input.labels.length === 0) {
      throw new Error("A comment needs a body or a label.");
    }
    const annotations = await readAnnotations(workspaceId, planId);
    const annotation: PlanAnnotation = PlanAnnotationSchema.parse({
      ...input,
      id: newAnnotationId(annotations),
      author,
      createdAt: now(),
      replies: [],
      version: meta.versions,
    });
    annotations.push(annotation);
    await writeAnnotations(workspaceId, planId, annotations);
    await writeMeta({ ...meta, updatedAt: now() });
    return annotation;
  });
}

export interface AnnotationUpdate {
  annotationId: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  delete?: boolean | undefined;
  reply?: string | undefined;
}

export type UpdateResult =
  | { kind: "deleted"; meta: PlanMeta }
  | { kind: "updated"; meta: PlanMeta; annotation: PlanAnnotation; replyId: string | null };

export function updateAnnotation(workspaceId: string, planId: string, update: AnnotationUpdate, author: Author): Promise<UpdateResult> {
  return withPlans(workspaceId, async () => {
    const meta = await requireMeta(workspaceId, planId);
    const annotations = await readAnnotations(workspaceId, planId);
    const index = annotations.findIndex((annotation) => annotation.id === update.annotationId);
    const annotation = annotations[index];
    if (annotation === undefined) throw new Error(`There is no annotation ${update.annotationId} on this plan.`);
    if (update.delete === true) {
      annotations.splice(index, 1);
      await writeAnnotations(workspaceId, planId, annotations);
      return { kind: "deleted", meta };
    }
    if (update.body !== undefined) annotation.body = update.body;
    if (update.labels !== undefined) annotation.labels = update.labels;
    let replyId: string | null = null;
    if (update.reply !== undefined && update.reply.trim() !== "") {
      replyId = newReplyId(annotations);
      const at = now();
      annotation.replies.push({ id: replyId, body: update.reply.trim(), author, createdAt: at, updatedAt: at });
    }
    await writeAnnotations(workspaceId, planId, annotations);
    const touched = { ...meta, updatedAt: now() };
    await writeMeta(touched);
    return { kind: "updated", meta: touched, annotation, replyId };
  });
}

/** After a verdict went out: the status, and which annotations it carried. */
export function recordDecision(
  workspaceId: string,
  planId: string,
  input: { status: PlanStatus; sentIds: readonly string[]; answeredElsewhere?: boolean },
): Promise<PlanMeta> {
  return withPlans(workspaceId, async () => {
    const meta = await requireMeta(workspaceId, planId);
    const annotations = await readAnnotations(workspaceId, planId);
    const sent = new Set(input.sentIds);
    for (const annotation of annotations) if (sent.has(annotation.id)) annotation.sentInVersion = meta.versions;
    await writeAnnotations(workspaceId, planId, annotations);
    const next: PlanMeta = { ...meta, status: input.status, updatedAt: now() };
    if (input.answeredElsewhere !== undefined) next.answeredElsewhere = input.answeredElsewhere;
    if (next.source.kind === "exit-plan-mode") next.source = { ...next.source, permissionId: null };
    await writeMeta(next);
    return next;
  });
}

/**
 * The ExitPlanMode request behind a plan was answered outside Debrief.
 * Returns the plan it belonged to, or null when it was none of Debrief's.
 */
export function recordAnsweredElsewhere(
  workspaceId: string,
  agentId: string,
  permissionId: string,
  status: PlanStatus | null,
): Promise<PlanMeta | null> {
  return withPlans(workspaceId, async () => {
    const meta = (await allMetas(workspaceId)).find(
      (entry) => entry.source.kind === "exit-plan-mode" && entry.source.agentId === agentId && entry.source.permissionId === permissionId,
    );
    if (meta === undefined || meta.source.kind !== "exit-plan-mode") return null;
    const next: PlanMeta = {
      ...meta,
      source: { ...meta.source, permissionId: null },
      status: status ?? meta.status,
      answeredElsewhere: true,
      updatedAt: now(),
    };
    await writeMeta(next);
    return next;
  });
}

export function replyAsAgent(workspaceId: string, planId: string, annotationId: string, body: string, author: Author): Promise<UpdateResult> {
  if (body.trim() === "") return Promise.reject(new Error("A reply needs a body."));
  return updateAnnotation(workspaceId, planId, { annotationId, reply: body }, author);
}
