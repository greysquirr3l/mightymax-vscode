import type { Logger } from './logger.js';

/**
 * A single content part of a MiniMax wire message. The OpenAI-compatible
 * wire spec expresses a multi-part user message as an array of these
 * (text + image_url). The MiniMax endpoint accepts the same shape on
 * the `/v1/chat/completions` route. T04 produces these from VS Code
 * `ChatMessage` content parts; the transport (T05) serializes them.
 *
 * The 'thinking' type is M3 Anthropic-specific and carries the signed
 * reasoning block that MUST be preserved across turns.
 */
export type MiniMaxWireContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image_url';
      readonly image_url: {
        readonly url: string;
        readonly detail?: 'low' | 'high' | 'auto' | undefined;
      };
    }
  | {
      readonly type: 'thinking';
      readonly thinking: string;
      readonly signature?: string;
    };

/**
 * Wire-level MiniMax message. The full rich message shape (with images,
 * tool calls, etc.) is built in the domain layer's message mapper
 * (T04); this port is the *transport* contract, not the model contract.
 *
 * `content` is either a plain string (the common case) or a list of
 * content parts (when the message carries images). The discriminator
 * the transport uses to decide serialization is the runtime type of
 * `content` — `typeof content === 'string'`.
 */
export interface MiniMaxWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ReadonlyArray<MiniMaxWireContentPart>;
  /** Set when role is 'tool' — the tool call id this result answers. */
  toolCallId?: string;
  /** Tool calls emitted by the assistant; populated on assistant turns. */
  toolCalls?: ReadonlyArray<MiniMaxWireToolCall>;
}

export interface MiniMaxWireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface MiniMaxToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface MiniMaxCompletionRequest {
  model: string;
  messages: ReadonlyArray<MiniMaxWireMessage>;
  tools?: ReadonlyArray<MiniMaxToolDefinition>;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  /**
   * Nucleus sampling. The M-series is tuned at `topP=0.95`; omitting
   * the field falls back to the upstream default which produces
   * noticeably different outputs (opencode `transform.ts:314-322`).
   */
  topP?: number;
  /**
   * Top-K sampling. The M-series is tuned at `topK=20-40`; omitting
   * the field falls back to the upstream default (opencode
   * `transform.ts:324-334`).
   */
  topK?: number;
  maxTokens?: number;
  stream: true;
  /**
   * Optional dialect override. When omitted, the transport picks
   * `'anthropic'` for M3 (M3 is the only model with native thinking
   * blocks) and `'openai'` for everything else.
   */
  dialect?: MiniMaxDialect;
  /**
   * M3 native thinking configuration. The Anthropic-compatible
   * interface defaults thinking **off** (unlike Chat Completions);
   * the chat-provider must opt in explicitly with an enabled or
   * adaptive block. See `getThinkingConfig` in
   * `src/lib/domain/anthropic-transform.ts`.
   */
  thinking?: {
    type: 'enabled' | 'adaptive' | 'disabled';
    budgetTokens?: number;
  };
  /**
   * Optional system prompt the chat-provider prepends to the
   * request. When omitted, no system message is sent (the
   * Anthropic endpoint accepts requests with empty system).
   */
  systemPrompt?: string;
  /**
   * 1-indexed positions of messages in `messages` that should
   * receive `cache_control: { type: 'ephemeral' }` when
   * serialized for the Anthropic dialect. Computed by
   * `mapRequestToMiniMax` (the last 1-2 messages in user
   * history). When omitted, no cache markers are stamped; the
   * system block is still cached.
   */
  cacheMarkers?: ReadonlyArray<number>;
}

export interface MiniMaxUsageDelta {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
}

