/**
 * Re-anchoring: a port of Crit's `internal/session/watch.go`
 * (`remapCommentPosition`, `verifyAndCorrectPosition`, `anchorSimilar`,
 * `findAnchorInLines`) and the Hirschberg line diff and old-to-new line map in
 * `internal/diff/diff.go`. Crit is MIT.
 *
 * A new-side line comment is moved from the content it was last anchored
 * against to the current content in three steps: the LCS line map gives a
 * candidate position; the anchor text is checked there, exactly or "edited but
 * recognisable"; failing that, the whole file is searched and the match
 * nearest the candidate wins. Not found anywhere, the comment keeps the mapped
 * position and is marked drifted.
 *
 * Crit does this at round boundaries. Debrief has no rounds, so it runs
 * whenever the file differs from the snapshot it was last anchored against;
 * see `server/reanchor.ts`.
 */
/**
 * Anything that sits on lines and follows them: a review comment, or a story
 * annotation adapted to the same shape.
 */
export interface Movable {
  scope: string;
  path?: string | undefined;
  side?: "old" | "new" | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
  anchor?: string | undefined;
  drifted: boolean;
}

export function splitLines(content: string): string[] {
  return content === "" ? [] : content.split("\n");
}

type Entry =
  | { type: "unchanged"; oldLine: number; newLine: number }
  | { type: "added"; newLine: number }
  | { type: "removed"; oldLine: number };

function lcsForwardRow(old: readonly string[], next: readonly string[]): Int32Array {
  const n = next.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (const oldLine of old) {
    for (let j = 1; j <= n; j += 1) {
      if (oldLine === next[j - 1]) curr[j] = (prev[j - 1] ?? 0) + 1;
      else if ((prev[j] ?? 0) >= (curr[j - 1] ?? 0)) curr[j] = prev[j] ?? 0;
      else curr[j] = curr[j - 1] ?? 0;
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev;
}

function lcsBackwardRow(old: readonly string[], next: readonly string[]): Int32Array {
  const n = next.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (old[i] === next[j]) curr[n - j] = (prev[n - j - 1] ?? 0) + 1;
      else if ((prev[n - j] ?? 0) >= (curr[n - j - 1] ?? 0)) curr[n - j] = prev[n - j] ?? 0;
      else curr[n - j] = curr[n - j - 1] ?? 0;
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev;
}

function hirschberg(old: readonly string[], next: readonly string[], oldOff: number, newOff: number, out: Entry[]): void {
  const m = old.length;
  const n = next.length;
  if (m === 0) {
    for (let i = 0; i < n; i += 1) out.push({ type: "added", newLine: newOff + i + 1 });
    return;
  }
  if (n === 0) {
    for (let i = 0; i < m; i += 1) out.push({ type: "removed", oldLine: oldOff + i + 1 });
    return;
  }
  if (m === 1) {
    const match = next.indexOf(old[0] ?? "");
    if (match < 0) {
      out.push({ type: "removed", oldLine: oldOff + 1 });
      for (let i = 0; i < n; i += 1) out.push({ type: "added", newLine: newOff + i + 1 });
      return;
    }
    for (let i = 0; i < match; i += 1) out.push({ type: "added", newLine: newOff + i + 1 });
    out.push({ type: "unchanged", oldLine: oldOff + 1, newLine: newOff + match + 1 });
    for (let i = match + 1; i < n; i += 1) out.push({ type: "added", newLine: newOff + i + 1 });
    return;
  }
  const mid = Math.floor(m / 2);
  const top = lcsForwardRow(old.slice(0, mid), next);
  const bottom = lcsBackwardRow(old.slice(mid), next);
  let bestK = 0;
  let bestScore = (top[0] ?? 0) + (bottom[n] ?? 0);
  for (let k = 1; k <= n; k += 1) {
    const score = (top[k] ?? 0) + (bottom[n - k] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  hirschberg(old.slice(0, mid), next.slice(0, bestK), oldOff, newOff, out);
  hirschberg(old.slice(mid), next.slice(bestK), oldOff + mid, newOff + bestK, out);
}

/**
 * The line diff, with the common prefix and suffix taken off first: an
 * agent's edit usually touches a small middle, and Hirschberg is O(n*m) time.
 */
export function computeLineDiff(oldContent: string, newContent: string): Entry[] {
  const old = splitLines(oldContent);
  const next = splitLines(newContent);
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const out: Entry[] = [];
  for (let i = 0; i < prefix; i += 1) out.push({ type: "unchanged", oldLine: i + 1, newLine: i + 1 });
  hirschberg(old.slice(prefix, old.length - suffix), next.slice(prefix, next.length - suffix), prefix, prefix, out);
  for (let i = suffix; i > 0; i -= 1) {
    out.push({ type: "unchanged", oldLine: old.length - i + 1, newLine: next.length - i + 1 });
  }
  return out;
}

/** Old line -> new line. Removed lines map to the next surviving new line, as in Crit. */
export function mapOldLineToNew(entries: readonly Entry[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type === "unchanged") map.set(entry.oldLine, entry.newLine);
  }
  let nextNewLine = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.type !== "removed") nextNewLine = entry.newLine;
    if (entry.type === "removed" && !map.has(entry.oldLine)) map.set(entry.oldLine, nextNewLine);
  }
  if (nextNewLine === 0) {
    let lastNewLine = 0;
    for (const entry of entries) if (entry.type !== "removed") lastNewLine = entry.newLine;
    if (lastNewLine > 0) {
      for (const entry of entries) {
        if (entry.type === "removed" && (map.get(entry.oldLine) ?? 0) === 0) map.set(entry.oldLine, lastNewLine);
      }
    }
  }
  return map;
}

export function computeLineMap(oldContent: string, newContent: string): Map<number, number> {
  return mapOldLineToNew(computeLineDiff(oldContent, newContent));
}

/** Crit's `findAnchorInLines`: the 1-based start of the match nearest `preferredStart`, or 0. */
export function findAnchorInLines(lines: readonly string[], anchor: string, preferredStart: number): number {
  if (anchor === "") return 0;
  const anchorLines = anchor.split("\n");
  const length = anchorLines.length;
  if (lines.length < length) return 0;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= lines.length - length; i += 1) {
    if (lines.slice(i, i + length).join("\n") !== anchor) continue;
    const distance = Math.abs(i + 1 - preferredStart);
    if (distance < bestDistance) {
      best = i + 1;
      bestDistance = distance;
    }
  }
  return best;
}

