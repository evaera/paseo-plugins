/**
 * The editor's look. Colours come from the host theme's tokens so light and
 * dark both follow Paseo; tints are `color-mix` over a token rather than
 * literal colours. The code font, its size and the syntax colours follow
 * Paseo's own code settings (`CodeSettings`, read in `client/web.ts`) and
 * Paseo's highlight package, so the editor matches the app's diff.
 *
 * Every widget drawn between lines (threads, the composer, narration, the
 * collapsed-lines bar) is wrapped in `.cm-debrief-block`, which has padding and
 * never margin: CodeMirror measures a block widget's border box, and a margin
 * would push every gutter number below it out of line.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { Extension } from "@codemirror/state";

import type { CodeSettings } from "../code-settings";
import type { CM } from "./cm";

/** Paseo's interface font (it sets the variable on the root), for the prose inside the editor. */
const UI_FONT = "var(--paseo-ui-font, system-ui, -apple-system, sans-serif)";

function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

/** Whether a CSS colour is dark; unknown formats count as dark, Paseo's default. */
export function isDarkColor(color: string): boolean {
  const value = color.trim();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (hex?.[1] !== undefined) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    rgb = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
  } else {
    const fn = /^rgba?\(([^)]+)\)$/i.exec(value);
    if (fn?.[1] !== undefined) rgb = fn[1].split(/[\s,/]+/).slice(0, 3).map(Number);
  }
  if (rgb === null || rgb.some((channel) => Number.isNaN(channel))) return true;
  const [r = 0, g = 0, b = 0] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

const smallButton = (color: string) => ({
  font: "inherit",
  fontSize: "12px",
  padding: "2px 10px",
  borderRadius: "5px",
  cursor: "pointer",
  color,
});

/**
 * `embedded`: the editor is one section of the continuous diff, so it grows to
 * its content and the panel's list scrolls it; it keeps only sideways scroll.
 */
