/**
 * Which of Mission Control's messages the user has not seen yet. Pure.
 *
 * A row's key is its timeline entry's sequence number (`rowKey`), so "seen"
 * is one number: the newest Mission Control message that was in view while the
 * user was looking. Only Mission Control's own messages count, never the
 * user's, a tool call or a notice.
 */
import type { TranscriptRow } from "./transcript-rows";

function seqOf(row: TranscriptRow): number | null {
  if (row.kind !== "coordinator") return null;
  const seq = Number(row.key);
  return Number.isFinite(seq) ? seq : null;
}

/** The newest Mission Control message's sequence number, or null before there is one. */
export function latestCoordinatorSeq(rows: readonly TranscriptRow[]): number | null {
  let latest: number | null = null;
  rows.forEach((row) => {
    const seq = seqOf(row);
    if (seq !== null && (latest === null || seq > latest)) latest = seq;
  });
  return latest;
}

/** The keys of Mission Control's messages after `seen`, oldest first. */
export function unreadKeys(rows: readonly TranscriptRow[], seen: number): string[] {
  return rows.flatMap((row) => {
    const seq = seqOf(row);
    return seq !== null && seq > seen ? [row.key] : [];
  });
}
