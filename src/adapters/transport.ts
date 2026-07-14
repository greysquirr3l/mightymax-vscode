import type { Logger } from '../ports/logger.js';
import {
  MiniMaxClientError,
  type MiniMaxClient,
  type MiniMaxCompletionRequest,
  type MiniMaxDialect,
  type MiniMaxStreamEvent,
  type MiniMaxWireContentPart,
  type MiniMaxWireMessage,
  type MiniMaxWireToolCall,
} from '../ports/minimax-client.js';
import { sanitizeAnthropicSchema } from '../lib/domain/anthropic-transform.js';

/**
 * MiniMaxClientAdapter — SSE streaming HTTP client against
 * platform.minimax.io (OpenAI- and Anthropic-compatible endpoints).
 *
 * Construction takes a *callback* for the base URL so the
 * composition root can re-read the configuration on every call
 * (matches AGENTS.md: "Configuration … read fresh at the use-site
 * and invalidate on onDidChangeConfiguration").
 *
 * The API key is supplied per-call by `streamCompletion`. The
 * adapter never stores it, never logs it, and never includes it
 * in any error message. Bearer is used for the OpenAI dialect;
 * the Anthropic dialect uses `x-api-key` per Anthropic's spec.
 *
 * Retry policy: 429 responses are retried with bounded exponential
 * backoff + jitter up to `maxRetries` times. After exhaustion the
 * adapter throws a typed `MiniMaxClientError({ kind: 'rate-limit' })`.
 * Transient 5xx errors (500, 502, 503, 504, 529) are retried with the
 * same backoff strategy. Other non-2xx responses are NOT retried.
 *
 * Cancellation: the caller-supplied `AbortSignal` is forwarded to
 * the underlying `fetch` call. Aborting mid-stream surfaces as
 * `MiniMaxClientError({ kind: 'abort' })`.
 */

export interface MiniMaxClientOptions {
  /** Reads the current base URL on every request. */
  baseUrl: () => string;
  /** Default: 3. Maximum 429 retries before surfacing RateLimitError. */
  maxRetries?: number;
  /** Default: 250ms. Initial backoff delay before the first retry. */
  initialBackoffMs?: number;
  /** Default: 8000ms. Cap on the backoff delay between retries. */
  maxBackoffMs?: number;
  /** Optional fetch override (used by the tests to inject the mock). */
  fetchImpl?: typeof fetch;
  /** Optional sleep override (used by the tests to skip real waits). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Default: 20000ms. Wall-clock threshold above which the
   * transport emits a `warn`-level "MiniMax request slow" line.
   * Tests can lower this to sub-second values to exercise the
   * warn path without real wall-clock waits.
   */
  slowRequestThresholdMs?: number;
  /**
   * Default: 30000ms. Wall-clock threshold above which a stream
   * that ends without a finish marker is classified as
   * `abandoned` (the model's tool loop was interrupted
   * mid-flight). Tests can lower this to sub-second values to
   * exercise the abandonment path without real wall-clock waits.
   */
  abandonmentThresholdMs?: number;
  /**
   * Default: 4. Maximum number of concurrent in-flight requests
   * to MiniMax across all `streamCompletion` callers on this
   * transport instance. Concurrent chat sessions share the
   * same transport, so this caps total in-flight requests
   * across every VS Code chat tab. The default (4) keeps
   * individual sessions under the 200 RPM MiniMax limit even
   * with 4 active chat tabs each making one request every 3
   * seconds. Lower this to dogpile-test or to debug rate
   * limiting; raise it for batched workloads.
   */
  maxConcurrentRequests?: number;
  /**
   * Default: 45000ms. Watchdog on time-to-response-headers. A
   * server that accepts the connection but never sends response
   * headers throws nothing — `fetch` just stays pending, the retry
   * loop never engages, and the request hangs until the user
   * cancels. On expiry the attempt is aborted and retried with
   * backoff like any transient network failure; exhausting the
   * retry budget surfaces `MiniMaxClientError({ kind: 'stall' })`.
   * A callback form is re-read on every request (the `baseUrl`
   * pattern) so a settings change is honored without restarting
   * the extension host. Non-finite or non-positive values fall
   * back to the default.
   */
  firstByteTimeoutMs?: number | (() => number);
  /**
   * Default: 60000ms. Watchdog on mid-stream byte silence: if no
   * bytes arrive on an open response body for this long, the
   * stream is cut with `MiniMaxClientError({ kind: 'stall' })`.
   * Silence BEFORE the first event is retried transparently (the
   * consumer saw nothing, so re-issuing is safe); silence after
   * the first event surfaces as an error (re-issuing would
   * duplicate content already delivered). Keyed off gaps between
   * bytes, never total elapsed time — a long request whose stream
   * keeps flowing is never cut. A callback form is re-read on
   * every request (the `baseUrl` pattern); non-finite or
   * non-positive values fall back to the default.
   */
  idleTimeoutMs?: number | (() => number);
}

const ANTHROPIC_VERSION = '2023-06-01';

const DEFAULTS = {
  maxRetries: 3,
  initialBackoffMs: 250,
  maxBackoffMs: 8_000,
  maxConcurrentRequests: 4,
};

/**
 * Threshold above which a request is flagged as a "slow request"
 * warning. M3 tool-calling requests are typically 5-15 seconds;
 * anything over 20s is anomalous and likely indicates either a
 * context-window-bound request, a server-side stall, or a tool
 * loop that has gone off the rails. The warning is emitted at
 * `warn` level so it surfaces in the Mighty Max output channel
 * at the default log level.
 */
const SLOW_REQUEST_THRESHOLD_MS = 20_000;

/**
 * Threshold above which a stream that ends without a finish
 * marker is classified as `abandoned` (the model's tool loop
 * was interrupted mid-flight). Below this threshold, a missing
 * finish marker is treated as a clean termination of an empty
 * stream — the chat-provider accepts the partial response.
 */
const ABANDONMENT_THRESHOLD_MS = 30_000;

/**
 * Watchdog on time-to-response-headers. Healthy MiniMax requests
 * return headers in single-digit seconds even on 90K-token cached
 * prompts; the hangs observed 2026-07-13 sat 80s+ with no headers
 * at all until manually cancelled. 45s is generous headroom over
 * the healthy case while still bounding the pathological one.
 */
const FIRST_BYTE_TIMEOUT_MS = 45_000;

/**
 * Watchdog on mid-stream byte silence. Distinct from the slow-
 * request threshold: total elapsed time is NOT a stall signal
 * (173s requests with a continuously flowing stream complete
 * successfully); only a sustained gap between bytes is. 60s
 * comfortably exceeds inter-token pauses and the Anthropic
 * dialect's ping cadence.
 */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Normalize a watchdog-timeout option to a validated getter. The
 * callback form is re-read on every use so a live settings change
 * is honored without restarting the extension host (the `baseUrl`
 * pattern); validation runs at read time for the same reason. Any
 * non-finite or non-positive value falls back to `fallbackMs` —
 * a user typo in settings must never disable a watchdog or turn
 * it into a 0ms insta-abort.
 */
function timeoutGetter(
  option: number | (() => number) | undefined,
  fallbackMs: number,
): () => number {
  const read =
    option === undefined ? () => fallbackMs : typeof option === 'number' ? () => option : option;
  return () => {
    const value = read();
    return Number.isFinite(value) && value > 0 ? value : fallbackMs;
  };
}

/**
 * Mutable parse state the SSE parsers update as they consume the
 * stream. The transport reads this in the `finally` block of
 * `streamCompletion` to decide whether the request was slow,
 * abandoned, or terminated without delivering any events.
 */

