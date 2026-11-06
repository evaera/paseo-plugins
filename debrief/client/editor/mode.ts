/**
 * Which editor a file gets, decided from what exists on each side. Pure, so the
 * panel can key the editor on it without loading CodeMirror.
 */
export type EditorLayout = "unified" | "split";

export type EditorMode =
  /** Both sides, the old one shown as deleted chunks inside the new. */
  | "unified"
  /** Both sides, side by side. */
  | "split"
  /** Only the new side: an added file, or a plain file view. */
  | "new-only"
  /** Only the old side: a deleted file. */
  | "old-only";

export function editorMode(oldText: string | null, newText: string | null, layout: EditorLayout): EditorMode {
  if (newText === null) return "old-only";
  if (oldText === null) return "new-only";
  return layout;
}

/** Whether the editor itself draws old-side threads; otherwise they are listed above it. */
export function editorShowsOldThreads(mode: EditorMode): boolean {
  return mode === "split" || mode === "old-only";
}
