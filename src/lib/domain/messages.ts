/**
 * Domain: bidirectional VS Code ↔ MiniMax message and response-part
 * mapping.
 *
 * Pure, framework-free. T04 implements:
 *  - `mapRequestToMiniMax`        — VS Code chat messages → MiniMax
 *                                    wire messages.
 *  - `mapStreamDeltaToResponseParts` — MiniMax stream events →
 *                                    VS Code response parts.
 *  - `mapMiniMaxUsage`            — normalize token counts to the
 *                                    `ChatUsageData` shape.
 *  - `extractAnthropicThinking`   — pull M3 thinking blocks out of
 *                                    an interleaved text delta
 *                                    (defensive; the transport
 *                                    normally splits them into
 *                                    `thinkingDelta` events).
 *
 * The domain layer is forbidden from importing `vscode` or any
 * HTTP module; the `src/lib/no-vscode.test.ts` guard enforces
 * that statically. Image bytes are encoded to base64 using the
 * `btoa` global (Node ≥ 16, browser) so the file does not need to
 * import `Buffer` from `node:buffer`.
 *
 * Errors are returned as `MessageMappingError` envelopes from the
 * port; the transport (T05) and chat-provider (T07) translate
 * those into chat errors VS Code can surface to the user without
 * crashing the host. One malformed message or delta does not
 * abort the turn — the mapper skips the offending part, surfaces
 * a warning, and continues with what remains.
 */

import type {
  ChatMessage,
  ChatResponsePart,
  ChatUsageData,
  MessageMappingError,
} from '../../ports/message-mapping.js';
import { isMessageMappingError } from '../../ports/message-mapping.js';
import type {
  MiniMaxStreamEvent,
  MiniMaxWireContentPart,
  MiniMaxWireMessage,
} from '../../ports/minimax-client.js';
import type { ThinkingStyle } from '../../ports/model-catalog.js';
import { mapToolResultToMiniMax } from './tools.js';
import {
  applyAnthropicRequestTransform,
  sanitizeSurrogates,
  type AnthropicTransformWarning,
} from './anthropic-transform.js';

// Re-export the port types so the test file and any future
// consumer can import everything the domain exports from one
// place. The domain is the canonical owner of these types as
// far as the rest of the codebase is concerned — the port is
// a thin boundary that mirrors them.
export type {
  ChatMessage,
  ChatMessageContentPart,
  ChatMessageRole,
  ChatResponsePart,
  ChatUsageData,
  MessageMappingError,
} from '../../ports/message-mapping.js';
export { isMessageMappingError };

// ─────────────────────────────────────────────────────────────────────────────
// Image encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Image MIME types MiniMax accepts on the OpenAI-compatible
 * endpoint. The Anthropic-compatible endpoint accepts the same
 * set; the transport (T05) translates the data URI to the right
 * Anthropic image-block shape if needed. Anything outside this
 * set is rejected with a `malformed-image` typed error.
 */
const ALLOWED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/**
 * Encode a `Uint8Array` to base64 using the `btoa` global. We
 * use the `btoa` path (not `Buffer`) so the file is portable
 * between the VS Code extension host and the browser — the
 * transport (T05) runs in the extension host (Node 20) and the
 * unit tests run under mocha in Node 20; both have `btoa` as a
 * global.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function buildImageContentPart(
  mimeType: string,
  data: Uint8Array,
): MiniMaxWireContentPart | MessageMappingError {
  const normalized = mimeType.toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(normalized)) {
    return {
      kind: 'malformed-image',
      reason: `unsupported MIME type: ${mimeType}`,
    };
  }
  if (data.byteLength === 0) {
    return {
      kind: 'malformed-image',
      reason: 'image data is empty',
    };
  }
  const dataUri = `data:${normalized};base64,${bytesToBase64(data)}`;
  return { type: 'image_url', image_url: { url: dataUri } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: VS Code chat messages -> MiniMax wire messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model information the inbound mapper consults. Today the mapper
 * only needs to recognize the model id for diagnostic warnings; the
 * outbound mapper (T05 transport) consults `thinkingStyle` to pick
 * the wire schema. T04 keeps the same shape on the inbound side
 * for symmetry.
 */
