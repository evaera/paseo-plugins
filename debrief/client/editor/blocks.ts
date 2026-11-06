/**
 * Keeps block widgets (threads, the composer, story narration) as wide as the
 * editor's visible area rather than its scrollable content, which grows with
 * the longest line. The plugin writes the visible width and the gutter's width
 * into CSS variables on the editor, and `.cm-debrief-block` in `theme.ts` is
 * sticky at the gutter's edge with that width, so a long comment wraps inside
 * what can be seen and stays in view while the code scrolls sideways.
 */
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type { CM } from "./cm";
import { setCssVar } from "./dom";

interface Box {
  readonly clientWidth: number;
  readonly offsetWidth?: number;
  querySelector?(selector: string): Box | null;
}

export function visibleWidth(cm: CM): Extension {
  const { ViewPlugin } = cm.view;
  return ViewPlugin.define((view: EditorView) => {
    let last = "";
    const measure = () =>
      view.requestMeasure({
        key: "debrief-visible-width",
        read: () => {
          const scroller = view.scrollDOM as unknown as Box;
          const gutters = scroller.querySelector?.(".cm-gutters") ?? null;
          const gutter = gutters?.offsetWidth ?? 0;
          return { width: Math.max(0, scroller.clientWidth - gutter), gutter };
        },
        write: ({ width, gutter }) => {
          const next = `${width}|${gutter}`;
          if (next === last) return;
          last = next;
          setCssVar(view.dom, "--debrief-visible-width", `${width}px`);
          setCssVar(view.dom, "--debrief-gutter-width", `${gutter}px`);
        },
      });
    measure();
    return {
      update(update) {
        if (update.geometryChanged || update.viewportChanged) measure();
      },
    };
  });
}
