import { describe, expect, it } from "vitest";

import { countLines, parseUnifiedDiff, unquotePath, untrackedDiffFile } from "./diff";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function top() {
 one
-two
+TWO
+three
 four
@@ -10 +11,0 @@
-gone
`;

describe("parseUnifiedDiff", () => {
  it("reads a modified file with hunks and counts", () => {
    expect(parseUnifiedDiff(MODIFIED)).toEqual([
      {
        path: "src/a.ts",
        status: "modified",
        binary: false,
        additions: 2,
        deletions: 2,
        hunks: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, header: "function top() {" },
          { oldStart: 10, oldLines: 1, newStart: 11, newLines: 0, header: "" },
        ],
      },
    ]);
  });

  it("reads added, deleted, renamed and binary files", () => {
    const text = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+a
+b
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/from dir/x.ts b/to dir/x.ts
similarity 90%
rename from from dir/x.ts
rename to to dir/x.ts
index 5555555..6666666 100644
--- a/from dir/x.ts
+++ b/to dir/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/img.png b/img.png
index 7777777..8888888 100644
Binary files a/img.png and b/img.png differ
`;
    const files = parseUnifiedDiff(text);
    expect(files.map((file) => [file.path, file.status, file.oldPath, file.binary, file.additions, file.deletions])).toEqual([
      ["new.txt", "added", undefined, false, 2, 0],
      ["old.txt", "deleted", undefined, false, 0, 1],
      ["to dir/x.ts", "renamed", "from dir/x.ts", false, 1, 1],
      ["img.png", "modified", undefined, true, 0, 0],
    ]);
  });

  it("treats a pure rename with no content change as renamed", () => {
    const text = `diff --git a/a.ts b/b.ts
similarity index 100%
rename from a.ts
rename to b.ts
`;
    expect(parseUnifiedDiff(text)).toEqual([
      { path: "b.ts", oldPath: "a.ts", status: "renamed", binary: false, additions: 0, deletions: 0, hunks: [] },
    ]);
  });

  it("does not mistake a removed line starting with dashes for a header", () => {
    const text = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,1 @@
--- a rule
 keep
`;
    const [file] = parseUnifiedDiff(text);
    expect(file?.deletions).toBe(1);
    expect(file?.path).toBe("a.md");
  });

  it("reads a mode-only change and an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    const [file] = parseUnifiedDiff("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n");
    expect(file).toMatchObject({ path: "run.sh", status: "modified", hunks: [] });
  });
});

describe("helpers", () => {
  it("unquotes git's C-style paths", () => {
    expect(unquotePath('"a\\tb"')).toBe("a\tb");
    expect(unquotePath('"caf\\303\\251"')).toBe("café");
    expect(unquotePath("plain")).toBe("plain");
  });

  it("counts lines with and without a final newline", () => {
    expect([countLines(""), countLines("a"), countLines("a\n"), countLines("a\nb")]).toEqual([0, 1, 1, 2]);
  });

  it("builds an untracked entry", () => {
    expect(untrackedDiffFile("n.ts", "a\nb\n")).toMatchObject({ status: "untracked", additions: 2, hunks: [{ oldStart: 0, newStart: 1, newLines: 2 }] });
    expect(untrackedDiffFile("n.bin", null)).toMatchObject({ binary: true, hunks: [] });
  });
});
