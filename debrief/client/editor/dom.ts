/**
 * The narrow shape of the DOM that the editor's widgets touch. No tsconfig here
 * has "DOM" in `lib`, so this declares what is used and nothing else. Only
 * `editor/` reaches it, and only after `mountEditor` has checked
 * `Platform.OS === "web"`.
 */

export interface DomEvent {
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly button?: number;
  readonly clientX?: number;
  readonly clientY?: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface El {
  style: Record<string, string>;
  className: string;
  textContent: string | null;
  innerHTML: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  title: string;
  rows: number;
  appendChild(child: El): El;
  classList: { add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): boolean };
  replaceChildren(...children: El[]): void;
  addEventListener(type: string, listener: (event: DomEvent) => void): void;
  setAttribute(name: string, value: string): void;
  focus(): void;
  remove(): void;
}

interface DomDocument {
  createElement(tag: string): El;
  addEventListener(type: string, listener: (event: DomEvent) => void): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void): void;
}

export function domDocument(): DomDocument {
  return (globalThis as unknown as { document: DomDocument }).document;
}

type Child = El | string | null | undefined | false;

/** A tiny element builder: `h("button", { className: "x", onclick }, "Label")`. */
export function h(
  tag: string,
  props: {
    className?: string;
    title?: string;
    placeholder?: string;
    value?: string;
    rows?: number;
    disabled?: boolean;
    style?: Record<string, string>;
    attrs?: Record<string, string>;
    on?: Record<string, (event: DomEvent) => void>;
  } = {},
  ...children: Child[]
): El {
  const el = domDocument().createElement(tag);
  if (props.className !== undefined) el.className = props.className;
  if (props.title !== undefined) el.title = props.title;
  if (props.placeholder !== undefined) el.placeholder = props.placeholder;
  if (props.rows !== undefined) el.rows = props.rows;
  if (props.value !== undefined) el.value = props.value;
  if (props.disabled !== undefined) el.disabled = props.disabled;
  if (props.style !== undefined) Object.assign(el.style, props.style);
  if (props.attrs !== undefined) {
    Object.entries(props.attrs).forEach(([name, value]) => el.setAttribute(name, value));
  }
  if (props.on !== undefined) {
    Object.entries(props.on).forEach(([type, listener]) => el.addEventListener(type, listener));
  }
  children.forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    if (typeof child === "string") {
      const span = domDocument().createElement("span");
      span.textContent = child;
      el.appendChild(span);
    } else {
      el.appendChild(child);
    }
  });
  return el;
}

/** A button that does not steal the editor's selection on mousedown. */
export function button(label: string, onClick: () => void, className = "cm-debrief-btn"): El {
  return h(
    "button",
    {
      className,
      attrs: { type: "button" },
      on: {
        mousedown: (event) => event.preventDefault(),
        click: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        },
      },
    },
    label,
  );
}

export function text(tag: string, className: string, content: string): El {
  const el = h(tag, { className });
  el.textContent = content;
  return el;
}

interface Observer {
  observe(target: unknown): void;
  disconnect(): void;
}
type ObserverCtor = new (callback: () => void) => Observer;

const observers = new WeakMap<object, Observer>();

/**
 * The outer element of a block widget. CodeMirror measures a block widget by
 * its border box, so a vertical margin on it shifts every gutter number below
 * it; the spacing is padding here, and the card inside carries no margin. A
 * ResizeObserver asks the editor to measure again whenever the card's height
 * changes (a reply opened, a font loaded), so the gutter stays aligned.
 */
export function blockWrapper(child: El, remeasure: () => void): El {
  const wrapper = h("div", { className: "cm-debrief-block" }, child);
  const Ctor = (globalThis as unknown as { ResizeObserver?: ObserverCtor }).ResizeObserver;
  if (Ctor !== undefined) {
    const observer = new Ctor(() => remeasure());
    observer.observe(child);
    observers.set(wrapper, observer);
  }
  setTimeout(remeasure, 0);
  return wrapper;
}

export function unwatchBlock(wrapper: El): void {
  observers.get(wrapper)?.disconnect();
  observers.delete(wrapper);
}

/** Sets a CSS custom property, which `style` as a plain record cannot. */
export function setCssVar(el: unknown, name: string, value: string): void {
  (el as { style: { setProperty(name: string, value: string): void } }).style.setProperty(name, value);
}
