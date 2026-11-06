/**
 * What `debrief_story_prep` hands the agent: a short authoring guide, then
 * the whole diff with every hunk labelled by its id, after Crit's
 * `internal/story/prep.go` (MIT). Crit writes the prep to a file and points
 * the agent at it; a tool result is the file here, so past a budget the rest
 * of the diff is listed by hunk id only and the agent reads those files
 * itself.
 */
import type { DiffFile } from "../shared/review";
import { parseUnifiedDiff } from "./diff";

/** Roughly 40k tokens of diff; the guide and the id list are on top. */
export const PREP_BUDGET_CHARS = 160_000;

/** `path -> oldStart -> the hunk's lines`, from a raw unified diff. */
export function hunkBodies(rawDiff: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  const sections = rawDiff.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const file = parseUnifiedDiff(section)[0];
    if (file === undefined) continue;
    const bodies = new Map<number, string>();
    let current: { oldStart: number; lines: string[] } | null = null;
    const close = () => {
      if (current !== null) bodies.set(current.oldStart, current.lines.join("\n").replace(/\n+$/, ""));
    };
    for (const line of section.split("\n")) {
      const header = /^@@ -(\d+)/.exec(line);
      if (header !== null) {
        close();
        current = { oldStart: Number(header[1]), lines: [line] };
      } else if (current !== null) current.lines.push(line);
    }
    close();
    out.set(file.path, bodies);
  }
  return out;
}

/** An untracked file's one hunk, as a diff would show it. */
export function addedBody(text: string): string {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
}

export const STORY_GUIDE = `How to write a Debrief story

A story is a guided tour of this diff for a human reviewer. Write it with debrief_write_story.

- prologue: a short title (48 characters at most), an overview paragraph saying what the change does and why, keyChanges (the few things the reviewer must understand) and risks (what could break, what to look at hardest). Each list needs at least one entry.
- chapters: the change told in the order a reviewer should read it, usually 2 to 7 chapters. Each has a title, a summary, and files in reading order. A file lists the hunk ids it shows in that chapter in "hunks"; leave "hunks" out to place all of that file's hunks there.
- support: hunks that support the change without telling its story (lockfiles, generated code, renames, formatting), each with a reason.
- Every hunk must be placed exactly once, across chapters and support. A hunk is identified by its file path and its id (the old start line in its @@ header, 0 for a new file). Placing a hunk twice is rejected. Missing hunks are moved into support as "auto-repaired" when at least half of the diff is placed; below that the story is rejected.
- annotations: on any file in a chapter, { line, side?, body } places a prose note above that 1-based line of the new file (side "old" for the base). Use them to point at the line that matters and say why. Keep them short; Markdown is fine. They are never written into the file. Add or edit one later with debrief_annotate.
- Pass the same compare (or scope) you prepared with, and the fingerprint below as "fingerprint", so a diff that changed while you wrote is caught. Pass replace: true to overwrite an existing story.`;

export interface PrepInput {
  /** "main @ b990f96 vs working tree". */
  compareLabel: string;
  files: readonly DiffFile[];
  bodies: ReadonlyMap<string, ReadonlyMap<number, string>>;
  fingerprint: string;
  budget?: number;
}

export interface Prep {
  text: string;
  /** Hunks whose body did not fit the budget. */
  omitted: number;
}

export function buildPrep(input: PrepInput): Prep {
  const budget = input.budget ?? PREP_BUDGET_CHARS;
  const hunkCount = input.files.reduce((sum, file) => sum + Math.max(1, file.hunks.length), 0);
  const parts: string[] = [
    STORY_GUIDE,
    "",
    `Comparing: ${input.compareLabel}`,
    `Fingerprint: ${input.fingerprint}`,
    `Files: ${input.files.length}, hunks: ${hunkCount}`,
    "",
  ];
  let used = parts.join("\n").length;
  let omitted = 0;
  for (const file of input.files) {
    const rename = file.oldPath === undefined ? "" : ` (from ${file.oldPath})`;
    parts.push(`=== ${file.path}${rename} [${file.status}${file.binary ? ", binary" : ""}] +${file.additions} -${file.deletions}`);
    if (file.hunks.length === 0) {
      parts.push(`--- hunk ${file.path} 0 (no text hunks; place it as hunk 0)`);
      continue;
    }
    const bodies = input.bodies.get(file.path);
    for (const hunk of file.hunks) {
      const body = bodies?.get(hunk.oldStart) ?? "";
      const label = `--- hunk ${file.path} ${hunk.oldStart}`;
      if (body !== "" && used + body.length <= budget) {
        parts.push(label, body);
        used += label.length + body.length + 2;
      } else {
        parts.push(`${label} (@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}; body omitted, read the file)`);
        if (body !== "") omitted += 1;
      }
    }
  }
  if (omitted > 0) parts.push("", `${omitted} hunk bodies did not fit and are listed by id only; read those files to see them.`);
  return { text: parts.join("\n"), omitted };
}
