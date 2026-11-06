/**
 * File contents for the continuous diff, fetched lazily and kept, so a
 * section scrolled back into view draws at once. Fetches run at most
 * `CONCURRENCY` at a time, nearest-first as callers ask; a request for a file
 * already in flight shares it. An entry is tagged with the refresh nonce it
 * was read at, and a newer nonce (the panel's poll saw the diff move) makes it
 * stale: a stale entry is still drawn while the fresh read runs.
 *
 * Module scope, so it outlives a panel remount (it is gone with the host
 * connection, which is fine: it is only a cache).
 */
export interface CachedFile<T> {
  value: T;
  nonce: number;
}

export const CONCURRENCY = 4;
const LIMIT = 400;

export class ContentsCache<T> {
  private readonly entries = new Map<string, CachedFile<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;

  constructor(private readonly concurrency = CONCURRENCY) {}

  get(key: string): CachedFile<T> | null {
    return this.entries.get(key) ?? null;
  }

  /** Whether `key` has an entry read at `nonce` or later. */
  fresh(key: string, nonce: number): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.nonce >= nonce;
  }

  set(key: string, value: T, nonce: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, nonce });
    // Oldest first out, so a long session over many compares does not grow without end.
    while (this.entries.size > LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Reads `key` through the queue unless a fresh entry or a running read exists. */
  load(key: string, nonce: number, fetch: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.nonce >= nonce) return Promise.resolve(entry.value);
    const running = this.inflight.get(`${key}#${nonce}`);
    if (running !== undefined) return running;
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.running += 1;
        fetch()
          .then((value) => {
            this.set(key, value, nonce);
            resolve(value);
          })
          .catch(reject)
          .finally(() => {
            this.running -= 1;
            this.inflight.delete(`${key}#${nonce}`);
            this.pump();
          });
      });
      this.pump();
    });
    this.inflight.set(`${key}#${nonce}`, promise);
    return promise;
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.queue.shift();
      if (next === undefined) return;
      next();
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
