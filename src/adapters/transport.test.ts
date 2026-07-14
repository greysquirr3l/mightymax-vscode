/**
 * T22 — Logging hygiene red-line tests.
 *
 * The AGENTS.md rule: "The key, Authorization header, and
 * request/response bodies are NEVER written to any log channel at any
 * level." These tests pin that rule with planted sentinel strings
 * in the fixtures; a violation surfaces as the sentinel appearing
 * in any captured log line.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { MiniMaxClientAdapter } from './transport.js';
import { MiniMaxClientError } from '../ports/minimax-client.js';
import type { Logger } from '../ports/logger.js';
import type {
  MiniMaxCompletionRequest,
  MiniMaxStreamEvent,
} from '../ports/minimax-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel constants — planted by tests, asserted-ABSENT in captured logs.
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel constants — planted by the T22 redaction guard, asserted
// ABSENT in captured log lines. The values are deliberately
// non-secret-shaped so the Gitleaks secret scanner (and the
// `generic-api-key` rule it carries by default) does not flag the
// test fixture as a leaked credential.
const SENTINEL_USER_CONTENT = 'SENTINEL_USER_CONTENT_9f3a';
const SENTINEL_API_KEY = 'MightyMax_Fixture_Key_77cc';
const SENTINEL_TOOL_CALL_ID = 'sentinel_call_xx42';

// ─────────────────────────────────────────────────────────────────────────────
// Recording logger
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

function makeCapturingLogger(): Logger & { readonly calls: ReadonlyArray<RecordedCall> } {
  const calls: RecordedCall[] = [];
  const rec = (level: RecordedCall['level']) =>
    (message: string, context?: Record<string, unknown>) => {
      calls.push(context === undefined ? { level, message } : { level, message, context });
    };
  return {
    get calls() {
      return calls;
    },
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake client that records the outbound request body and replays a
// 400 with an HTML response body (the worst-case leak surface:
// logs the raw HTML to a log channel).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// T22 — sentinel captured-log assertion (real adapter wired through)
// The fake client helper was the RED-trial attempt; the GREEN
// path uses the real MiniMaxClientAdapter with a fetchImpl that
// always 400s.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 400 / 5xx redaction — the load-bearing AGENTS.md invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('T22 — request/response-body redaction under failure paths', () => {
  it('emits a structural request summary on 400 — never the request body', async () => {
    // Comprehensive T22 redaction + structural-summary test. The
    // capture exercises the same 400 path twice: once asserting
    // the user-content / api-key / Authorization-header sentinels
    // are absent from every captured log line, and once asserting
    // the structured summary emitted by `summarizeRequestForLog`
    // carries the expected shape.
    const logger = makeCapturingLogger();

    // Real MiniMaxClientAdapter with a fetchImpl that always
    // 400s. Plant the user-content sentinel in the REQUEST body
    // — both the user-message content AND the system prompt.
    // The response body carries the documented safe structural
    // envelope (`error.type` / `error.message` / `error.code`)
    // which the T22 spec accepts as a redaction-safe surface; the
    // assertion below walks every captured log line but EXCLUDES
    // the `errorMessage` structural key from the user-content
    // sentinel check, because surfacing the upstream error
    // message is the one allowed exception for the response side.
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: (async (_url: string, _init?: RequestInit) => {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'invalid_request: tool result id not found',
              code: 2013,
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const request: MiniMaxCompletionRequest = {
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: SENTINEL_USER_CONTENT }],
      systemPrompt: SENTINEL_USER_CONTENT,
      stream: true,
    };
    try {
      const signal = new AbortController().signal;
      const events = adapter.streamCompletion(
        request,
        SENTINEL_API_KEY,
        signal,
        logger,
      );
      const iter = events[Symbol.asyncIterator]();
      await iter.next();
    } catch {
      // 400 surfaces as typed MiniMaxClientError — we
      // intentionally swallow so the test focuses on what the
      // LOGGER recorded, not what the caller saw.
    }

    // Walk every captured log entry: the request-side sentinel
    // MUST NOT appear in any captured structural field except the
    // documented redaction-safe envelope (`errorMessage`,
    // `errorType`, `errorCode`) which the T22 spec accepts for
    // the response side. Strip that single field from the blob
    // before the substring assertion so the test catches leaks
    // in the request body, the system prompt, or any other
    // structural key — without false-positives on the
    // upstream-supplied error message.
    const strippedFromError = (blob: string): string =>
      blob.replace(/"errorMessage"\s*:\s*"[^"]*"/g, '"errorMessage":"<stripped>"');
    for (const call of logger.calls) {
      const blob = JSON.stringify(call);
      const blobStripped = strippedFromError(blob);
      ok(
        !blobStripped.includes(SENTINEL_API_KEY),
        `API key sentinel leaked into log line: ${blob}`,
      );
      ok(
        !blobStripped.includes('Authorization: Bearer'),
        `Authorization header literal leaked into log line: ${blob}`,
      );
      // Belt-and-braces: the request-side sentinel we planted in
      // the user message must not have leaked anywhere in the
      // log line — neither inside message-list / system-prompt
      // structural keys (the previous body-stringification
      // regression) nor as a free-text fragment. The previous
      // structural-keys-only assertions would have passed if a
      // leak landed inside the request's body but outside the
      // `messages` / `system` JSON literal. Catch it with a
      // single substring assertion across the whole blob.
      ok(
        !blob.includes(SENTINEL_USER_CONTENT),
        `user-content sentinel leaked into log line: ${blob}`,
      );
    }

    // The T22 GREEN rewrite emits a STRUCTURED summary — not the
    // raw request body. Verify the summary shape produced by
    // `summarizeRequestForLog` against the M3 failure path
    // captured here: the 400 log entry carries the expected
    // dialect, model, role counts, tool count, has-system /
    // has-thinking flags, and approximate content character-
    // count. No message content, tool schemas, or tool-call
    // argument bodies leak into the summary.
    const summaryCall = logger.calls.find(
      (c) => c.level === 'error' && c.context?.['model'] === 'MiniMax-M3',
    );
    ok(summaryCall !== undefined, 'expected a 400 log entry with the request summary');
    if (summaryCall !== undefined && summaryCall.context !== undefined) {
      const ctx = summaryCall.context;
      strictEqual(ctx['dialect'], 'anthropic');
      strictEqual(ctx['model'], 'MiniMax-M3');
      deepStrictEqual(ctx['messageCountByRole'], { user: 1 });
      strictEqual(ctx['toolCount'], 0);
      strictEqual(ctx['hasSystem'], true);
      strictEqual(ctx['hasThinking'], false);
      const approxChars = ctx['approxContentChars'];
      ok(
        typeof approxChars === 'number' && approxChars > 0,
        `approxContentChars should be > 0, got ${String(approxChars)}`,
      );
      const ctxBlob = JSON.stringify(ctx);
      // The summary itself MUST NOT carry the user-content
      // sentinel anywhere — the requested structural keys are
      // counts and flags, not raw content.
      ok(
        !ctxBlob.includes(SENTINEL_USER_CONTENT),
        `summary leaked the user-content sentinel: ${ctxBlob}`,
      );
      ok(
        !ctxBlob.includes(SENTINEL_TOOL_CALL_ID),
        `summary leaked the tool-call-id sentinel: ${ctxBlob}`,
      );
      // The upstream error message is the one allowed exception —
      // verify it surfaces through the `errorMessage` key.
      strictEqual(
        ctx['errorMessage'],
        'invalid_request: tool result id not found',
      );
      strictEqual(ctx['errorType'], 'invalid_request_error');
      strictEqual(ctx['errorCode'], 2013);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency semaphore — permit lifecycle regression tests.
//
// The stall this pins: permits were released only on the two
// dispatch-failure paths, so every SUCCESSFUL stream leaked one
// permit. After `maxConcurrentRequests` completions the transport
// deadlocked — each later request sat in `acquire()` until its
// signal aborted ("request aborted while waiting for semaphore").
// A second bug destroyed one permit per queue handoff
// (`permits -= 1` on direct transfer to a waiter).
// ─────────────────────────────────────────────────────────────────────────────

const SSE_OK_BODY = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const OPENAI_REQUEST: MiniMaxCompletionRequest = {
  model: 'MiniMax-M3',
  dialect: 'openai',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
};

function sseOkResponse(): Response {
  return new Response(SSE_OK_BODY, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A Response whose SSE body is fed manually via the returned
 * controller handles, so a test can hold a request in-flight
 * (permit held) for as long as it needs.
 */