/**
 * Counting semaphore for in-process concurrency control on
 * MiniMax requests. Acquire returns a permit token whose
 * `release()` call frees the slot for the next waiter. The
 * semaphore aborts `acquire` cleanly when the caller's
 * `AbortSignal` fires, so a cancelled request never sits in
 * the queue.
 *
 * Implementation note: a simple FIFO with an abort listener.
 * `release()` always wakes the head of the queue; if no
 * waiters are present, it just increments the available
 * permit count. This is not a fair lock in the strict sense
 * (a newly-arriving acquire when the queue is empty wins over
 * a queue head), but that's intentional: real cancellation
 * pressure from a higher-priority request should be able to
 * jump the queue. The behavioral guarantee we care about is
 * "no more than N concurrent in-flight requests, ever."
 */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<{
    resolve: (token: { release: () => void }) => void;
    reject: (err: unknown) => void;
    onAbort: () => void;
  }> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`Semaphore permits must be a positive integer; got ${permits}`);
    }
    this.permits = permits;
  }

  /**
   * Acquire a permit. Resolves with a token whose `release()`
   * the caller MUST invoke once (typically from a `finally`
   * block) to free the slot. If the caller's `signal` aborts
   * while waiting, the returned promise rejects with
   * `MiniMaxClientError({ kind: 'abort' })` and the waiter is
   * removed from the queue.
   */
  async acquire(signal: AbortSignal): Promise<{ release: () => void }> {
    if (signal.aborted) {
      throw new MiniMaxClientError('abort', 'request aborted before semaphore acquire', {
        cause: signal.reason,
      });
    }
    if (this.permits > 0) {
      this.permits -= 1;
      return this.makeToken();
    }
    return await new Promise<{ release: () => void }>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.waiters.findIndex((w) => w.reject === reject);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new MiniMaxClientError('abort', 'request aborted while waiting for semaphore', {
            cause: signal.reason,
          }),
        );
      };
      const onResolve = (): void => {
        signal.removeEventListener('abort', onAbort);
        // The releaser handed its slot directly to this waiter;
        // the available-permit count is unchanged by a handoff.
        resolve(this.makeToken());
      };
      this.waiters.push({ resolve: onResolve, reject, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Mint a single-use release token. Idempotent: a token that
   * is released twice (e.g. both an error path and a `finally`
   * fire) frees its slot exactly once, so double-release can
   * never inflate the permit count past the configured cap.
   */
  private makeToken(): { release: () => void } {
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the head waiter. The permit
      // count is untouched: the releaser's slot transfers to the
      // waiter instead of ever becoming available. (Decrementing
      // here — as an earlier revision did — permanently destroys
      // one permit per handoff and eventually deadlocks the
      // transport.)
      next.resolve(this.makeToken());
      return;
    }
    this.permits += 1;
  }
}

interface MutableParseState {
  /** Set to true when any yielded event carries a `finishReason`. */
  sawFinishReason: boolean;
  /** Set to true on the first yielded event of any kind. */
  sawAnyEvent: boolean;
  /**
   * Most recent `cache_read_input_tokens` value from the
   * stream's `usage` block, if any. Used by the transport to
   * surface cache-hit-ratio information in the slow-request
   * warn and the completion `info` log — a request that ran
   * for 60s but had 95% cache hit ratio is genuinely
   * server-side stalled, not load-bearing on the model.
   */
  lastCacheReadTokens: number | undefined;
  /**
   * Most recent `cache_creation_input_tokens` value from the
   * stream's `usage` block, if any. A non-zero value means the
   * server cached new content for the first time on this
   * request; subsequent requests will likely see
   * `lastCacheReadTokens` rise.
   */
  lastCacheCreateTokens: number | undefined;
  /**
   * Buffer of pending `content_block_start` (tool_use) events
   * keyed by content block index. Anthropic emits the tool
   * header and argument fragments as separate SSE records; the
   * transport merges the header with the FIRST argument fragment
   * so downstream consumers see one `toolCallDelta` carrying
   * `id` + `name` + first `argumentsDelta` followed by
   * continuation fragments.
   *
   * Lives on `MutableParseState` (per-request) rather than
   * module-level so an abandoned stream cannot leak entries
   * into a later concurrent request on the same transport
   * instance. The map's lifetime is the request's lifetime.
   */
  pendingToolUseStarts: Map<number, { id?: string; name?: string }>;
  /**
   * Pending thinking fragment (M3 Anthropic). The transport emits
   * one `thinkingDelta` per `thinking_delta`, but keeps the most
   * recent fragment pending long enough to attach a later
   * `signature_delta` or sibling `signature` field before flushing it.
   */
  pendingThinking: { thinking: string; signature?: string } | undefined;
}

export class MiniMaxClientAdapter implements MiniMaxClient {
  private readonly baseUrl: () => string;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly slowRequestThresholdMs: number;
  private readonly abandonmentThresholdMs: number;
  private readonly firstByteTimeoutMs: () => number;
  private readonly idleTimeoutMs: () => number;
  private readonly semaphore: Semaphore;

  constructor(options: MiniMaxClientOptions) {
    this.baseUrl = options.baseUrl;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.slowRequestThresholdMs = options.slowRequestThresholdMs ?? SLOW_REQUEST_THRESHOLD_MS;
    this.abandonmentThresholdMs = options.abandonmentThresholdMs ?? ABANDONMENT_THRESHOLD_MS;
    this.firstByteTimeoutMs = timeoutGetter(options.firstByteTimeoutMs, FIRST_BYTE_TIMEOUT_MS);
    this.idleTimeoutMs = timeoutGetter(options.idleTimeoutMs, IDLE_TIMEOUT_MS);
    this.semaphore = new Semaphore(options.maxConcurrentRequests ?? DEFAULTS.maxConcurrentRequests);
  }

  async *streamCompletion(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    logger: Logger,
  ): AsyncIterable<MiniMaxStreamEvent> {
    if (!apiKey) {
      throw new MiniMaxClientError('auth', 'API key is required');
    }
    if (signal.aborted) {
      throw new MiniMaxClientError('abort', 'request aborted before start');
    }

    // Acquire a concurrency-control permit *before* the
    // dispatch+retry loop so a 429 retry sequence keeps the
    // permit for its full duration. Two concurrent chat
    // sessions on the same transport instance are each
    // bounded by `maxConcurrentRequests`; without this, they
    // could each be in a 429-retry loop simultaneously and
    // dogpile the server's rate-limit window. Aborts
    // propagate cleanly (the Semaphore rejects with
    // `kind:'abort'` when the caller's signal fires while
    // waiting).
    const permit = await this.semaphore.acquire(signal);
    try {
      yield* this.runCompletion(
        request,
        apiKey,
        signal,
        request.dialect ?? defaultDialectFor(request.model),
        logger,
      );
    } finally {
      // Exactly-once release on EVERY exit path: dispatch
      // failure, missing body, stream error, abandonment, clean
      // completion, and the caller abandoning the generator
      // (early `break` / `return()` runs this finally too). An
      // earlier revision released only on the two dispatch
      // failure paths, which leaked one permit per successful
      // request and deadlocked the transport after
      // `maxConcurrentRequests` completions — every later
      // request sat in `acquire()` until its signal aborted
      // ("request aborted while waiting for semaphore").
      permit.release();
    }
  }

  private async *runCompletion(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    dialect: MiniMaxDialect,
    logger: Logger,
  ): AsyncIterable<MiniMaxStreamEvent> {
    // Stall-retry driver. A stream that dies BEFORE delivering any
    // event is invisible to the caller (nothing was yielded), so
    // re-issuing the whole request is safe. Two failure shapes land
    // here as retriable errors with `sawAnyEvent === false`:
    //  - `stall`   — the idle watchdog cut a connection that went
    //                silent after headers but before the first event
    //                (the first-byte watchdog inside
    //                `doRequestWithRetries` handles its own retries).
    //  - `network` — the response body terminated without ever
    //                delivering an event.
    // Anything after the first yielded event is NOT retried here —
    // re-issuing would duplicate content the consumer already saw.
    const maxAttempts = 1 + this.maxRetries;
    for (let attempt = 1; ; attempt += 1) {
      // Mutable state the parsers update as they consume the stream.
      // Created out here (not inside the attempt) so the retry
      // predicate below can consult `sawAnyEvent` after a failure.
      const parseState: MutableParseState = {
        sawFinishReason: false,
        sawAnyEvent: false,
        lastCacheReadTokens: undefined,
        lastCacheCreateTokens: undefined,
        pendingToolUseStarts: new Map(),
        pendingThinking: undefined,
      };
      try {
        yield* this.runCompletionAttempt(request, apiKey, signal, dialect, logger, parseState);
        return;
      } catch (err) {
        const retriableBeforeFirstEvent =
          err instanceof MiniMaxClientError &&
          err.retriable &&
          (err.kind === 'stall' || err.kind === 'network') &&
          !parseState.sawAnyEvent &&
          !signal.aborted &&
          attempt < maxAttempts;
        if (!retriableBeforeFirstEvent) throw err;
        const waitMs = computeBackoff({
          attempt,
          initialMs: this.initialBackoffMs,
          maxMs: this.maxBackoffMs,
        });
        logger.warn('MiniMax stream died before first event — retrying', {
          model: request.model,
          kind: err.kind,
          attempt,
          waitMs,
        });
        await this.sleep(waitMs);
      }
    }
  }

