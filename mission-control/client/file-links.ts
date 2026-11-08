/**
 * A reply's inline Markdown as tokens: text, bold, code, links, images, and the files it names,
 * which the chat links. Pure, so what is found and what is drawn are the same walk and can be
 * tested without a renderer.
 *
 * Finding a path is only half of it: whether `state/backlog.md` is a file is the daemon's to say
 * (`mission-control.files.find`, through the home and the registered project roots), so the chat
 * first collects every candidate a message could link (`fileCandidates`), asks, and then tokenizes
 * again with the answer (`inlineTokens`). Anything the daemon does not vouch for stays text.
 *
 * The scanner is CommonMark's shape, loosened where agents write otherwise: a link or image target
 * runs to its matching `)`, so it may hold balanced parentheses and, unlike CommonMark, spaces (an
 * agent writes `C:\My Shots\a.png` bare); a backslash escapes Markdown's punctuation, but never a
 * `.` or a backslash, so a Windows path in prose keeps every character. Nothing crosses a newline.
 */

import { MAX_FILE_PATH_LENGTH } from "../shared/files";
import { isAbsoluteLocal, joinRelative, localPathOf } from "../shared/local-path";
import { inlineTexts, parseMarkdown } from "./markdown-parse";

/** A run of plain text that could be a path: whatever brackets, quotes, commas and spaces leave. A source only; each walk makes its own. */
const WORD = /[^\s()[\]{}<>"'`,;]+/g;
/** Sentence punctuation after a path, which is not part of it. */
const TRAILING_PUNCTUATION = /[.:!?]+$/;
/** `:12` or `:12:4` after a path, or `#L12`, `#L12-L20`: a line, which the Files view cannot go to, so it is linked but not looked up. */
const LINE_SUFFIX = /(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/;
/** What a backslash makes literal. Not `.` or `\`, which a Windows path in prose is full of. */
const ESCAPABLE = "`*_[]{}()#+-!|<>~";
/** Schemes a link may open in the browser or an app; anything else is not followed. */
const UNSAFE_SCHEME = /^(?:javascript|vbscript|data|file):/i;

export type FileWhere = "home" | "project";

export type InlineToken =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "code"; text: string; bold: boolean }
  | { kind: "link"; text: string; url: string; bold: boolean; code: boolean }
  /** A file the daemon vouched for: home-relative in the home, absolute in a project. `code` keeps an inline-code look. */
  | { kind: "file"; text: string; path: string; where: FileWhere; bold: boolean; code: boolean }
  /** `![alt](src)`: `src` as written, or joined to the base folder when it is relative and one was given. */
  | { kind: "image"; alt: string; src: string };

export interface FileTarget {
  where: FileWhere;
  path: string;
}

/** What the daemon said `candidate` is, or null when it names no file it will link. */
export type FileLookup = (candidate: string) => FileTarget | null;

export interface InlineOptions {
  /** The home-relative folder relative paths are read from: the Markdown file's own, in the Files preview. Default: the home. */
  baseDir?: string;
}

/**
 * The path `text` would name, without a trailing line number, or null when it does not look like
 * one: a path has a slash (either way) in it or ends in an extension, so `tasks/scout-x/report.md`,
 * `C:\Users\x\notes.md`, `watches/pr-watch` and `AGENTS.md` are, and `backlog` is not. A `file:` URL
 * is decoded to its path. Spaces are allowed only where the writer delimited the path, in inline
 * code or a link's target. Nor is anything longer than the daemon will look up.
 */
export function pathCandidate(text: string, allowSpaces = false): string | null {
  // The line comes off first: `AGENTS.md:12` would otherwise read as a URL with the scheme `AGENTS.md`.
  const local = localPathOf(text.replace(LINE_SUFFIX, ""));
  if (local === null) return null;
  const path = local.replace(LINE_SUFFIX, "");
  if (path === "" || path.length > MAX_FILE_PATH_LENGTH || (!allowSpaces && /\s/.test(path))) return null;
  if (/[\\/]/.test(path)) return /[\w-]/.test(path) ? path : null;
  return /^[\w.@+-]*\w\.[a-zA-Z0-9]{1,10}$/.test(path) ? path : null;
}

function candidateOf(raw: string, allowSpaces: boolean, options: InlineOptions): string | null {
  const candidate = pathCandidate(raw, allowSpaces);
  if (candidate === null) return null;
  return options.baseDir !== undefined && options.baseDir !== "" && !isAbsoluteLocal(candidate)
    ? joinRelative(options.baseDir, candidate)
    : candidate;
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, (whole, char: string) => (ESCAPABLE.includes(char) ? char : whole));
}

