/**
 * Comment threads inside the editor: a block widget after each thread's last
 * line, a tint over the lines it covers, the composer that starts one, the
 * floating "Comment" button over a selection, and gutter press-and-drag to pick
 * a line range. Widgets are plain DOM styled by `theme.ts`.
 *
 * A thread widget is rebuilt only when its comment changes (`signature`), so a
 * poll that brings nothing new leaves a half-typed reply alone; and drafts are
 * kept per comment, so a rebuild restores them.
 */
import type { EditorState, Extension } from "@codemirror/state";
import type { DecorationSet, EditorView } from "@codemirror/view";

import type { Comment, Reply, Side } from "../../shared/review";
import { adjacentLine, authorLabel, messageOf, rangeLabel, relativeTime } from "../format";
import type { CM } from "./cm";
import { blockWrapper, button, domDocument, type El, h, text, unwatchBlock } from "./dom";
import { iconButton, iconSvg } from "./icons";
import { markdownDom } from "./markdown-dom";

export interface NewComment {
  side: Side;
  startLine: number;
  endLine: number;
  quote?: string;
  body: string;
}

export interface ThreadCallbacks {
  reply(commentId: string, body: string): Promise<void>;
  resolve(commentId: string, resolved: boolean): Promise<void>;
  edit(commentId: string, replyId: string | undefined, body: string): Promise<void>;
  remove(commentId: string, replyId: string | undefined): Promise<void>;
  create(input: NewComment): Promise<void>;
  agentProvider?(agentId: string): string | undefined;
  openAgent?(agentId: string): void;
}

interface ComposerRange {
  startLine: number;
  endLine: number;
  quote?: string;
}

interface ThreadsValue {
  comments: readonly Comment[];
  composer: ComposerRange | null;
  decorations: DecorationSet;
}

export interface ThreadsHandle {
  extension: Extension;
  /** Handlers for `lineNumbers({ domEventHandlers })`: press or drag to choose lines. */
  gutterHandlers: Record<string, (view: EditorView, line: { from: number }, event: unknown) => boolean>;
  setComments(view: EditorView, comments: readonly Comment[]): void;
  /** Opens the composer on the selection, or the cursor's line. */
  commentOnSelection(view: EditorView): boolean;
  closeComposer(view: EditorView): boolean;
  /** Moves to the next or previous thread; false when there is none. */
  step(view: EditorView, direction: 1 | -1): boolean;
}

const QUOTE_LIMIT = 500;