export interface MessageMappingModel {
  readonly id: string;
  readonly thinkingStyle: ThinkingStyle;
}

/**
 * Result of `mapRequestToMiniMax`. The `messages` array is the
 * list of wire messages to send to MiniMax; the `warnings`
 * array is the typed errors the mapper skipped along the way.
 * The chat-provider (T07) is expected to log the warnings at
 * `warn` level and continue with `messages`.
 *
 * `cacheMarkers` is the list of 1-indexed positions in `messages`
 * to receive `cache_control: { type: 'ephemeral' }` when the
 * request is serialized for the Anthropic dialect. System messages
 * are always cached first; these markers stamp the last 1-2 user
 * history messages so the conversation tail is reused across
 * requests (opencode `applyCaching` pattern).
 */
export interface MessageMappingResult {
  readonly messages: ReadonlyArray<MiniMaxWireMessage>;
  readonly warnings: ReadonlyArray<MessageMappingError>;
  readonly cacheMarkers: ReadonlyArray<number>;
}

/**
 * A frozen empty options object. The function takes an options
 * argument reserved for future tool-mode wiring (T05 / T07); the
 * default value lets the test file call the function without
 * passing `{}` explicitly.
 */
const EMPTY_OPTIONS: Record<string, unknown> = Object.freeze({});

/**
 * Convert a list of VS Code chat request messages to MiniMax wire
 * messages. The function is total over `ChatMessage` input —
 * every malformed input surfaces a typed warning in
 * `result.warnings` and is skipped; the remaining parts are
 * mapped. Order is preserved.
 *
 * Per-message rules:
 *  - All text parts are joined with `'\n'`.
 *  - Image parts are encoded to a `data:` URI on the
 *    `image_url` wire shape; unsupported MIME types and empty
 *    data emit a `malformed-image` warning.
 *  - Tool-result parts are projected to a `role: 'tool'` wire
 *    message with the call id preserved. They bypass the
 *    text/image content array.
 *  - Tool-call parts in user-supplied request content emit an
 *    `unsupported-content` warning and are skipped — the model
 *    has the wire history of the prior assistant turn.
 *  - A final reconciliation pass drops any `tool` wire message
 *    whose `toolCallId` does not match a `tool_call` id from the
 *    immediately preceding assistant turn. Anthropic rejects the
 *    request outright (error 2013, "tool result's tool id not
 *    found") if a `tool_result` references a `tool_use_id` that
 *    the assistant never emitted, and the chat-provider's
 *    history scrubber can occasionally emit a `tool-result` part
 *    whose `tool-call` half was already dropped on a previous
 *    turn. The reconciler closes the gap and surfaces a warning.
 *  - An empty `content` array emits an `empty-message` warning
 *    and the message is dropped from the output.
 */