/** Plain text split into what stays text and the files in it that `lookup` knows. */
function plainTokens(text: string, lookup: FileLookup, options: InlineOptions, bold: boolean): InlineToken[] {
  const tokens: InlineToken[] = [];
  let pending = "";
  let at = 0;
  const words = new RegExp(WORD.source, "g");
  let match: RegExpExecArray | null;
  while ((match = words.exec(text)) !== null) {
    const start = match.index;
    const word = match[0].replace(TRAILING_PUNCTUATION, "");
    const candidate = candidateOf(word, false, options);
    const found = candidate === null ? null : lookup(candidate);
    if (found === null) continue;
    pending += text.slice(at, start);
    if (pending !== "") tokens.push({ kind: "text", text: pending, bold });
    tokens.push({ kind: "file", text: word, path: found.path, where: found.where, bold, code: false });
    pending = "";
    at = start + word.length;
  }
  pending += text.slice(at);
  if (pending !== "") tokens.push({ kind: "text", text: pending, bold });
  return tokens;
}

/** The index of the backtick run closing one of `run`'s length opened before `from`, on the same line; -1 when there is none. */
function codeClose(text: string, from: number, run: number): number {
  let at = from;
  while (at < text.length) {
    if (text[at] === "\n") return -1;
    if (text[at] !== "`") {
      at += 1;
      continue;
    }
    let end = at;
    while (text[end] === "`") end += 1;
    if (end - at === run) return at;
    at = end;
  }
  return -1;
}

