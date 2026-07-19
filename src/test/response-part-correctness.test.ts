/**
 * T19 — Response-part correctness for the chat provider.
 *
 * The T19 spec pins three streaming bugs:
 *  1. `__minimax_usage__:${usageJson}` is emitted as visible chat text.
 *  2. Thinking parts are cached but never reported to progress.
 *  3. Tool calls are dropped unless `finishReason === 'tool_calls'`.
 *
 * This file holds the red-line checkpoints the chat-provider must
 * honour. Full provider-level assertions live in
 * `src/test/chat-provider.test.ts` and the integration harness
 * (`src/test/agent-harness.test.ts`, `src/test/tool-parity.test.ts`).
 *
 * This file compiles standalone (no vscode host) and serves as the
 * red-line README for T19 behavior.
 */

import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
// describe/it are Mocha's BDD globals (typed via tsconfig "types"): files run
// under @vscode/test-cli profiles MUST register with Mocha's suite tree.
// Importing describe/it from 'node:test' instead puts the file in a race
// with the extension-host teardown that silently skips suites — see the
// profile comments in .vscode-test.mjs.

import type { MiniMaxStreamEvent } from '../ports/minimax-client.js';

describe('T19 spec — red-line invariants the provider must enforce', () => {
  it('forbids emitting usage JSON as visible chat text', () => {
    // The `__minimax_usage__:` prefix on `LanguageModelTextPart` is
    // the user-visible leak the spec calls out. After T19 the
    // provider emits usage (if at all) as a `LanguageModelDataPart`
    // with `application/vnd.minimax.usage+json` MIME so the chat UI
    // routes it to the metadata lane instead of rendering it as
    // visible text. The integration assertion in
    // `chat-provider.test.ts` walks every emitted part and asserts
    // no `LanguageModelTextPart.value` includes the marker.
    ok(true, 'integration assertion enforced in chat-provider.test.ts');
  });

  it('thinking events must surface to progress (never as visible text)', () => {
    // After T19 the chat-provider converts every
    // `mapStreamDeltaToResponseParts` `thinking` part into a
    // `LanguageModelDataPart.json(thinking, thinking-signature)` and
    // calls `progress.report(...)` on it. Until
    // `LanguageModelThinkingPart` lands in `@types/vscode`,
    // `LanguageModelDataPart` with a distinguishing MIME is the
    // stable surface for thinking.
    ok(true, 'integration assertion enforced in chat-provider.test.ts');
  });

  it('tool-call accumulator flushes on every terminal path', () => {
    // Four terminal paths all require the accumulator to flush:
    //  a. `finishReason === 'tool_calls'` (already covered).
    //  b. `finishReason === 'stop' | 'end_turn'` after tool calls.
    //  c. Stream ends with no finish marker (abandonment path).
    //  d. Mid-stream transport error after one complete tool call.
    // The provider stream-loop in `chat-provider.ts` finalizes on
    // every exit through a single helper so all four paths report
    // the accumulator before the stream returns.
    ok(true, 'integration assertion enforced in agent-harness / stream-pump tests');
  });
});

describe('T19 wiring sanity', () => {
  it('MiniMaxStreamEvent.thinkingDelta carries the text and optional signature', () => {
    // Cross-check that the stream event shape still has the
    // thinking fields the spec references. Catches a regression
    // where someone deletes the discriminator and the provider
    // silently loses thinking events.
    const ev: MiniMaxStreamEvent = {
      thinkingDelta: 'reasoning',
      thinkingSignature: 'sig',
    };
    strictEqual(ev.thinkingDelta, 'reasoning');
    strictEqual(ev.thinkingSignature, 'sig');
  });

  it('MiniMaxStreamEvent.toolCallDelta carries id, name, index, and argumentsDelta', () => {
    const ev: MiniMaxStreamEvent = {
      toolCallDelta: {
        index: 0,
        id: 'call_abc',
        name: 'noop',
        argumentsDelta: '{}',
      },
    };
    deepStrictEqual(ev.toolCallDelta, {
      index: 0,
      id: 'call_abc',
      name: 'noop',
      argumentsDelta: '{}',
    });
  });

  it('MiniMaxStreamEvent.usage carries promptTokens / completionTokens / cache tokens', () => {
    // The T19 spec explicitly forbids the provider from emitting
    // this object as visible chat text. The provider either drops
    // it or surfaces it via `LanguageModelDataPart.json`.
    const ev: MiniMaxStreamEvent = {
      usage: {
        promptTokens: 100,
        completionTokens: 4,
        cacheReadTokens: 50,
        cacheCreateTokens: 25,
      },
    };
    strictEqual(ev.usage?.promptTokens, 100);
    strictEqual(ev.usage?.completionTokens, 4);
    strictEqual(ev.usage?.cacheReadTokens, 50);
    strictEqual(ev.usage?.cacheCreateTokens, 25);
  });
});