export interface MiniMaxStreamEvent {
  /** Incremental text token from the assistant. */
  textDelta?: string;
  /**
   * M2.x OpenAI-style reasoning content. The MiniMax OpenAI-compatible
   * stream emits `delta.reasoning_content` as a sibling of
   * `delta.content`; the transport (T05) surfaces it as a separate
   * `reasoningDelta` event. Mapped to `LanguageModelThinkingPart` by
   * T04 — NEVER emitted as visible text.
   */
  reasoningDelta?: string;
  /**
   * M3 Anthropic-style thinking content block. The Anthropic-compatible
   * stream emits a `delta.type = 'thinking_delta'` event with a
   * `delta.thinking` field; the transport (T05) surfaces it as a
   * `thinkingDelta` event after the per-block split. Mapped to
   * `LanguageModelThinkingPart` by T04.
   *
   * The `signature` field is the cryptographic signature of the thinking
   * block (M3 only). When present, it MUST be preserved and returned in
   * the next request to maintain the reasoning chain.
   */
  thinkingDelta?: string;
  thinkingSignature?: string;
  /** Incremental tool-call argument token; accumulator logic lives in T03. */
  toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string };
  /** Final usage block; emitted once at the end of the stream. */
  usage?: MiniMaxUsageDelta;
  /** Terminal marker. */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  /** Terminal error payload, if the stream aborted. */
  error?: { message: string; code?: string; retriable: boolean };
}

/**
 * MiniMaxClient — streaming transport port.
 *
 * Implemented in `src/adapters/transport.ts` (T05). The implementation
 * talks to platform.minimax.io over SSE in either OpenAI-compatible or
 * Anthropic-compatible dialect; the dialect is selected per request from
 * the model id (M3 → Anthropic, everything else → OpenAI) and can be
 * overridden with `MiniMaxCompletionRequest.dialect`. Authentication is
 * supplied by the caller via `apiKey` — the adapter never persists it.
 */
export interface MiniMaxClient {
  /**
   * Open a streaming completion. Yields events until the stream terminates.
   * Throws on transport-level failures (DNS, TLS, non-2xx HTTP, rate-limit
   * exhaustion, parse errors); per-event stream errors arrive as
   * `MiniMaxStreamEvent.error` and do not throw.
   */
  streamCompletion(
    request: MiniMaxCompletionRequest,
    apiKey: string,
    signal: AbortSignal,
    logger: Logger,
  ): AsyncIterable<MiniMaxStreamEvent>;
}

/**
 * Dialect hint for the transport. The default selector in T05 picks
 * `'anthropic'` for M3 and `'openai'` for everything else; an explicit
 * `dialect` on the request wins over the default.
 */
export type MiniMaxDialect = 'openai' | 'anthropic';

/**
 * Typed error envelope. The chat-provider (T07) catches this and
 * surfaces it as a chat error so the extension host never crashes.
 *
 * `kind` discriminates the failure mode:
 *  - `auth`        — 401/403; the API key is invalid or revoked.
 *  - `rate-limit`  — 429 after the bounded retry budget is exhausted.
 *  - `http`        — non-2xx status that is not auth or rate-limit.
 *  - `network`     — DNS, TLS, connection reset, fetch threw.
 *  - `parse`       — SSE bytes could not be decoded or contained
 *                    malformed JSON.
 *  - `abort`       — caller cancelled the request via AbortSignal.
 */
export type MiniMaxClientErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'http'
  | 'network'
  | 'parse'
  | 'abort'
  /**
   * The server completed a streaming response without ever sending
   * a terminal marker (no `finishReason`, no `message_stop`). The
   * client was left waiting for an event that never came; the wall-
   * clock elapsed time typically exceeds 30 seconds. Distinct from
   * `http` (which is for non-2xx response status) and `network`
   * (which is for transport-level failures): an abandoned request
   * succeeded in HTTP terms but never produced a usable response.
   * The chat-provider (T07) catches this and surfaces a user-visible
   * chat error so a turn that returned "I'll build X now" with no
   * follow-up execution is not silently swallowed.
   */
  | 'abandoned'
  /**
   * A watchdog cut a connection the server left hanging: either no
   * response headers arrived within the first-byte budget (after
   * bounded retries), or an open stream went silent mid-flight for
   * longer than the idle budget. Distinct from `abandoned` (the
   * stream ENDED without a finish marker) — a stalled stream never
   * ended on its own; the client cut it. Stalls that occur before
   * the first event was delivered are retried transparently by the
   * transport; only post-first-event stalls and exhausted retry
   * budgets surface to the chat-provider.
   */
  | 'stall';

export class MiniMaxClientError extends Error {
  public readonly kind: MiniMaxClientErrorKind;
  public readonly status?: number;
  public readonly retriable: boolean;

  constructor(
    kind: MiniMaxClientErrorKind,
    message: string,
    options: { status?: number; retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MiniMaxClientError';
    this.kind = kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    this.retriable = options.retriable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
