/**
 * T40 — end-to-end: `mapRequestToMiniMax` bounds a long session.
 *
 * The domain pruner is unit-tested in `history-prune.test.ts`. This
 * file proves it is actually WIRED into the mapper, and that the
 * Anthropic-shaped output still has every `tool_result` paired with a
 * `tool_use` after pruning — the 2013 rejection being the whole
 * reason pruning is not a naive slice.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import { mapRequestToMiniMax } from './domain/messages.js';
import type { ChatMessage, MessageMappingError } from '../ports/message-mapping.js';

const MODEL = { id: 'MiniMax-M3', thinkingStyle: 'anthropic' as const };

/** Build a long alternating user/assistant/tool history. */
function longHistory(exchanges: number, resultChars: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', value: 'do the work' }] }];
  for (let i = 0; i < exchanges; i++) {
    msgs.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCall: {
            callId: `call_${i}`,
            name: 'read_file',
            input: { filePath: `/tmp/${i}` },
          },
        },
      ],
    });
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolResult: { callId: `call_${i}`, content: ['z'.repeat(resultChars)] },
        },
      ],
    });
  }
  return msgs;
}

describe('T40 — mapRequestToMiniMax bounds a long session', () => {
  it('leaves a short history untouched', () => {
    const msgs = longHistory(3, 100);
    const out = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 400_000 });
    strictEqual(out.messages.length > 0, true);
    ok(
      !out.warnings.some(
        (w: MessageMappingError) =>
          w.kind === 'unsupported-content' && w.reason.startsWith('history pruned'),
      ),
      'no pruning warning under budget',
    );
  });

  it('prunes an over-budget history and reports it', () => {
    // 40 exchanges x 4096 chars of result, well past the budget.
    const msgs = longHistory(40, 4096);
    const out = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 20_000 });
    const warned = out.warnings.find(
      (w: MessageMappingError) =>
        w.kind === 'unsupported-content' && w.reason.startsWith('history pruned'),
    );
    ok(warned !== undefined, 'pruning is surfaced as a mapping warning');
    ok(
      out.messages.length < msgs.length,
      `history must shrink (${String(msgs.length)} -> ${String(out.messages.length)})`,
    );
  });

  it('never leaves a tool_result without its tool_use after pruning', () => {
    // The load-bearing invariant. If pruning split an exchange,
    // Anthropic rejects the request with error 2013 — trading the
    // original 500 for a 400.
    const msgs = longHistory(40, 4096);
    const out = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 20_000 });
    const callIds = new Set<string>();
    for (const m of out.messages) {
      for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
    }
    const results = out.messages.filter((m) => m.role === 'tool');
    for (const r of results) {
      ok(
        callIds.has(r.toolCallId ?? ''),
        `tool result ${String(r.toolCallId)} has no tool_use — the request would 400`,
      );
    }
    ok(results.length > 0, 'sanity: the pruned history still carries results');
  });

  it('keeps the most recent exchange — the model must see the current turn', () => {
    const msgs = longHistory(40, 4096);
    const out = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 20_000 });
    const callIds = new Set<string>();
    for (const m of out.messages) {
      for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
    }
    ok(callIds.has('call_39'), 'the newest exchange must survive pruning');
  });

  it('keeps the original user request', () => {
    const msgs = longHistory(40, 4096);
    const out = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 20_000 });
    ok(
      out.messages.some((m) =>
        typeof m.content === 'string'
          ? m.content.includes('do the work')
          : m.content.some((p) => p.type === 'text' && p.text.includes('do the work')),
      ),
      'the opening request must never be pruned',
    );
  });

  it('respects a generous budget the user opted into', () => {
    // A user who raises the setting gets the behaviour they asked
    // for — the budget is a real knob, not a fixed cap.
    const msgs = longHistory(20, 4096);
    const tight = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 20_000 });
    const loose = mapRequestToMiniMax(MODEL, msgs, { historyMaxChars: 4_000_000 });
    ok(loose.messages.length > tight.messages.length, 'a larger budget must retain more history');
  });
});
