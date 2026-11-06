/**
 * Every browser global the React side of Debrief touches, and nothing else
 * does. No tsconfig here has "DOM" in `lib`, so each global is declared in the
 * narrow shape used; every export checks `Platform.OS` and is a no-op (or a
 * default) on iOS and Android. The editor's own DOM lives in `editor/`.
 */
import { Platform } from "react-native";

interface Storage {
  getItem(key: string): string | null;
}

interface EventTargetLike {
  addEventListener(type: string, listener: (event: never) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, options?: boolean): void;
}

interface NodeLike {
  contains(other: unknown): boolean;
}

interface ElementLike extends NodeLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?(selector: string): ElementLike | null;
}

interface Selection {
  readonly isCollapsed: boolean;
  readonly anchorNode: unknown;
  readonly focusNode: unknown;
  toString(): string;
}

interface WindowLike extends EventTargetLike {
  localStorage?: Storage;
  getSelection?(): Selection | null;
}

function win(): WindowLike | null {
  if (Platform.OS !== "web") return null;
  return (globalThis as unknown as { window?: WindowLike }).window ?? null;
}

function doc(): EventTargetLike | null {
  if (Platform.OS !== "web") return null;
  return (globalThis as unknown as { document?: EventTargetLike }).document ?? null;
}

import { APP_SETTINGS_KEY, type CodeSettings, codeSettingsFrom } from "./code-settings";

export type { CodeSettings } from "./code-settings";

let lastRaw: string | null | undefined;
let lastSettings: CodeSettings = codeSettingsFrom(null);

/** The current code settings; the defaults off web or when nothing is stored. */
export function readCodeSettings(): CodeSettings {
  let raw: string | null = null;
  try {
    raw = win()?.localStorage?.getItem(APP_SETTINGS_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastSettings = codeSettingsFrom(raw);
  }
  return lastSettings;
}

/** Calls `onChange` when another window changes Paseo's stored settings. */
export function watchCodeSettings(onChange: () => void): () => void {
  const w = win();
  if (w === null) return () => undefined;
  const listener = (event: { key?: string | null }) => {
    if (event.key === null || event.key === undefined || event.key === APP_SETTINGS_KEY) onChange();
  };
  w.addEventListener("storage", listener as (event: never) => void);
  return () => w.removeEventListener("storage", listener as (event: never) => void);
}

/**
 * Calls `onSelect` with the selected text whenever a mouse selection ends
 * inside `node` (a React Native Web view's element). No-op on native.
 */
export function watchSelection(node: unknown, onSelect: (text: string) => void): () => void {
  const w = win();
  if (w === null || node === null || node === undefined) return () => undefined;
  const target = node as EventTargetLike & NodeLike;
  if (typeof target.addEventListener !== "function") return () => undefined;
  const listener = () => {
    const selection = w.getSelection?.() ?? null;
    if (selection === null || selection.isCollapsed) return;
    if (!target.contains(selection.anchorNode) || !target.contains(selection.focusNode)) return;
    const text = selection.toString();
    if (text.trim() !== "") onSelect(text);
  };
  target.addEventListener("mouseup", listener);
  return () => target.removeEventListener("mouseup", listener);
}

/** Whether a key event's target takes typing: a field, or an editor that is not read-only. */
function typingTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (el === null || typeof el !== "object") return false;
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable === true) {
    // CodeMirror marks a read-only editor's content with aria-readonly; only that one is safe for j and k.
    return el.closest?.('[aria-readonly="true"]') === null;
  }
  return false;
}

let activeRoot: unknown = null;

/**
 * Bare review keys (j, k) for one panel: they act only while the last press
 * landed inside `root`, so two Debrief tabs do not both move, and never while
 * the focus is somewhere that takes typing.
 */
export function watchReviewKeys(root: unknown, onKey: (key: "j" | "k") => void): () => void {
  const d = doc();
  const node = root as (EventTargetLike & NodeLike) | null;
  if (d === null || node === null || typeof node?.addEventListener !== "function") return () => undefined;
  activeRoot = node;
  const press = () => {
    activeRoot = node;
  };
  const keydown = (event: {
    key?: string;
    target?: unknown;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    defaultPrevented?: boolean;
    preventDefault(): void;
  }) => {
    if (activeRoot !== node || event.defaultPrevented === true) return;
    if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return;
    if (event.key !== "j" && event.key !== "k") return;
    if (typingTarget(event.target)) return;
    event.preventDefault();
    onKey(event.key);
  };
  node.addEventListener("pointerdown", press, true);
  d.addEventListener("keydown", keydown as (event: never) => void);
  return () => {
    node.removeEventListener("pointerdown", press, true);
    d.removeEventListener("keydown", keydown as (event: never) => void);
    if (activeRoot === node) activeRoot = null;
  };
}
