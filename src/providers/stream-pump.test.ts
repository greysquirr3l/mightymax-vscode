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
 *
 * `stream-pump.ts` imports `vscode` transitively, so — like
 * `chat-provider.test.ts` — this file is not run by the `unit`
 * @vscode/test-cli profile; it runs via
 * `scripts/run-vscode-stub-tests.cjs` (see `npm run test:unit`).
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { pumpProviderStream, type StreamPumpDeps } from './stream-pump.js';

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
    strictEqual(result.toolCallIds.length, 1, 'stranded tool call must be flushed on stream end');
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
    ok(callsReported.length >= 1, 'in-flight tool call must be flushed before the error');
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

// ─────────────────────────────────────────────────────────────────────────────
// T26 (issue #46): usage surfaces as a `LanguageModelDataPart`
// with the `'usage'` MIME type — matching the convention used by
// VS Code's built-in Copilot BYOK providers. This makes the usage
// visible to any extension consuming our response stream and
// future-proofs us if/when VS Code adds a native decode for
// provider-stream usage data parts.
// ─────────────────────────────────────────────────────────────────────────────

describe('pumpProviderStream — T26 usage data part', () => {
  it('emits a LanguageModelDataPart with mimeType="usage" carrying the usage JSON', async () => {
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        { textDelta: 'hi' },
        {
          usage: {
            promptTokens: 42,
            completionTokens: 7,
            cacheReadTokens: 11,
            cacheCreateTokens: 0,
          },
        },
        { finishReason: 'stop' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    await pumpProviderStream(deps);

    const usageParts = progress.parts.filter(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { constructor?: { name?: string } }).constructor?.name === 'LanguageModelDataPart' &&
        (p as { mimeType?: unknown }).mimeType === 'usage',
    );
    strictEqual(usageParts.length, 1, 'expected exactly one usage data part');

    const usage = usageParts[0] as {
      data: Uint8Array;
      mimeType: string;
    };
    strictEqual(usage.mimeType, 'usage');
    const decoded = JSON.parse(new TextDecoder().decode(usage.data)) as {
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
    };
    strictEqual(decoded.promptTokens, 42);
    strictEqual(decoded.completionTokens, 7);
    strictEqual(decoded.cacheReadTokens, 11);
    strictEqual(decoded.cacheCreateTokens, 0);
  });

  it('coerces undefined cache fields to 0 (T26 invariant)', async () => {
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        {
          usage: { promptTokens: 1, completionTokens: 1 },
        },
        { finishReason: 'stop' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    await pumpProviderStream(deps);

    const usagePart = progress.parts.find(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { constructor?: { name?: string } }).constructor?.name === 'LanguageModelDataPart' &&
        (p as { mimeType?: unknown }).mimeType === 'usage',
    );
    ok(usagePart, 'expected a usage data part');
    const decoded = JSON.parse(
      new TextDecoder().decode((usagePart as unknown as { data: Uint8Array }).data),
    ) as { cacheReadTokens: number; cacheCreateTokens: number };
    strictEqual(decoded.cacheReadTokens, 0);
    strictEqual(decoded.cacheCreateTokens, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T27 (verbose thinking): M3 thinking surfaces as a
// `LanguageModelThinkingPart` on VS Code 1.128+, and falls back
// to `LanguageModelDataPart(application/vnd.minimax.thinking+json)`
// on hosts where the proposed API isn't yet available (VS Code
// 1.125–1.127 upgrade window). Either way, the LRU replay
// accumulator (`currentThinking` in the pump scope) still gets
// the signature for Anthropic wire replay.
// ─────────────────────────────────────────────────────────────────────────────

describe('pumpProviderStream — T27 thinking surface', () => {
  it('emits a LanguageModelThinkingPart when the constructor is present', async () => {
    // The stub already exposes LanguageModelThinkingPart; this
    // test asserts the happy path so a regression in the
    // primary surface is caught.
    const progress = makeProgress();
    const deps: StreamPumpDeps = {
      events: asyncIterable([
        { thinkingDelta: 'planning the next step' },
        { thinkingSignature: 'sig_xyz' },
        { textDelta: 'On it.' },
        { finishReason: 'stop' },
      ]),
      progress: progress.progress,
      thinkingStyle: 'anthropic',
      logger: noopLogger(),
      recordToolUsage: () => undefined,
    };
    await pumpProviderStream(deps);

    const thinkingParts = progress.parts.filter(
      (p): p is { value: string | string[]; metadata?: { signature?: string } } =>
        (p as { constructor?: { name?: string } }).constructor?.name ===
        'LanguageModelThinkingPart',
    );
    strictEqual(thinkingParts.length, 2);
    const deltaPart = thinkingParts[0];
    const signaturePart = thinkingParts[1];
    ok(deltaPart, 'expected a delta thinking part');
    ok(signaturePart, 'expected a signature thinking part');
    strictEqual(deltaPart.value, 'planning the next step');
    deepStrictEqual(deltaPart.metadata, {});
    strictEqual(signaturePart.value, '');
    deepStrictEqual(signaturePart.metadata, { signature: 'sig_xyz' });
  });

  it('falls back to LanguageModelDataPart when LanguageModelThinkingPart is missing', async () => {
    // Simulate VS Code < 1.128 by deleting the proposed-API
    // constructor from the underlying stub exports. The
    // stream-pump must fall back to the JSON data-part surface
    // (the pre-T27 behavior) instead of silently dropping the
    // thinking.
    //
    // We mutate the source exports object directly: `__importStar`
    // in the compiled chat-provider/stream-pump wrappers reads
    // each property lazily from the source, so deleting here
    // makes the wrappers see `undefined` too.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stubExports = require('vscode') as Record<string, unknown>;
    const ThinkingCtor = stubExports['LanguageModelThinkingPart'];
    delete stubExports['LanguageModelThinkingPart'];

    try {
      const progress = makeProgress();
      const deps: StreamPumpDeps = {
        events: asyncIterable([
          { thinkingDelta: 'planning the next step' },
          { thinkingSignature: 'sig_xyz' },
          { textDelta: 'On it.' },
          { finishReason: 'stop' },
        ]),
        progress: progress.progress,
        thinkingStyle: 'anthropic',
        logger: noopLogger(),
        recordToolUsage: () => undefined,
      };
      await pumpProviderStream(deps);

      // No LanguageModelThinkingPart on hosts without 1.128+.
      const thinkingParts = progress.parts.filter(
        (p) =>
          (p as { constructor?: { name?: string } }).constructor?.name ===
          'LanguageModelThinkingPart',
      );
      strictEqual(
        thinkingParts.length,
        0,
        'expected no LanguageModelThinkingPart on hosts without the proposed API',
      );

      // Two data-part emissions: one for the delta, one for the
      // standalone signature (each carrying the same JSON
      // payload as the pre-T27 stream).
      const dataParts = progress.parts.filter(
        (p) =>
          (p as { constructor?: { name?: string } }).constructor?.name ===
            'LanguageModelDataPart' &&
          (p as { mimeType?: unknown }).mimeType === 'application/vnd.minimax.thinking+json',
      );
      strictEqual(
        dataParts.length,
        2,
        'expected one delta data part and one signature data part on the fallback surface',
      );

      const [deltaPart, signaturePart] = dataParts as Array<{
        data: Uint8Array;
      }>;
      ok(deltaPart, 'expected a delta data part');
      ok(signaturePart, 'expected a signature data part');
      const decodedDelta = JSON.parse(new TextDecoder().decode(deltaPart.data)) as {
        thinking: string;
        signature?: string;
      };
      strictEqual(decodedDelta.thinking, 'planning the next step');
      strictEqual(
        decodedDelta.signature,
        undefined,
        'the delta data part should not carry a signature when the signature is its own chunk',
      );

      const decodedSignature = JSON.parse(new TextDecoder().decode(signaturePart.data)) as {
        thinking: string;
        signature?: string;
      };
      strictEqual(decodedSignature.thinking, '');
      strictEqual(decodedSignature.signature, 'sig_xyz');
    } finally {
      stubExports['LanguageModelThinkingPart'] = ThinkingCtor;
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
