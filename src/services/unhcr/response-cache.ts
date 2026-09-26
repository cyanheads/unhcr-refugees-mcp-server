/**
 * @fileoverview In-memory LRU cache of single-page UNHCR response bodies, keyed
 * by canonical request URL, with a per-entry TTL and a total size budget.
 * UNHCR publishes new figures twice a year and supports no conditional GET, so
 * a cached page is served until its TTL lapses. Sizes are measured in UTF-16
 * code units, which equal bytes for the ASCII JSON the API returns.
 * @module services/unhcr/response-cache
 */

/** Largest single body the cache holds (a 10,000-row page is ~2.8 MB). */
export const MAX_CACHED_BODY = 4 * 1024 * 1024;

interface Entry {
  body: string;
  storedAt: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();
  private size = 0;

  /**
   * @param maxSize Total budget; `0` disables the cache.
   * @param ttlMs Lifetime of one entry.
   * @param now Clock, injectable for tests.
   */
  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  /** Return a fresh body and mark it most recently used, or `undefined`. */
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.size -= entry.body.length;
      return;
    }
    this.entries.set(key, entry);
    return entry.body;
  }

  /** Store a body, evicting least recently used entries until it fits. */
  set(key: string, body: string): void {
    if (body.length > MAX_CACHED_BODY || body.length > this.maxSize) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.size -= previous.body.length;
    }
    for (const [oldest, entry] of this.entries) {
      if (this.size + body.length <= this.maxSize) break;
      this.entries.delete(oldest);
      this.size -= entry.body.length;
    }
    this.entries.set(key, { body, storedAt: this.now() });
    this.size += body.length;
  }
}
