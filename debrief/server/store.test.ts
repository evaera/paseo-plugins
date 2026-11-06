import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createComment, deleteComment, replyToComment, resolveComment } from "./comments";
import { claimOpenRequests } from "./open-requests";
import { freshReview } from "./review";
import { loadReviewDoc, mutateReview, newCommentId, newReplyId, reviewDir, reviewPath } from "./store";

const human = { kind: "human" as const, name: "Reviewer" };
let home: string;
let work: string;
const saved = process.env.PASEO_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "debrief-home-"));
  work = await mkdtemp(join(tmpdir(), "debrief-work-"));
  process.env.PASEO_HOME = home;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = saved;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("the review store", () => {
  it("starts empty, bumps the revision on every write, and serializes writers", async () => {
    expect((await loadReviewDoc("ws1", work)).revision).toBe(0);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        mutateReview("ws1", work, (review) => {
          review.comments.push({
            id: `c_${index}`,
            scope: "review",
            body: String(index),
            author: human,
            createdAt: "t",
            updatedAt: "t",
            resolved: false,
            drifted: false,
            replies: [],
          });
        }),
      ),
    );
    const review = await loadReviewDoc("ws1", work);
    expect(review.revision).toBe(10);
    expect(review.comments).toHaveLength(10);
  });

  it("skips the write when asked to", async () => {
    await mutateReview("ws1", work, () => false, { skipWriteWhen: (changed) => !changed });
    await expect(readFile(reviewPath("ws1"), "utf8")).rejects.toThrow();
  });

  it("sets an invalid document aside instead of overwriting it", async () => {
    await mkdir(dirname(reviewPath("ws1")), { recursive: true });
    await writeFile(reviewPath("ws1"), '{"version": 2}');
    expect((await loadReviewDoc("ws1", work)).comments).toEqual([]);
    expect((await readdir(reviewDir("ws1"))).some((name) => name.startsWith("review.json.invalid-"))).toBe(true);
  });

  it("refuses a workspace id that would climb out of its directory", () => {
    expect(() => reviewDir("../x")).toThrow();
    expect(() => reviewDir("..")).toThrow();
  });

  it("makes Crit-shaped ids", async () => {
    const review = await loadReviewDoc("ws1", work);
    expect(newCommentId(review)).toMatch(/^c_[0-9a-f]{6}$/);
    expect(newReplyId(review)).toMatch(/^rp_[0-9a-f]{6}$/);
  });
});

describe("comments", () => {
  it("anchors a new-side line comment and follows the code when the file changes", async () => {
    await writeFile(join(work, "a.ts"), "one\ntwo\nthree\n");
    const { comment } = await createComment("ws1", work, { scope: "line", path: "./a.ts", startLine: 3, endLine: 2, body: " fix " }, human);
    expect(comment).toMatchObject({ path: "a.ts", side: "new", startLine: 2, endLine: 3, anchor: "two\nthree", body: "fix", drifted: false });

    await writeFile(join(work, "a.ts"), "zero\none\ntwo\nthree\n");
    const moved = (await freshReview("ws1", work)).comments[0];
    expect([moved?.startLine, moved?.endLine, moved?.drifted]).toEqual([3, 4, false]);

    await writeFile(join(work, "a.ts"), "nothing like it\n");
    expect((await freshReview("ws1", work)).comments[0]?.drifted).toBe(true);
  });

  it("replies, resolves and deletes", async () => {
    const { comment } = await createComment("ws1", work, { scope: "review", body: "overall" }, human);
    const replied = await replyToComment("ws1", work, comment.id, "done", { kind: "agent", name: "Claude", agentId: "a1" });
    expect(replied.comment.replies[0]).toMatchObject({ id: replied.replyId, body: "done", author: { kind: "agent", agentId: "a1" } });
    const resolved = await resolveComment("ws1", work, comment.id, true);
    expect(resolved.comment.resolved).toBe(true);
    expect(resolved.comment.resolvedAt).toBeDefined();
    expect((await resolveComment("ws1", work, comment.id, false)).comment.resolvedAt).toBeUndefined();
    await deleteComment("ws1", work, { commentId: comment.id, replyId: replied.replyId });
    expect((await loadReviewDoc("ws1", work)).comments[0]?.replies).toEqual([]);
    await deleteComment("ws1", work, { commentId: comment.id });
    expect((await loadReviewDoc("ws1", work)).comments).toEqual([]);
  });

  it("refuses a line comment without a path or outside the workspace", async () => {
    await expect(createComment("ws1", work, { scope: "line", startLine: 1, body: "x" }, human)).rejects.toThrow();
    await expect(createComment("ws1", work, { scope: "file", path: "../x", body: "x" }, human)).rejects.toThrow();
  });
});

describe("open requests", () => {
  it("claims valid requests once and deletes invalid ones", async () => {
    const dir = join(home, "plugin-data", "debrief", "open-requests");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), JSON.stringify({ workspaceId: "ws1", view: "story" }));
    await writeFile(join(dir, "b.json"), JSON.stringify({ nope: true }));
    await writeFile(join(dir, "c.json"), "{broken");
    expect(await claimOpenRequests()).toEqual([{ workspaceId: "ws1", view: "story" }]);
    expect(await readdir(dir)).toEqual([]);
    expect(await claimOpenRequests()).toEqual([]);
  });
});
