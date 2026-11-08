/**
 * An image's type and size from its first bytes, for the four types the chat draws. Pure. The type
 * is decided by the bytes, never the name, so a `.png` that is really an HTML error page is refused
 * rather than handed to the renderer.
 */

export interface ImageHeader {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number | null;
  height: number | null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function be16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function le16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function le24(bytes: Uint8Array, at: number): number {
  return le16(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
}

function be32(bytes: Uint8Array, at: number): number {
  return ((be16(bytes, at) << 16) | be16(bytes, at + 2)) >>> 0;
}

/** Width and height from a JPEG's first start-of-frame marker, walking the segments before it. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // SOF0–SOF15 carry the frame size, except C4 (DHT), C8 (JPG) and CC (DAC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
    }
    at += 2 + be16(bytes, at + 2);
  }
  return null;
}

/** `bytes` is the start of the file; a few kilobytes are enough for every type but a JPEG with a large EXIF block. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
    return { mimeType: "image/png", width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    return { mimeType: "image/jpeg", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { mimeType: "image/gif", width: le16(bytes, 6), height: le16(bytes, 8) };
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    // VP8: a 14-bit width and height after the frame tag and start code.
    if (chunk === "VP8 " && bytes.length >= 30) {
      return { mimeType: "image/webp", width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff };
    }
    // VP8L: width-1 and height-1 packed into 14 bits each after the signature byte.
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      return {
        mimeType: "image/webp",
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    // VP8X: 24-bit canvas width-1 and height-1.
    if (chunk === "VP8X" && bytes.length >= 30) {
      return { mimeType: "image/webp", width: 1 + le24(bytes, 24), height: 1 + le24(bytes, 27) };
    }
    return { mimeType: "image/webp", width: null, height: null };
  }
  return null;
}