export function mapRequestToMiniMax(
  model: MessageMappingModel,
  messages: ReadonlyArray<ChatMessage>,
  // Reserved for future tool-mode wiring (T05). Kept as a positional
  // arg so the chat-provider can pass a fresh options object per
  // request.
  _options: Record<string, unknown> = EMPTY_OPTIONS,
): MessageMappingResult {
  void model;
  const wireMessages: MiniMaxWireMessage[] = [];
  const warnings: MessageMappingError[] = [];
  // Ids of `tool_use` blocks the mapper has emitted on assistant
  // turns (in call order, deduplicated). The reconciler at the end
  // of the function consults this set to decide whether each
  // `tool` wire message has a valid `toolCallId` reference.
  const assistantToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      warnings.push({ kind: 'unknown-message-role', rawRole: msg.role });
      continue;
    }

    const textParts: string[] = [];
    const richParts: MiniMaxWireContentPart[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const thinkingParts: Array<{ thinking: string; signature?: string }> = [];
    let sawAnyPart = false;

    for (const part of msg.content) {
      sawAnyPart = true;
      if (part.type === 'text') {
        // Sanitize surrogate code points inline. Anthropic returns
        // HTTP 400 for strings with unpaired UTF-16 surrogates; the
        // most common source is VS Code tool results that include
        // raw file / terminal / error output.
        textParts.push(sanitizeSurrogates(part.value));
        continue;
      }
      if (part.type === 'thinking') {
        // Accumulate thinking parts to prepend to assistant messages
        // (M3 Anthropic requirement: thinking must precede text/tool_use)
        if (msg.role === 'assistant') {
          const fixed = sanitizeSurrogates(part.value);
          const thinkingPart: { thinking: string; signature?: string } = { thinking: fixed };
          if (part.signature) thinkingPart.signature = part.signature;
          thinkingParts.push(thinkingPart);
        } else {
          // Thinking in user messages is ignored (shouldn't happen in practice)
          warnings.push({
            kind: 'unsupported-content',
            reason: 'thinking part in user message (only assistant messages can have thinking)',
          });
        }
        continue;
      }
      if (part.type === 'image') {
        const encoded = buildImageContentPart(part.mimeType, part.data);
        if (isMessageMappingError(encoded)) {
          warnings.push(encoded);
        } else {
          richParts.push(encoded);
        }
        continue;
      }
      if (part.type === 'tool-call') {
        if (msg.role !== 'assistant') {
          // T18: HOIST, do not drop. VS Code history can present a
          // tool-call part inside a user-role message (the
          // chat-provider's history scrubber does not preserve the
          // role strictly). The original behavior emitted an
          // `unsupported-content` warning and skipped the part —
          // leaving the next user message's tool-result orphaned
          // (which the reconciler then dropped, silencing the 400
          // but destroying tool output). We now synthesize a
          // MINIMAL assistant turn at this position carrying the
          // tool_use so the matching tool_result on the next user
          // turn has a valid `tool_use_id` reference.
          //
          // The synthesized assistant turn is pushed into the wire
          // list immediately (alongside the accumulating user-role
          // wire message being built) so the wire order is:
          //   [...prior..., user_with_tool_call, *hoisted_assistant*]
          //
          // Other user-role parts (text, images, tool-results) on
          // the same message continue to accumulate on the
          // user-role wire message — the hoist is purely additive.
          warnings.push({
            kind: 'unsupported-content',
            reason:
              'tool-call in user request content (hoisted into synthesized assistant turn)',
          });
          const hoistedId = part.toolCall.callId;
          const hoistedName = part.toolCall.name;
          wireMessages.push({
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: hoistedId,
                type: 'function',
                function: {
                  name: hoistedName,
                  arguments: JSON.stringify(part.toolCall.input ?? {}),
                },
              },
            ],
          });
          if (hoistedId.length > 0) assistantToolCallIds.add(hoistedId);
          continue;
        }
        // Tool calls from assistant history need to be preserved so that
        // corresponding tool_results can reference them by ID.
        const callId = part.toolCall.callId;
        toolCalls.push({
          id: callId,
          name: part.toolCall.name,
          arguments: JSON.stringify(part.toolCall.input ?? {}),
        });
        if (callId.length > 0) {
          assistantToolCallIds.add(callId);
        }
        continue;
      }
      if (part.type === 'tool-result') {
        const mapped = mapToolResultToMiniMax(part.toolResult);
        // T03's mapper returns a `MiniMaxWireMessage | ToolSchemaError`
        // — discriminate on `role === 'tool'` (the only valid role
        // for a tool result wire message). Anything else is a
        // T03-typed error we surface as a T04 unsupported-content
        // warning.
        if ('role' in mapped && mapped.role === 'tool') {
          // mapped.content is `string | ReadonlyArray<...>`; the T03
          // mapper always returns a string for tool results, so the
          // string branch is the one that fires here. The defensive
          // stringify guarantees a primitive string lands on the
          // wire even if T03 ever returns a structured value
          // (the T03 mapper currently always returns a string, but
          // this is the right place to enforce the contract for
          // the Anthropic dialect, which demands a primitive).
          const raw = mapped.content;
          const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
          toolResults.push({
            callId: mapped.toolCallId ?? '',
            content,
          });
        } else {
          const errorKind =
            'kind' in mapped && typeof mapped.kind === 'string'
              ? mapped.kind
              : 'tool-result-mapping-failed';
          warnings.push({
            kind: 'unsupported-content',
            reason: `tool-result mapping failed: ${errorKind}`,
          });
        }
        continue;
      }
      // Unknown part type — narrowing should be exhaustive, but if
      // a new variant is added in the port, surface a warning.
      warnings.push({
        kind: 'unsupported-content',
        reason: `unknown content part type: ${(part as { type: string }).type}`,
      });
    }

    if (!sawAnyPart) {
      warnings.push({ kind: 'empty-message', role: msg.role });
      continue;
    }

    if (
      textParts.length > 0 ||
      richParts.length > 0 ||
      toolCalls.length > 0 ||
      thinkingParts.length > 0
    ) {
      const hasImages = richParts.length > 0;
      const hasText = textParts.length > 0;
      const hasToolCalls = toolCalls.length > 0;
      const hasThinking = thinkingParts.length > 0;

      let content: string | ReadonlyArray<MiniMaxWireContentPart>;
      if (hasImages || hasThinking) {
        // Use content array for images or thinking (Anthropic requires
        // thinking blocks to be separate content parts)
        const parts: MiniMaxWireContentPart[] = [];
        // Thinking must come first in Anthropic format
        for (const tp of thinkingParts) {
          const thinkingPart: MiniMaxWireContentPart = {
            type: 'thinking',
            thinking: tp.thinking,
          };
          if (tp.signature) {
            (thinkingPart as { type: 'thinking'; thinking: string; signature?: string }).signature =
              tp.signature;
          }
          parts.push(thinkingPart);
        }
        if (hasText) {
          parts.push({ type: 'text', text: textParts.join('\n') });
        }
        parts.push(...richParts);
        content = parts;
      } else {
        content = textParts.join('\n');
      }

      const wireMsg: MiniMaxWireMessage = { role: msg.role, content };
      if (hasToolCalls && msg.role === 'assistant') {
        wireMsg.toolCalls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      wireMessages.push(wireMsg);
    } else if (msg.role === 'assistant') {
      // Assistant turn that contained no text or image parts but is
      // still a valid turn boundary (e.g. the prior assistant emitted
      // only tool calls). Emit an empty assistant message so the
      // conversation history is preserved; the model sees the next
      // user turn and continues.
      wireMessages.push({ role: 'assistant', content: '' });
    }

    for (const result of toolResults) {
      wireMessages.push({
        role: 'tool',
        content: result.content,
        toolCallId: result.callId,
      });
    }
  }

  // Reconciliation pass: ADOPT orphan tool-results rather than drop
  // them. Anthropic rejects a `tool_result` whose `tool_use_id` has
  // no matching assistant `tool_use` (error 2013, "invalid params,
  // tool result's tool id not found"). The previous behavior
  // silently dropped the orphan and emitted an
  // `unsupported-content` warning — which silenced the 400 in some
  // cases but destroyed tool output: the model re-ran the tool,
  // looped, or hallucinated. T18's spec calls for adoption: if a
  // `tool_result` arrives without a corresponding `tool_use` in the
  // assistant history, synthesize a minimal assistant turn
  // IMMEDIATELY before the orphan with a `tool_use` carrying the
  // same id. The wire stays valid and the model still sees the
  // tool output as if the call had happened.
  const reconciled: MiniMaxWireMessage[] = [];
  for (const m of wireMessages) {
    if (m.role === 'tool') {
      const callId = m.toolCallId ?? '';
      if (callId.length === 0 || !assistantToolCallIds.has(callId)) {
        // Adopt: synthesize a minimal assistant `tool_use` carrying
        // the orphan id, placed immediately before the orphan
        // `tool_result`. Name falls back to `'unknown_tool'` only
        // when the chat-provider did not preserve the original
        // function name; the user-facing assistant turn is empty
        // (text content '') and `input` is `{}` so the upstream
        // parser sees a structurally complete `tool_use`.
        reconciled.push({
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: callId,
              type: 'function',
              function: { name: 'unknown_tool', arguments: '{}' },
            },
          ],
        });
        assistantToolCallIds.add(callId);
      }
    }
    reconciled.push(m);
  }

  // Anthropic pre-flight: strip empty text parts / empty messages
  // (Anthropic rejects with 400), and return the cache-control
  // markers for the last 2 surviving messages. System messages are
  // always hoisted out of the message list by the Anthropic
  // serializer, so the transform works on user/assistant history
  // only — `applyAnthropicRequestTransform` handles system
  // separately.
  const systemTexts: string[] = [];
  const nonSystem: MiniMaxWireMessage[] = [];
  for (const m of reconciled) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : extractTextFromParts(m.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    nonSystem.push(m);
  }
  const transform = applyAnthropicRequestTransform(nonSystem, systemTexts.join('\n'));
  for (const w of transform.warnings) {
    const mw = anthropicWarningToMappingError(w);
    if (mw !== undefined) warnings.push(mw);
  }

  return { messages: transform.messages, warnings, cacheMarkers: transform.cacheMarkers };
}

