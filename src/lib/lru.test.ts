/**
 * Domain unit tests for `LruMap`.
 */

import { equal, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LruMap } from './domain/lru.js';

describe('LruMap', () => {
  it('throws on a non-positive capacity', () => {
    let threw = false;
    try {
      new LruMap<string, number>(0);
    } catch (err) {
      threw = err instanceof RangeError;
    }
    ok(threw, 'expected RangeError for capacity 0');
  });

  it('returns undefined for a missing key', () => {
    const cache = new LruMap<string, number>(4);
    equal(cache.get('missing'), undefined);
    equal(cache.has('missing'), false);
  });

  it('inserts and reads a key', () => {
    const cache = new LruMap<string, number>(4);
    cache.set('a', 1);
    equal(cache.get('a'), 1);
    equal(cache.size, 1);
  });

  it('evicts the oldest key when at capacity', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    equal(cache.has('a'), false, 'a should be evicted');
    equal(cache.has('b'), true);
    equal(cache.has('c'), true);
    equal(cache.size, 2);
  });

  it('updating an existing key does not grow the map', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11);
    equal(cache.get('a'), 11);
    equal(cache.size, 2);
  });

  it('promotes a touched key to most-recent', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.touch('a');
    // Insert a third key — the new key evicts b (the oldest), not a.
    cache.set('c', 3);
    equal(cache.has('a'), true, 'a was touched and should not be evicted');
    equal(cache.has('b'), false, 'b was oldest and should be evicted');
    equal(cache.has('c'), true);
  });

  it('touch returns the value when present and undefined when missing', () => {
    const cache = new LruMap<string, number>(2);
    equal(cache.touch('a'), undefined);
    cache.set('a', 1);
    equal(cache.touch('a'), 1);
  });

  it('delete removes a key', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    equal(cache.delete('a'), true);
    equal(cache.has('a'), false);
    equal(cache.delete('a'), false);
  });

  it('clear empties the map', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    equal(cache.size, 0);
    equal(cache.has('a'), false);
  });

  it('survives 1000 inserts at capacity=10 with the most-recent 10 keys intact', () => {
    const cache = new LruMap<number, number>(10);
    for (let i = 0; i < 1000; i += 1) {
      cache.set(i, i);
    }
    equal(cache.size, 10);
    for (let i = 0; i < 990; i += 1) {
      equal(cache.has(i), false, `expected ${i} to be evicted`);
    }
    for (let i = 990; i < 1000; i += 1) {
      equal(cache.get(i), i, `expected ${i} to survive`);
    }
  });
});
