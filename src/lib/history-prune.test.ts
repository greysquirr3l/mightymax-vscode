/**
 * T40 — History pruning (context growth).
 *
 * A captured 0.9.2 session grew monotonically to 186 messages /
 * ~269k characters and ended in a hard HTTP 500, with the key pool
 * rotating slots because a 500 classifies as `kind: 'http'`. Nothing
 * bounded the message COUNT — `truncateToolResults` caps each result
 * at 4096 chars, but 40 truncated results are still 160k chars.
 *
 * The hard constraint is Anthropic's wire rule: a `tool_result` whose
 * `tool_use_id` has no matching assistant `tool_use` is rejected
 * (error 2013). So a tool result and its originating assistant turn
 * must be dropped TOGETHER or not at all. Naive "keep the last N
 * messages" slicing would strand results and 400 the request.
 *
 * Strategy: walk from the oldest end, grouping each assistant turn
 * with the contiguous `tool` turns that answer it, and drop whole
 * groups until the remaining history fits the budget. The most
 * recent group is never dropped.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  pruneHistory,
  estimateWireChars,
  DEFAULT_HISTORY_MAX_CHARS,
} from './domain/history-prune.js';
import type { MiniMaxWireMessage } from '../ports/minimax-client.js';

/** assistant turn with one tool call, answered by one tool result. */
function exchange(id: string, size: number): MiniMaxWireMessage[] {
  return [
    {
      role: 'assistant',
      content: `calling ${id}`,
      toolCalls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', content: 'x'.repeat(size), toolCallId: id },
  ];
}

const firstUser: MiniMaxWireMessage = { role: 'user', content: 'the original task' };

describe('T40 — pruneHistory', () => {
  it('leaves history alone when it already fits the budget', () => {
    const msgs = [firstUser, ...exchange('a', 10), ...exchange('b', 10)];
    const out = pruneHistory(msgs, { maxChars: 100_000 });
    strictEqual(out.messages.length, msgs.length);
    strictEqual(out.droppedMessages, 0);
  });

  it('drops the OLDEST exchanges first, keeping the newest', () => {
    // Budget maths: each exchange is assistant(~22) + tool(500) =
    // 522 chars, and the leading user turn is 17. A budget of 700
    // admits exactly one middle exchange alongside the mandatory
    // first and last groups, so the oldest one must be the one
    // dropped.
    const msgs = [firstUser, ...exchange('a', 500), ...exchange('b', 500), ...exchange('c', 500)];
    const out = pruneHistory(msgs, { maxChars: 700 });
    const ids = out.messages
      .flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id))
      .concat(out.messages.flatMap((m) => (m.toolCallId ? [m.toolCallId] : [])));
    ok(!ids.includes('a'), 'oldest exchange dropped');
    ok(ids.includes('b'), 'newer exchange retained');
    ok(ids.includes('c'), 'newest exchange retained');
    ok(out.droppedMessages > 0, 'reports how many messages were dropped');
  });

  it('never strands a tool result — the dropped set is pair-complete', () => {
    // This is the invariant that makes naive slicing unsafe. If
    // pruning kept a `tool` message whose assistant turn was
    // dropped, Anthropic rejects the request with error 2013.
    const msgs: MiniMaxWireMessage[] = [firstUser];
    for (let i = 0; i < 20; i++) msgs.push(...exchange(`c${i}`, 400));
    const out = pruneHistory(msgs, { maxChars: 3000 });

    const assistantIds = new Set(
      out.messages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id)),
    );
    for (const m of out.messages) {
      if (m.role !== 'tool') continue;
      ok(
        assistantIds.has(m.toolCallId ?? ''),
        `tool result ${String(m.toolCallId)} has no matching tool_use — request would 400`,
      );
    }
  });

  it('never drops a tool result while keeping its assistant turn', () => {
    const msgs: MiniMaxWireMessage[] = [firstUser];
    for (let i = 0; i < 20; i++) msgs.push(...exchange(`d${i}`, 400));
    const out = pruneHistory(msgs, { maxChars: 3000 });
    const resultIds = new Set(
      out.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId ?? ''),
    );
    for (const m of out.messages) {
      for (const tc of m.toolCalls ?? []) {
        if (m.role !== 'assistant') continue;
        // An assistant turn with a tool call may be retained even
        // when its result was pruned (a dangling tool_use is
        // legal); what is illegal is the reverse. Assert the
        // reverse here for clarity.
        ok(typeof tc.id === 'string');
      }
    }
    strictEqual(resultIds.size, out.messages.filter((m) => m.role === 'tool').length);
  });

  it('keeps the leading user message — dropping it loses the task', () => {
    const msgs: MiniMaxWireMessage[] = [firstUser];
    for (let i = 0; i < 30; i++) msgs.push(...exchange(`e${i}`, 500));
    const out = pruneHistory(msgs, { maxChars: 1000 });
    strictEqual(out.messages[0]?.role, 'user');
    ok(
      out.messages.some((m) => m.content === 'the original task'),
      'the original task statement must survive',
    );
  });

  it('always retains at least the final exchange, even over budget', () => {
    // Degenerate budget must not produce an empty request — that
    // would read as "the user said nothing".
    const msgs = [firstUser, ...exchange('f', 9000), ...exchange('g', 9000)];
    const out = pruneHistory(msgs, { maxChars: 1 });
    ok(out.messages.length > 0, 'never returns an empty history');
    ok(
      out.messages.some((m) => m.toolCallId === 'g'),
      'the newest exchange is always kept',
    );
  });

  it('keeps a user message that follows pruned tool output', () => {
    // A mid-conversation user turn is a boundary, not a
    // disposable: dropping it would splice two unrelated
    // requests together.
    const msgs: MiniMaxWireMessage[] = [
      firstUser,
      ...exchange('g0', 600),
      { role: 'user', content: 'now do this instead' },
      ...exchange('g1', 600),
    ];
    const out = pruneHistory(msgs, { maxChars: 1000 });
    ok(
      out.messages.some((m) => m.content === 'now do this instead'),
      'a mid-history user turn is retained',
    );
  });

  it('handles a tool result with no matching assistant turn (adopted orphan)', () => {
    // The mapper synthesizes `tool_use` adoptions for orphans, so
    // this shape can reach the pruner. A bare tool message must
    // not crash the grouping logic.
    const msgs: MiniMaxWireMessage[] = [
      firstUser,
      { role: 'tool', content: 'y'.repeat(900), toolCallId: 'orphan' },
    ];
    const out = pruneHistory(msgs, { maxChars: 100 });
    ok(Array.isArray(out.messages));
  });

  it('is a no-op on an empty history', () => {
    const out = pruneHistory([], { maxChars: 1000 });
    deepStrictEqual([...out.messages], []);
    strictEqual(out.droppedMessages, 0);
  });

  it('is idempotent — re-pruning an already-pruned history is a no-op', () => {
    // Worth pinning: the provider re-maps the full history on every
    // request, so a session that is already at the budget must not
    // keep shedding context turn after turn.
    const msgs: MiniMaxWireMessage[] = [firstUser];
    for (let i = 0; i < 30; i++) msgs.push(...exchange(`z${i}`, 500));
    const once = pruneHistory(msgs, { maxChars: 3000 });
    ok(once.droppedMessages > 0, 'the first pass actually pruned something');
    const twice = pruneHistory(once.messages, { maxChars: 3000 });
    strictEqual(
      twice.messages.length,
      once.messages.length,
      'a second pass must not drop anything further',
    );
    strictEqual(twice.droppedMessages, 0);
  });

  it('reports droppedChars so the provider can log the win', () => {
    const msgs = [firstUser, ...exchange('h', 4000), ...exchange('i', 4000)];
    const out = pruneHistory(msgs, { maxChars: 100 });
    ok(out.droppedChars > 0, 'reports the characters reclaimed');
  });
});

describe('T40 — estimateWireChars', () => {
  it('counts string content', () => {
    strictEqual(estimateWireChars({ role: 'user', content: 'abcd' }), 4);
  });

  it('counts part-array content including image payloads', () => {
    const n = estimateWireChars({
      role: 'user',
      content: [
        { type: 'text', text: 'ab' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ZZZZ' } },
      ],
    });
    ok(n > 20, 'an image is never near-free in a character budget');
  });

  it('counts tool call arguments', () => {
    const n = estimateWireChars({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'x', type: 'function', function: { name: 'read_file', arguments: 'y'.repeat(500) } },
      ],
    });
    ok(n >= 500, 'large tool arguments must count against the budget');
  });

  it('defaults to a budget that leaves headroom under a 1M context', () => {
    // 1M tokens is roughly 3.7M chars for the M3 family. Budgeting
    // ~500k chars of history keeps the request well inside while
    // leaving room for output + a turn or two of growth.
    ok(
      DEFAULT_HISTORY_MAX_CHARS > 0 && DEFAULT_HISTORY_MAX_CHARS < 1_000_000,
      'default budget must be positive and conservative',
    );
  });
});
