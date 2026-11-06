/**
 * A plan's Markdown split into annotatable blocks: a port of Plannotator's
 * `parseMarkdownToBlocks` (`packages/ui/utils/parser.ts`, MIT OR Apache-2.0).
 *
 * The same linear rules: a heading, rule, list item, quote run, fenced code
 * block, table or raw HTML block is one block each, and everything else
 * collects into paragraphs separated by blank lines; an indented line after a
 * list item continues it. Display math, `:::` directives, GitHub alerts and
 * reference-link resolution are not ported: their lines fall through as
 * paragraphs, which is still a valid place to annotate.
 *
 * Unlike Plannotator, a block's `text` is its source lines verbatim (from
 * `startLine` to `endLine`), not the content with its marker stripped, so the
 * client can draw it with the host `Markdown` and annotation offsets index
 * the source.
 */
import type { PlanBlock } from "../shared/plan";

/** Plannotator's `HTML_BLOCK_TAGS`: block-level tags that open a raw HTML block. */
const HTML_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul", "picture", "video", "audio", "iframe", "img", "br", "center", "script", "style",
]);

/** The line a `---` frontmatter block ends on (0-based), or -1 when there is none. */
function frontmatterEnd(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "---" || trimmed === "...") return i;
  }
  return -1;
}

/** The closing fence for an opening fence of `fenceLen` backticks at `open`; the last line when unclosed. */
function fenceClose(lines: readonly string[], open: number, fenceLen: number): number {
  const close = new RegExp(`^\`{${fenceLen},}\\s*$`);
  for (let i = open + 1; i < lines.length; i += 1) {
    if (close.test((lines[i] ?? "").trim())) return i;
  }
  return lines.length - 1;
}

/**
 * Where a raw HTML block opened at `start` ends, or -1 when the line does not
 * open one. An opening tag runs until its close balances (GitHub's behaviour,
 * so `<details>` with blank lines inside stays one block); a close tag or a
 * void tag runs to the next blank line.
 */
function htmlBlockEnd(lines: readonly string[], start: number): number {
  const first = (lines[start] ?? "").trim();
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(first);
  if (match === null) return -1;
  const tag = (match[2] ?? "").toLowerCase();
  if (!HTML_BLOCK_TAGS.has(tag)) return -1;
  const untilBlank = () => {
    let end = start;
    while (end + 1 < lines.length && (lines[end + 1] ?? "").trim() !== "") end += 1;
    return end;
  };
  if (match[1] === "/" || /\/>\s*$/.test(first)) return untilBlank();
  const open = new RegExp(`<${tag}(?=[\\s/>]|$)`, "gi");
  const close = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    depth += (line.match(open) ?? []).length - (line.match(close) ?? []).length;
    if (depth <= 0) return i;
  }
  // Never closed: a void-ish tag like `<img>` or a stray opener; fall back to the blank line.
  return untilBlank();
}

export function parsePlanBlocks(markdown: string): PlanBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: PlanBlock[] = [];
  const source = (start: number, end: number) => lines.slice(start, end + 1).join("\n");
  const push = (kind: string, start: number, end: number, level?: number) => {
    const block: PlanBlock = { id: `block-${blocks.length}`, kind, startLine: start + 1, endLine: end + 1, text: source(start, end) };
    if (level !== undefined) block.level = level;
    blocks.push(block);
  };

  let bufferStart = -1;
  let bufferEnd = -1;
  let lastLineWasBlank = false;
  const flush = () => {
    if (bufferStart !== -1) push("paragraph", bufferStart, bufferEnd);
    bufferStart = -1;
    bufferEnd = -1;
  };

  for (let i = frontmatterEnd(lines) + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const prevLineWasBlank = lastLineWasBlank;
    lastLineWasBlank = false;

    // ATX headings: `#123` and `#hashtag` are text, not headings.
    const heading = /^(#{1,6})(?:\s|$)/.exec(trimmed);
    if (heading !== null) {
      flush();
      push("heading", i, i, (heading[1] ?? "#").length);
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      flush();
      push("rule", i, i);
      continue;
    }

    if (/^(\*|-|\d+\.)\s/.test(trimmed)) {
      flush();
      const indent = (/^(\s*)/.exec(line)?.[1] ?? "").replace(/\t/g, "  ").length;
      push("list-item", i, i, Math.floor(indent / 2));
      continue;
    }

    // A run of `>` lines is one quote; blank lines at its edges are not part of it.
    if (trimmed.startsWith(">")) {
      flush();
      let end = i;
      while (end + 1 < lines.length && (lines[end + 1] ?? "").trim().startsWith(">")) end += 1;
      const empty = (index: number) => (lines[index] ?? "").replace(/^\s*>[ \t]?/, "").trim() === "";
      let first = i;
      while (first < end && empty(first)) first += 1;
      let last = end;
      while (last > first && empty(last)) last -= 1;
      push("quote", first, last);
      i = end;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flush();
      const fenceLen = /^`+/.exec(trimmed)?.[0].length ?? 3;
      const close = fenceClose(lines, i, fenceLen);
      push("code", i, close);
      i = close;
      continue;
    }

    if (trimmed.startsWith("|")) {
      flush();
      let end = i;
      while (end + 1 < lines.length && (lines[end + 1] ?? "").trim().startsWith("|")) end += 1;
      push("table", i, end);
      i = end;
      continue;
    }

    const htmlEnd = htmlBlockEnd(lines, i);
    if (htmlEnd !== -1) {
      flush();
      push("html", i, htmlEnd);
      i = htmlEnd;
      continue;
    }

    if (trimmed === "") {
      flush();
      lastLineWasBlank = true;
      continue;
    }

    // An indented line after a list item continues it: any indent when tight, two spaces after a blank line.
    const previous = blocks[blocks.length - 1];
    if (bufferStart === -1 && previous?.kind === "list-item" && (prevLineWasBlank ? /^\s{2,}/ : /^\s+/).test(line)) {
      previous.endLine = i + 1;
      previous.text = source(previous.startLine - 1, i);
      continue;
    }

    if (bufferStart === -1) bufferStart = i;
    bufferEnd = i;
  }
  flush();
  return blocks;
}

/** `"lines a-b"` or `"line a"`, as the export labels a block. */
export function blockLineLabel(block: Pick<PlanBlock, "startLine" | "endLine">): string {
  return block.endLine <= block.startLine ? `line ${block.startLine}` : `lines ${block.startLine}-${block.endLine}`;
}
