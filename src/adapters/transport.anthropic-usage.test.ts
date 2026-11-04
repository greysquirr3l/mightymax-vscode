/**
 * T42 — Anthropic-dialect usage events.
 *
 * The Anthropic-compatible endpoint reports usage in TWO records:
 *
 *   - `message_start` → `message.usage` carries the input side
 *     (`input_tokens`, `cache_read_input_tokens`,
 *     `cache_creation_input_tokens`) plus an initial `output_tokens`.
 *   - `message_delta` → `usage` carries the CUMULATIVE
 *     `output_tokens` for the turn.
 *
 * The transport used to stash the cache counters for its own
 * diagnostics and yield NOTHING, so the chat provider never saw a
 * usage event on the dialect every current model (M3, M3.1-Flash)
 * speaks. Everything downstream — the context-window widget, the
 * cache-hit telemetry, `recentTurnUsage` — was dead code on the
 * modern path.
 *
 * These tests pin the merge rules:
 *
 *   1. ONE usage event per turn, carrying the union of both records.
 *   2. Cache counters are cumulative snapshots, so a counter reported
 *      in BOTH records must NOT be summed (that would double-count).
 *   3. Usage is still surfaced when the server omits `message_delta`
 *      (proxies and some MiniMax deployments do), by falling back to
 *      the `message_stop` record.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import { MiniMaxClientAdapter } from './transport.js';
import type { Logger } from '../ports/logger.js';
import type { MiniMaxCompletionRequest, MiniMaxStreamEvent } from '../ports/minimax-client.js';

const ANTHROPIC_REQUEST: MiniMaxCompletionRequest = {
  model: 'MiniMax-M3',
  dialect: 'anthropic',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
};

function makeSilentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** Build a 200 SSE response from pre-serialized JSON records. */
function sseAnthropicResponse(records: ReadonlyArray<string>): Response {
  const body = records.map((record) => `data: ${record}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectEvents(
  events: AsyncIterable<MiniMaxStreamEvent>,
): Promise<ReadonlyArray<MiniMaxStreamEvent>> {
  const out: MiniMaxStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function adapterOver(records: ReadonlyArray<string>): MiniMaxClientAdapter {
  return new MiniMaxClientAdapter({
    baseUrl: () => 'https://api.minimax.io',
    fetchImpl: async () => sseAnthropicResponse(records),
  });
}

const MESSAGE_START = JSON.stringify({
  type: 'message_start',
  message: {
    id: 'msg_1',
    role: 'assistant',
    model: 'MiniMax-M3',
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 50,
      output_tokens: 1,
    },
  },
});

const TEXT_DELTA = JSON.stringify({
  type: 'content_block_delta',
  delta: { type: 'text_delta', text: 'hello' },
});

const MESSAGE_DELTA = JSON.stringify({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 42 },
});

const MESSAGE_STOP = JSON.stringify({ type: 'message_stop' });

describe('T42 — Anthropic-dialect usage events', () => {
  it('yields ONE merged usage event carrying the union of both records', async () => {
    const logger = makeSilentLogger();
    const adapter = adapterOver([MESSAGE_START, TEXT_DELTA, MESSAGE_DELTA, MESSAGE_STOP]);
    const signal = new AbortController().signal;

    const events = await collectEvents(
      adapter.streamCompletion(ANTHROPIC_REQUEST, 'test-key', signal, logger),
    );

    const usageEvents = events.filter((event) => event.usage !== undefined);
    strictEqual(usageEvents.length, 1, 'expected exactly one usage event for the turn');

    const usage = usageEvents[0]?.usage;
    ok(usage, 'expected a usage payload');
    // `promptTokens` is the TOTAL input the request consumed:
    // input_tokens + cache_read + cache_creation. This matches the
    // OpenAI dialect, where `prompt_tokens` includes cached tokens.
    strictEqual(usage.promptTokens, 950);
    strictEqual(usage.completionTokens, 42);
    strictEqual(usage.cacheReadTokens, 800);
    strictEqual(usage.cacheCreateTokens, 50);
  });

  it('does not double-count a cache counter reported in BOTH records', async () => {
    // Anthropic reports cumulative snapshots. A proxy that echoes the
    // cache counters on `message_delta` must not inflate them.
    const logger = makeSilentLogger();
    const adapter = adapterOver([
      MESSAGE_START,
      TEXT_DELTA,
      JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 42,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
        },
      }),
      MESSAGE_STOP,
    ]);
    const signal = new AbortController().signal;

    const events = await collectEvents(
      adapter.streamCompletion(ANTHROPIC_REQUEST, 'test-key', signal, logger),
    );

    const usage = events.find((event) => event.usage !== undefined)?.usage;
    ok(usage, 'expected a usage payload');
    strictEqual(usage.cacheReadTokens, 800, 'cache reads must not be summed across records');
    strictEqual(usage.cacheCreateTokens, 50, 'cache creates must not be summed across records');
    strictEqual(usage.promptTokens, 950, 'promptTokens must not double-count the cache');
  });

  it('still surfaces usage when the server omits message_delta', async () => {
    // Some deployments/proxies drop `message_delta`. The `message_stop`
    // record must still produce the usage event, carrying whatever
    // `message_start` reported.
    const logger = makeSilentLogger();
    const adapter = adapterOver([MESSAGE_START, TEXT_DELTA, MESSAGE_STOP]);
    const signal = new AbortController().signal;

    const events = await collectEvents(
      adapter.streamCompletion(ANTHROPIC_REQUEST, 'test-key', signal, logger),
    );

    const usageEvents = events.filter((event) => event.usage !== undefined);
    strictEqual(usageEvents.length, 1, 'expected a usage event from the message_stop fallback');
    const usage = usageEvents[0]?.usage;
    ok(usage, 'expected a usage payload');
    strictEqual(usage.promptTokens, 950);
    strictEqual(usage.cacheReadTokens, 800);
  });

  it('emits no usage event when the server reports no usage at all', async () => {
    // A server that says nothing about usage must not produce a
    // zero-valued usage event — the chat provider distinguishes
    // "no usage reported" from "zero tokens used".
    const logger = makeSilentLogger();
    const adapter = adapterOver([
      JSON.stringify({ type: 'message_start', message: { id: 'msg_1', role: 'assistant' } }),
      TEXT_DELTA,
      // A `message_delta` with NO `usage` block — the server
      // reported nothing about token accounting.
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      MESSAGE_STOP,
    ]);
    const signal = new AbortController().signal;

    const events = await collectEvents(
      adapter.streamCompletion(ANTHROPIC_REQUEST, 'test-key', signal, logger),
    );

    strictEqual(
      events.filter((event) => event.usage !== undefined).length,
      0,
      'expected no usage event when the server reported none',
    );
  });
});
