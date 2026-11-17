import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { CompactionCache, prefixKeys, renderTranscript } from './domain/compaction.js';
import { pruneHistory } from './domain/history-prune.js';
import type { MiniMaxWireMessage } from '../ports/minimax-client.js';

const user = (content: string): MiniMaxWireMessage => ({ role: 'user', content });
const assistant = (content: string): MiniMaxWireMessage => ({ role: 'assistant', content });

describe('CompactionCache', () => {
  it('finds the longest cached prefix of a grown dropped list', () => {
    const old = [user('a'), assistant('b')];
    const grown = [...old, user('c'), assistant('d')];
    const cache = new CompactionCache();
    const oldKeys = prefixKeys('m', old);
    cache.set(oldKeys[1] ?? '', 'summary of a,b');
    const hit = cache.find(prefixKeys('m', grown));
    deepStrictEqual(hit, { covered: 2, summary: 'summary of a,b' });
  });
  it('misses on a different model or content', () => {
    const cache = new CompactionCache();
    cache.set(prefixKeys('m', [user('a')])[0] ?? '', 's');
    strictEqual(cache.find(prefixKeys('other', [user('a')])), undefined);
    strictEqual(cache.find(prefixKeys('m', [user('b')])), undefined);
  });
  it('evicts the oldest entries beyond its cap', () => {
    const cache = new CompactionCache();
    for (let i = 0; i < 20; i++) cache.set(`k${String(i)}`, 's');
    strictEqual(cache.find(['k0']), undefined);
    ok(cache.find(['k19']) !== undefined);
  });
});

describe('renderTranscript', () => {
  it('labels roles and truncates long messages', () => {
    const out = renderTranscript([user('hi'), assistant('x'.repeat(5_000))]);
    ok(out.startsWith('USER: hi'));
    ok(out.includes('[truncated]'));
  });
});

describe('pruneHistory dropped list', () => {
  it('returns the dropped messages oldest first', () => {
    const msgs = [user('task'), assistant('A'.repeat(100)), user('B'.repeat(100)), assistant('tail')];
    const result = pruneHistory(msgs, { maxChars: 120 });
    strictEqual(result.dropped.length, result.droppedMessages);
    ok(result.droppedMessages > 0);
  });
});
