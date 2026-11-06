/**
 * Lucide's icons as SVG markup for the editor's DOM widgets (the React side
 * uses the host `Icon`). Stroke-only, `currentColor`, sized by CSS.
 */
import { domDocument, type El } from "./dom";

const PATHS = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronsUpDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function iconSvg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** A small icon button that keeps the editor's selection on mousedown. */
export function iconButton(
  name: IconName,
  title: string,
  onClick: () => void,
  className = "cm-debrief-icon",
  label?: string,
): El {
  const button = domDocument().createElement("button");
  button.className = className;
  button.title = title;
  button.setAttribute("type", "button");
  button.setAttribute("aria-label", title);
  button.innerHTML = iconSvg(name);
  if (label !== undefined) {
    const span = domDocument().createElement("span");
    span.textContent = label;
    button.appendChild(span);
  }
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}