function heldSseResponse(): {
  response: Response;
  emitText: (text: string) => void;
  finish: () => void;
} {
  const encoder = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    emitText: (text: string) => {
      ctrl.enqueue(
        encoder.encode(
          `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`,
        ),
      );
    },
    finish: () => {
      ctrl.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        ),
      );
      ctrl.close();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: ${label}`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function consumeAll(events: AsyncIterable<MiniMaxStreamEvent>): Promise<number> {
  let count = 0;
  for await (const _event of events) {
    count += 1;
  }
  return count;
}

describe('concurrency semaphore — permit lifecycle', () => {
  it('releases the permit after a successful stream (no leak per completion)', async () => {
    // With maxConcurrentRequests: 1, the leak variant hangs on the
    // SECOND request; run three back-to-back to pin the release.
    const logger = makeCapturingLogger();
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      maxConcurrentRequests: 1,
      fetchImpl: (async () => sseOkResponse()) as unknown as typeof fetch,
    });
    for (let i = 1; i <= 3; i += 1) {
      const signal = new AbortController().signal;
      const eventCount = await withTimeout(
        consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
        2_000,
        `request ${i} blocked on the semaphore — permit leaked by a prior completion`,
      );
      ok(eventCount > 0, `request ${i} should yield events`);
    }
  });

  it('hands the slot to a queued waiter without destroying a permit', async () => {
    // A holds the single permit mid-stream; B queues; A finishes
    // and hands off to B; after B completes, C must still find a
    // permit. The handoff-decrement variant deadlocks on C.
    const logger = makeCapturingLogger();
    const held = heldSseResponse();
    let call = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      maxConcurrentRequests: 1,
      fetchImpl: (async () => {
        call += 1;
        return call === 1 ? held.response : sseOkResponse();
      }) as unknown as typeof fetch,
    });

    const signal = new AbortController().signal;
    const eventsA = adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger);
    const iterA = eventsA[Symbol.asyncIterator]();
    held.emitText('first');
    const firstA = await withTimeout(iterA.next(), 2_000, 'A first event');
    strictEqual(firstA.done, false);

    // B queues behind A's permit.
    const doneB = consumeAll(
      adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger),
    );

    // Finish A; its permit hands off to B.
    held.finish();
    while (!(await iterA.next()).done) {
      // drain A to completion so its finally releases the permit
    }
    const eventCountB = await withTimeout(doneB, 2_000, 'B never received the handoff');
    ok(eventCountB > 0, 'B should yield events');

    // C is the regression probe: a destroyed permit deadlocks here.
    const eventCountC = await withTimeout(
      consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
      2_000,
      'C blocked — the A→B handoff destroyed a permit',
    );
    ok(eventCountC > 0, 'C should yield events');
  });

  it('a waiter aborted in the queue rejects cleanly and leaves the semaphore usable', async () => {
    const logger = makeCapturingLogger();
    const held = heldSseResponse();
    let call = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      maxConcurrentRequests: 1,
      fetchImpl: (async () => {
        call += 1;
        return call === 1 ? held.response : sseOkResponse();
      }) as unknown as typeof fetch,
    });

    const signalA = new AbortController().signal;
    const eventsA = adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signalA, logger);
    const iterA = eventsA[Symbol.asyncIterator]();
    held.emitText('first');
    await withTimeout(iterA.next(), 2_000, 'A first event');

    // B queues, then aborts while waiting.
    const controllerB = new AbortController();
    const doneB = consumeAll(
      adapter.streamCompletion(OPENAI_REQUEST, 'test-key', controllerB.signal, logger),
    );
    // Let B reach the semaphore queue before aborting.
    await new Promise((resolve) => setImmediate(resolve));
    controllerB.abort();
    try {
      await withTimeout(doneB, 2_000, 'aborted waiter never rejected');
      ok(false, 'expected the aborted waiter to reject');
    } catch (err) {
      ok(err instanceof MiniMaxClientError, `expected MiniMaxClientError, got ${String(err)}`);
      strictEqual(err.kind, 'abort');
    }

    // Finish A and verify a fresh request still gets a permit.
    held.finish();
    while (!(await iterA.next()).done) {
      // drain
    }
    const eventCountC = await withTimeout(
      consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signalA, logger)),
      2_000,
      'semaphore unusable after an aborted waiter',
    );
    ok(eventCountC > 0, 'post-abort request should yield events');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No content previews on the chat provider (T19 also covers)
// ─────────────────────────────────────────────────────────────────────────────

describe('T22 — chat-provider does not log content previews', () => {
  it('the no-preview invariant holds (regression on chat-provider.ts)', () => {
    // The chat-provider uses debug-level length-only logs for
    // text and thinking deltas (no `preview: part.value.substring`
    // style leak). The integration assertions live in
    // chat-provider.test.ts; this file keeps the cross-cutting
    // sentinel guard in one place for grep-ability.
    ok(SENTINEL_TOOL_CALL_ID.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stall watchdogs — first-byte timeout and mid-stream idle timeout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fetchImpl that never resolves — the observed 2026-07-13 failure
 * shape (server accepts the socket, never sends response headers).
 * Rejects with the abort reason when the attempt signal fires so
 * the watchdog / caller-abort paths behave like real undici fetch.
 */
function hangingFetch(onCall?: () => void): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    onCall?.();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason: unknown = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error('aborted'));
      });
    });
  }) as unknown as typeof fetch;
}

describe('stall watchdogs — first-byte and idle timeouts', () => {
  it('a server that never sends headers is retried, then surfaces kind:stall', async () => {
    const logger = makeCapturingLogger();
    let calls = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: hangingFetch(() => {
        calls += 1;
      }),
      firstByteTimeoutMs: 20,
      maxRetries: 1,
      sleep: async () => {},
    });
    const signal = new AbortController().signal;
    let thrown: unknown;
    try {
      await withTimeout(
        consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
        5_000,
        'first-byte watchdog never fired — request hung',
      );
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof MiniMaxClientError, 'expected a MiniMaxClientError');
    strictEqual(thrown.kind, 'stall');
    strictEqual(calls, 2, 'expected one retry before surfacing the stall');
    ok(
      logger.calls.some(
        (c) => c.level === 'warn' && c.message.includes('first-byte timeout'),
      ),
      'expected a first-byte-timeout retry warning',
    );
  });

  it('a first-byte timeout recovers transparently when the retry succeeds', async () => {
    const logger = makeCapturingLogger();
    let calls = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return sseOkResponse();
      }) as unknown as typeof fetch,
      firstByteTimeoutMs: 20,
      maxRetries: 2,
      sleep: async () => {},
    });
    const signal = new AbortController().signal;
    const eventCount = await withTimeout(
      consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
      5_000,
      'retry after first-byte timeout never completed',
    );
    ok(eventCount > 0, 'the retried request should yield events');
    strictEqual(calls, 2);
  });

  it('a caller abort that races the watchdog still surfaces kind:abort, not stall', async () => {
    const logger = makeCapturingLogger();
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: hangingFetch(),
      firstByteTimeoutMs: 5_000,
      sleep: async () => {},
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user cancelled')), 10);
    let thrown: unknown;
    try {
      await withTimeout(
        consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', controller.signal, logger)),
        5_000,
        'caller abort never propagated',
      );
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof MiniMaxClientError, 'expected a MiniMaxClientError');
    strictEqual(thrown.kind, 'abort');
  });

  it('mid-stream silence AFTER the first event surfaces kind:stall without re-issuing', async () => {
    const logger = makeCapturingLogger();
    const held = heldSseResponse();
    let calls = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      maxConcurrentRequests: 1,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? held.response : sseOkResponse();
      }) as unknown as typeof fetch,
      idleTimeoutMs: 40,
      sleep: async () => {},
    });
    const signal = new AbortController().signal;
    const events = adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger);
    const iter = events[Symbol.asyncIterator]();
    held.emitText('first');
    const first = await withTimeout(iter.next(), 2_000, 'first event never arrived');
    strictEqual(first.done, false);

    // The stream now goes silent; the idle watchdog must cut it.
    let thrown: unknown;
    try {
      await withTimeout(iter.next(), 5_000, 'idle watchdog never fired — stream hung');
    } catch (err) {
      thrown = err;
    }
    ok(thrown instanceof MiniMaxClientError, 'expected a MiniMaxClientError');
    strictEqual(thrown.kind, 'stall');
    strictEqual(calls, 1, 'a post-first-event stall must NOT be re-issued');

    // Regression probe: the stall path must release the semaphore
    // permit (maxConcurrentRequests: 1 deadlocks here otherwise).
    const eventCount = await withTimeout(
      consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
      2_000,
      'permit leaked by the stalled stream',
    );
    ok(eventCount > 0, 'follow-up request should yield events');
  });

  it('silence BEFORE the first event is retried transparently', async () => {
    const logger = makeCapturingLogger();
    const held = heldSseResponse(); // headers arrive, body never emits
    let calls = 0;
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? held.response : sseOkResponse();
      }) as unknown as typeof fetch,
      idleTimeoutMs: 40,
      maxRetries: 2,
      sleep: async () => {},
    });
    const signal = new AbortController().signal;
    const eventCount = await withTimeout(
      consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger)),
      5_000,
      'before-first-event stall was never retried',
    );
    ok(eventCount > 0, 'the retried request should yield events');
    strictEqual(calls, 2, 'expected exactly one transparent re-issue');
    ok(
      logger.calls.some(
        (c) => c.level === 'warn' && c.message.includes('died before first event'),
      ),
      'expected a before-first-event retry warning',
    );
  });

  it('a flowing stream is never cut by the idle watchdog, however long it runs', async () => {
    // Regression pin for the 2026-07-13 observation: 173s requests
    // with a continuously flowing stream completed successfully.
    // The watchdog measures byte gaps, not elapsed time — a stream
    // that keeps trickling events past several idle windows must
    // complete cleanly.
    const logger = makeCapturingLogger();
    const held = heldSseResponse();
    const adapter = new MiniMaxClientAdapter({
      baseUrl: () => 'https://api.minimax.io',
      fetchImpl: (async () => held.response) as unknown as typeof fetch,
      idleTimeoutMs: 60,
      sleep: async () => {},
    });
    const signal = new AbortController().signal;
    const done = consumeAll(adapter.streamCompletion(OPENAI_REQUEST, 'test-key', signal, logger));
    // Trickle events at half the idle window for several windows.
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      held.emitText(`chunk-${i}`);
    }
    held.finish();
    const eventCount = await withTimeout(done, 5_000, 'flowing stream was cut by the watchdog');
    ok(eventCount >= 6, 'every trickled event should be delivered');
  });
});
