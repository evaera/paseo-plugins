/**
 * The CodeMirror diff editor, web and Electron only. `mountEditor` returns null
 * anywhere else, and CodeMirror is required only past that check, so native
 * never evaluates it (the pattern in Paseo's markdown-panel example).
 *
 * Unified is one editor over the new text with `unifiedMergeView` showing the
 * old text's deleted chunks; split is a `MergeView` with the old side read-only.
 * Only the new side is ever editable, and only when the panel says it is the
 * work tree.
 */
import { wordChanges } from "./word-changes";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MergeView } from "@codemirror/merge";
import { Platform } from "react-native";

import type { Comment, Side } from "../../shared/review";
import type { Annotation } from "../../shared/story";
import { CONTEXT_LINES, changedSpans, keepSpans, mapLine, mapSpan, type Region, unchangedRegions } from "../collapse";
import type { Focus, LineSpan } from "../story";
import type { CodeSettings } from "../code-settings";
import { visibleWidth } from "./blocks";
import { type CollapseHandle, createCollapse } from "./collapse";
import { type CM, languageExtension, loadCodeMirror } from "./cm";
import { createLsp, type Diagnostic, fromLsp, type LspCallbacks, type LspHandle, type LspPosition } from "./lsp";
import { type EditorLayout, editorMode } from "./mode";
import { createNarration, type NarrationHandle } from "./narration";
import { editorTheme } from "./theme";
import { createThreads, type ThreadCallbacks, type ThreadsHandle } from "./threads";

const CHANGE_DEBOUNCE_MS = 500;

export interface EditorCallbacks extends ThreadCallbacks, LspCallbacks {
  onDirty(dirty: boolean): void;
  onSave(text: string): void;
  /** The new side's text, debounced, after an edit. */
  onChange(text: string): void;
}

export interface EditorOptions {
  oldText: string | null;
  newText: string | null;
  layout: EditorLayout;
  editable: boolean;
  language: string;
  theme: PluginTheme;
  /** Paseo's code font and syntax theme. */
  code: CodeSettings;
  /** Fold unchanged lines; off for a plain file outside the diff. */
  collapse: boolean;
  /** Whether hover, completion and navigation are wired for the new side. */
  lsp: boolean;
  /** A section of the continuous diff: the editor grows to its content and the panel scrolls it. */
  embedded?: boolean;
  /** Read on every call, so the panel can swap closures without remounting. */
  callbacks: { readonly current: EditorCallbacks };
}

export interface EditorHandle {
  /** Replaces both texts without counting it as an edit. */
  setDocs(oldText: string | null, newText: string | null): void;
  setComments(newSide: readonly Comment[], oldSide: readonly Comment[]): void;
  /** Story narration per side, and the chapter's lines (null: every change). */
  setStory(newSide: readonly Annotation[], oldSide: readonly Annotation[], focus: Focus | null): void;
  setDiagnostics(diagnostics: readonly Diagnostic[]): void;
  getText(): string;
  /** Delivers a debounced edit now, so a language request sees the text on screen. */
  flushChange(): void;
  isDirty(): boolean;
  markSaved(): void;
  goTo(position: LspPosition): void;
  destroy(): void;
}

interface SideView {
  side: Side;
  view: EditorView;
  threads: ThreadsHandle;
  collapse: CollapseHandle;
  narration: NarrationHandle;
  lsp: LspHandle | null;
}

/** Lines a list of comments sits on, for keeping them out of folds. */
function commentLines(comments: readonly Comment[]): number[] {
  return comments.flatMap((comment) => {
    const start = comment.startLine ?? comment.endLine;
    const end = comment.endLine ?? comment.startLine;
    if (start === undefined || end === undefined) return [];
    return start === end ? [start] : [start, end];
  });
}

