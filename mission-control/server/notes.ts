/**
 * The user's notes on a task, `tasks/<task id>/user-notes.md`, written
 * from the card's view. Beside Mission Control's own `notes.md` in the task's
 * folder and apart from it: Mission Control reads these and never writes them
 * (charter §2). A task with no notes has no file; saving empty notes removes it.
 */
import { rm } from "node:fs/promises";

import { readTextFile, resolveInHome, writeTextFile } from "./files";
import { serialized } from "./serialize";

/** The backlog's own id rule: a short path-safe slug. */
const TASK_ID = /^[\w.-]{1,64}$/;

export function notesPath(taskId: string): string {
  if (!TASK_ID.test(taskId) || taskId === "." || taskId === "..") throw new Error(`"${taskId}" is not a task id.`);
  return `tasks/${taskId}/user-notes.md`;
}

/** Queued behind any save of the same file, so a read right after a save sees it. */
export async function readNotes(home: string, taskId: string): Promise<string> {
  const path = notesPath(taskId);
  const { absolute } = await resolveInHome(home, path);
  return serialized(absolute, async () => {
    try {
      return (await readTextFile(home, path)).content ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  });
}

export async function writeNotes(home: string, taskId: string, text: string): Promise<void> {
  const path = notesPath(taskId);
  if (text.trim() === "") {
    const { absolute } = await resolveInHome(home, path);
    await serialized(absolute, () => rm(absolute, { force: true }));
    return;
  }
  // `writeTextFile` queues itself on the same key; wrapping it again would wait on itself.
  await writeTextFile(home, { path, content: text.endsWith("\n") ? text : `${text}\n`, expectedModifiedMs: null, force: true });
}
