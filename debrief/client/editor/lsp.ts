/**
 * Language intelligence in the editor, over Debrief's typed LSP RPCs: hover,
 * completion, go to definition (F12, Cmd/Ctrl-click), references (Shift+F12),
 * and diagnostics drawn as underlines. Positions are LSP's: 0-based line and
 * UTF-16 character, which is what CodeMirror offsets already count in.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState, Extension, Text } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";

import type { CompletionItem, Location } from "../../shared/rpc";
import { completionType, splitFences } from "../format";
import type { CM } from "./cm";
import { h, text } from "./dom";

export interface LspPosition {
  line: number;
  character: number;
}

export interface Diagnostic {
  range: { start: LspPosition; end: LspPosition };
  severity: number | null;
  message: string;
  source: string | null;
}

export type LocationKind = "definition" | "references";

export interface LspCallbacks {
  hover(position: LspPosition): Promise<string | null>;
  completion(position: LspPosition): Promise<{ items: CompletionItem[]; isIncomplete: boolean }>;
  locations(position: LspPosition, kind: LocationKind): Promise<Location[]>;
  /** What to do with the answer: jump, switch file, or list references. */
  showLocations(kind: LocationKind, locations: Location[]): void;
}

export function toLsp(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export function fromLsp(doc: Text, position: LspPosition): number {
  const number = Math.min(Math.max(1, position.line + 1), doc.lines);
  const line = doc.line(number);
  return line.from + Math.min(position.character, line.length);
}

function renderHover(markdown: string) {
  const root = h("div", { className: "cm-debrief-hover" });
  splitFences(markdown).forEach((part) => {
    root.appendChild(text(part.code ? "pre" : "p", "", part.text));
  });
  return root;
}

export interface LspHandle {
  extension: Extension;
  setDiagnostics(view: EditorView, diagnostics: readonly Diagnostic[]): void;
  /** Go to definition at the cursor. */
  definitionAtCursor(view: EditorView): boolean;
  referencesAtCursor(view: EditorView): boolean;
}

export function createLsp(cm: CM, callbacks: () => LspCallbacks): LspHandle {
  const { StateEffect, StateField, RangeSetBuilder } = cm.state;
  const { Decoration, EditorView, hoverTooltip, keymap } = cm.view;
  const { autocompletion } = cm.autocomplete;

  const hover = hoverTooltip(
    async (view, pos) => {
      let markdown: string | null = null;
      try {
        markdown = await callbacks().hover(toLsp(view.state.doc, pos));
      } catch {
        return null;
      }
      if (markdown === null || markdown.trim() === "") return null;
      const content = markdown;
      return { pos, above: true, create: () => ({ dom: renderHover(content) as never }) };
    },
    { hoverTime: 400 },
  );

  async function complete(context: CompletionContext): Promise<CompletionResult | null> {
    const word = context.matchBefore(/[\w$]+/);
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    if (word === null && !context.explicit && before !== ".") return null;
    let answer: { items: CompletionItem[]; isIncomplete: boolean };
    try {
      answer = await callbacks().completion(toLsp(context.state.doc, context.pos));
    } catch {
      return null;
    }
    if (context.aborted || answer.items.length === 0) return null;
    const firstRange = answer.items[0]?.range ?? null;
    const from = firstRange !== null ? fromLsp(context.state.doc, firstRange.start) : (word?.from ?? context.pos);
    const options: Completion[] = answer.items.map((item, index) => {
      const type = completionType(item.kind);
      return {
        label: item.label,
        apply: item.insertText,
        ...(item.detail !== null ? { detail: item.detail } : {}),
        ...(type !== undefined ? { type } : {}),
        // Keep the server's order: an earlier item ranks higher.
        boost: -Math.min(99, index),
      };
    });
    return answer.isIncomplete ? { from, options } : { from, options, validFor: /^[\w$]*$/ };
  }

  function lookUp(view: EditorView, pos: number, kind: LocationKind): void {
    const position = toLsp(view.state.doc, pos);
    callbacks()
      .locations(position, kind)
      .then((locations) => callbacks().showLocations(kind, locations))
      .catch((cause: unknown) => console.warn(`[debrief] ${kind} failed:`, cause));
  }

  const setDiagnosticsEffect = StateEffect.define<readonly Diagnostic[]>();
  const diagnosticsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      let next = value.map(tr.changes);
      tr.effects.forEach((effect) => {
        if (effect.is(setDiagnosticsEffect)) next = buildDiagnostics(tr.state, effect.value);
      });
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  function buildDiagnostics(state: EditorState, diagnostics: readonly Diagnostic[]): DecorationSet {
    const ranges = diagnostics
      .map((diagnostic) => {
        const from = fromLsp(state.doc, diagnostic.range.start);
        let to = fromLsp(state.doc, diagnostic.range.end);
        // A zero-width diagnostic still deserves a mark: widen it to the next character.
        if (to <= from) to = Math.min(state.doc.length, from + 1);
        return { from, to, diagnostic };
      })
      .filter((range) => range.to > range.from)
      .sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<ReturnType<typeof Decoration.mark>>();
    ranges.forEach(({ from, to, diagnostic }) => {
      const severity = Math.min(4, Math.max(1, diagnostic.severity ?? 1));
      const title = diagnostic.source ? `${diagnostic.source}: ${diagnostic.message}` : diagnostic.message;
      builder.add(from, to, Decoration.mark({ class: `cm-debrief-diag-${severity}`, attributes: { title } }));
    });
    return builder.finish();
  }

  const definitionAtCursor = (view: EditorView) => {
    lookUp(view, view.state.selection.main.head, "definition");
    return true;
  };
  const referencesAtCursor = (view: EditorView) => {
    lookUp(view, view.state.selection.main.head, "references");
    return true;
  };

  return {
    extension: [
      hover,
      autocompletion({ override: [complete], activateOnTyping: true }),
      diagnosticsField,
      keymap.of([
        { key: "F12", run: definitionAtCursor },
        { key: "Shift-F12", run: referencesAtCursor },
      ]),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          const mouse = event as unknown as { metaKey: boolean; ctrlKey: boolean; clientX: number; clientY: number };
          if (!mouse.metaKey && !mouse.ctrlKey) return false;
          const pos = view.posAtCoords({ x: mouse.clientX, y: mouse.clientY });
          if (pos === null) return false;
          lookUp(view, pos, "definition");
          return true;
        },
      }),
    ],
    setDiagnostics(view, diagnostics) {
      view.dispatch({ effects: setDiagnosticsEffect.of(diagnostics) });
    },
    definitionAtCursor,
    referencesAtCursor,
  };
}
