/**
 * What an agent writes to name a file on this machine, turned into a path both halves read the same
 * way. Pure, with no Node, so the client can key its lookups by exactly what the daemon resolves.
 *
 * An agent writes a file as `tasks/x/shot.png` (relative to the home, or to the Markdown file it is
 * in), `C:\Users\…\shot.png`, `C:/Users/…/shot.png`, `/Users/…/shot.png`, or a `file:` URL
 * (`file:///C:/Users/…/shot%20one.png`, `file://localhost/…`). Anything with another scheme is not a
 * local file.
 */

/** The image types the chat draws, by extension. The daemon checks the bytes as well. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A drive-letter path, either slash: `C:\x`, `c:/x`. */
const DRIVE = /^[a-zA-Z]:[\\/]/;
/** A URL scheme; a drive letter is not one. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Whether `path` is absolute on some platform: a drive letter, a UNC share, or a leading slash. */
export function isAbsoluteLocal(path: string): boolean {
  return DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\\\");
}

/**
 * The local path `source` names, or null when it names none: a URL with a scheme other than
 * `file:`, or an empty string. A `file:` URL is percent-decoded and loses its query and fragment;
 * `file:///C:/x` becomes `C:/x`. A plain path is returned trimmed, as written.
 */
export function localPathOf(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  if (/^file:/i.test(trimmed)) {
    let rest = trimmed.slice("file:".length).replace(/[?#].*$/, "");
    // `file://host/path`: only an empty host or localhost is this machine.
    if (rest.startsWith("//")) {
      const slash = rest.indexOf("/", 2);
      const host = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
      if (host !== "" && host.toLowerCase() !== "localhost") return null;
      rest = slash === -1 ? "" : rest.slice(slash);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      decoded = rest;
    }
    // `/C:/x` is how a URL spells a drive letter.
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) decoded = decoded.slice(1);
    return decoded === "" ? null : decoded;
  }
  if (SCHEME.test(trimmed) && !DRIVE.test(trimmed)) return null;
  return trimmed;
}

/**
 * `relative` resolved against `base`, a home-relative folder (`""` for the home), `/`-separated and
 * normalized. An absolute path is returned as it is, and so is a relative one that climbs above the
 * home: the daemon refuses it, and the client must not hide that by clamping it.
 */
export function joinRelative(base: string, relative: string): string {
  if (isAbsoluteLocal(relative)) return relative;
  const parts: string[] = [];
  for (const part of `${base}/${relative}`.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0 || parts[parts.length - 1] === "..") parts.push("..");
      else parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/** The lowercase extension of the last segment of `path`, without the dot; `""` when it has none. */
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether `path` names a PNG, JPEG, GIF or WebP by its extension. */
export function isImagePath(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_EXTENSIONS, extensionOf(path));
}