export function mountEditor(parent: unknown, options: EditorOptions): EditorHandle | null {
  if (Platform.OS !== "web" || !parent) return null;
  // Paseo points every element's font at its UI font unless it sits inside a
  // `[data-pmono]` subtree, which is how its own code surfaces keep monospace.
  (parent as { setAttribute(name: string, value: string): void }).setAttribute("data-pmono", "");
  const cm = loadCodeMirror();
  return new DiffEditor(cm, parent, options);
}

class DiffEditor implements EditorHandle {
  private applying = false;
  private dirty = false;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private merge: MergeView | null = null;
  private primary: SideView;
  private secondary: SideView | null = null;
  private readonly mode;

  private pins: Record<Side, { comments: number[]; annotations: number[] }> = {
    new: { comments: [], annotations: [] },
    old: { comments: [], annotations: [] },
  };
  private focus: Focus | null = null;
  private regions: Region[] = [];
  private oldText: string | null;
  private newText: string | null;

  constructor(
    private readonly cm: CM,
    parent: unknown,
    private readonly options: EditorOptions,
  ) {
    const { oldText, newText, layout } = options;
    this.oldText = oldText;
    this.newText = newText;
    this.mode = editorMode(oldText, newText, layout);
    const callbacks = () => options.callbacks.current;
    // A reveal on one side of a split shows the same unchanged lines on the other.
    const mirror = (from: Side) => (span: LineSpan) => {
      const other = this.sideView(from === "new" ? "old" : "new");
      if (other === null || other.side === from || this.mode !== "split") return;
      const mapped = mapSpan(this.regions, span, from);
      if (mapped !== null) other.collapse.reveal(other.view, mapped);
    };

    if (this.mode === "split") {
      const { MergeView } = cm.merge;
      const oldParts = this.parts("old", mirror("old"));
      const newParts = this.parts("new", mirror("new"));
      const newLsp = options.lsp ? createLsp(cm, callbacks) : null;
      this.merge = new MergeView({
        parent: parent as never,
        a: { doc: oldText ?? "", extensions: this.extensions("old", false, oldParts, null, false) },
        b: { doc: newText ?? "", extensions: this.extensions("new", options.editable, newParts, newLsp, true) },
        // Word marks come from wordChanges(), only inside modified lines.
        highlightChanges: false,
        gutter: true,
      });
      const dom = this.merge.dom as unknown as { style: Record<string, string> };
      Object.assign(dom.style, options.embedded === true ? { height: "auto", overflow: "visible" } : { height: "100%", overflow: "auto" });
      this.primary = { side: "new", view: this.merge.b, ...newParts, lsp: newLsp };
      this.secondary = { side: "old", view: this.merge.a, ...oldParts, lsp: null };
      this.refold();
      return;
    }

    const side: Side = this.mode === "old-only" ? "old" : "new";
    const parts = this.parts(side, () => undefined);
    const lsp = side === "new" && options.lsp ? createLsp(cm, callbacks) : null;
    const editable = side === "new" && options.editable;
    const extensions = this.extensions(side, editable, parts, lsp, side === "new");
    if (this.mode === "unified") {
      extensions.push(
        cm.merge.unifiedMergeView({
          original: oldText ?? "",
          mergeControls: false,
          highlightChanges: false,
          gutter: true,
          syntaxHighlightDeletions: true,
        }),
      );
    }
    const view = new cm.view.EditorView({
      parent: parent as never,
      state: cm.state.EditorState.create({
        doc: side === "old" ? (oldText ?? "") : (newText ?? ""),
        extensions,
      }),
    });
    this.primary = { side, view, ...parts, lsp };
    this.refold();
  }

  private parts(side: Side, onReveal: (span: LineSpan) => void) {
    const callbacks = () => this.options.callbacks.current;
    return {
      threads: createThreads(this.cm, side, callbacks),
      collapse: createCollapse(this.cm, onReveal),
      narration: createNarration(this.cm),
    };
  }

  private sideView(side: Side): SideView | null {
    if (this.primary.side === side) return this.primary;
    if (this.secondary?.side === side) return this.secondary;
    return null;
  }

