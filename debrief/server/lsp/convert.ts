/**
 * LSP's answers, in the shapes `shared/rpc.ts` promises the panel. Pure.
 */
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CompletionItem, Location } from "../../shared/rpc";

type Range = Location["range"];

export function toUri(path: string): string {
  return pathToFileURL(path).href;
}

export function fromUri(uri: string): string | null {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : null;
  } catch {
    return null;
  }
}

/** Workspace-relative when inside `root`, absolute otherwise. */
export function displayPath(root: string, absolute: string): { path: string; insideWorkspace: boolean } {
  const between = relative(root, absolute);
  if (between !== "" && !between.startsWith("..") && !isAbsolute(between)) {
    return { path: between.split(sep).join("/"), insideWorkspace: true };
  }
  return { path: absolute, insideWorkspace: false };
}

function isRange(value: unknown): value is Range {
  const range = value as Range | null;
  return (
    range !== null &&
    typeof range === "object" &&
    typeof range.start?.line === "number" &&
    typeof range.start.character === "number" &&
    typeof range.end?.line === "number" &&
    typeof range.end.character === "number"
  );
}

function cleanRange(range: Range): Range {
  return {
    start: { line: Math.max(0, range.start.line), character: Math.max(0, range.start.character) },
    end: { line: Math.max(0, range.end.line), character: Math.max(0, range.end.character) },
  };
}

/** `Location | Location[] | LocationLink[] | null` to the panel's locations. */
export function toLocations(root: string, result: unknown): Location[] {
  const items = result === null || result === undefined ? [] : Array.isArray(result) ? result : [result];
  const out: Location[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (item === null || typeof item !== "object") continue;
    const uri = typeof item.targetUri === "string" ? item.targetUri : typeof item.uri === "string" ? item.uri : null;
    const range = isRange(item.targetSelectionRange) ? item.targetSelectionRange : isRange(item.targetRange) ? item.targetRange : isRange(item.range) ? item.range : null;
    if (uri === null || range === null) continue;
    const absolute = fromUri(uri);
    if (absolute === null) continue;
    out.push({ ...displayPath(root, absolute), range: cleanRange(range) });
  }
  return out;
}

function markedString(value: unknown): string {
  if (typeof value === "string") return value;
  const marked = value as { language?: unknown; value?: unknown } | null;
  if (marked !== null && typeof marked === "object" && typeof marked.value === "string") {
    return typeof marked.language === "string" && marked.language !== "" ? `\`\`\`${marked.language}\n${marked.value}\n\`\`\`` : marked.value;
  }
  return "";
}

/** `Hover` to Markdown: `MarkupContent`, a `MarkedString`, or an array of them. */
export function toHover(result: unknown): { markdown: string | null; range: Range | null } {
  const hover = result as { contents?: unknown; range?: unknown } | null;
  if (hover === null || typeof hover !== "object" || hover.contents === undefined) return { markdown: null, range: null };
  const contents = hover.contents;
  let text: string;
  if (Array.isArray(contents)) text = contents.map(markedString).filter((part) => part !== "").join("\n\n---\n\n");
  else if (typeof contents === "object" && contents !== null && "kind" in contents) {
    const markup = contents as { kind?: unknown; value?: unknown };
    const value = typeof markup.value === "string" ? markup.value : "";
    text = markup.kind === "plaintext" ? value.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, "\\$1") : value;
  } else text = markedString(contents);
  return { markdown: text.trim() === "" ? null : text, range: isRange(hover.range) ? cleanRange(hover.range) : null };
}

const MAX_COMPLETIONS = 200;

/** `CompletionList | CompletionItem[]` to the panel's items, capped. */
export function toCompletions(result: unknown): { items: CompletionItem[]; isIncomplete: boolean } {
  const list = result as { items?: unknown; isIncomplete?: unknown } | unknown[] | null;
  const rawItems = Array.isArray(list) ? list : list !== null && typeof list === "object" && Array.isArray(list.items) ? list.items : [];
  const isIncomplete = !Array.isArray(list) && list !== null && typeof list === "object" && list.isIncomplete === true;
  const items: CompletionItem[] = [];
  for (const raw of rawItems as Array<Record<string, unknown>>) {
    if (items.length >= MAX_COMPLETIONS) break;
    if (raw === null || typeof raw !== "object" || typeof raw.label !== "string") continue;
    const edit = raw.textEdit as { newText?: unknown; range?: unknown; replace?: unknown; insert?: unknown } | undefined;
    const editRange = edit === undefined ? null : isRange(edit.range) ? edit.range : isRange(edit.replace) ? edit.replace : isRange(edit.insert) ? edit.insert : null;
    const insertText =
      edit !== undefined && typeof edit.newText === "string" ? edit.newText : typeof raw.insertText === "string" ? raw.insertText : raw.label;
    items.push({
      label: raw.label,
      detail: typeof raw.detail === "string" ? raw.detail : null,
      kind: typeof raw.kind === "number" ? raw.kind : null,
      insertText,
      range: editRange === null ? null : cleanRange(editRange),
      sortText: typeof raw.sortText === "string" ? raw.sortText : null,
    });
  }
  return { items, isIncomplete: isIncomplete || rawItems.length > items.length };
}
