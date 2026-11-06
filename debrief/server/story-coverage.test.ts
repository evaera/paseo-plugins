import { describe, expect, it } from "vitest";

import type { DiffFile } from "../shared/review";
import type { StoryDraft } from "../shared/story";
import { AUTO_REPAIRED, checkCoverage, hunkIndex, scopeFingerprint, shapeDraft, StoryRejected } from "./story-coverage";
import { addedBody, buildPrep, hunkBodies } from "./story-prep";

function file(path: string, starts: number[], extra: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: starts.map((oldStart) => ({ oldStart, oldLines: 3, newStart: oldStart, newLines: 4, header: "" })),
    ...extra,
  };
}

const files = [file("a.ts", [1, 20]), file("b.ts", [5]), file("img.png", [], { binary: true })];
const prologue = { title: "Add a thing", overview: "It adds a thing.", keyChanges: ["the thing"], risks: ["none really"] };

function draft(chapters: StoryDraft["chapters"], support: StoryDraft["support"] = []): StoryDraft {
  return { prologue, chapters, support };
}

describe("story coverage", () => {
  it("indexes a file without hunks as hunk 0", () => {
    expect(hunkIndex(files)).toEqual([
      { path: "a.ts", oldStart: 1 },
      { path: "a.ts", oldStart: 20 },
      { path: "b.ts", oldStart: 5 },
      { path: "img.png", oldStart: 0 },
    ]);
  });

  it("accepts a story that places every hunk once, with omitted hunks meaning all of a file's", () => {
    const shaped = shapeDraft(
      draft(
        [{ title: "Core", summary: "", files: [{ path: "a.ts", annotations: [] }, { path: "b.ts", hunks: [5], annotations: [] }] }],
        [{ path: "img.png", reason: "asset" }],
      ),
    );
    const result = checkCoverage(shaped, hunkIndex(files));
    expect(result.coverage).toMatchObject({ indexed: 4, placed: 4, missing: [], duplicated: [], autoRepaired: 0 });
    expect(shaped.chapters[0]?.id).toBe("core");
  });

  it("rejects duplicates", () => {
    const shaped = shapeDraft(
      draft([
        { title: "One", summary: "", files: [{ path: "a.ts", hunks: [1], annotations: [] }] },
        { title: "Two", summary: "", files: [{ path: "a.ts", annotations: [] }, { path: "b.ts", annotations: [] }, { path: "img.png", annotations: [] }] },
      ]),
    );
    expect(() => checkCoverage(shaped, hunkIndex(files))).toThrow(StoryRejected);
    try {
      checkCoverage(shaped, hunkIndex(files));
    } catch (error) {
      expect((error as StoryRejected).coverage.duplicated).toEqual([{ path: "a.ts", oldStart: 1 }]);
    }
  });

  it("repairs missing hunks into support above the floor", () => {
    const shaped = shapeDraft(draft([{ title: "Core", summary: "", files: [{ path: "a.ts", annotations: [] }, { path: "b.ts", annotations: [] }] }]));
    const result = checkCoverage(shaped, hunkIndex(files));
    expect(result.coverage.autoRepaired).toBe(1);
    expect(result.support).toEqual([{ path: "img.png", hunks: [0], reason: AUTO_REPAIRED }]);
  });

  it("rejects below the floor, listing what is missing", () => {
    const shaped = shapeDraft(draft([{ title: "Core", summary: "", files: [{ path: "b.ts", annotations: [] }] }]));
    expect(() => checkCoverage(shaped, hunkIndex(files))).toThrow(/fewer than half/);
  });

  it("ignores hunks the diff does not have", () => {
    const shaped = shapeDraft(
      draft([{ title: "Core", summary: "", files: [{ path: "a.ts", annotations: [] }, { path: "b.ts", hunks: [5, 99], annotations: [] }, { path: "img.png", annotations: [] }] }]),
    );
    expect(checkCoverage(shaped, hunkIndex(files)).coverage.placed).toBe(4);
  });

  it("checks the prologue and chapter ids", () => {
    expect(() => shapeDraft({ ...draft([]), prologue: { ...prologue, risks: [""] } })).toThrow(/prologue/);
    expect(() => shapeDraft(draft([{ id: "support", title: "X", summary: "", files: [] }]))).toThrow(/Chapter id/);
    const shaped = shapeDraft(draft([{ title: "Same", summary: "", files: [] }, { title: "Same", summary: "", files: [] }]));
    expect(shaped.chapters.map((chapter) => chapter.id)).toEqual(["same", "same-2"]);
  });

  it("fingerprints the hunks' whole shape, in any order", () => {
    const base = scopeFingerprint(files);
    expect(scopeFingerprint([...files].reverse())).toBe(base);
    const grown = files.map((entry) => (entry.path === "b.ts" ? { ...entry, hunks: entry.hunks.map((hunk) => ({ ...hunk, newLines: 9 })) } : entry));
    expect(scopeFingerprint(grown)).not.toBe(base);
  });
});

describe("story prep", () => {
  const raw = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    " one",
    "+two",
    "@@ -20,3 +21,4 @@ fn",
    "-x",
    "+y",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5,3 +5,4 @@",
    "+z",
    "",
  ].join("\n");

  it("splits a raw diff into hunk bodies by path and id", () => {
    const bodies = hunkBodies(raw);
    expect(bodies.get("a.ts")?.get(1)).toBe("@@ -1,3 +1,4 @@\n one\n+two");
    expect(bodies.get("a.ts")?.get(20)).toBe("@@ -20,3 +21,4 @@ fn\n-x\n+y");
    expect(bodies.get("b.ts")?.get(5)).toBe("@@ -5,3 +5,4 @@\n+z");
  });

  it("labels every hunk and lists bodies past the budget by id", () => {
    const prep = buildPrep({ compareLabel: "main @ abc vs working tree", files, bodies: hunkBodies(raw), fingerprint: "fp", budget: 3_000 });
    expect(prep.text).toContain("--- hunk a.ts 1\n@@ -1,3 +1,4 @@");
    expect(prep.text).toContain("--- hunk img.png 0 (no text hunks");
    expect(prep.text).toContain("Fingerprint: fp");
    const tight = buildPrep({ compareLabel: "x", files, bodies: hunkBodies(raw), fingerprint: "fp", budget: 0 });
    expect(tight.omitted).toBe(3);
    expect(tight.text).toContain("body omitted");
  });

  it("writes an untracked file as one added hunk", () => {
    expect(addedBody("a\nb\n")).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  });
});