function anthropicWarningToMappingError(
  w: AnthropicTransformWarning,
): MessageMappingError | undefined {
  if (w.kind === 'empty-part') {
    return { kind: 'unsupported-content', reason: `anthropic: empty ${w.role} text part dropped` };
  }
  if (w.kind === 'empty-message') {
    return { kind: 'empty-message', role: 'user' };
  }
  if (w.kind === 'surrogate-fix') {
    return {
      kind: 'unsupported-content',
      reason: 'anthropic: lone surrogate code points replaced with U+FFFD',
    };
  }
  return undefined;
}

function extractTextFromParts(
  parts: ReadonlyArray<MiniMaxWireContentPart>,
): string {
  return parts
    .filter((p): p is Extract<MiniMaxWireContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: MiniMax stream deltas -> VS Code response parts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State carried across stream deltas. Reserved for future
 * block-level tracking (e.g. an open Anthropic thinking block
 * that spans multiple text deltas in the same event). Today
 * the transport (T05) is expected to split the Anthropic stream
 * into per-block deltas, so the mapping is stateless. The
 * argument is kept for forward-compat.
 */
export interface StreamMappingState {
  // Reserved.

  readonly _placeholder?: never;
}

export function createStreamMappingState(): StreamMappingState {
  return {};
}

/**
 * Convert a single MiniMax stream event to a list of VS Code
 * response parts. The mapping is total over `MiniMaxStreamEvent`
 * — unknown event fields are ignored, and empty deltas produce
 * an empty array. One malformed delta (e.g. a usage chunk with
 * non-numeric token counts) does not abort the stream.
 *
 * Reasoning content from M2.x (`reasoningDelta`) and M3
 * (`thinkingDelta`) is NEVER emitted as visible text. Both
 * surface as `LanguageModelThinkingPart` only. The M3 transport
 * splits the Anthropic stream into per-block deltas; the mapper
 * also defensively strips `[<anthropic_thinking>...</anthropic_thinking>]`
 * markers that might still be embedded in a `textDelta` (the
 * transport is free to use either form).
 */
export function mapStreamDeltaToResponseParts(
  delta: MiniMaxStreamEvent,
  thinkingStyle: ThinkingStyle,
  _state: StreamMappingState = createStreamMappingState(),
): ReadonlyArray<ChatResponsePart | MessageMappingError> {
  void _state;
  const parts: Array<ChatResponsePart | MessageMappingError> = [];

  // 1. Text deltas — may include interleaved Anthropic thinking
  //    blocks (M3). Strip them and surface as thinking parts.
  if (delta.textDelta !== undefined && delta.textDelta.length > 0) {
    if (thinkingStyle === 'anthropic') {
      const extracted = extractAnthropicThinking(delta.textDelta);
      for (const part of extracted.parts) {
        if (part.value.length === 0) continue;
        parts.push(part.type === 'thinking' ? { type: 'thinking', value: part.value } : part);
      }
    } else {
      parts.push({ type: 'text', value: delta.textDelta });
    }
  }

  // 2. M2.x reasoning content (OpenAI-compatible wire) — surface
  //    as thinking parts, NEVER as visible text.
  if (delta.reasoningDelta !== undefined && delta.reasoningDelta.length > 0) {
    parts.push({ type: 'thinking', value: delta.reasoningDelta });
  }

  // 3. M3 Anthropic thinking content block (after the transport
  //    splits the Anthropic stream into per-block deltas) — same
  //    treatment as reasoning content. Preserve the signature if
  //    present so it can be replayed in the next request.
  if (delta.thinkingDelta !== undefined && delta.thinkingDelta.length > 0) {
    const thinkingPart: ChatResponsePart = {
      type: 'thinking',
      value: delta.thinkingDelta,
    };
    if (delta.thinkingSignature) {
      (thinkingPart as { type: 'thinking'; value: string; signature?: string }).signature =
        delta.thinkingSignature;
    }
    parts.push(thinkingPart);
  }

  // 4. Usage data — normalize and emit as a usage response part.
  if (delta.usage !== undefined) {
    parts.push({ type: 'usage', usage: mapMiniMaxUsage(delta.usage) });
  }

  return parts;
}

/**
 * Strip `[<anthropic_thinking>...</anthropic_thinking>]` blocks
 * from a text delta. The transport (T05) is expected to split
 * M3 Anthropic streams into per-block deltas, but the mapper
 * stays defensive in case the transport opts to embed the
 * blocks inline. Returns the visible text and the concatenated
 * thinking content.
 */
function extractAnthropicThinking(text: string): {
  readonly parts: ReadonlyArray<{ readonly type: 'thinking' | 'text'; readonly value: string }>;
} {
  const pattern = /\[?<anthropic_thinking>([\s\S]*?)<\/anthropic_thinking>\]?/g;
  const parts: Array<{ readonly type: 'thinking' | 'text'; readonly value: string }> = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const full = match[0];
    const content = match[1];
    const start = match.index ?? -1;
    if (start < 0 || full === undefined || content === undefined) continue;
    if (start > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, start) });
    }
    parts.push({ type: 'thinking', value: content });
    cursor = start + full.length;
  }

  if (cursor < text.length) {
    parts.push({ type: 'text', value: text.slice(cursor) });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', value: text });
  }

  return { parts };
}

/**
 * Normalize MiniMax usage deltas to a chat-provider-ready
 * `ChatUsageData` shape. The MiniMax wire may not include all
 * fields; the mapper returns only what is present.
 */
export function mapMiniMaxUsage(usage: {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreateTokens?: number;
}): ChatUsageData {
  const finiteNumber = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const out: {
    -readonly [K in keyof ChatUsageData]: ChatUsageData[K];
  } = {};
  const promptTokens = finiteNumber(usage.promptTokens);
  const completionTokens = finiteNumber(usage.completionTokens);
  const cacheReadTokens = finiteNumber(usage.cacheReadTokens);
  const cacheCreateTokens = finiteNumber(usage.cacheCreateTokens);
  if (promptTokens !== undefined) out.promptTokens = promptTokens;
  if (completionTokens !== undefined) out.completionTokens = completionTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheCreateTokens !== undefined) out.cacheCreateTokens = cacheCreateTokens;
  return out;
}
