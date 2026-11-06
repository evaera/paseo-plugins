/**
 * Story narration in the editor: each annotation is a block widget above its
 * line, drawn as interlinear prose rather than a card: no label, italic and
 * accent-tinted, indented to where the line's code starts. It is never part of
 * the document, so it can neither be edited nor saved.
 */
import type { EditorState, Extension } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";

import type { Annotation } from "../../shared/story";
import type { CM } from "./cm";
import { blockWrapper, type El, h, text, unwatchBlock } from "./dom";
import { markdownDom } from "./markdown-dom";

export interface NarrationHandle {
  extension: Extension;
  set(view: EditorView, annotations: readonly Annotation[]): void;
}

export function createNarration(cm: CM): NarrationHandle {
  const { StateEffect, StateField } = cm.state;
  const { Decoration, EditorView, WidgetType } = cm.view;
  const setAnnotations = StateEffect.define<readonly Annotation[]>();

  class NarrationWidget extends WidgetType {
    constructor(
      readonly annotation: Annotation,
      /** The start of the annotated line, for its indentation. */
      readonly pos: number,
    ) {
      super();
    }
    override eq(other: NarrationWidget): boolean {
      return (
        other.annotation.id === this.annotation.id &&
        other.annotation.body === this.annotation.body &&
        other.annotation.drifted === this.annotation.drifted
      );
    }
    override get estimatedHeight(): number {
      return 64;
    }
    override toDOM(view: EditorView) {
      const annotation = this.annotation;
      // Interlinear: no box and no label, just prose in the gap above its line, starting where
      // that line's code starts, so it reads as part of the page rather than a comment on it.
      const line = view.state.doc.lineAt(Math.min(this.pos, view.state.doc.length)).text;
      const indent = indentColumns(line, view.state.tabSize);
      const body = markdownDom(annotation.body);
      const note = h(
        "div",
        { className: "cm-debrief-narration", style: { paddingLeft: `${indent}ch` } },
        h("div", { className: "cm-debrief-narration-text" }, body),
        annotation.drifted ? text("div", "cm-debrief-narration-drifted", "The code here moved since this was written.") : null,
      );
      return blockWrapper(note, () => view.requestMeasure()) as never;
    }
    override destroy(dom: unknown): void {
      unwatchBlock(dom as El);
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  function build(state: EditorState, annotations: readonly Annotation[]): DecorationSet {
    const ranges = annotations
      .filter((annotation) => annotation.line <= state.doc.lines)
      .map((annotation, index) =>
        Decoration.widget({
          widget: new NarrationWidget(annotation, state.doc.line(annotation.line).from),
          block: true,
          side: -100 + index,
        }).range(state.doc.line(annotation.line).from),
      );
    return Decoration.set(ranges, true);
  }

  const field = StateField.define<{ annotations: readonly Annotation[]; decorations: DecorationSet }>({
    create: () => ({ annotations: [], decorations: Decoration.none }),
    update(value, tr) {
      let next: readonly Annotation[] | null = null;
      tr.effects.forEach((effect) => {
        if (effect.is(setAnnotations)) next = effect.value;
      });
      if (next !== null) return { annotations: next, decorations: build(tr.state, next) };
      if (!tr.docChanged) return value;
      return { ...value, decorations: value.decorations.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  return {
    extension: field,
    set(view, annotations) {
      view.dispatch({ effects: setAnnotations.of(annotations) });
    },
  };
}

/** How many columns a line's leading whitespace takes, tabs expanded. */
export function indentColumns(line: string, tabSize: number): number {
  let columns = 0;
  for (const char of line) {
    if (char === " ") columns += 1;
    else if (char === "\t") columns += tabSize - (columns % tabSize);
    else break;
  }
  return columns;
}
