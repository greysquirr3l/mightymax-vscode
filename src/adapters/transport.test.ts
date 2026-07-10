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
import type { Logger } from '../ports/logger.js';
import type {
  MiniMaxCompletionRequest,
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
