import { open } from "node:fs/promises";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "../shared/videos";
import { resolveLocalFile } from "./local-files";
import { readVideoHeader } from "./video-header";

/** Each request rechecks roots, real paths, type and cap. Never reads more than one chunk. */
export async function readVideoChunk(home: string, roots: readonly string[], src: string, offset: number) {
  const target = await resolveLocalFile(home, roots, src);
  if ("refused" in target) return { status: "refused" as const, reason: target.refused, size: null };
  const file = await open(target.absolute, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) return { status: "refused" as const, reason: "not-a-file" as const, size: null };
    if (info.size > MAX_VIDEO_BYTES) return { status: "refused" as const, reason: "too-large" as const, size: info.size };
    const header = Buffer.alloc(Math.min(4096, info.size));
    await file.read(header, 0, header.length, 0);
    const mimeType = readVideoHeader(header);
    if (mimeType === null) return { status: "refused" as const, reason: "unsupported" as const, size: info.size };
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) throw new Error("Invalid video offset");
    const bytes = Buffer.alloc(Math.min(VIDEO_CHUNK_BYTES, info.size - offset));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    return { status: "ok" as const, mimeType, size: info.size, modifiedMs: info.mtimeMs, base64: bytes.subarray(0, bytesRead).toString("base64") };
  } finally {
    await file.close();
  }
}