/** Code-point boundaries of `text`, as UTF-16 offsets, excluding its length. */
function boundaries(text: string): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const char of text) {
    out.push(offset);
    offset += char.length;
  }
  return out;
}

/** Crit's `oneMiddleCut`: `short` is `long` with one contiguous run removed. */
export function oneMiddleCut(short: string, long: string): boolean {
  if (short.length >= long.length) return false;
  for (const k of boundaries(short)) {
    if (long.startsWith(short.slice(0, k)) && long.endsWith(short.slice(k))) return true;
  }
  return long.startsWith(short);
}

function levenshtein(a: readonly string[], b: readonly string[]): number {
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  if (short.length === 0) return long.length;
  let prev = Array.from({ length: short.length + 1 }, (_, j) => j);
  let curr = new Array<number>(short.length + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= short.length; j += 1) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[short.length] ?? 0;
}

export function levenshteinRatio(a: string, b: string): number {
  const ar = Array.from(a);
  const br = Array.from(b);
  if (ar.length === 0 && br.length === 0) return 1;
  return 1 - levenshtein(ar, br) / Math.max(ar.length, br.length);
}

/** Crit's `anchorSimilar`: close enough to treat an edited line as the same line. */
export function anchorSimilar(candidate: string, anchor: string): boolean {
  const a = candidate.trim();
  const b = anchor.trim();
  if (a === b) return true;
  if (a === "" || b === "") return false;
  const [shorter, longer] = Buffer.byteLength(b) < Buffer.byteLength(a) ? [b, a] : [a, b];
  if (Buffer.byteLength(shorter) >= 8 && (longer.includes(shorter) || oneMiddleCut(shorter, longer))) return true;
  return levenshteinRatio(a, b) >= 0.7;
}

/** Crit's `remapLines`: through the map, falling back to the old numbers, clamped to [1, maxLine]. */
export function remapLines(lineMap: ReadonlyMap<number, number>, oldStart: number, oldEnd: number, maxLine: number): [number, number] {
  let start = lineMap.get(oldStart) ?? 0;
  let end = lineMap.get(oldEnd) ?? 0;
  if (start === 0) start = oldStart;
  if (end === 0) end = oldEnd;
  if (start > maxLine) start = maxLine;
  if (end > maxLine) end = maxLine;
  if (start < 1) start = 1;
  if (end < start) end = start;
  return [start, end];
}

