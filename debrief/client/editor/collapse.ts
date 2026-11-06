/**
 * Folded unchanged lines in the editor: a replace decoration over each run
 * `foldedRuns` picks, drawn as a bar that expands 20 lines up, 20 down, or the
 * whole run. Block decorations have to come from a state field, so this is
 * one; the editor sets what each side keeps (`set`) and the bar reveals
 * (`reveal`), and a split view mirrors each reveal onto the other side.
 */
import type { EditorState, Extension } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";

import { type ExpandDirection, expandRun, foldedRuns } from "../collapse";
import type { LineSpan } from "../story";
import { mergeSpans } from "../story";
import type { CM } from "./cm";
import { h, text } from "./dom";
import { iconButton } from "./icons";

export interface CollapseHandle {
  extension: Extension;
  /** What stays visible; null folds nothing. Expansions are kept. */
  set(view: EditorView, keep: readonly LineSpan[] | null, label: string): void;
  reveal(view: EditorView, span: LineSpan): void;
}

interface CollapseValue {
  keep: readonly LineSpan[] | null;
  revealed: readonly LineSpan[];
  label: string;
  decorations: DecorationSet;
}

export function createCollapse(cm: CM, onReveal: (span: LineSpan) => void): CollapseHandle {
  const { StateEffect, StateField } = cm.state;
  const { Decoration, EditorView, WidgetType } = cm.view;

  const setKeep = StateEffect.define<{ keep: readonly LineSpan[] | null; label: string }>();
  const addReveal = StateEffect.define<LineSpan>();

  class FoldWidget extends WidgetType {
    constructor(
      readonly run: LineSpan,
      readonly total: number,
      readonly label: string,
    ) {
      super();
    }
    override eq(other: FoldWidget): boolean {
      return (
        other.run.start === this.run.start &&
        other.run.end === this.run.end &&
        other.total === this.total &&
        other.label === this.label
      );
    }
    override get estimatedHeight(): number {
      return 26;
    }
    override toDOM(view: EditorView) {
      const { run, total } = this;
      const count = run.end - run.start + 1;
      const expand = (direction: ExpandDirection) => {
        const span = expandRun(run, direction);
        view.dispatch({ effects: addReveal.of(span) });
        onReveal(span);
      };
      return h(
        "div",
        { className: "cm-debrief-fold", attrs: { "aria-label": `${count} ${this.label}` } },
        run.start > 1 ? iconButton("chevronDown", "Show 20 more lines below", () => expand("down"), "cm-debrief-fold-btn") : null,
        run.end < total ? iconButton("chevronUp", "Show 20 more lines above", () => expand("up"), "cm-debrief-fold-btn") : null,
        text("span", "cm-debrief-fold-label", `${count} ${this.label}`),
        iconButton("chevronsUpDown", `Show all ${count} lines`, () => expand("all"), "cm-debrief-fold-btn", "Expand all"),
      ) as never;
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  function build(state: EditorState, keep: readonly LineSpan[] | null, revealed: readonly LineSpan[], label: string) {
    if (keep === null) return Decoration.none;
    const total = state.doc.lines;
    const ranges = foldedRuns(total, keep, revealed).map((run) =>
      Decoration.replace({ widget: new FoldWidget(run, total, label), block: true }).range(
        state.doc.line(run.start).from,
        state.doc.line(run.end).to,
      ),
    );
    return Decoration.set(ranges, true);
  }

  const field = StateField.define<CollapseValue>({
    create: () => ({ keep: null, revealed: [], label: "", decorations: Decoration.none }),
    update(value, tr) {
      let { keep, revealed, label } = value;
      let rebuild = false;
      tr.effects.forEach((effect) => {
        if (effect.is(setKeep)) {
          keep = effect.value.keep;
          label = effect.value.label;
          rebuild = true;
        } else if (effect.is(addReveal)) {
          revealed = mergeSpans([...revealed, effect.value]);
          rebuild = true;
        }
      });
      if (rebuild) return { keep, revealed, label, decorations: build(tr.state, keep, revealed, label) };
      if (!tr.docChanged) return value;
      return { ...value, decorations: value.decorations.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  return {
    extension: field,
    set(view, keep, label) {
      view.dispatch({ effects: setKeep.of({ keep, label }) });
    },
    reveal(view, span) {
      view.dispatch({ effects: addReveal.of(span) });
    },
  };
}
