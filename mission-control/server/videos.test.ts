import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "../shared/videos";
import { readVideoHeader } from "./video-header";
import { readVideoChunk } from "./videos";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const mp4 = () => Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("mp42")]);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "mc-video-")); dirs.push(home);
  return home;
}
it("recognizes MP4, MOV and WebM containers and rejects other bytes", () => {
  expect(readVideoHeader(mp4())).toBe("video/mp4");
  const mov = mp4(); mov.write("qt  ", 8); expect(readVideoHeader(mov)).toBe("video/quicktime");
  expect(readVideoHeader(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...Buffer.from("webm")]))).toBe("video/webm");
  expect(readVideoHeader(Buffer.from("<html>video.mp4</html>"))).toBeNull();
  expect(readVideoHeader(mp4().subarray(0, 12))).toBeNull();
});
it("reads bounded chunks at offsets and verifies content rather than extension", async () => {
  const home = await fixture(); const bytes = Buffer.alloc(VIDEO_CHUNK_BYTES + 57); mp4().copy(bytes);
  await writeFile(join(home, "clip.mov"), bytes);
  const first = await readVideoChunk(home, [], "clip.mov", 0);
  const last = await readVideoChunk(home, [], "clip.mov", VIDEO_CHUNK_BYTES);
  expect(first.status).toBe("ok"); expect(last.status).toBe("ok");
  if (first.status !== "ok" || last.status !== "ok") return;
  expect(first.mimeType).toBe("video/mp4");
  expect(Buffer.from(first.base64, "base64").length).toBe(VIDEO_CHUNK_BYTES);
  expect(Buffer.from(last.base64, "base64")).toEqual(bytes.subarray(VIDEO_CHUNK_BYTES));
  expect(await readVideoChunk(home, [], "clip.mov", bytes.length)).toMatchObject({ status: "ok", base64: "" });
  await expect(readVideoChunk(home, [], "clip.mov", bytes.length + 1)).rejects.toThrow("offset");
});
it("refuses unsafe paths, folders, missing files, unsupported headers and oversized videos", async () => {
  const home = await fixture(); const outside = await fixture();
  await writeFile(join(outside, "secret.mp4"), mp4());
  expect(await readVideoChunk(home, [], join(outside, "secret.mp4"), 0)).toMatchObject({ reason: "outside" });
  expect(await readVideoChunk(home, [], "../secret.mp4", 0)).toMatchObject({ reason: "outside" });
  expect(await readVideoChunk(home, [], "missing.mp4", 0)).toMatchObject({ reason: "missing" });
  expect(await readVideoChunk(home, [], home, 0)).toMatchObject({ reason: "not-a-file" });
  expect(await readVideoChunk(home, [outside], join(outside, "secret.mp4"), 0)).toMatchObject({ status: "ok" });
  await writeFile(join(home, "fake.mp4"), "not video");
  expect(await readVideoChunk(home, [], "fake.mp4", 0)).toMatchObject({ reason: "unsupported" });
  const large = await open(join(home, "large.mp4"), "w");
  try { await large.truncate(MAX_VIDEO_BYTES + 1); } finally { await large.close(); }
  expect(await readVideoChunk(home, [], "large.mp4", 0)).toMatchObject({ reason: "too-large", size: MAX_VIDEO_BYTES + 1 });
});
