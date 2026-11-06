/**
 * A small Markdown reader for narration drawn inside the web editor, where the
 * host `Markdown` component cannot go (a CodeMirror widget is plain DOM).
 * Paragraphs, headings, bullet and numbered lists, fenced code, and inline
 * code, bold, italics and links (as their text). Anything else is text. Pure,
 * so it is tested directly; `editor/markdown-dom.ts` turns it into elements.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string };

export type MdBlock =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string };

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\([^)]*\)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (inline: Inline) => {
    const prev = out[out.length - 1];
    if (inline.kind === "text" && prev?.kind === "text") prev.text += inline.text;
    else if (inline.text !== "") out.push(inline);
  };
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) push({ kind: "text", text: text.slice(last, index) });
    const [, code, bold1, bold2, em1, em2, link] = match;
    if (code !== undefined) push({ kind: "code", text: code });
    else if (bold1 !== undefined || bold2 !== undefined) push({ kind: "strong", text: bold1 ?? bold2 ?? "" });
    else if (em1 !== undefined || em2 !== undefined) push({ kind: "em", text: em1 ?? em2 ?? "" });
    else push({ kind: "text", text: link ?? "" });
    last = index + match[0].length;
  }
  if (last < text.length) push({ kind: "text", text: text.slice(last) });
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function parseMarkdownLite(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
    if (list !== null) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const marker = fence[1] ?? "```";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(marker)) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", inline: parseInline(heading[1] ?? "") });
      index += 1;
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? NUMBERED.exec(line) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list !== null && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[1] ?? "");
      index += 1;
      continue;
    }
    if (list !== null && /^\s+\S/.test(line)) {
      // An indented line continues the last list item.
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ""} ${line.trim()}`;
      index += 1;
      continue;
    }
    if (list !== null) flush();
    paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
}