  /** Recomputes what each side keeps unfolded: the changes (or the chapter's lines) and every pinned line. */
  private refold(): void {
    const both = this.oldText !== null && this.newText !== null;
    this.regions = both ? unchangedRegions(this.oldText ?? "", this.newText ?? "") : [];
    const changed = both ? changedSpans(this.oldText ?? "", this.newText ?? "") : null;
    const label = this.focus !== null ? "lines outside this chapter" : "unchanged lines";
    [this.primary, this.secondary].forEach((part) => {
      if (part === null) return;
      const total = part.view.state.doc.lines;
      const base = this.focus !== null ? this.focus[part.side] : changed?.[part.side];
      if (!this.options.collapse || base === undefined) {
        part.collapse.set(part.view, null, label);
        return;
      }
      const other: Side = part.side === "new" ? "old" : "new";
      const own = this.pins[part.side];
      const theirs = this.pins[other];
      const mirrored = [...theirs.comments, ...theirs.annotations].flatMap((line) => {
        const mapped = mapLine(this.regions, line, other);
        return mapped === null ? [] : [mapped];
      });
      part.collapse.set(
        part.view,
        keepSpans({ base, pins: [...own.comments, ...own.annotations], mirroredPins: mirrored, total }),
        label,
      );
    });
  }

