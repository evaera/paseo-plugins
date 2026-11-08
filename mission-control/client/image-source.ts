/**
 * What a Markdown image's source is and how big to draw it. Pure, so the rules are testable
 * without a renderer; `./markdown-image` draws them.
 */
import { MAX_IMAGE_BYTES, type ImageRefusal } from "../shared/files";
import { localPathOf } from "../shared/local-path";
import { formatBytes } from "./attachments";

export type ImageSource =
  /** Loaded by the app itself: an `http(s)` URL, or a `data:` URI of one of the four types. */
  | { kind: "remote"; uri: string }
  /** A file on the daemon's machine, read through `mission-control.files.image`. */
  | { kind: "local"; src: string }
  | { kind: "invalid" };

export function classifyImage(src: string): ImageSource {
  const trimmed = src.trim();
  if (/^https?:\/\/[^/\s]/i.test(trimmed)) return { kind: "remote", uri: trimmed };
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(trimmed)) return { kind: "remote", uri: trimmed };
  return localPathOf(trimmed) === null ? { kind: "invalid" } : { kind: "local", src: trimmed };
}

/** The file name a source ends in, for a placeholder's sentence; a URL's last segment, decoded. */
export function imageName(src: string): string {
  if (/^data:/i.test(src)) return "an inline image";
  const path = (localPathOf(src) ?? src).replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    return decodeURIComponent(name) || src;
  } catch {
    return name || src;
  }
}

/** Why an image is not drawn, as the placeholder says it. */
export function refusalText(reason: ImageRefusal | "failed" | "other-host" | "invalid", src: string, size: number | null): string {
  const name = imageName(src);
  switch (reason) {
    case "missing":
      return `Image not found: ${name}`;
    case "outside":
      return `Not shown: ${name} is outside Mission Control's home and Paseo's projects`;
    case "too-large":
      return `${name} is ${size === null ? "too large" : formatBytes(size)}, over the ${formatBytes(MAX_IMAGE_BYTES)} limit for images in the chat`;
    case "unsupported":
      return `${name} is not a PNG, JPEG, GIF or WebP image`;
    case "not-a-file":
      return `${name} is a folder, not an image`;
    case "other-host":
      return `${name} is on the worker's host, which this view cannot read files from`;
    case "invalid":
      return `Not an image Mission Control can show: ${src}`;
    default:
      return `Couldn't load ${name}`;
  }
}

/**
 * The size to draw an image at: the column's width, never taller than `maxHeight`, never wider
 * than the image itself so a small icon is not blown up, and its own shape kept. Without known
 * dimensions it is drawn 16:9.
 */
export function fitImage(
  natural: { width: number | null; height: number | null },
  columnWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const known = natural.width !== null && natural.height !== null && natural.width > 0 && natural.height > 0;
  const aspect = known ? (natural.width ?? 16) / (natural.height ?? 9) : 16 / 9;
  const width = Math.max(0, Math.min(columnWidth, maxHeight * aspect, known ? (natural.width ?? Infinity) : Infinity));
  return { width: Math.round(width), height: Math.round(width / aspect) };
}