export interface Position {
  startLine: number;
  endLine: number;
  drifted: boolean;
}

/** Crit's `verifyAndCorrectPosition`. */
export function verifyAndCorrectPosition(newLines: readonly string[], anchor: string, lcsStart: number, lcsEnd: number): Position {
  const length = anchor.split("\n").length;
  if (lcsStart >= 1 && lcsStart + length - 1 <= newLines.length) {
    const candidate = newLines.slice(lcsStart - 1, lcsStart + length - 1).join("\n");
    if (candidate === anchor || anchorSimilar(candidate, anchor)) {
      return { startLine: lcsStart, endLine: lcsStart + length - 1, drifted: false };
    }
  }
  const found = findAnchorInLines(newLines, anchor, lcsStart);
  if (found > 0) return { startLine: found, endLine: found + length - 1, drifted: false };
  return { startLine: lcsStart, endLine: lcsEnd, drifted: true };
}

/** Crit's `remapCommentPosition`: a comment without an anchor is never drifted. */
export function remapPosition(
  position: { startLine: number; endLine: number; anchor?: string | undefined },
  lineMap: ReadonlyMap<number, number>,
  newLines: readonly string[],
): Position {
  const maxLine = Math.max(newLines.length, 1);
  const [start, end] = remapLines(lineMap, position.startLine, position.endLine, maxLine);
  if (position.anchor === undefined || position.anchor === "") return { startLine: start, endLine: end, drifted: false };
  return verifyAndCorrectPosition(newLines, position.anchor, start, end);
}

/** Whether a comment moves with the work tree: a new-side line comment with lines. */
export function isMovable(comment: Movable): boolean {
  return (
    comment.scope === "line" &&
    comment.side !== "old" &&
    comment.path !== undefined &&
    comment.startLine !== undefined &&
    comment.endLine !== undefined
  );
}

/**
 * Every movable comment on `path`, moved from `previous` to `current`.
 * `current === null` means the file is gone: its comments stay put, drifted
 * when they carry an anchor. Returns whether anything changed.
 */
export function reanchorComments(comments: Movable[], path: string, previous: string, current: string | null): boolean {
  const targets = comments.filter((comment) => comment.path === path && isMovable(comment));
  if (targets.length === 0) return false;
  let changed = false;
  if (current === null) {
    for (const comment of targets) {
      const drifted = comment.anchor !== undefined && comment.anchor !== "";
      if (comment.drifted !== drifted) {
        comment.drifted = drifted;
        changed = true;
      }
    }
    return changed;
  }
  if (previous === current) return false;
  const lineMap = computeLineMap(previous, current);
  const newLines = splitLines(current);
  for (const comment of targets) {
    const startLine = comment.startLine ?? 1;
    const endLine = comment.endLine ?? startLine;
    const result = remapPosition({ startLine, endLine, anchor: comment.anchor }, lineMap, newLines);
    if (result.startLine !== comment.startLine || result.endLine !== comment.endLine || result.drifted !== comment.drifted) {
      comment.startLine = result.startLine;
      comment.endLine = result.endLine;
      comment.drifted = result.drifted;
      changed = true;
    }
  }
  return changed;
}

/**
 * For content that has not changed since the last anchoring: re-checks the
 * anchors where the comments already are, which only ever clears drift set
 * while the file was gone. Returns whether anything changed.
 */
export function reverifyComments(comments: Movable[], path: string, content: string): boolean {
  const newLines = splitLines(content);
  let changed = false;
  for (const comment of comments) {
    if (comment.path !== path || !isMovable(comment) || !comment.drifted) continue;
    if (comment.anchor === undefined || comment.anchor === "") {
      comment.drifted = false;
      changed = true;
      continue;
    }
    const start = comment.startLine ?? 1;
    const next = verifyAndCorrectPosition(newLines, comment.anchor, start, comment.endLine ?? start);
    if (!next.drifted) {
      comment.startLine = next.startLine;
      comment.endLine = next.endLine;
      comment.drifted = false;
      changed = true;
    }
  }
  return changed;
}

/** The text of lines `start..end` (1-based, inclusive), what a new comment anchors on. */
export function captureAnchor(content: string, startLine: number, endLine: number): string | undefined {
  const lines = splitLines(content);
  if (startLine < 1 || startLine > lines.length) return undefined;
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join("\n");
}
