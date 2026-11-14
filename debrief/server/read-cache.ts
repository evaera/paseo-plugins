/** A short-lived daemon read, shared until it settles, with backoff after a failure. */
export class ReadCache<T> {
  private cached: { value: T; until: number } | undefined;
  private pending: Promise<T> | undefined;
  private failure: { error: unknown; until: number } | undefined;
  private retryMs: number;

  constructor(private readonly ttlMs: number) {
    this.retryMs = ttlMs;
  }

  read(load: () => Promise<T>): Promise<T> {
    if (this.pending !== undefined) return this.pending;
    if (this.cached !== undefined && Date.now() < this.cached.until) return Promise.resolve(this.cached.value);
    if (this.failure !== undefined && Date.now() < this.failure.until) return Promise.reject(this.failure.error);
    const started = Date.now();
    // Keep the original operation in flight even if a caller stops waiting for it.
    this.pending = Promise.resolve().then(load).then(
      (value) => {
        const cooldown = Math.min(60_000, Math.max(this.ttlMs, (Date.now() - started) * 2));
        this.cached = { value, until: Date.now() + cooldown };
        this.failure = undefined;
        this.retryMs = this.ttlMs;
        return value;
      },
      (error: unknown) => {
        this.failure = { error, until: Date.now() + this.retryMs };
        this.retryMs = Math.min(this.retryMs * 2, 60_000);
        throw error;
      },
    ).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
}