  private async *runCompletionAttempt(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    dialect: MiniMaxDialect,
    logger: Logger,
    parseState: MutableParseState,
  ): AsyncIterable<MiniMaxStreamEvent> {
    const startedAt = Date.now();
    logger.debug('MiniMax request start', {
      dialect,
      model: request.model,
      toolCount: request.tools?.length ?? 0,
    });

    const response = await this.doRequestWithRetries(request, apiKey, signal, dialect, logger);
    if (!response.body) {
      throw new MiniMaxClientError('network', 'MiniMax response has no body');
    }
    // The abandonment check is stashed in this local rather than
    // thrown directly inside the `finally` block: the
    // `no-unsafe-finally` lint rule forbids `throw` in `finally`
    // because it masks any prior error and overrides the function
    // return path. After the `try`/`finally` returns, we read the
    // stashed error and throw it once, which propagates to the
    // caller's `for await` loop.
    let abandonmentError: MiniMaxClientError | undefined;
    try {
      yield* parseStream(response.body, dialect, signal, parseState, logger, this.idleTimeoutMs());
    } finally {
      const elapsedMs = Date.now() - startedAt;
      // Slow-request warning: anything over the threshold is
      // anomalous. M3 tool-calling requests are typically 5-15s;
      // longer requests are either context-window-bound,
      // server-side stalled, or a sign that the tool loop has
      // gone off the rails. The warning is visible in the Mighty
      // Max output channel at the default `warn` log level, unlike
      // the existing `info` completion line which is invisible
      // without enabling debug.
      if (elapsedMs > this.slowRequestThresholdMs) {
        logger.warn('MiniMax request slow — possible model stall', {
          dialect,
          model: request.model,
          elapsedMs,
          sawAnyEvent: parseState.sawAnyEvent,
          // Cache-hit ratio context: a 60s request with 95%
          // cache hits is server-side stalled (idle cache
          // warming or upstream queue); a 60s request with 0%
          // cache hits is the model itself doing real work
          // on a long input. The signal is useful for
          // diagnosing which class of stall we're seeing.
          ...(parseState.lastCacheReadTokens !== undefined && {
            cacheReadTokens: parseState.lastCacheReadTokens,
          }),
          ...(parseState.lastCacheCreateTokens !== undefined && {
            cacheCreateTokens: parseState.lastCacheCreateTokens,
          }),
        });
      }
      logger.info('MiniMax request complete', {
        dialect,
        model: request.model,
        elapsedMs,
        // Same cache info on the always-emitted completion line
        // so non-slow requests are also observable. A gradual
        // rise in `cacheReadTokens` across a session indicates
        // the model is reusing prior context — useful
        // operational signal.
        ...(parseState.lastCacheReadTokens !== undefined && {
          cacheReadTokens: parseState.lastCacheReadTokens,
        }),
        ...(parseState.lastCacheCreateTokens !== undefined && {
          cacheCreateTokens: parseState.lastCacheCreateTokens,
        }),
      });
      // Abandonment detection: the stream ended without a finish
      // marker. If we also have no events at all, treat as a
      // network failure (likely an early-terminated response
      // body). If we have events but no finish, and the request
      // took longer than the abandonment threshold, the model's
      // tool loop was likely interrupted mid-flight — surface
      // a typed `abandoned` error so the chat-provider can emit
      // a user-visible chat error instead of letting the turn
      // end silently.
      if (!parseState.sawFinishReason) {
        if (!parseState.sawAnyEvent) {
          abandonmentError = new MiniMaxClientError(
            'network',
            'MiniMax stream ended without delivering any events',
            { retriable: true },
          );
        } else if (elapsedMs >= this.abandonmentThresholdMs) {
          abandonmentError = new MiniMaxClientError(
            'abandoned',
            `MiniMax stream ended after ${elapsedMs}ms without a finish marker — the model's tool loop was likely interrupted`,
            { retriable: true },
          );
        }
      }
    }
    if (abandonmentError !== undefined) {
      throw abandonmentError;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HTTP + retry
  // ───────────────────────────────────────────────────────────────────────────

  private async doRequestWithRetries(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    dialect: MiniMaxDialect,
    logger: Logger,
  ): Promise<Response> {
    const maxAttempts = 1 + this.maxRetries;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptController = new AbortController();
      const onCallerAbort = (): void => attemptController.abort(signal.reason);
      signal.addEventListener('abort', onCallerAbort, { once: true });
      // First-byte watchdog: a server that accepts the socket and
      // then never sends response headers throws nothing — `fetch`
      // stays pending forever and the retry machinery below never
      // engages (observed 2026-07-13: two requests hung 80s/53s
      // with zero response until the user cancelled). The watchdog
      // aborts the attempt so the hang becomes a visible, retriable
      // failure. It is cleared as soon as headers arrive — silence
      // on the open body afterwards is the idle watchdog's job.
      let firstByteTimedOut = false;
      let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
      const firstByteTimeoutMs = this.firstByteTimeoutMs();
      try {
        if (signal.aborted) {
          throw new MiniMaxClientError('abort', 'request aborted', { cause: signal.reason });
        }
        firstByteTimer = setTimeout(() => {
          firstByteTimedOut = true;
          attemptController.abort(new Error(`no response headers after ${firstByteTimeoutMs}ms`));
        }, firstByteTimeoutMs);
        const response = await this.dispatch(request, apiKey, attemptController.signal, dialect);
        clearTimeout(firstByteTimer);
        if (response.ok) {
          return response;
        }
        const status = response.status;
        if (status === 429) {
          if (attempt < maxAttempts) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            const waitMs = computeBackoff({
              attempt,
              initialMs: this.initialBackoffMs,
              maxMs: this.maxBackoffMs,
              ...(retryAfterMs !== undefined && { retryAfterMs }),
            });
            logger.warn('MiniMax 429 — retrying', {
              model: request.model,
              attempt,
              waitMs,
            });
            await this.sleep(waitMs);
            continue;
          }
          throw new MiniMaxClientError(
            'rate-limit',
            `MiniMax returned 429 after ${attempt} attempts`,
            { status, retriable: true },
          );
        }
        if (status === 401 || status === 403) {
          throw new MiniMaxClientError('auth', `MiniMax returned ${status}`, { status });
        }
        // Read the error body ONCE. AGENTS.md forbids logging the
        // raw body; we parse it as JSON and emit the structural
        // fields (envelope type / message / numeric code) below.
        const errorBodyText = await response.text().catch(() => '');
        const parsedEnvelope = parseMiniMaxErrorBody(errorBodyText);
        // T22 (logging hygiene): emit a STRUCTURAL summary — never
        // the request body, never the raw response body. See
        // `summarizeRequestForLog` and `summarizeErrorBody`.
        if (status === 400) {
          logger.error('MiniMax 400 Bad Request', {
            ...summarizeRequestForLog(request, dialect),
            ...summarizeErrorBody(errorBodyText),
          });
        }
        const errorDetail =
          parsedEnvelope.message !== undefined ? `: ${parsedEnvelope.message}` : '';
        // Handle 5xx server errors with retry for transient failures
        if (status >= 500 && status < 600) {
          logger.error(`MiniMax ${status} Server Error`, {
            ...summarizeRequestForLog(request, dialect),
            ...summarizeErrorBody(errorBodyText),
          });
          // Retry transient 5xx errors (500, 502, 503, 504) and 529 (overloaded)
          const isRetriable =
            status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
          if (isRetriable && attempt < maxAttempts) {
            const waitMs = computeBackoff({
              attempt,
              initialMs: this.initialBackoffMs,
              maxMs: this.maxBackoffMs,
            });
            logger.warn('MiniMax 5xx server error — retrying', {
              model: request.model,
              status,
              attempt,
              waitMs,
            });
            await this.sleep(waitMs);
            continue;
          }
          throw new MiniMaxClientError('http', `MiniMax returned ${status}${errorDetail}`, {
            status,
            retriable: isRetriable,
          });
        }
        throw new MiniMaxClientError('http', `MiniMax returned ${status}${errorDetail}`, {
          status,
        });
      } catch (err) {
        // First-byte timeout: the watchdog aborted this attempt, so
        // `err` is the abort reason we planted, not a real network
        // failure. Retry with backoff; surface `stall` once the
        // budget is spent. (`retriable` stays false on the thrown
        // error — the retries already happened here, so the
        // before-first-event driver in `runCompletion` must not
        // spend a second budget on it.) The caller-abort case is
        // excluded: a user cancel that races the watchdog is still
        // an abort.
        if (firstByteTimedOut && !signal.aborted) {
          if (attempt < maxAttempts) {
            const waitMs = computeBackoff({
              attempt,
              initialMs: this.initialBackoffMs,
              maxMs: this.maxBackoffMs,
            });
            logger.warn('MiniMax first-byte timeout — retrying', {
              model: request.model,
              attempt,
              timeoutMs: firstByteTimeoutMs,
              waitMs,
            });
            await this.sleep(waitMs);
            lastError = err;
            continue;
          }
          throw new MiniMaxClientError(
            'stall',
            `MiniMax sent no response headers within ${firstByteTimeoutMs}ms (${maxAttempts} attempts)`,
            { cause: err },
          );
        }
        if (err instanceof MiniMaxClientError) {
          if (err.kind === 'abort') throw err;
          if (err.kind === 'auth' || err.kind === 'http' || err.kind === 'parse') throw err;
          if (err.kind === 'rate-limit' && attempt < maxAttempts) {
            lastError = err;
            continue;
          }
          throw err;
        }
        if (signal.aborted) {
          throw new MiniMaxClientError('abort', 'request aborted', { cause: err });
        }
        if (attempt < maxAttempts && isRetriableNetworkError(err)) {
          const waitMs = computeBackoff({
            attempt,
            initialMs: this.initialBackoffMs,
            maxMs: this.maxBackoffMs,
          });
          logger.warn('MiniMax network error — retrying', {
            model: request.model,
            attempt,
            waitMs,
            error: errorMessage(err),
          });
          await this.sleep(waitMs);
          lastError = err;
          continue;
        }
        throw new MiniMaxClientError('network', errorMessage(err), { cause: err });
      } finally {
        if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
        signal.removeEventListener('abort', onCallerAbort);
      }
    }
    throw new MiniMaxClientError('network', 'request failed after retries', { cause: lastError });
  }

