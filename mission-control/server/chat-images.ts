/**
 * The images the user attached in the chat, kept so the conversation can draw them again. Paseo's
 * timeline records a user message's words and nothing of what went with them, so each message sent
 * with images gets a `messageId` of its own (`IMAGE_MESSAGE_ID_PREFIX`), which the daemon records as
 * the timeline item's `clientMessageId`, and its images are written to the home under
 * `.attachments/<messageId>/` before the send. They live in the home so the chat reads them through
 * `mission-control.files.image`, the one vetted way a local image reaches the app.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CHAT_IMAGES_DIR, IMAGE_MESSAGE_ID_PREFIX, isImageMessageId, type ImagePart } from "../shared/attachments";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

export function newImageMessageId(): string {
  return `${IMAGE_MESSAGE_ID_PREFIX}${randomUUID()}`;
}

/** Writes `images` where `chatImageSources` finds them, in the order they were attached. */
export async function keepChatImages(home: string, messageId: string, images: readonly ImagePart[]): Promise<void> {
  if (!isImageMessageId(messageId)) throw new Error(`"${messageId}" is not an image message id.`);
  const dir = join(home, CHAT_IMAGES_DIR, messageId);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    images.map((image, index) => {
      const type = image.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      // Zero-padded, so a directory listing sorts in attachment order.
      const name = `${String(index).padStart(2, "0")}.${EXTENSIONS[type] ?? "img"}`;
      return writeFile(join(dir, name), Buffer.from(image.data, "base64"));
    }),
  );
}

/** The kept images of one message as home-relative paths, in order; none for an id nothing was kept under. */
export async function chatImageSources(home: string, messageId: string): Promise<string[]> {
  if (!isImageMessageId(messageId)) return [];
  try {
    const names = await readdir(join(home, CHAT_IMAGES_DIR, messageId));
    return names.sort().map((name) => `${CHAT_IMAGES_DIR}/${messageId}/${name}`);
  } catch {
    return [];
  }
}
