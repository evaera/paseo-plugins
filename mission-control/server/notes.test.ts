import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { notesPath, readNotes, writeNotes } from "./notes";

describe("the user's notes on a task", () => {
  it("live beside Mission Control's notes, under the task's own folder", () => {
    expect(notesPath("fix-login")).toBe("tasks/fix-login/user-notes.md");
    expect(() => notesPath("../etc")).toThrow();
    expect(() => notesPath("..")).toThrow();
    expect(() => notesPath("a/b")).toThrow();
  });

  it("read as empty until written, and saving nothing removes the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "mission-control-notes-"));
    expect(await readNotes(home, "fix-login")).toBe("");
    await writeNotes(home, "fix-login", "Check the migration before merging");
    expect(await readFile(join(home, notesPath("fix-login")), "utf8")).toBe("Check the migration before merging\n");
    expect(await readNotes(home, "fix-login")).toBe("Check the migration before merging\n");
    await writeNotes(home, "fix-login", "  ");
    await expect(stat(join(home, notesPath("fix-login")))).rejects.toThrow();
    expect(await readNotes(home, "fix-login")).toBe("");
  });
});