  private async dispatch(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    dialect: MiniMaxDialect,
  ): Promise<Response> {
    const baseUrl = this.baseUrl().replace(/\/+$/, '');
    const url =
      dialect === 'anthropic'
        ? `${baseUrl}/anthropic/v1/messages`
        : `${baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // MiniMax uses Authorization: Bearer for both endpoints
    headers.authorization = `Bearer ${apiKey}`;
    if (dialect === 'anthropic') {
      headers['anthropic-version'] = ANTHROPIC_VERSION;
    }
    const body =
      dialect === 'anthropic'
        ? JSON.stringify(serializeAnthropicRequest(request))
        : JSON.stringify(serializeOpenAiRequest(request));

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    // For error responses, read the body immediately before it's consumed elsewhere
    if (!response.ok) {
      // Read the error body now so we can log it
      const errorText = await response.text().catch(() => '');
      // Create a new Response with the error text so callers can still access it
      return new Response(errorText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    if (!response.body) {
      throw new MiniMaxClientError('network', 'MiniMax response has no body');
    }
    return response;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire serializers (request)
// ─────────────────────────────────────────────────────────────────────────────

interface OpenAiRequest {
  model: string;
  messages: ReadonlyArray<unknown>;
  stream: true;
  tools?: ReadonlyArray<unknown>;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
}

function serializeOpenAiRequest(request: MiniMaxCompletionRequest): OpenAiRequest {
  const out: OpenAiRequest = {
    model: request.model,
    messages: serializeOpenAiMessages(request.messages, request.systemPrompt),
    stream: true,
  };
  if (request.tools !== undefined) {
    // Tool schemas are passed through verbatim. The Anthropic-only
    // `sanitizeAnthropicSchema` lowering happens inside
    // `serializeAnthropicRequest` so the OpenAI wire body carries the
    // VS Code-style `additionalProperties`/`const`/boolean schemas
    // that the OpenAI-compatible endpoint accepts unchanged.
    out.tools = request.tools as unknown as ReadonlyArray<unknown>;
  }
  if (request.toolChoice !== undefined) out.tool_choice = request.toolChoice;
  if (request.temperature !== undefined) {
    // MiniMax OpenAI API requires temperature in [0, 2]
    out.temperature = Math.max(0, Math.min(2, request.temperature));
  }
  if (request.topP !== undefined) {
    out.top_p = Math.max(0, Math.min(1, request.topP));
  }
  // MiniMax's OpenAI-compatible endpoint accepts `top_k` as a sampling
  // extension. Verified against the OpenAPI spec; this is the same
  // value the chat-provider pins per `getTopKForModel`.
  if (request.topK !== undefined) out.top_k = Math.max(0, request.topK);
  if (request.maxTokens !== undefined) out.max_tokens = request.maxTokens;
  return out;
}

/**
 * Build the OpenAI-compatible `messages` array. The MiniMax OpenAI
 * endpoint does not have an Anthropic-style top-level `system` field;
 * the system prompt is injected as the first `{role:'system',...}`
 * entry. The Anthropic serializer hoists system content out of the
 * message list into `request.system`; the two dialects must agree on
 * where the system content lives or it will be emitted twice.
 */
function serializeOpenAiMessages(
  messages: ReadonlyArray<MiniMaxWireMessage>,
  systemPrompt: string | undefined,
): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    out.push(serializeOpenAiMessage(m));
  }
  return out;
}

function serializeOpenAiMessage(message: MiniMaxWireMessage): unknown {
  const out: Record<string, unknown> = { role: message.role };
  if (typeof message.content === 'string') {
    out.content = message.content;
  } else if (Array.isArray(message.content)) {
    // The Anthropic-only `thinking` content part is produced by the
    // thinking-passback cache (T19). The OpenAI-compatible endpoint
    // does not accept `{type:'thinking',...}` parts and would 400 on
    // them. Drop the parts here; the cache is dialect-scoped via the
    // `enrichWithThinking` filter, so Anthropic requests still see the
    // thinking block serialized into the right shape.
    const parts = message.content as ReadonlyArray<MiniMaxWireContentPart>;
    const filtered: MiniMaxWireContentPart[] = [];
    for (const part of parts) {
      if (part.type !== 'thinking') filtered.push(part);
    }
    if (filtered.length === 0) {
      // After dropping thinking parts, the message has no visible
      // content. Match the Anthropic serializer's empty-content
      // behavior by passing an empty string — the model receives a
      // no-op turn that still carries `toolCalls`/`toolCallId`.
      out.content = '';
    } else {
      out.content = filtered;
    }
  } else {
    out.content = '';
  }
  if (message.toolCallId !== undefined) out.tool_call_id = message.toolCallId;
  if (message.toolCalls !== undefined) out.tool_calls = message.toolCalls;
  return out;
}

interface AnthropicRequest {
  model: string;
  system?: string | ReadonlyArray<{ type: 'text'; text: string; cache_control?: unknown }>;
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: unknown }>;
  stream: true;
  max_tokens: number;
  tools?: ReadonlyArray<unknown>;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: { type: 'enabled' | 'adaptive' | 'disabled'; budget_tokens?: number };
}

function serializeAnthropicRequest(request: MiniMaxCompletionRequest): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  let hasSeenUserMessage = false;

  // Coalesce consecutive tool results into a single user message
  const coalescedMessages: MiniMaxWireMessage[] = [];
  for (let i = 0; i < request.messages.length; i++) {
    const m = request.messages[i];
    if (m === undefined) continue;

    if (m.role === 'tool') {
      // Collect all consecutive tool messages
      const toolResults: MiniMaxWireMessage[] = [m];
      while (i + 1 < request.messages.length && request.messages[i + 1]?.role === 'tool') {
        i++;
        const nextTool = request.messages[i];
        if (nextTool !== undefined) toolResults.push(nextTool);
      }
      // Create a synthetic "tool-batch" marker message
      coalescedMessages.push({
        role: 'user',
        content: '',
        toolCallId: '__batch__',
        _toolBatch: toolResults as unknown as ReadonlyArray<MiniMaxWireMessage>,
      } as MiniMaxWireMessage & { _toolBatch: ReadonlyArray<MiniMaxWireMessage> });
    } else {
      coalescedMessages.push(m);
    }
  }

  for (const m of coalescedMessages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : extractTextFromParts(m.content);
      if (text.length > 0) systemParts.push(text);
      continue;
    }
    // Anthropic API requires messages array to start with a user message.
    // Convert assistant text before the first user message to system messages,
    // but preserve tool_use blocks since tool_results reference them by ID.
    if (m.role === 'assistant' && !hasSeenUserMessage) {
      const text = typeof m.content === 'string' ? m.content : extractTextFromParts(m.content);
      if (text.length > 0) systemParts.push(text);
      // If there are tool calls, we can't just drop them - insert a synthetic user message first
      if (m.toolCalls && m.toolCalls.length > 0) {
        hasSeenUserMessage = true;
        messages.push({ role: 'user', content: 'Continue.' });
        const content: unknown[] = [];
        for (const call of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: safeParseJson(call.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content });
      }
      continue;
    }
    if (m.role === 'user') {
      hasSeenUserMessage = true;
      // Handle batched tool results
      const batch = (m as MiniMaxWireMessage & { _toolBatch?: ReadonlyArray<MiniMaxWireMessage> })
        ._toolBatch;
      if (batch) {
        // Create a single user message with all tool_result blocks
        const toolResultBlocks: unknown[] = [];
        for (const toolMsg of batch) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolMsg.toolCallId,
            content:
              typeof toolMsg.content === 'string'
                ? toolMsg.content
                : extractTextFromParts(toolMsg.content),
          });
        }
        messages.push({ role: 'user', content: toolResultBlocks });
        continue;
      }
    }
    if (m.role === 'tool') {
      // Should not reach here after coalescing, but handle it defensively
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: typeof m.content === 'string' ? m.content : extractTextFromParts(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (typeof m.content === 'string') {
        if (m.content.length > 0) content.push({ type: 'text', text: m.content });
      } else {
        for (const part of m.content) content.push(convertAnthropicContentPart(part));
      }
      if (m.toolCalls) {
        for (const call of m.toolCalls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: safeParseJson(call.function.arguments),
          });
        }
      }
      // Only push if we have content (text or tool_use blocks)
      if (content.length > 0) {
        messages.push({ role: 'assistant', content });
      }
      continue;
    }
    if (typeof m.content === 'string') {
      messages.push({ role: 'user', content: m.content });
    } else {
      messages.push({
        role: 'user',
        content: m.content.map((p) => convertAnthropicContentPart(p)),
      });
    }
  }

  const out: AnthropicRequest = {
    model: request.model,
    messages,
    stream: true,
    max_tokens: request.maxTokens ?? 32_000,
  };
  if (systemParts.length > 0) {
    // System block always carries `cache_control: ephemeral` so
    // the prefix is reused across requests. The Anthropic
    // interface expects `system` to be a string OR a list of
    // content blocks; the list form is required to attach
    // `cache_control` to the system block itself.
    out.system = [
      {
        type: 'text',
        text: systemParts.join('\n'),
        cache_control: { type: 'ephemeral' },
      },
    ];
  } else if (request.systemPrompt !== undefined && request.systemPrompt.length > 0) {
    out.system = [
      {
        type: 'text',
        text: request.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    // Convert OpenAI-format tools to Anthropic format. Tool schemas
    // arrive at the wire boundary in VS Code style (T03 / mapToolsToMiniMax
    // keeps them verbatim so the same array can be serialized to either
    // dialect). Anthropic's tool validator rejects `const`,
    // `additionalProperties: false`, and a few other shapes; lowering
    // happens here so the OpenAI-compatible endpoint never sees the
    // mangled schemas.
    out.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema:
        t.function.parameters !== undefined
          ? (sanitizeAnthropicSchema(t.function.parameters) as Record<string, unknown>)
          : { type: 'object', properties: {} },
    }));
  }
  if (request.toolChoice !== undefined) {
    // Convert OpenAI-style tool_choice to Anthropic format
    if (request.toolChoice === 'auto') {
      out.tool_choice = { type: 'auto' };
    } else if (request.toolChoice === 'required') {
      out.tool_choice = { type: 'any' };
    } else if (request.toolChoice === 'none') {
      // Anthropic doesn't have 'none' - just don't send tools
    } else if (typeof request.toolChoice === 'object' && request.toolChoice.function?.name) {
      out.tool_choice = { type: 'tool', name: request.toolChoice.function.name };
    }
  }
  if (request.temperature !== undefined) {
    // MiniMax Anthropic API requires temperature in [0, 2]
    out.temperature = Math.max(0, Math.min(2, request.temperature));
  }
  if (request.topP !== undefined) {
    out.top_p = Math.max(0, Math.min(1, request.topP));
  }
  if (request.topK !== undefined && request.topK > 0) {
    out.top_k = Math.floor(request.topK);
  }
  if (request.thinking !== undefined) {
    out.thinking = {
      type: request.thinking.type,
      ...(request.thinking.budgetTokens !== undefined
        ? { budget_tokens: Math.floor(request.thinking.budgetTokens) }
        : {}),
    };
  }

  // Cache markers: stamp `cache_control: { type: 'ephemeral' }`
  // on the last 1-2 user-history messages. The mapper's
  // `cacheMarkers` is 1-indexed into the `messages` array (which
  // we built above, after coalescing tool messages and hoisting
  // out the first system message). The stamp attaches to the
  // last text or tool_use block in the message — Anthropic only
  // honors `cache_control` on text / image / tool_use blocks.
  if (request.cacheMarkers !== undefined) {
    for (const marker of request.cacheMarkers) {
      const idx = marker - 1;
      const msg = out.messages[idx];
      if (msg === undefined) continue;
      const content = msg.content;
      if (typeof content === 'string') {
        // Convert string content to a single text block with the
        // cache_control marker; preserves the wire compatibility
        // for the chat-provider.
        msg.content = [
          { type: 'text', text: content, cache_control: { type: 'ephemeral' } },
        ];
      } else if (Array.isArray(content)) {
        // Find the last text or tool_use block. Skip image
        // blocks (Anthropic does not honor cache_control on
        // images).
        for (let i = content.length - 1; i >= 0; i -= 1) {
          const block = content[i] as { type?: unknown };
          if (block.type === 'text' || block.type === 'tool_use') {
            (content[i] as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
            break;
          }
        }
      }
    }
  }

  return out;
}

function convertAnthropicContentPart(part: MiniMaxWireContentPart): unknown {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'thinking') {
    const block: { type: 'thinking'; thinking: string; signature?: string } = {
      type: 'thinking',
      thinking: part.thinking,
    };
    if (part.signature) block.signature = part.signature;
    return block;
  }
  return {
    type: 'image',
    source: { type: 'url', url: part.image_url.url },
  };
}

function extractTextFromParts(parts: ReadonlyArray<MiniMaxWireContentPart>): string {
  return parts
    .filter((p): p is Extract<MiniMaxWireContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE stream parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the response stream into normalized `MiniMaxStreamEvent`s.
 * Incremental: yields events as they arrive; never buffers the full
 * body. The two dialects are normalized to the same shape so the
 * chat provider (T07) does not branch.
 */
async function* parseStream(
  body: ReadableStream<Uint8Array>,
  dialect: MiniMaxDialect,
  signal: AbortSignal,
  parseState: MutableParseState,
  logger: Logger,
  idleTimeoutMs: number,
): AsyncIterable<MiniMaxStreamEvent> {
  if (dialect === 'openai') {
    yield* parseOpenAiStream(body, signal, parseState, logger, idleTimeoutMs);
  } else {
    yield* parseAnthropicStream(body, signal, parseState, logger, idleTimeoutMs);
  }
}

/**
 * `reader.read()` with an idle watchdog. A server that holds the
 * connection open but stops sending bytes leaves `read()` pending
 * forever — the abort checks in the parse loops only run when a
 * chunk arrives, so without this the stream hangs until the user
 * cancels. On expiry the reader is cancelled (which settles the
 * pending `read()`, so the caller's `releaseLock()` in its
 * `finally` stays clean) and a retriable `stall` error is thrown.
 * Whether a stall is actually retried is decided upstream in
 * `runCompletion`: only streams that had not yet delivered any
 * event are re-issued.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new MiniMaxClientError(
              'stall',
              `MiniMax stream went silent — no bytes received for ${idleTimeoutMs}ms`,
              { retriable: true },
            ),
          );
        }, idleTimeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof MiniMaxClientError && err.kind === 'stall') {
      await reader.cancel(err.message).catch(() => {});
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const textDecoder = new TextDecoder('utf-8');

/**
 * Stateful SSE parser. Consumes chunks of UTF-8 bytes, splits on
 * the blank-line record boundary, and yields one record per call.
 * Records may span chunk boundaries.
 */
type SseRecord = { event?: string; data: string };

function* parseSseRecords(buffer: { value: string }): Generator<SseRecord> {
  let pending = buffer.value;
  let start = 0;
  for (let i = 0; i < pending.length; i += 1) {
    if (pending[i] === '\n' && pending[i + 1] === '\n') {
      const record = pending.slice(start, i);
      buffer.value = pending.slice(i + 2);
      yield parseSseRecord(record);
      pending = buffer.value;
      start = 0;
      i = -1;
      continue;
    }
    if (
      pending[i] === '\r' &&
      pending[i + 1] === '\n' &&
      pending[i + 2] === '\r' &&
      pending[i + 3] === '\n'
    ) {
      const record = pending.slice(start, i);
      buffer.value = pending.slice(i + 4);
      yield parseSseRecord(record);
      pending = buffer.value;
      start = 0;
      i = -1;
      continue;
    }
  }
  buffer.value = pending.slice(start);
}

function parseSseRecord(raw: string): SseRecord {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      let payload = line.slice('data:'.length);
      if (payload.startsWith(' ')) payload = payload.slice(1);
      dataLines.push(payload);
    }
  }
  return event !== undefined
    ? { event, data: dataLines.join('\n') }
    : { data: dataLines.join('\n') };
}

async function* parseOpenAiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  parseState: MutableParseState,
  logger: Logger,
  idleTimeoutMs: number,
): AsyncIterable<MiniMaxStreamEvent> {
  const reader = body.getReader();
  const buffer = { value: '' };
  try {
    while (true) {
      if (signal.aborted) {
        throw new MiniMaxClientError('abort', 'request aborted');
      }
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (signal.aborted) {
        throw new MiniMaxClientError('abort', 'request aborted');
      }
      if (done) break;
      if (value) {
        buffer.value += textDecoder.decode(value, { stream: true });
      }
      for (const record of parseSseRecords(buffer)) {
        if (!record.data) continue;
        if (record.data === '[DONE]') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(record.data);
        } catch (err) {
          logger.warn('MiniMax SSE JSON parse error', { error: errorMessage(err) });
          throw new MiniMaxClientError(
            'parse',
            `MiniMax SSE JSON parse error: ${errorMessage(err)}`,
          );
        }
        for (const event of openAiEventToStreamEvents(parsed, parseState)) {
          yield event;
        }
      }
    }
    if (buffer.value.length > 0) {
      const record = parseSseRecord(buffer.value);
      if (record.data && record.data !== '[DONE]') {
        try {
          const parsed = JSON.parse(record.data) as unknown;
          for (const event of openAiEventToStreamEvents(parsed, parseState)) yield event;
        } catch {
          // Drop on the floor; stream is already done.
        }
      }
    }
  } catch (err) {
    if (err instanceof MiniMaxClientError) throw err;
    if (isAbortError(err) || signal.aborted) {
      throw new MiniMaxClientError('abort', 'request aborted', { cause: err });
    }
    throw new MiniMaxClientError('network', errorMessage(err), { cause: err });
  } finally {
    reader.releaseLock();
  }
}

function* openAiEventToStreamEvents(
  parsed: unknown,
  parseState: MutableParseState,
): Generator<MiniMaxStreamEvent> {
  if (!isObject(parsed)) return;
  // From here on, any yielded event counts as "stream is alive".
  // The finish-reason flag is set explicitly at the two yield
  // sites below that emit a finish event.
  parseState.sawAnyEvent = true;
  const choices = (parsed as { choices?: unknown }).choices;
  const usage = (parsed as { usage?: unknown }).usage;
  // The terminal record combines `choices[].finish_reason` and the
  // top-level `usage` block. We collect them into a single event so
  // downstream consumers see usage + finishReason together (the model
  // emits them in the same SSE record).
  let pendingFinishReason: FinishReason | undefined;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isObject(choice)) continue;
      const delta = (choice as { delta?: unknown }).delta;
      if (isObject(delta)) {
        const content = (delta as { content?: unknown }).content;
        if (typeof content === 'string' && content.length > 0) {
          yield { textDelta: content };
        }
        const reasoning = (delta as { reasoning_content?: unknown }).reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { reasoningDelta: reasoning };
        }
        const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            if (!isObject(tc)) continue;
            const index = (tc as { index?: unknown }).index;
            const id = (tc as { id?: unknown }).id;
            const fn = (tc as { function?: unknown }).function;
            if (!isObject(fn)) continue;
            const name = (fn as { name?: unknown }).name;
            const args = (fn as { arguments?: unknown }).arguments;
            const toolDelta: MiniMaxStreamEvent['toolCallDelta'] = {
              index: typeof index === 'number' ? index : 0,
            };
            if (typeof id === 'string') toolDelta.id = id;
            if (typeof name === 'string') toolDelta.name = name;
            if (typeof args === 'string') toolDelta.argumentsDelta = args;
            yield { toolCallDelta: toolDelta };
          }
        }
      }
      const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
      if (typeof finishReason === 'string' && finishReason.length > 0) {
        pendingFinishReason = normalizeOpenAiFinishReason(finishReason);
      }
    }
  }
  let usageEvent: MiniMaxStreamEvent | undefined;
  if (isObject(usage)) {
    const u = usage as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
    const out: MiniMaxStreamEvent['usage'] = {};
    if (typeof u.prompt_tokens === 'number') out.promptTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') out.completionTokens = u.completion_tokens;
    if (typeof u.total_tokens === 'number') out.totalTokens = u.total_tokens;
    if (typeof u.cache_read_input_tokens === 'number') {
      out.cacheReadTokens = u.cache_read_input_tokens;
      // Stash on parseState for the transport's slow-request
      // warn / completion log. A new value overwrites the
      // previous one; OpenAI emits usage at most once per
      // stream, so the stashed value is the final cache
      // reading for the request.
      parseState.lastCacheReadTokens = u.cache_read_input_tokens;
    }
    if (typeof u.cache_creation_input_tokens === 'number') {
      out.cacheCreateTokens = u.cache_creation_input_tokens;
      parseState.lastCacheCreateTokens = u.cache_creation_input_tokens;
    }
    if (Object.keys(out).length > 0) usageEvent = { usage: out };
  }
  if (pendingFinishReason !== undefined && usageEvent) {
    parseState.sawFinishReason = true;
    yield { ...usageEvent, finishReason: pendingFinishReason };
  } else {
    if (usageEvent) yield usageEvent;
    if (pendingFinishReason !== undefined) {
      parseState.sawFinishReason = true;
      yield { finishReason: pendingFinishReason };
    }
  }
}

type FinishReason = NonNullable<MiniMaxStreamEvent['finishReason']>;

function normalizeOpenAiFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
    case 'error':
      return reason;
    default:
      return 'stop';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic stream parser
// ─────────────────────────────────────────────────────────────────────────────

async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  parseState: MutableParseState,
  logger: Logger,
  idleTimeoutMs: number,
): AsyncIterable<MiniMaxStreamEvent> {
  const reader = body.getReader();
  const buffer = { value: '' };
  try {
    while (true) {
      if (signal.aborted) {
        throw new MiniMaxClientError('abort', 'request aborted');
      }
      const { value, done } = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (signal.aborted) {
        throw new MiniMaxClientError('abort', 'request aborted');
      }
      if (done) break;
      if (value) {
        buffer.value += textDecoder.decode(value, { stream: true });
      }
      for (const record of parseSseRecords(buffer)) {
        if (!record.data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(record.data);
        } catch (err) {
          logger.warn('MiniMax Anthropic SSE JSON parse error', { error: errorMessage(err) });
          throw new MiniMaxClientError(
            'parse',
            `MiniMax Anthropic SSE parse error: ${errorMessage(err)}`,
          );
        }
        for (const event of anthropicEventToStreamEvents(parsed, parseState)) yield event;
      }
    }
  } catch (err) {
    if (err instanceof MiniMaxClientError) throw err;
    if (isAbortError(err) || signal.aborted) {
      throw new MiniMaxClientError('abort', 'request aborted', { cause: err });
    }
    throw new MiniMaxClientError('network', errorMessage(err), { cause: err });
  } finally {
    reader.releaseLock();
  }
}

function flushPendingThinking(parseState: MutableParseState): MiniMaxStreamEvent | undefined {
  if (!parseState.pendingThinking) return undefined;
  if (parseState.pendingThinking.thinking.length === 0) {
    parseState.pendingThinking = undefined;
    return undefined;
  }
  const event: MiniMaxStreamEvent = { thinkingDelta: parseState.pendingThinking.thinking };
  if (parseState.pendingThinking.signature) {
    event.thinkingSignature = parseState.pendingThinking.signature;
  }
  parseState.pendingThinking = undefined;
  return event;
}

function* anthropicEventToStreamEvents(
  parsed: unknown,
  parseState: MutableParseState,
): Generator<MiniMaxStreamEvent> {
  if (!isObject(parsed)) return;
  // From here on, any yielded event counts as "stream is alive".
  // The finish-reason flag is set explicitly at the two yield
  // sites below that emit a finish event.
  parseState.sawAnyEvent = true;
  const type = (parsed as { type?: unknown }).type;
  if (type === 'error') {
    const err = (parsed as { error?: unknown }).error;
    if (isObject(err)) {
      const message = (err as { message?: unknown }).message;
      parseState.sawFinishReason = true;
      yield {
        error: {
          message: typeof message === 'string' ? message : 'unknown error',
          retriable: false,
        },
        finishReason: 'error',
      };
    }
    return;
  }
  if (type === 'content_block_start') {
    const cb = (parsed as { content_block?: unknown }).content_block;
    if (!isObject(cb)) return;
    const blockType = (cb as { type?: unknown }).type;
    if (blockType === 'tool_use') {
      // Flush any pending thinking before starting a tool block
      const pendingThinking = flushPendingThinking(parseState);
      if (pendingThinking) {
        yield pendingThinking;
      }
      const id = (cb as { id?: unknown }).id;
      const name = (cb as { name?: unknown }).name;
      const index = (parsed as { index?: unknown }).index;
      const idx = typeof index === 'number' ? index : 0;
      // Stash the tool-use header so the first input_json_delta can
      // be merged with it into a single toolCallDelta event carrying
      // id + name + first argument fragment. Without this merge the
      // consumer would see a toolCallDelta with no `argumentsDelta`
      // followed by argument-only fragments, which produces a
      // no-op entry when callers filter on `argumentsDelta`.
      const start: { id?: string; name?: string } = {};
      if (typeof id === 'string') start.id = id;
      if (typeof name === 'string') start.name = name;
      parseState.pendingToolUseStarts.set(idx, start);
    } else if (blockType === 'thinking') {
      // Nothing to do until the first thinking/signature delta arrives.
      parseState.pendingThinking = undefined;
    }
    return;
  }
  if (type === 'content_block_delta') {
    const delta = (parsed as { delta?: unknown }).delta;
    if (!isObject(delta)) return;
    const deltaType = (delta as { type?: unknown }).type;
    if (deltaType === 'text_delta') {
      // Flush any pending thinking before emitting text
      const pendingThinking = flushPendingThinking(parseState);
      if (pendingThinking) {
        yield pendingThinking;
      }
      const text = (delta as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) yield { textDelta: text };
      return;
    }
    if (deltaType === 'thinking_delta') {
      let carriedSignature: string | undefined;
      if (parseState.pendingThinking?.thinking.length === 0) {
        carriedSignature = parseState.pendingThinking.signature;
        parseState.pendingThinking = undefined;
      } else {
        const pendingThinking = flushPendingThinking(parseState);
        if (pendingThinking) {
          yield pendingThinking;
        }
      }

      const thinking = (delta as { thinking?: unknown }).thinking;
      const signature = (delta as { signature?: unknown }).signature;
      if (typeof thinking === 'string' && thinking.length > 0) {
        const nextPending: { thinking: string; signature?: string } = { thinking };
        if (typeof signature === 'string') {
          nextPending.signature = signature;
        } else if (carriedSignature !== undefined) {
          nextPending.signature = carriedSignature;
        }
        parseState.pendingThinking = nextPending;
      }
      return;
    }
    if (deltaType === 'signature_delta') {
      const signature = (delta as { signature?: unknown }).signature;
      if (typeof signature === 'string') {
        if (!parseState.pendingThinking) {
          parseState.pendingThinking = { thinking: '', signature };
        } else {
          parseState.pendingThinking.signature = signature;
        }
      }
      return;
    }
    if (deltaType === 'input_json_delta') {
      // Flush any pending thinking before emitting tool call deltas
      const pendingThinking = flushPendingThinking(parseState);
      if (pendingThinking) {
        yield pendingThinking;
      }
      const partial = (delta as { partial_json?: unknown }).partial_json;
      const index = (parsed as { index?: unknown }).index;
      if (typeof partial === 'string') {
        const idx = typeof index === 'number' ? index : 0;
        const start = parseState.pendingToolUseStarts.get(idx);
        if (start) {
          // First fragment: emit a combined event with id + name + fragment.
          const toolDelta: MiniMaxStreamEvent['toolCallDelta'] = {
            index: idx,
            argumentsDelta: partial,
          };
          if (start.id !== undefined) toolDelta.id = start.id;
          if (start.name !== undefined) toolDelta.name = start.name;
          yield { toolCallDelta: toolDelta };
          parseState.pendingToolUseStarts.delete(idx);
        } else {
          // Continuation fragment.
          yield {
            toolCallDelta: {
              index: idx,
              argumentsDelta: partial,
            },
          };
        }
      }
    }
    return;
  }
  if (type === 'content_block_stop') {
    // Flush pending thinking when a content block ends
    const pendingThinking = flushPendingThinking(parseState);
    if (pendingThinking) {
      yield pendingThinking;
    }
    const index = (parsed as { index?: unknown }).index;
    if (typeof index === 'number') {
      // A block may end without ever receiving an input_json_delta
      // (e.g. a malformed tool_use). Clear any pending start so the
      // buffer does not leak into a later block at the same index.
      parseState.pendingToolUseStarts.delete(index);
    }
    return;
  }
  if (type === 'message_delta') {
    const delta = (parsed as { delta?: unknown }).delta;
    if (isObject(delta)) {
      const stop = (delta as { stop_reason?: unknown }).stop_reason;
      if (typeof stop === 'string' && stop.length > 0) {
        parseState.sawFinishReason = true;
        yield { finishReason: normalizeAnthropicStopReason(stop) };
      }
    }
    // Anthropic's `message_delta` event also carries a
    // top-level `usage` block (cumulative tokens so far,
    // including cache_read_input_tokens and
    // cache_creation_input_tokens). Stash the cache values
    // on parseState so the transport's slow-request warn can
    // include them. We don't yield a `usage` event from the
    // message_delta — the chat-provider already gets one
    // from the `message_start` event if it asks for it; the
    // transport uses the cumulative value for its own
    // diagnostic log only.
    const usage = (parsed as { usage?: unknown }).usage;
    if (isObject(usage)) {
      const u = usage as {
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
      };
      if (typeof u.cache_read_input_tokens === 'number') {
        parseState.lastCacheReadTokens = u.cache_read_input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === 'number') {
        parseState.lastCacheCreateTokens = u.cache_creation_input_tokens;
      }
    }
    return;
  }
}

/**
 * Module-level buffer of pending `content_block_start` (tool_use) events
 * keyed by content block index. Anthropic emits the tool header and
 * argument fragments as separate SSE records; the transport merges the
 * header with the FIRST argument fragment so downstream consumers see
 * one `toolCallDelta` carrying `id` + `name` + first `argumentsDelta`
 * followed by continuation fragments.
 *
 * **Moved onto `MutableParseState` (request-scoped) in 0.1.3** so
 * an abandoned stream cannot leak entries into a later concurrent
 * request on the same transport instance. The map's lifetime
 * is the request's lifetime.
 */

function normalizeAnthropicStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a STRUCTURAL summary of a `MiniMaxCompletionRequest` for
 * use in a log call. NEVER returns message content, tool schemas,
 * or anything resembling a request body — only the keys the
 * AGENTS.md redaction rule explicitly preserves: counts by role,
 * presence flags, byte length, and the model + dialect identifier.
 *
 * Used by the 400 / 5xx failure paths so the diagnostic line
 * remains useful without ever leaking prompt or tool content.
 */
function summarizeRequestForLog(
  request: MiniMaxCompletionRequest,
  dialect: MiniMaxDialect,
): Record<string, unknown> {
  const counts: Record<string, number> = {};
  let totalContentChars = 0;
  for (const m of request.messages) {
    counts[m.role] = (counts[m.role] ?? 0) + 1;
    if (typeof m.content === 'string') {
      totalContentChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      const parts = m.content as ReadonlyArray<MiniMaxWireContentPart>;
      for (const p of parts) {
        if (p.type === 'text') totalContentChars += p.text.length;
      }
    }
  }
  const referencedToolCallIds = new Set<string>();
  for (const m of request.messages) {
    if (m.toolCalls) for (const tc of m.toolCalls) referencedToolCallIds.add(tc.id);
    if (m.toolCallId) referencedToolCallIds.add(m.toolCallId);
  }
  // Coarse body length proxy: each text character ~ 1 byte in the
  // serialized UTF-8 envelope. Not exact (tool schemas / control
  // fields add bytes) but the diagnostic value is the order of
  // magnitude, not the precise count.
  return {
    dialect,
    model: request.model,
    messageCountByRole: counts,
    toolCount: request.tools?.length ?? 0,
    referencedToolCallIds: Array.from(referencedToolCallIds),
    hasSystem: request.systemPrompt !== undefined && request.systemPrompt.length > 0,
    hasThinking: request.thinking !== undefined,
    cacheMarkerCount: request.cacheMarkers?.length ?? 0,
    approxContentChars: totalContentChars,
  };
}

/**
 * Build a STRUCTURAL summary of an error response body for a log
 * call. Tries to parse the body as JSON; falls back to a
 * `{ bodyParseFailed: true }` marker so the failure is
 * diagnosable without exposing HTML / echoed input / etc.
 */
function summarizeErrorBody(
  bodyText: string,
): {
  errorType?: string;
  errorMessage?: string;
  errorCode?: string | number;
  bodyParseFailed?: true;
} {
  if (bodyText.length === 0) return { bodyParseFailed: true };
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!isObject(parsed)) return { bodyParseFailed: true };
    const errorBlock = parsed['error'];
    if (!isObject(errorBlock)) {
      const topType = parsed['type'];
      const out: { errorType?: string; errorMessage?: string; errorCode?: string | number } = {};
      if (typeof topType === 'string') out.errorType = topType;
      return out;
    }
    const out: { errorType?: string; errorMessage?: string; errorCode?: string | number } = {};
    const typeField = errorBlock['type'];
    const messageField = errorBlock['message'];
    const codeField = errorBlock['code'];
    if (typeof typeField === 'string') out.errorType = typeField;
    if (typeof messageField === 'string') out.errorMessage = messageField;
    if (typeof codeField === 'number' || typeof codeField === 'string') {
      out.errorCode = codeField;
    }
    return out;
  } catch {
    return { bodyParseFailed: true };
  }
}

/**
 * Parse the MiniMax error envelope shape used by `summarizeErrorBody`
 * to also produce the user-facing error-message string appended
 * to `MiniMax returned <status>`. Same parse logic; returns the
 * `{ message }` field if present.
 */
function parseMiniMaxErrorBody(bodyText: string): { message?: string } {
  if (bodyText.length === 0) return {};
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!isObject(parsed)) return {};
    const errorBlock = parsed['error'];
    if (!isObject(errorBlock)) return {};
    const messageField = errorBlock['message'];
    if (typeof messageField === 'string') {
      return { message: messageField };
    }
    return {};
  } catch {
    return {};
  }
}

function defaultDialectFor(model: string): MiniMaxDialect {
  // M3 is the only MiniMax M-series model that advertises native
  // Anthropic-style thinking blocks. Every other model (M2.7, M2.5,
  // M2, M1, and any unknown future M-series id) routes through the
  // OpenAI-compatible endpoint. M3-only Anthropic routing is set
  // explicitly by the chat-provider via `request.dialect` so this
  // fallback is rarely hit; it exists so a misconfigured caller
  // still reaches the right endpoint for the most-popular model.
  return model === 'MiniMax-M3' ? 'anthropic' : 'openai';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      (typeof (err as { code?: unknown }).code === 'string' &&
        ((err as { code?: string }).code === 'ABORT_ERR' ||
          (err as { code?: string }).code === '20')))
  );
}

function isRetriableNetworkError(err: unknown): boolean {
  if (!isObject(err)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    return (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNREFUSED' ||
      code === 'EPIPE' ||
      code === 'ENOTFOUND'
    );
  }
  return false;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

interface BackoffOpts {
  attempt: number;
  initialMs: number;
  maxMs: number;
  retryAfterMs?: number;
}

function computeBackoff(opts: BackoffOpts): number {
  if (opts.retryAfterMs !== undefined) {
    return Math.min(opts.retryAfterMs, opts.maxMs);
  }
  const exp = opts.initialMs * 2 ** (opts.attempt - 1);
  const capped = Math.min(exp, opts.maxMs);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(capped * 0.25)));
  return capped + jitter;
}

// Re-export the wire-call shape from the port so consumers can use
// the adapter's types without importing the port module separately.
export type { MiniMaxWireToolCall };