/** `(target "title")` from the `(` at `open`: the target and the index after `)`, or null when it does not close on this line. */
function destination(text: string, open: number): { target: string; end: number } | null {
  let at = open + 1;
  while (text[at] === " ") at += 1;
  if (text[at] === "<") {
    const close = text.indexOf(">", at);
    if (close === -1 || text.slice(at, close).includes("\n")) return null;
    const end = text.indexOf(")", close);
    if (end === -1 || text.slice(close, end).includes("\n")) return null;
    const target = text.slice(at + 1, close).trim();
    return target === "" ? null : { target, end: end + 1 };
  }
  const begin = at;
  let depth = 0;
  for (; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\n") return null;
    if (char === "\\" && (text[at + 1] === "(" || text[at + 1] === ")")) {
      at += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (at >= text.length) return null;
  let target = text.slice(begin, at).trim();
  const titled = /^(.*?)\s+(?:"[^"]*"|'[^']*')$/.exec(target);
  if (titled !== null) target = titled[1] ?? "";
  target = target.replace(/\\([()])/g, "$1");
  return target === "" ? null : { target, end: at + 1 };
}

/** `[label](target)` from the `[` at `start`, brackets balanced and code spans skipped; null when it is not one. */
function bracketLink(text: string, start: number): { label: string; target: string; end: number } | null {
  let depth = 0;
  let at = start;
  for (; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\n") return null;
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === "`") {
      let run = 0;
      while (text[at + run] === "`") run += 1;
      const close = codeClose(text, at + run, run);
      if (close !== -1) at = close + run - 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (at >= text.length || text[at + 1] !== "(") return null;
  const target = destination(text, at + 1);
  return target === null ? null : { label: text.slice(start + 1, at), ...target };
}

function imageSource(target: string, options: InlineOptions): string {
  const local = localPathOf(target);
  if (local === null || isAbsoluteLocal(local) || options.baseDir === undefined || options.baseDir === "") return target;
  return joinRelative(options.baseDir, local);
}

function linkTokens(
  link: { label: string; target: string },
  lookup: FileLookup,
  options: InlineOptions,
  bold: boolean,
): InlineToken[] {
  let shown = link.label.trim() === "" ? link.target : link.label.trim();
  let code = false;
  const codeLabel = /^`+([^`]+)`+$/.exec(shown);
  if (codeLabel !== null) {
    shown = codeLabel[1] ?? shown;
    code = true;
  } else {
    shown = unescape(shown.replace(/^(\*\*|__)(.+)\1$/, "$2"));
  }
  const local = localPathOf(link.target);
  if (local === null) {
    // Another scheme: the browser's, unless it could run something.
    return UNSAFE_SCHEME.test(link.target)
      ? [{ kind: "text", text: shown, bold }]
      : [{ kind: "link", text: shown, url: link.target, bold, code }];
  }
  const candidate = link.target.startsWith("#") ? null : candidateOf(link.target, true, options);
  const found = candidate === null ? null : lookup(candidate);
  if (found !== null) return [{ kind: "file", text: shown, path: found.path, where: found.where, bold, code }];
  return [code ? { kind: "code", text: shown, bold } : { kind: "text", text: shown, bold }];
}

/** A bare URL from `start`: up to whitespace or a bracket, parentheses balanced, sentence punctuation left off. */
function bareUrl(text: string, start: number): string | null {
  let at = start;
  let depth = 0;
  for (; at < text.length; at += 1) {
    const char = text[at] ?? "";
    if (/\s/.test(char) || "<>`[]\"".includes(char)) break;
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  const url = text.slice(start, at).replace(/[.,;:!?'*_]+$/, "");
  return /^https?:\/\/[^/\s]/i.test(url) ? url : null;
}

function scan(text: string, lookup: FileLookup, options: InlineOptions, bold: boolean): InlineToken[] {
  const tokens: InlineToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") tokens.push(...plainTokens(plain, lookup, options, bold));
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    const before = text[at - 1] ?? "";

    if (char === "\\" && ESCAPABLE.includes(text[at + 1] ?? "\\")) {
      flush();
      tokens.push({ kind: "text", text: text[at + 1] ?? "", bold });
      at += 2;
      continue;
    }

    if (char === "`") {
      let run = 0;
      while (text[at + run] === "`") run += 1;
      const close = codeClose(text, at + run, run);
      if (close === -1) {
        plain += "`".repeat(run);
        at += run;
        continue;
      }
      flush();
      const inner = text.slice(at + run, close);
      const code = /^ .* $/.test(inner) && inner.trim() !== "" ? inner.slice(1, -1) : inner;
      const candidate = candidateOf(code.trim(), true, options);
      const found = candidate === null ? null : lookup(candidate);
      tokens.push(
        found === null
          ? { kind: "code", text: code, bold }
          : { kind: "file", text: code, path: found.path, where: found.where, bold, code: true },
      );
      at = close + run;
      continue;
    }

    // `__` only between non-word characters, so snake__case stays text.
    const strong = text.startsWith("**", at) ? "**" : text.startsWith("__", at) && !/\w/.test(before) ? "__" : null;
    if (strong !== null && !bold) {
      const close = text.indexOf(strong, at + 2);
      const inner = close === -1 ? "" : text.slice(at + 2, close);
      if (inner.trim() !== "" && !inner.includes("\n") && !/^\s/.test(inner) && !(strong === "__" && /\w/.test(text[close + 2] ?? ""))) {
        flush();
        tokens.push(...scan(inner, lookup, options, true));
        at = close + 2;
        continue;
      }
    }

    if (char === "!" && text[at + 1] === "[") {
      const image = bracketLink(text, at + 1);
      if (image !== null) {
        flush();
        tokens.push({ kind: "image", alt: unescape(image.label.trim()), src: imageSource(image.target, options) });
        at = image.end;
        continue;
      }
    }

    if (char === "[") {
      const link = bracketLink(text, at);
      if (link !== null) {
        flush();
        tokens.push(...linkTokens(link, lookup, options, bold));
        at = link.end;
        continue;
      }
    }

    if (char === "<") {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(text.slice(at, at + 2048));
      if (auto !== null) {
        flush();
        tokens.push({ kind: "link", text: auto[1] ?? "", url: auto[1] ?? "", bold, code: false });
        at += auto[0].length;
        continue;
      }
    }

    if ((char === "h" || char === "H") && !/[\w/]/.test(before)) {
      const url = /^https?:\/\//i.test(text.slice(at, at + 8)) ? bareUrl(text, at) : null;
      if (url !== null) {
        flush();
        tokens.push({ kind: "link", text: url, url, bold, code: false });
        at += url.length;
        continue;
      }
    }

    plain += char;
    at += 1;
  }
  flush();
  return tokens;
}

/** Inline Markdown as tokens; inline code, a link's target and plain text are checked against `lookup` for files. */
export function inlineTokens(text: string, lookup: FileLookup, options: InlineOptions = {}): InlineToken[] {
  return scan(text, lookup, options, false);
}

/**
 * Every path `source` mentions that could be linked, once per mention, in order. Only the text the
 * renderer draws inline is walked, so a path in a fenced code block, which is never linked, is
 * never asked about.
 */
function mentions(source: string, options: InlineOptions): string[] {
  const found: string[] = [];
  const collect: FileLookup = (candidate) => {
    found.push(candidate);
    return null;
  };
  for (const text of inlineTexts(parseMarkdown(source))) inlineTokens(text, collect, options);
  return found;
}

/** Every path `source` could link, in order of first mention, each once: what to ask the daemon about. */
export function fileCandidates(source: string, options: InlineOptions = {}): string[] {
  return [...new Set(mentions(source, options))];
}

/**
 * The candidates of a whole conversation, oldest message first, each once and at its latest
 * mention (within a reply as much as across replies), keeping the `max` most recently mentioned,
 * so a file named early and again just now is not the one left out.
 */
export function recentCandidates(messages: readonly string[], max: number, options: InlineOptions = {}): string[] {
  const order = new Set<string>();
  for (const message of messages) {
    for (const candidate of mentions(message, options)) {
      order.delete(candidate);
      order.add(candidate);
    }
  }
  return [...order].slice(-max);
}

/** A lookup over the daemon's answer. */
export function lookupIn(
  files: Readonly<Record<string, string>>,
  projectFiles: Readonly<Record<string, string>> = {},
): FileLookup {
  return (candidate) => {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) {
      const path = files[candidate];
      return path === undefined ? null : { where: "home", path };
    }
    if (Object.prototype.hasOwnProperty.call(projectFiles, candidate)) {
      const path = projectFiles[candidate];
      return path === undefined ? null : { where: "project", path };
    }
    return null;
  };
}