  private extensions(
    side: Side,
    editable: boolean,
    parts: { threads: ThreadsHandle; collapse: CollapseHandle; narration: NarrationHandle },
    lsp: LspHandle | null,
    primary: boolean,
  ): Extension[] {
    const { threads } = parts;
    const { cm, options } = this;
    const { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } = cm.view;
    const { EditorState } = cm.state;
    const { defaultKeymap, history, historyKeymap, indentWithTab } = cm.commands;
    const { bracketMatching, indentOnInput } = cm.language;
    const { searchKeymap, highlightSelectionMatches } = cm.search;
    const { completionKeymap, closeBrackets, closeBracketsKeymap } = cm.autocomplete;

    const reviewKeys = [
      {
        key: "Mod-s",
        preventDefault: true,
        run: (view: EditorView) => {
          if (primary && editable) options.callbacks.current.onSave(view.state.doc.toString());
          return true;
        },
      },
      { key: "Mod-Alt-c", run: (view: EditorView) => threads.commentOnSelection(view) },
      { key: "Escape", run: (view: EditorView) => threads.closeComposer(view) },
      { key: "Alt-]", run: (view: EditorView) => threads.step(view, 1) },
      { key: "Alt-[", run: (view: EditorView) => threads.step(view, -1) },
      // Bare keys would type into an editable side; they are review shortcuts only where nothing can be typed.
      ...(editable
        ? []
        : [
            { key: "c", run: (view: EditorView) => threads.commentOnSelection(view) },
            { key: "]", run: (view: EditorView) => threads.step(view, 1) },
            { key: "[", run: (view: EditorView) => threads.step(view, -1) },
          ]),
    ];

    return [
      lineNumbers({ domEventHandlers: threads.gutterHandlers as never }),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      highlightSelectionMatches(),
      ...(editable ? [history(), indentOnInput(), closeBrackets()] : []),
      keymap.of([
        ...reviewKeys,
        ...(editable ? [...closeBracketsKeymap, ...historyKeymap, indentWithTab] : []),
        ...completionKeymap,
        ...searchKeymap,
        ...defaultKeymap,
      ]),
      EditorState.readOnly.of(!editable),
      EditorState.tabSize.of(4),
      languageExtension(options.language),
      editorTheme(cm, options.theme, options.code, options.embedded === true),
      threads.extension,
      parts.collapse.extension,
      parts.narration.extension,
      wordChanges(cm, side),
      visibleWidth(cm),
      lsp?.extension ?? [],
      EditorView.contentAttributes.of({ "aria-label": side === "old" ? "Base version" : "Changed version" }),
      primary
        ? EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.applying) return;
            if (!this.dirty) {
              this.dirty = true;
              options.callbacks.current.onDirty(true);
            }
            clearTimeout(this.changeTimer);
            this.changeTimer = setTimeout(() => {
              this.changeTimer = undefined;
              options.callbacks.current.onChange(update.view.state.doc.toString());
            }, CHANGE_DEBOUNCE_MS);
          })
        : [],
    ];
  }

  private replaceDoc(view: EditorView, next: string): void {
    if (view.state.doc.toString() === next) return;
    this.applying = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    } finally {
      this.applying = false;
    }
  }

  setDocs(oldText: string | null, newText: string | null): void {
    const { cm } = this;
    this.oldText = oldText;
    this.newText = newText;
    if (this.mode === "split") {
      this.replaceDoc(this.secondary!.view, oldText ?? "");
      this.replaceDoc(this.primary.view, newText ?? "");
    } else if (this.mode === "old-only") {
      this.replaceDoc(this.primary.view, oldText ?? "");
    } else {
      const view = this.primary.view;
      this.replaceDoc(view, newText ?? "");
      if (this.mode === "unified") {
        const original = cm.merge.getOriginalDoc(view.state);
        const next = oldText ?? "";
        if (original.toString() !== next) {
          const changes = cm.state.ChangeSet.of({ from: 0, to: original.length, insert: next }, original.length);
          view.dispatch({ effects: cm.merge.originalDocChangeEffect(view.state, changes) });
        }
      }
    }
    this.markSaved();
    this.refold();
  }

  setComments(newSide: readonly Comment[], oldSide: readonly Comment[]): void {
    this.pins.new.comments = commentLines(newSide);
    this.pins.old.comments = commentLines(oldSide);
    if (this.mode === "split") {
      this.primary.threads.setComments(this.primary.view, newSide);
      this.secondary!.threads.setComments(this.secondary!.view, oldSide);
    } else if (this.mode === "old-only") {
      this.primary.threads.setComments(this.primary.view, oldSide);
    } else {
      this.primary.threads.setComments(this.primary.view, newSide);
    }
    this.refold();
  }

  setStory(newSide: readonly Annotation[], oldSide: readonly Annotation[], focus: Focus | null): void {
    this.pins.new.annotations = newSide.map((annotation) => annotation.line);
    this.pins.old.annotations = oldSide.map((annotation) => annotation.line);
    this.focus = focus;
    if (this.mode === "split") {
      this.primary.narration.set(this.primary.view, newSide);
      this.secondary!.narration.set(this.secondary!.view, oldSide);
    } else if (this.mode === "old-only") {
      this.primary.narration.set(this.primary.view, oldSide);
    } else {
      this.primary.narration.set(this.primary.view, newSide);
    }
    this.refold();
  }

  setDiagnostics(diagnostics: readonly Diagnostic[]): void {
    this.primary.lsp?.setDiagnostics(this.primary.view, diagnostics);
  }

  getText(): string {
    return this.primary.view.state.doc.toString();
  }

  flushChange(): void {
    if (this.changeTimer === undefined) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.options.callbacks.current.onChange(this.getText());
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.options.callbacks.current.onDirty(false);
  }

  goTo(position: LspPosition): void {
    const view = this.primary.view;
    // A target inside a fold is unfolded first, with a little context, so there is a line to land on.
    const line = position.line + 1;
    this.primary.collapse.reveal(view, { start: Math.max(1, line - CONTEXT_LINES), end: line + CONTEXT_LINES });
    const pos = fromLsp(view.state.doc, position);
    view.dispatch({
      selection: { anchor: pos },
      effects: this.cm.view.EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }

  destroy(): void {
    clearTimeout(this.changeTimer);
    if (this.merge !== null) this.merge.destroy();
    else this.primary.view.destroy();
  }
}
