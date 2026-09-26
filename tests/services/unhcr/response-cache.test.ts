/**
 * @fileoverview Tests for the in-memory LRU response cache: TTL through the
 * injected clock, least-recently-used eviction under the size budget, the
 * per-body ceiling, and the `0` budget that disables caching.
 * @module tests/services/unhcr/response-cache.test
 */

import { describe, expect, it } from 'vitest';
import { MAX_CACHED_BODY, ResponseCache } from '@/services/unhcr/response-cache.js';
import { envelope, POPULATION_ROWS } from '../../fixtures/unhcr.js';

const TTL = 6 * 60 * 60 * 1000;
const body = JSON.stringify(envelope(POPULATION_ROWS.slice(0, 2)));

/** A controllable clock. */
const clock = () => {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('ResponseCache', () => {
  it('serves a stored body until its TTL lapses', () => {
    const time = clock();
    const cache = new ResponseCache(1024 * 1024, TTL, time.now);
    cache.set('url-a', body);
    expect(cache.get('url-a')).toBe(body);
    time.advance(TTL - 1);
    expect(cache.get('url-a')).toBe(body);
    time.advance(1);
    expect(cache.get('url-a')).toBeUndefined();
  });

  it('frees an expired entry’s budget so a new body fits', () => {
    const time = clock();
    const cache = new ResponseCache(10, TTL, time.now);
    cache.set('a', '0123456789');
    time.advance(TTL);
    expect(cache.get('a')).toBeUndefined();
    cache.set('b', '01234');
    cache.set('c', '56789');
    expect(cache.get('b')).toBe('01234');
    expect(cache.get('c')).toBe('56789');
  });

  it('evicts the least recently used entry when the budget is full', () => {
    const cache = new ResponseCache(20, TTL, clock().now);
    cache.set('a', '0123456789');
    cache.set('b', '0123456789');
    expect(cache.get('a')).toBeDefined();
    cache.set('c', '0123456789');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('0123456789');
    expect(cache.get('c')).toBe('0123456789');
  });

  it('replaces an entry stored under the same key without double-counting it', () => {
    const cache = new ResponseCache(20, TTL, clock().now);
    cache.set('a', '0123456789');
    cache.set('a', 'abcdefghij');
    cache.set('b', '0123456789');
    expect(cache.get('a')).toBe('abcdefghij');
    expect(cache.get('b')).toBe('0123456789');
  });

  it('never stores a body larger than the budget or the per-body ceiling', () => {
    const small = new ResponseCache(5, TTL, clock().now);
    small.set('a', '0123456789');
    expect(small.get('a')).toBeUndefined();

    const large = new ResponseCache(MAX_CACHED_BODY * 2, TTL, clock().now);
    large.set('big', 'x'.repeat(MAX_CACHED_BODY + 1));
    expect(large.get('big')).toBeUndefined();
    large.set('edge', 'x'.repeat(MAX_CACHED_BODY));
    expect(large.get('edge')).toHaveLength(MAX_CACHED_BODY);
  });

  it('is disabled by a zero budget', () => {
    const cache = new ResponseCache(0, TTL, clock().now);
    cache.set('a', body);
    expect(cache.get('a')).toBeUndefined();
  });

  it('misses on an unknown key', () => {
    expect(new ResponseCache(100, TTL, clock().now).get('nope')).toBeUndefined();
  });
});
