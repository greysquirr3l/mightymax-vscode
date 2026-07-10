/**
 * T19 stream-pump tests.
 *
 * The pump is the only piece of `ChatProvider` that consumes
 * MiniMax stream events and produces host-facing parts. The
 * four invariants below are exactly the T19 spec's "always-flush
 * on every terminal path" requirements:
 *
 *   - `finishReason === 'tool_calls'` flushes accumulator.
 *   - `finishReason === 'stop'` after tool calls flushes
 *     accumulator (the most-missed branch in the previous code).
 *   - Stream-end with no finish marker (abandonment) flushes.
 *   - Mid-stream transport error flushes BEFORE rethrowing.
 *
 * Plus the "no `__minimax_usage__:` text leak" invariant from T22.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import {
  pumpProviderStream,
  type StreamPumpDeps,
} from './stream-pump.js';

function makeProgress() {
  const parts: unknown[] = [];
  return {
    parts,
    progress: {
      report: (p: unknown) => parts.push(p),
    } as unknown as StreamPumpDeps['progress'],
  };
}

function asyncIterable<T>(records: ReadonlyArray<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () => {
          const index = i;
          i += 1;
          return index < records.length
            ? Promise.resolve({ value: records[index], done: false } as IteratorResult<T>)
            : Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
        },
      };
    },
  };
}

describe('pumpProviderStream — finishReason flush paths', () => {
  it('flushes the accumulator with finishReason=tool_calls', async () => {
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        {
          toolCallDelta: { index: 0, id: 'call_a', name: 'noop', argumentsDelta: '{}' },
        },
        { finishReason: 'tool_calls' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    const result = await pumpProviderStream(deps);
    strictEqual(result.toolCallIds.length, 1);
    const tools = progress.parts.filter(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { constructor: { name: string } }).constructor.name === 'LanguageModelToolCallPart',
    );
    // The host-free test harness exposes LanguageModelToolCallPart as
    // a class; the test exits without it instantiable, so we look up
    // by struct shape instead.
    const callsReported = progress.parts.filter((p) => {
      const r = p as Record<string, unknown> | null;
      return (
        r !== null &&
        typeof r === 'object' &&
        'callId' in r &&
        (r as { callId: unknown }).callId === 'call_a'
      );
    });
    ok(tools.length + callsReported.length >= 1, 'tool-call part should be reported');
  });

  it('flushes the accumulator with finishReason=stop after a tool-call delta', async () => {
    // T19 invariant 4a — the most-missed branch in the previous
    // implementation. The model emits a tool_call then finishes
    // with `stop` instead of `tool_calls`. The accumulator must
    // still surface the partial call.
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        {
          toolCallDelta: {
            index: 0,
            id: 'call_stop',
            name: 'noop',
            argumentsDelta: '{}',
          },
        },
        { finishReason: 'stop' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    const result = await pumpProviderStream(deps);
    strictEqual(result.toolCallIds.length, 1, 'tool call flushed on stop');
    const callsReported = progress.parts.filter((p) => {
      const r = p as Record<string, unknown> | null;
      return (
        r !== null &&
        typeof r === 'object' &&
        'callId' in r &&
        (r as { callId: unknown }).callId === 'call_stop'
      );
    });
    ok(callsReported.length >= 1, 'tool-call part should be reported on stop');
  });

  it('flushes the accumulator when the stream ends with no finish marker (abandonment path)', async () => {
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        {
          toolCallDelta: {
            index: 0,
            id: 'call_stranded',
            name: 'noop',
            argumentsDelta: '{}',
          },
        },
        // No finishReason, no usage, no error — the stream just ends.
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    const result = await pumpProviderStream(deps);
    strictEqual(
      result.toolCallIds.length,
      1,
      'stranded tool call must be flushed on stream end',
    );
  });

  it('flushes the accumulator before rethrowing on a mid-stream transport error', async () => {
    // T19 invariant 4c — a mid-stream error AFTER a complete
    // tool call must NOT swallow the tool call. The pump
    // flushes BEFORE rethrowing.
    const progress = makeProgress();
    let onStreamErrorCalled = false;
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        {
          toolCallDelta: {
            index: 0,
            id: 'call_pre_error',
            name: 'noop',
            argumentsDelta: '{}',
          },
        },
        { error: { message: 'transport stalled', retriable: false } },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
      onStreamError: () => {
        onStreamErrorCalled = true;
      },
    };
    let threw = false;
    try {
      await pumpProviderStream(deps);
    } catch {
      threw = true;
    }
    ok(threw, 'pump must throw on mid-stream error');
    ok(onStreamErrorCalled, 'pump must invoke onStreamError before throwing');
    const callsReported = progress.parts.filter((p) => {
      const r = p as Record<string, unknown> | null;
      return (
        r !== null &&
        typeof r === 'object' &&
        'callId' in r &&
        (r as { callId: unknown }).callId === 'call_pre_error'
      );
    });
    ok(
      callsReported.length >= 1,
      'in-flight tool call must be flushed before the error',
    );
  });
});

describe('pumpProviderStream — never emits usage as chat text', () => {
  it('captures the text delta and rejects the `__minimax_usage__:` marker on the text lane', async () => {
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        { textDelta: 'done.' },
        {
          usage: { promptTokens: 100, completionTokens: 5, cacheReadTokens: 95 },
        },
        { finishReason: 'stop' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    const result = await pumpProviderStream(deps);
    strictEqual(result.text, 'done.');
    // T19 / T22 invariant: no usage text in the visible lane.
    for (const part of progress.parts) {
      const r = part as Record<string, unknown> | null;
      if (r !== null && typeof r === 'object' && 'value' in r) {
        ok(
          !String((r as { value: unknown }).value).includes('__minimax_usage__'),
          'usage text leaked into chat lane',
        );
      }
    }
  });
});

function noopLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
