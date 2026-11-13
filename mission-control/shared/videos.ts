import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ImageRefusalSchema, MAX_FILE_PATH_LENGTH } from "./files";

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_CHUNK_BYTES = 256 * 1024;
export const videoChunk = defineRpc({
  name: "mission-control.files.video-chunk",
  input: z.object({ src: z.string().min(1).max(MAX_FILE_PATH_LENGTH), offset: z.number().int().min(0).max(MAX_VIDEO_BYTES) }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), mimeType: z.string(), size: z.number(), modifiedMs: z.number(), base64: z.string() }),
    z.object({ status: z.literal("refused"), reason: ImageRefusalSchema, size: z.number().nullable() }),
  ]),
});

/** Extension selects the player; the daemon still verifies the actual container. */
export function isVideoPath(src: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(src.trim().replace(/[?#].*$/, ""));
}

export function videoRefusal(reason: string, size: number | null): string {
  if (reason === "too-large") return `Video is ${size === null ? "too large" : `${Math.ceil(size / 1024 / 1024)} MB`}, over the 100 MB chat limit`;
  if (reason === "unsupported") return "Not a supported MP4, WebM or MOV video";
  if (reason === "outside") return "Video is outside Mission Control's home and Paseo's projects";
  if (reason === "missing") return "Video not found";
  if (reason === "not-a-file") return "Video source is a folder";
  return "Couldn't load video";
}
