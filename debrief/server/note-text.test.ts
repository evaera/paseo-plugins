import { describe, expect, it } from "vitest";

import type { Comment } from "../shared/review";
import { ThreadRowSchema } from "../shared/timeline";
import { noteText, threadRow } from "./note-text";

const comment: Comment = {
  id: "c_ab12cd",
  scope: "line",
  path: "src/a.ts",
  side: "new",
  startLine: 12,
  endLine: 14,
  anchor: "const a = 1;\nconst b = 2;\nconst c = 3;",
  body: "Rename these.",
  author: { kind: "human", name: "Reviewer" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  resolved: false,
  drifted: false,
  replies: [],
};

describe("notes", () => {
  it("states the comment, its place, its code and what to do", () => {
    expect(noteText({ kind: "created", comment })).toBe(
      "Debrief: new review comment c_ab12cd on src/a.ts lines 12-14 (new side):\n" +
        "> const a = 1;\n> const b = 2;\n> const c = 3;\n\nRename these.\n\n" +
        "Act on it, then reply with the debrief_reply tool (commentId c_ab12cd). Do not resolve it; the reviewer resolves.",
    );
  });

  it("covers resolve, delete and approve", () => {
    expect(noteText({ kind: "resolved", comment, resolved: true })).toContain("resolved comment c_ab12cd");
    expect(noteText({ kind: "deleted", comment })).toContain("Disregard it");
    expect(noteText({ kind: "approved", note: "Ship it", open: 1 })).toBe(
      "Debrief: the reviewer approved the review. 1 comment is still unresolved; use debrief_list_comments to see them.\n\nShip it",
    );
  });
});

describe("thread rows", () => {
  it("match the shared schema and stay under the row cap", () => {
    const huge: Comment = {
      ...comment,
      body: "x".repeat(200_000),
      replies: Array.from({ length: 50 }, (_, index) => ({
        id: `rp_${index}`,
        body: "y".repeat(10_000),
        author: { kind: "agent" as const, name: "Claude", agentId: "a1" },
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      })),
    };
    const row = threadRow("ws1", huge);
    expect(ThreadRowSchema.safeParse(row).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(64 * 1024);
    expect(row.updatedAt).toBe("2026-01-02T00:00:00Z");
  });
});