/** A folded thread's one line: the start of its body. */
function summaryLine(comment: Comment): string {
  const first = comment.body.split("\n").find((line) => line.trim() !== "") ?? "";
  return first.replace(/[#>*_`]/g, "").trim();
}

function signature(comment: Comment): string {
  return [
    comment.id,
    comment.updatedAt,
    comment.resolved ? "r" : "",
    comment.drifted ? "d" : "",
    comment.startLine ?? "",
    comment.endLine ?? "",
    comment.body,
    comment.replies.map((reply) => `${reply.id}:${reply.updatedAt}`).join(","),
  ].join("|");
}

export function createThreads(
  cm: CM,
  side: Side,
  callbacks: () => ThreadCallbacks,
): ThreadsHandle {
  const { StateEffect, StateField, RangeSetBuilder } = cm.state;
  const { Decoration, EditorView, WidgetType, showTooltip } = cm.view;
  const drafts = new Map<string, string>();
  /** Per-thread open or folded, when the reviewer chose; otherwise resolved threads start folded. */
  const collapsed = new Map<string, boolean>();

  const setCommentsEffect = StateEffect.define<readonly Comment[]>();
  const setComposerEffect = StateEffect.define<ComposerRange | null>();

  function lineEnd(state: EditorState, line: number): number {
    const clamped = Math.min(Math.max(1, line), state.doc.lines);
    return state.doc.line(clamped).to;
  }

  /**
   * A text form. Compact, it is a one-line "Reply..." field that grows into a
   * textarea with Cancel and the submit button on focus, as Crit's reply box
   * does; otherwise it starts grown. Cmd/Ctrl+Enter submits, Escape cancels.
   */
  function form(options: {
    initial: string;
    placeholder: string;
    submitLabel: string;
    submit: (body: string) => Promise<void>;
    /** Called after Cancel or Escape; a compact form shrinks back on its own first. */
    cancel?: () => void;
    onInput?: (value: string) => void;
    compact: boolean;
    remeasure: () => void;
    focus?: boolean;
  }): El {
    const root = h("div", { className: options.compact ? "cm-debrief-reply-form" : "" });
    const error = h("div", { className: "cm-debrief-error" });
    let busy = false;
    let expanded = !options.compact || options.initial !== "";
    let value = options.initial;

    const draw = (focus: boolean) => {
      if (!expanded) {
        const input = h("input", {
          className: "cm-debrief-reply-input",
          placeholder: options.placeholder,
          attrs: { type: "text", "aria-label": options.placeholder },
        });
        input.addEventListener("focus", () => {
          expanded = true;
          draw(true);
        });
        root.classList.remove("is-expanded");
        root.replaceChildren(input);
        options.remeasure();
        return;
      }
      if (options.compact) root.classList.add("is-expanded");
      const textarea = h("textarea", {
        className: "cm-debrief-textarea",
        value,
        rows: 3,
        placeholder: options.placeholder,
        attrs: { "aria-label": options.placeholder },
      });
      const submitButton = button(options.submitLabel, () => send(), "cm-debrief-btn-primary");
      const send = () => {
        const body = textarea.value.trim();
        if (body === "" || busy) return;
        busy = true;
        submitButton.disabled = true;
        error.textContent = "";
        options
          .submit(body)
          .then(() => {
            value = "";
            textarea.value = "";
            options.onInput?.("");
            if (options.compact) {
              expanded = false;
              draw(false);
            }
          })
          .catch((cause: unknown) => {
            error.textContent = messageOf(cause);
            options.remeasure();
          })
          .finally(() => {
            busy = false;
            submitButton.disabled = false;
          });
      };
      const cancel = () => {
        value = "";
        options.onInput?.("");
        if (options.compact) {
          expanded = false;
          draw(false);
        }
        options.cancel?.();
      };
      textarea.addEventListener("input", () => {
        value = textarea.value;
        options.onInput?.(value);
      });
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey === true || event.ctrlKey === true)) {
          event.preventDefault();
          send();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      });
      textarea.addEventListener("blur", () => {
        // An untouched grown reply box shrinks back when focus leaves it.
        if (options.compact && textarea.value.trim() === "" && !busy) {
          setTimeout(() => {
            if (expanded && textarea.value.trim() === "") {
              expanded = false;
              draw(false);
            }
          }, 150);
        }
      });
      root.replaceChildren(
        textarea,
        error,
        h(
          "div",
          { className: "cm-debrief-form-buttons" },
          text("span", "cm-debrief-form-hint", "Cmd+Enter to send"),
          button("Cancel", cancel),
          submitButton,
        ),
      );
      options.remeasure();
      if (focus) setTimeout(() => textarea.focus(), 0);
    };
    draw(options.focus === true || (!options.compact && options.initial !== ""));
    return root;
  }

  function authorBadge(author: Comment["author"]): El {
    const label = authorLabel(author, (agentId) => callbacks().agentProvider?.(agentId));
    if (author.kind !== "agent") return text("span", "cm-debrief-author", label);
    const agentId = author.agentId;
    const open = callbacks().openAgent;
    if (agentId === undefined || open === undefined) {
      const badge = text("span", "cm-debrief-author is-agent", label);
      badge.title = author.name;
      return badge;
    }
    const badge = h(
      "button",
      {
        className: "cm-debrief-author is-agent is-link",
        title: `${author.name}: open this agent`,
        attrs: { type: "button" },
        on: { mousedown: (event) => event.preventDefault(), click: () => callbacks().openAgent?.(agentId) },
      },
      label,
    );
    return badge;
  }

  /** The trash button: the first press arms it, the second deletes. */
  function deleteButton(what: string, onDelete: () => void): El {
    let armed = false;
    const el = iconButton("trash", `Delete ${what}`, () => {
      if (!armed) {
        armed = true;
        el.classList.add("is-armed");
        el.title = `Press again to delete ${what}`;
        setTimeout(() => {
          armed = false;
          el.classList.remove("is-armed");
          el.title = `Delete ${what}`;
        }, 3000);
        return;
      }
      onDelete();
    }, "cm-debrief-icon is-danger");
    return el;
  }

  function renderReply(comment: Comment, reply: Reply, remeasure: () => void, fail: (cause: unknown) => void): El {
    const root = h("div", { className: "cm-debrief-reply" });
    let editing = false;
    const draw = () => {
      const human = reply.author.kind === "human";
      const head = h(
        "div",
        { className: "cm-debrief-reply-head" },
        h(
          "div",
          { className: "cm-debrief-reply-meta" },
          authorBadge(reply.author),
          text("span", "cm-debrief-time", relativeTime(reply.createdAt)),
        ),
        human && !editing
          ? h(
              "div",
              { className: "cm-debrief-reply-actions" },
              iconButton("pencil", "Edit reply", () => {
                editing = true;
                draw();
              }),
              deleteButton("reply", () => callbacks().remove(comment.id, reply.id).catch(fail)),
            )
          : null,
      );
      const body = editing
        ? form({
            initial: reply.body,
            placeholder: "Edit reply",
            submitLabel: "Save",
            submit: (next) => callbacks().edit(comment.id, reply.id, next),
            cancel: () => {
              editing = false;
              draw();
            },
            compact: false,
            remeasure,
            focus: true,
          })
        : markdownDom(reply.body);
      root.replaceChildren(head, body);
      remeasure();
    };
    draw();
    return root;
  }

  function renderThread(comment: Comment, remeasure: () => void): El {
    const card = h("div", { attrs: { "data-comment-id": comment.id } });
    let editing = false;
    const error = h("div", { className: "cm-debrief-error" });
    const fail = (cause: unknown) => {
      error.textContent = messageOf(cause);
      remeasure();
    };
    const run = (action: Promise<void>) => {
      error.textContent = "";
      action.catch(fail);
    };
    const draw = () => {
      const isCollapsed = collapsed.get(comment.id) ?? comment.resolved;
      card.className = [
        "cm-debrief-card",
        comment.resolved ? "is-resolved" : "",
        comment.drifted ? "is-drifted" : "",
        isCollapsed ? "is-collapsed" : "",
      ]
        .filter((name) => name !== "")
        .join(" ");
      const toggle = () => {
        collapsed.set(comment.id, !isCollapsed);
        draw();
      };
      const range = rangeLabel(comment);
      const human = comment.author.kind === "human";
      const chevron = h("button", {
        className: "cm-debrief-chevron",
        title: isCollapsed ? "Expand thread" : "Collapse thread",
        attrs: { type: "button", "aria-label": isCollapsed ? "Expand thread" : "Collapse thread" },
        on: {
          mousedown: (event) => event.preventDefault(),
          click: (event) => {
            event.stopPropagation();
            toggle();
          },
        },
      });
      chevron.innerHTML = iconSvg("chevronDown");
      const left = h(
        "div",
        { className: "cm-debrief-head-left" },
        chevron,
        authorBadge(comment.author),
        range !== "" ? text("span", "cm-debrief-ref", range) : null,
        text("span", "cm-debrief-time", relativeTime(comment.createdAt)),
        comment.drifted ? text("span", "cm-debrief-tag is-drifted", "drifted") : null,
        isCollapsed ? text("span", "cm-debrief-summary", summaryLine(comment)) : null,
      );
      const resolve = iconButton(
        comment.resolved ? "undo" : "check",
        comment.resolved ? "Reopen thread" : "Resolve thread",
        () => run(callbacks().resolve(comment.id, !comment.resolved)),
        comment.resolved ? "cm-debrief-resolve is-active" : "cm-debrief-resolve",
        comment.resolved ? "Resolved" : "Resolve",
      );
      const icons = h(
        "div",
        { className: "cm-debrief-icons" },
        resolve,
        human && !isCollapsed && !editing
          ? iconButton("pencil", "Edit comment", () => {
              editing = true;
              draw();
            })
          : null,
        human && !isCollapsed ? deleteButton("thread", () => run(callbacks().remove(comment.id, undefined))) : null,
      );
      const head = h("div", { className: "cm-debrief-card-head" }, left, icons);
      if (isCollapsed) head.addEventListener("click", toggle);
      if (isCollapsed) {
        card.replaceChildren(head, error);
        remeasure();
        return;
      }
      const body = h(
        "div",
        { className: "cm-debrief-card-body" },
        comment.quote ? text("div", "cm-debrief-quote", comment.quote) : null,
        editing
          ? form({
              initial: comment.body,
              placeholder: "Edit comment",
              submitLabel: "Save",
              submit: async (next) => {
                await callbacks().edit(comment.id, undefined, next);
              },
              cancel: () => {
                editing = false;
                draw();
              },
              compact: false,
              remeasure,
              focus: true,
            })
          : markdownDom(comment.body),
      );
      const replies =
        comment.replies.length > 0
          ? h(
              "div",
              { className: "cm-debrief-replies" },
              ...comment.replies.map((reply) => renderReply(comment, reply, remeasure, fail)),
            )
          : null;
      const reply = form({
        initial: drafts.get(comment.id) ?? "",
        placeholder: "Reply...",
        submitLabel: "Reply",
        submit: async (next) => {
          await callbacks().reply(comment.id, next);
          drafts.delete(comment.id);
        },
        onInput: (value) => {
          if (value === "") drafts.delete(comment.id);
          else drafts.set(comment.id, value);
        },
        compact: true,
        remeasure,
      });
      card.replaceChildren(...[head, body, replies, error, reply].filter((child): child is El => child !== null));
      // Opening, replying or editing changes the block's height; CodeMirror has to measure it again.
      remeasure();
    };
    draw();
    return card;
  }

  class ThreadWidget extends WidgetType {
    constructor(
      readonly comment: Comment,
      readonly key: string,
    ) {
      super();
    }
    override eq(other: ThreadWidget): boolean {
      return other.key === this.key;
    }
    override get estimatedHeight(): number {
      return (collapsed.get(this.comment.id) ?? this.comment.resolved) ? 44 : 120 + this.comment.replies.length * 56;
    }
    override toDOM(view: EditorView) {
      const remeasure = () => view.requestMeasure();
      return blockWrapper(renderThread(this.comment, remeasure), remeasure) as never;
    }
    override destroy(dom: unknown): void {
      unwatchBlock(dom as El);
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  class ComposerWidget extends WidgetType {
    constructor(readonly range: ComposerRange) {
      super();
    }
    override eq(other: ComposerWidget): boolean {
      return (
        other.range.startLine === this.range.startLine &&
        other.range.endLine === this.range.endLine &&
        other.range.quote === this.range.quote
      );
    }
    override toDOM(view: EditorView) {
      const range = this.range;
      const label = rangeLabel({ startLine: range.startLine, endLine: range.endLine, side });
      const close = () => view.dispatch({ effects: setComposerEffect.of(null) });
      const remeasure = () => view.requestMeasure();
      const card = h(
        "div",
        { className: "cm-debrief-card" },
        h(
          "div",
          { className: "cm-debrief-card-head" },
          h(
            "div",
            { className: "cm-debrief-head-left" },
            text("span", "cm-debrief-time", "New comment on"),
            text("span", "cm-debrief-ref", label),
          ),
        ),
        range.quote ? h("div", { className: "cm-debrief-card-body" }, text("div", "cm-debrief-quote", range.quote)) : null,
        form({
          initial: "",
          placeholder: "Leave a comment",
          submitLabel: "Comment",
          submit: async (body) => {
            await callbacks().create({
              side,
              startLine: range.startLine,
              endLine: range.endLine,
              ...(range.quote ? { quote: range.quote } : {}),
              body,
            });
            close();
          },
          cancel: close,
          compact: false,
          remeasure,
          focus: true,
        }),
      );
      return blockWrapper(card, remeasure) as never;
    }
    override get estimatedHeight(): number {
      return 150;
    }
    override destroy(dom: unknown): void {
      unwatchBlock(dom as El);
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  function build(state: EditorState, comments: readonly Comment[], composer: ComposerRange | null): DecorationSet {
    type Entry = { pos: number; order: number; deco: ReturnType<typeof Decoration.widget> };
    const entries: Entry[] = [];
    comments.forEach((comment, index) => {
      const end = comment.endLine ?? comment.startLine;
      if (end === undefined) return;
      const start = comment.startLine ?? end;
      const first = Math.min(Math.max(1, start), state.doc.lines);
      const last = Math.min(Math.max(first, end), state.doc.lines);
      for (let line = first; line <= last; line += 1) {
        entries.push({
          pos: state.doc.line(line).from,
          order: -1,
          deco: Decoration.line({ class: "cm-debrief-commented" }),
        });
      }
      entries.push({
        pos: lineEnd(state, end),
        order: index,
        deco: Decoration.widget({
          widget: new ThreadWidget(comment, signature(comment)),
          block: true,
          side: 1 + index,
        }),
      });
    });
    if (composer !== null) {
      entries.push({
        pos: lineEnd(state, composer.endLine),
        order: comments.length,
        deco: Decoration.widget({ widget: new ComposerWidget(composer), block: true, side: 1000 }),
      });
    }
    entries.sort((a, b) => a.pos - b.pos || a.order - b.order);
    const builder = new RangeSetBuilder<ReturnType<typeof Decoration.widget>>();
    // Line decorations for the same line must not repeat; keep the first.
    const seenLines = new Set<number>();
    entries.forEach((entry) => {
      if (entry.order === -1) {
        if (seenLines.has(entry.pos)) return;
        seenLines.add(entry.pos);
      }
      builder.add(entry.pos, entry.pos, entry.deco);
    });
    return builder.finish();
  }

  const field = StateField.define<ThreadsValue>({
    create: () => ({ comments: [], composer: null, decorations: Decoration.none }),
    update(value, tr) {
      let comments = value.comments;
      let composer = value.composer;
      let rebuild = false;
      tr.effects.forEach((effect) => {
        if (effect.is(setCommentsEffect)) {
          comments = effect.value;
          rebuild = true;
        } else if (effect.is(setComposerEffect)) {
          composer = effect.value;
          rebuild = true;
        }
      });
      if (rebuild) return { comments, composer, decorations: build(tr.state, comments, composer) };
      if (!tr.docChanged) return value;
      return { comments, composer, decorations: value.decorations.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  function selectionRange(state: EditorState): ComposerRange {
    const selection = state.selection.main;
    const startLine = state.doc.lineAt(selection.from).number;
    let endLine = state.doc.lineAt(selection.to).number;
    // A selection that ends at the start of a line does not cover that line.
    if (selection.to > selection.from && state.doc.lineAt(selection.to).from === selection.to) {
      endLine = Math.max(startLine, endLine - 1);
    }
    const quote = selection.empty ? "" : state.sliceDoc(selection.from, selection.to).trim().slice(0, QUOTE_LIMIT);
    return quote === "" ? { startLine, endLine } : { startLine, endLine, quote };
  }

  function commentOnSelection(view: EditorView): boolean {
    view.dispatch({ effects: setComposerEffect.of(selectionRange(view.state)) });
    return true;
  }

  const commentTooltip = showTooltip.compute(["selection", field], (state) => {
    const selection = state.selection.main;
    if (selection.empty || state.field(field).composer !== null) return null;
    return {
      pos: selection.head,
      above: selection.head === selection.from,
      strictSide: false,
      arrow: false,
      create: (view: EditorView) => ({
        dom: h(
          "div",
          { className: "cm-debrief-comment-tip" },
          button("Comment", () => commentOnSelection(view), "cm-debrief-btn-primary"),
        ) as never,
      }),
    };
  });

  /** Press a line number to comment on it; drag across numbers for a range. */
  const gutterHandlers: ThreadsHandle["gutterHandlers"] = {
    mousedown(view, block, event) {
      const mouse = event as { button?: number; clientY?: number; preventDefault(): void };
      if (mouse.button !== 0) return false;
      mouse.preventDefault();
      const anchor = view.state.doc.lineAt(block.from).number;
      let current = anchor;
      const select = () => {
        const first = Math.min(anchor, current);
        const last = Math.max(anchor, current);
        view.dispatch({
          selection: { anchor: view.state.doc.line(first).from, head: view.state.doc.line(last).to },
        });
      };
      select();
      const doc = domDocument();
      const move = (moveEvent: { clientY?: number }) => {
        if (typeof moveEvent.clientY !== "number") return;
        const lineBlock = view.lineBlockAtHeight(moveEvent.clientY - view.documentTop);
        const line = view.state.doc.lineAt(lineBlock.from).number;
        if (line !== current) {
          current = line;
          select();
        }
      };
      const up = () => {
        doc.removeEventListener("mousemove", move);
        doc.removeEventListener("mouseup", up);
        const first = Math.min(anchor, current);
        const last = Math.max(anchor, current);
        view.dispatch({
          selection: { anchor: view.state.doc.line(last).to },
          effects: setComposerEffect.of({ startLine: first, endLine: last }),
        });
      };
      doc.addEventListener("mousemove", move);
      doc.addEventListener("mouseup", up);
      return true;
    },
  };

  return {
    extension: [field, commentTooltip],
    gutterHandlers,
    setComments(view, comments) {
      view.dispatch({ effects: setCommentsEffect.of(comments) });
    },
    commentOnSelection,
    closeComposer(view) {
      if (view.state.field(field).composer === null) return false;
      view.dispatch({ effects: setComposerEffect.of(null) });
      return true;
    },
    step(view, direction) {
      const lines = view.state
        .field(field)
        .comments.flatMap((comment) => {
          const line = comment.endLine ?? comment.startLine;
          return line === undefined ? [] : [Math.min(line, view.state.doc.lines)];
        });
      const current = view.state.doc.lineAt(view.state.selection.main.head).number;
      const target = adjacentLine(lines, current, direction);
      if (target === null) return false;
      const pos = view.state.doc.line(target).from;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      return true;
    },
  };
}