export function editorTheme(cm: CM, theme: PluginTheme, code: CodeSettings, embedded = false): Extension[] {
  const c = theme.colors;
  const dark = isDarkColor(c.surface0);
  const { EditorView } = cm.view;
  const { syntaxHighlighting } = cm.language;

  const base = EditorView.theme(
    {
      "&": {
        height: embedded ? "auto" : "100%",
        color: c.foreground,
        backgroundColor: c.surface0,
        fontSize: `${code.fontSize}px`,
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": embedded
        ? { overflowX: "auto", overflowY: "hidden", fontFamily: code.fontFamily, lineHeight: `${code.lineHeight}px` }
        : { overflow: "auto", fontFamily: code.fontFamily, lineHeight: `${code.lineHeight}px` },
      ".cm-content": { caretColor: c.foreground },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.foreground },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: tint(c.accent, 30) },
      ".cm-activeLine": { backgroundColor: tint(c.foreground, 4) },
      ".cm-gutters": { backgroundColor: c.surface0, color: c.foregroundMuted, border: "none" },
      ".cm-activeLineGutter": { backgroundColor: tint(c.foreground, 6) },

      // Line numbers: hovering one shows the "+" that starts a comment there.
      ".cm-lineNumbers .cm-gutterElement": { cursor: "pointer", paddingLeft: "8px", position: "relative" },
      ".cm-lineNumbers .cm-gutterElement:hover:not(:empty)::after": {
        content: '"+"',
        position: "absolute",
        top: "1px",
        bottom: "1px",
        right: "2px",
        minWidth: `${Math.max(14, code.lineHeight - 2)}px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "4px",
        backgroundColor: c.accent,
        color: c.accentForeground,
        fontFamily: UI_FONT,
        fontWeight: "700",
        fontSize: `${Math.max(12, code.fontSize + 1)}px`,
        lineHeight: "1",
        pointerEvents: "none",
      },

      ".cm-panels": { backgroundColor: c.surface1, color: c.foreground },
      ".cm-searchMatch": { backgroundColor: tint(c.statusWarning, 30) },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: tint(c.statusWarning, 55) },
      ".cm-tooltip": {
        backgroundColor: c.surface1,
        color: c.foreground,
        border: `1px solid ${c.border}`,
        borderRadius: "6px",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: c.accent,
        color: c.accentForeground,
      },
      ".cm-completionDetail": { color: c.foregroundMuted },

      // The merge view: inserted lines on the new side, deleted chunks shown above them.
      "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: tint(c.statusSuccess, 12) },
      "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: tint(c.statusDanger, 12) },
      "&.cm-merge-b .cm-changedText": { background: tint(c.statusSuccess, 30) },
      // Split view: where a line has no counterpart, the other side's gap is hatched, as in Crit.
      ".cm-mergeSpacer": {
        backgroundImage: `repeating-linear-gradient(-45deg, ${tint(c.border, 70)} 0, ${tint(c.border, 70)} 1px, transparent 1px, transparent 7px)`,
        backgroundColor: tint(c.surface1, 60),
      },
      // Word emphasis only where a line was modified (word-changes.ts), as in Crit.
      ".cm-debrief-word-add": { backgroundColor: tint(c.statusSuccess, 22), borderRadius: "2px" },
      ".cm-debrief-word-del": { backgroundColor: tint(c.statusDanger, 22), borderRadius: "2px" },
      "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: tint(c.statusDanger, 30) },
      "&.cm-merge-b .cm-deletedText": { background: tint(c.statusDanger, 30) },
      "&.cm-merge-b .cm-changedLineGutter": { background: c.statusSuccess },
      "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: c.statusDanger },
      ".cm-inlineChangedLineGutter": { background: c.statusWarning },

      // The outer box of every block widget (see the header comment and blocks.ts).
      ".cm-debrief-block": {
        boxSizing: "border-box",
        padding: "6px 12px 6px 4px",
        margin: "0",
        position: "sticky",
        left: "var(--debrief-gutter-width, 0px)",
        width: "var(--debrief-visible-width, 100%)",
        maxWidth: "var(--debrief-visible-width, 100%)",
        whiteSpace: "normal",
        fontFamily: UI_FONT,
        fontSize: "13px",
        lineHeight: "1.5",
        cursor: "auto",
      },

      // Thread cards, after Crit's: a header with the author and small icon actions, the body,
      // the replies, and a compact reply field that grows on focus.
      ".cm-debrief-card": {
        boxSizing: "border-box",
        margin: "0",
        border: `1px solid ${c.border}`,
        borderRadius: "8px",
        backgroundColor: c.surface1,
        color: c.foreground,
        overflow: "hidden",
        minWidth: "0",
        overflowWrap: "anywhere",
      },
      ".cm-debrief-card.is-drifted": { borderColor: c.statusWarning },
      ".cm-debrief-card.is-resolved": { opacity: "0.8" },
      ".cm-debrief-card-head": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "5px 8px 5px 10px",
        backgroundColor: tint(c.statusWarning, 10),
        borderBottom: `1px solid ${c.border}`,
        fontSize: "12px",
        color: c.foregroundMuted,
        minWidth: "0",
      },
      ".cm-debrief-card.is-collapsed .cm-debrief-card-head": { borderBottom: "none", cursor: "pointer" },
      ".cm-debrief-head-left": { display: "flex", alignItems: "center", gap: "8px", minWidth: "0", flex: "1" },
      ".cm-debrief-chevron": {
        background: "none",
        border: "none",
        padding: "0",
        margin: "0",
        cursor: "pointer",
        color: c.foregroundMuted,
        display: "flex",
        alignItems: "center",
        transition: "transform 0.15s ease",
        flexShrink: "0",
      },
      ".cm-debrief-chevron svg": { width: "14px", height: "14px" },
      ".cm-debrief-card.is-collapsed .cm-debrief-chevron": { transform: "rotate(-90deg)" },
      ".cm-debrief-author": {
        fontSize: "11px",
        fontWeight: "600",
        padding: "0 7px",
        borderRadius: "10px",
        border: `1px solid ${c.border}`,
        color: c.foreground,
        whiteSpace: "nowrap",
        flexShrink: "0",
      },
      ".cm-debrief-author.is-link": { cursor: "pointer", font: "inherit" },
      ".cm-debrief-author.is-link:hover": { textDecoration: "underline" },
      ".cm-debrief-author.is-agent": { borderColor: c.accent, color: c.accent, backgroundColor: tint(c.accent, 10) },
      ".cm-debrief-ref": { fontWeight: "600", color: c.accent, fontFamily: code.fontFamily, whiteSpace: "nowrap" },
      ".cm-debrief-time": { fontSize: "11px", color: c.foregroundMuted, whiteSpace: "nowrap" },
      ".cm-debrief-tag": {
        fontSize: "10px",
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        borderRadius: "10px",
        padding: "0 6px",
        border: `1px solid ${c.foregroundMuted}`,
        whiteSpace: "nowrap",
      },
      ".cm-debrief-tag.is-resolved": { borderColor: c.statusSuccess, color: c.statusSuccess },
      ".cm-debrief-tag.is-drifted": { borderColor: c.statusWarning, color: c.statusWarning },
      ".cm-debrief-summary": {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        color: c.foregroundMuted,
      },
      ".cm-debrief-icons": { display: "flex", alignItems: "center", gap: "2px", flexShrink: "0" },
      ".cm-debrief-icon": {
        background: "none",
        border: "none",
        color: c.foregroundMuted,
        cursor: "pointer",
        padding: "4px",
        borderRadius: "4px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      ".cm-debrief-icon svg": { width: "13px", height: "13px", opacity: "0.6" },
      ".cm-debrief-icon:hover": { color: c.foreground, backgroundColor: tint(c.foreground, 8) },
      ".cm-debrief-icon:hover svg": { opacity: "1" },
      ".cm-debrief-icon.is-danger:hover, .cm-debrief-icon.is-armed": { color: c.statusDanger },
      ".cm-debrief-icon.is-armed svg": { opacity: "1" },
      ".cm-debrief-resolve": {
        display: "flex",
        alignItems: "center",
        gap: "3px",
        fontFamily: "inherit",
        fontSize: "11px",
        padding: "1px 7px 1px 4px",
        background: "none",
        border: "1px solid transparent",
        borderRadius: "10px",
        color: c.foregroundMuted,
        cursor: "pointer",
      },
      ".cm-debrief-resolve svg": { width: "12px", height: "12px", opacity: "0.7" },
      ".cm-debrief-resolve:hover": { color: c.statusSuccess, backgroundColor: tint(c.statusSuccess, 12) },
      ".cm-debrief-resolve.is-active": { borderColor: c.statusSuccess, color: c.statusSuccess },
      ".cm-debrief-card-body": { padding: "8px 12px", lineHeight: "1.55" },
      ".cm-debrief-quote": {
        margin: "0 0 6px 0",
        paddingLeft: "8px",
        borderLeft: `2px solid ${c.border}`,
        color: c.foregroundMuted,
        fontStyle: "italic",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      ".cm-debrief-replies": { borderTop: `1px solid ${c.border}` },
      ".cm-debrief-reply": { padding: "6px 12px" },
      ".cm-debrief-reply + .cm-debrief-reply": { borderTop: `1px solid ${c.border}` },
      ".cm-debrief-reply-head": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        marginBottom: "2px",
        fontSize: "12px",
      },
      ".cm-debrief-reply-meta": { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" },
      ".cm-debrief-reply-actions": { display: "flex", gap: "2px", opacity: "0", transition: "opacity 0.15s" },
      ".cm-debrief-reply:hover .cm-debrief-reply-actions, .cm-debrief-reply-actions:focus-within": { opacity: "1" },
      ".cm-debrief-reply-form": { padding: "8px 12px 10px", borderTop: `1px solid ${c.border}` },
      ".cm-debrief-reply-form.is-expanded": { padding: "0" },
      ".cm-debrief-reply-input": {
        boxSizing: "border-box",
        width: "100%",
        padding: "5px 9px",
        border: `1px solid ${c.border}`,
        borderRadius: "6px",
        backgroundColor: c.surface0,
        color: c.foreground,
        fontFamily: "inherit",
        fontSize: "13px",
        cursor: "text",
      },
      ".cm-debrief-reply-input:focus": { outline: "none", borderColor: c.accent },
      ".cm-debrief-textarea": {
        display: "block",
        boxSizing: "border-box",
        width: "100%",
        minHeight: "64px",
        padding: "8px 12px",
        border: "none",
        borderRadius: "0",
        backgroundColor: c.surface1,
        color: c.foreground,
        fontFamily: "inherit",
        fontSize: "13px",
        lineHeight: "1.5",
        resize: "vertical",
      },
      ".cm-debrief-textarea:focus": { outline: "none" },
      ".cm-debrief-form-buttons": {
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: "8px",
        padding: "6px 12px",
        borderTop: `1px solid ${c.border}`,
      },
      ".cm-debrief-form-hint": { flex: "1", color: c.foregroundMuted, fontSize: "11px" },
      ".cm-debrief-btn": {
        ...smallButton(c.foreground),
        border: `1px solid ${c.border}`,
        backgroundColor: c.surface2,
      },
      ".cm-debrief-btn:hover": { borderColor: c.accent },
      ".cm-debrief-btn-primary": {
        ...smallButton(c.accentForeground),
        border: `1px solid ${c.accent}`,
        backgroundColor: c.accent,
      },
      ".cm-debrief-btn-primary:disabled": { opacity: "0.5", cursor: "default" },
      ".cm-debrief-error": { color: c.statusDanger, fontSize: "12px", padding: "0 12px" },
      ".cm-debrief-error:empty": { display: "none" },
      ".cm-debrief-comment-tip": { padding: "2px", border: "none", backgroundColor: "transparent" },
      // Yellow, not the accent: in a diff, green reads as an added line.
      ".cm-debrief-commented": { backgroundColor: tint(c.statusWarning, 12) },

      // Story narration: drawn above its line, distinct from a thread.
      // Story narration, interlinear: prose in the space between lines, not a card. The
      // container carries the code font so its `ch` indent lines up with the code below.
      ".cm-debrief-narration": {
        boxSizing: "border-box",
        fontFamily: code.fontFamily,
        padding: "6px 16px 7px 0",
        minWidth: "0",
      },
      ".cm-debrief-narration-text": {
        fontFamily: UI_FONT,
        fontSize: "13px",
        lineHeight: "1.55",
        fontStyle: "italic",
        color: `color-mix(in srgb, ${c.accent} 38%, ${c.foreground})`,
        borderLeft: `2px solid ${tint(c.accent, 55)}`,
        paddingLeft: "10px",
        marginLeft: "2px",
        maxWidth: "72ch",
        overflowWrap: "anywhere",
      },
      ".cm-debrief-narration-text code": { fontStyle: "normal" },
      ".cm-debrief-narration-drifted": {
        fontFamily: UI_FONT,
        color: c.statusWarning,
        fontSize: "11px",
        paddingLeft: "14px",
        marginTop: "2px",
      },

      // Markdown drawn by markdown-dom.ts, in thread bodies and narration.
      ".cm-debrief-md p": { margin: "0 0 6px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      ".cm-debrief-md p:last-child": { marginBottom: "0" },
      ".cm-debrief-md h4": { margin: "2px 0 4px 0", fontSize: "13px", fontWeight: "700" },
      ".cm-debrief-md ul, .cm-debrief-md ol": { margin: "0 0 6px 0", paddingLeft: "20px" },
      ".cm-debrief-md li": { overflowWrap: "anywhere" },
      ".cm-debrief-md code": {
        fontFamily: code.fontFamily,
        fontSize: "12px",
        backgroundColor: tint(c.foreground, 8),
        borderRadius: "3px",
        padding: "0 4px",
      },
      ".cm-debrief-md pre": {
        fontFamily: code.fontFamily,
        fontSize: "12px",
        margin: "2px 0 6px 0",
        padding: "6px 8px",
        backgroundColor: c.surface0,
        borderRadius: "4px",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },

      // A run of unchanged lines folded away, with expand controls.
      ".cm-debrief-fold": {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        boxSizing: "border-box",
        padding: "2px 8px",
        margin: "0",
        backgroundColor: c.surface1,
        borderTop: `1px solid ${tint(c.border, 70)}`,
        borderBottom: `1px solid ${tint(c.border, 70)}`,
        color: c.foregroundMuted,
        fontFamily: UI_FONT,
        fontSize: "12px",
        lineHeight: "20px",
        position: "sticky",
        left: "var(--debrief-gutter-width, 0px)",
        width: "var(--debrief-visible-width, 100%)",
      },
      ".cm-debrief-fold-label": { flex: "1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      ".cm-debrief-fold-btn": {
        display: "flex",
        alignItems: "center",
        gap: "3px",
        background: "none",
        border: "1px solid transparent",
        borderRadius: "4px",
        color: c.foregroundMuted,
        fontFamily: "inherit",
        fontSize: "12px",
        padding: "0 6px",
        cursor: "pointer",
      },
      ".cm-debrief-fold-btn svg": { width: "13px", height: "13px" },
      ".cm-debrief-fold-btn:hover": { color: c.accent, backgroundColor: tint(c.accent, 12) },

      ".cm-debrief-diag-1": { textDecoration: `underline wavy ${c.statusDanger}`, textUnderlineOffset: "3px" },
      ".cm-debrief-diag-2": { textDecoration: `underline wavy ${c.statusWarning}`, textUnderlineOffset: "3px" },
      ".cm-debrief-diag-3, .cm-debrief-diag-4": {
        textDecoration: `underline dotted ${c.foregroundMuted}`,
        textUnderlineOffset: "3px",
      },
      ".cm-debrief-hover": { maxWidth: "640px", maxHeight: "360px", overflow: "auto", padding: "6px 10px", fontSize: "12px" },
      ".cm-debrief-hover pre": {
        fontFamily: code.fontFamily,
        margin: "4px 0",
        whiteSpace: "pre-wrap",
        color: c.foreground,
      },
      ".cm-debrief-hover p": { margin: "4px 0", whiteSpace: "pre-wrap", color: c.foregroundMuted },
    },
    { dark },
  );

  return [base, syntaxHighlighting(cm.syntax.paseoHighlightStyle(cm.language, cm.highlight, code.syntaxTheme, dark))];
}
