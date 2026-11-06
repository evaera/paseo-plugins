/**
 * Renaming a task from its card: the title on its `state/backlog.md` line is
 * rewritten in place, and nothing else on the line or in the file is touched.
 * Mission Control writes the same file, so the write is compare-and-swap
 * (`replaceTextIfUnchanged`) and starts over from the new version when the
 * Mission Control wrote in between, as removing a suggestion does.
 *
 * A line is `- [ ] <id> - <title> <links> (<field>: …) …`, and a title can have
 * links in among its words. The title is everything between the id's dash and
 * the first field; the new title takes its place, with the links that were in
 * it kept after it, so a card keeps its pull requests.
 */
import { FileChangedError, readTextFile, replaceTextIfUnchanged } from "./files";
import { LINK } from "./links";
import { TEMPLATES } from "./templates";

const ATTEMPTS = 3;
const ITEM = /^(\s*[-*]\s+\[[ xX~-]\]\s+)([\w.-]{1,64})(\s+[-–—]\s+)(.*)$/;
/** Where the fields start: the first `(key:`, outcome or `(since …)` group. */
const FIELDS = /\s\((?:[a-zA-Z][\w-]*\s*:|(?:merged|done|landed|closed|failed|abandoned|since)\b)/i;
const REPORT_PATH = /\bdata\/[\w.-]+\/report\.md\b/g;

/** A title as it can go on one backlog line: one line, spaces collapsed. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim();
}

/** `markdown` with task `taskId`'s title replaced, or null when no line has that task. */
export function renamedBacklog(markdown: string, taskId: string, title: string): string | null {
  const lines = markdown.split("\n");
  const index = lines.findIndex((line) => ITEM.exec(line.replace(/\r$/, ""))?.[2] === taskId);
  if (index === -1) return null;
  const line = lines[index] ?? "";
  const ending = line.endsWith("\r") ? "\r" : "";
  const match = ITEM.exec(line.replace(/\r$/, ""));
  if (match === null) return null;
  const [, prefix = "", id = "", dash = "", rest = ""] = match;
  const cut = rest.search(FIELDS);
  const head = cut === -1 ? rest : rest.slice(0, cut);
  const fields = cut === -1 ? "" : rest.slice(cut);
  const kept = [...(head.match(new RegExp(LINK.source, "g")) ?? []), ...(head.match(REPORT_PATH) ?? [])];
  const newHead = [title, ...kept].join(" ");
  lines[index] = `${prefix}${id}${dash}${newHead}${fields}${ending}`;
  return lines.join("\n");
}

export async function renameTask(home: string, taskId: string, rawTitle: string): Promise<void> {
  const title = cleanTitle(rawTitle);
  if (title === "") throw new Error("A task needs a title.");
  for (let attempt = 1; ; attempt++) {
    const file = await readTextFile(home, TEMPLATES.backlog);
    if (file.content === null) throw new Error(`${TEMPLATES.backlog} is not a text file the board can edit.`);
    const next = renamedBacklog(file.content, taskId, title);
    if (next === null) throw new Error(`The backlog has no task ${taskId}.`);
    if (next === file.content) return;
    try {
      await replaceTextIfUnchanged(home, TEMPLATES.backlog, file.content, next);
      return;
    } catch (error) {
      if (!(error instanceof FileChangedError)) throw error;
      if (attempt >= ATTEMPTS) throw new Error("Mission Control kept rewriting the backlog while the task was being renamed. Try again.");
    }
  }
}
