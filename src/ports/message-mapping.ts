/**
 * message-mapping — port for the VS Code ↔ MiniMax message and
 * response-part mapping.
 *
 * T04 lives mostly in `src/lib/domain/messages.ts`; this port file
 * is the boundary that re-exports the relevant `vscode` types and
 * defines the domain-neutral types the mapping functions operate
 * on. The domain layer is forbidden from importing `vscode`, so
 * the chat-provider (T07) is responsible for converting between
 * `vscode.LanguageModelChatRequestMessage` and the `ChatMessage`
 * alias below before calling the domain functions.
 *
 * The contract this port captures:
 *  - `ChatMessage` / `ChatMessageContentPart` / `ChatMessageRole`
 *    are the framework-free aliases the domain maps. They mirror
 *    the shape of the corresponding `vscode` types so the
 *    adapter boundary stays a thin struct-by-struct copy.
 *  - `ChatResponsePart` is the domain-neutral output of mapping
 *    MiniMax stream deltas to vscode response parts: text,
 *    thinking (reasoning), usage data, and tool calls. The
 *    `usage` shape is a normalized view of MiniMax token counts
 *    (prompt / completion / cache) the chat-provider emits as
 *    a `LanguageModelDataPart` payload.
 *  - `MessageMappingError` is the discriminated union of typed
 *    errors the mapping may surface (unsupported content,
 *    missing role, malformed image, unknown role, empty
 *    message). The T04 spec mandates that one malformed
 *    message or delta must not abort the turn — these errors
 *    are returned from the mapping functions rather than
 *    thrown, and the transport (T05) is expected to log and
 *    skip the offending piece.
 *  - `toLanguageModelTextPart` /
 *    `toLanguageModelToolCallPart` /
 *    `toLanguageModelToolResultPart` are the convenience handles
 *    the chat-provider uses to convert a `ChatResponsePart` back
 *    into a `vscode` value class.
 *
 * `LanguageModelThinkingPart` and `LanguageModelDataPart` are not
 * available in `@types/vscode` 1.104 — the T04 spec is written for
 * a future API. The mapper still produces the domain-neutral
 * `ChatResponsePart` shape; the chat-provider (T07) is responsible
 * for emitting the right `vscode` value class (e.g. by
 * constructing a `LanguageModelTextPart` for thinking content, or
 * by emitting usage in an `unknown` part the host can introspect).
 */

import {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode';
import type { LanguageModelChatMessageRole, LanguageModelChatRequestMessage } from 'vscode';

import type { ChatToolCallPart, ChatToolResultPart } from './tool-schema.js';

// Re-exports of vscode types so the chat-provider (T07) can
// reference them via this port file rather than importing vscode
// directly in its provider code.
export type { LanguageModelChatMessageRole, LanguageModelChatRequestMessage };

/**
 * A domain-neutral message role. The full `vscode.LanguageModelChatMessageRole`
 * enum also includes `Function` and a `System`-shaped role; T04 only
 * handles `User` and `Assistant` in the request — `System` is the
 * responsibility of the chat-provider (the extension does not
 * surface a system prompt in T04; future tasks may add one).
 * `Function` does not appear in request messages; the transport
 * handles it as part of the streaming response.
 */
export type ChatMessageRole = 'user' | 'assistant';

/**
 * A domain-neutral part that can appear in a chat message content
 * array. Mirrors the union of `vscode` message content types: text,
 * images, tool calls (from prior assistant responses), and tool
 * results (user feedback on tool execution).
 *
 * The variants intentionally mirror the vscode types 1:1 so the
 * chat-provider (T07) boundary stays a thin struct-by-struct copy.
 */
export type ChatMessageContentPart =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'image';
      readonly mimeType: string;
      readonly data: Uint8Array;
    }
  | { readonly type: 'tool-call'; readonly toolCall: ChatToolCallPart }
  | { readonly type: 'tool-result'; readonly toolResult: ChatToolResultPart }
  | {
      readonly type: 'thinking';
      readonly value: string;
      readonly signature?: string;
    };

/**
 * A domain-neutral chat message, mirroring
 * `vscode.LanguageModelChatRequestMessage` with relaxations:
 *  - `role` is narrowed to exclude `Function` and `System`.
 *  - `content` is a list of domain-neutral parts (not `vscode` types).
 *  - `name` is optional (used by tool-result messages for the tool
 *    name in the request; not surfaced in the wire — VS Code
 *    conveys tool identity via the matching `tool_call_id`).
 */
export interface ChatMessage {
  readonly role: ChatMessageRole;
  readonly content: ReadonlyArray<ChatMessageContentPart>;
  readonly name?: string | undefined;
}

/**
 * Normalized usage data the chat-provider emits as the payload of
 * a `LanguageModelDataPart`. The MiniMax wire may emit usage in
 * two shapes (the OpenAI-compatible chunk includes
 * `prompt_tokens` / `completion_tokens`; the Anthropic-compatible
 * chunk includes `cache_read_input_tokens` /
 * `cache_creation_input_tokens`). T04 normalizes both into this
 * shape; the chat-provider (T07) wraps it in a
 * `LanguageModelDataPart` so the context-window widget can read
 * it.
 */
export interface ChatUsageData {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreateTokens?: number;
}

/**
 * A domain-neutral response part, the output of mapping MiniMax
 * deltas to VS Code. Includes text, thinking (reasoning), usage
 * data, and tool calls. Thinking parts are NEVER emitted as
 * visible text; they surface via `LanguageModelThinkingPart` only.
 *
 * The signature field on thinking parts (M3 only) MUST be preserved
 * and returned in the next request to maintain the reasoning chain.
 */
export type ChatResponsePart =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'thinking'; readonly value: string; readonly signature?: string }
  | { readonly type: 'usage'; readonly usage: ChatUsageData }
  | { readonly type: 'tool-call'; readonly toolCall: ChatToolCallPart };

/**
 * Discriminated union of typed errors the message mapping may
 * surface. The transport (T05) and chat-provider (T07) translate
 * these into chat errors VS Code can surface to the user without
 * crashing the host. `kind` is present on every variant, so a
 * single `isMessageMappingError` guard narrows the type.
 */
export type MessageMappingError =
  | { readonly kind: 'missing-role' }
  | { readonly kind: 'unsupported-content'; readonly reason: string }
  | { readonly kind: 'malformed-image'; readonly reason: string }
  | { readonly kind: 'unknown-message-role'; readonly rawRole: unknown }
  | { readonly kind: 'empty-message'; readonly role: ChatMessageRole };

/**
 * Type guard for `MessageMappingError`. The `kind` discriminator
 * is present on every variant of the union, so a single guard
 * narrows the type. Use this at consumer boundaries (T05, T07,
 * tests) instead of `'kind' in x` — the `in` operator's type
 * constraint requires the key to be in the union's key
 * intersection, and `MessageMappingError`'s variant keys are not
 * in common with the rest of the chat response, so the `in`
 * narrowing would fail to compile.
 */
export function isMessageMappingError(x: unknown): x is MessageMappingError {
  return (
    typeof x === 'object' &&
    x !== null &&
    'kind' in x &&
    typeof (x).kind === 'string'
  );
}

/**
 * Collapse a mapping-warning list into one entry per distinct
 * warning with an occurrence count, preserving first-seen order.
 * A large chat history re-maps in full on every request, so the
 * same warning (e.g. the Anthropic pre-flight's "empty assistant
 * text part dropped") can repeat once per historical message —
 * hundreds of identical log lines per request. Consumers log one
 * line per distinct warning instead. Non-warning entries are
 * skipped via `isMessageMappingError`.
 */
export function countMessageMappingErrors(
  warnings: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly error: MessageMappingError; readonly count: number }> {
  const byKey = new Map<string, { error: MessageMappingError; count: number }>();
  for (const w of warnings) {
    if (!isMessageMappingError(w)) continue;
    // The variants are flat records of JSON-safe primitives
    // (`rawRole: unknown` is the one hole — a circular value makes
    // stringify throw), so the serialized form is a stable
    // identity key. Unserializable warnings are kept distinct:
    // never merge what cannot be compared.
    let key: string;
    try {
      key = JSON.stringify(w);
    } catch {
      key = `unserializable:${byKey.size}:${w.kind}`;
    }
    const entry = byKey.get(key);
    if (entry !== undefined) {
      entry.count += 1;
    } else {
      byKey.set(key, { error: w, count: 1 });
    }
  }
  return [...byKey.values()];
}

/**
 * Convenience: build a `vscode.LanguageModelTextPart` from a
 * domain `ChatResponsePart.text` (or `.thinking`, until the
 * LanguageModelThinkingPart API lands in @types/vscode). The
 * chat-provider (T07) uses this to convert the mapping's output
 * back into a vscode value class.
 */
export function toLanguageModelTextPart(value: string): LanguageModelTextPart {
  return new LanguageModelTextPart(value);
}

/**
 * Convenience: build a `vscode.LanguageModelToolCallPart` from a
 * domain `ChatResponsePart.toolCall`. The chat-provider (T07)
 * uses this when the assistant's streaming response emits a
 * tool call.
 */
export function toLanguageModelToolCallPart(toolCall: ChatToolCallPart): LanguageModelToolCallPart {
  return new LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input);
}

/**
 * Convenience: build a `vscode.LanguageModelToolResultPart` from
 * a domain `ChatToolResultPart`. The chat-provider (T07) uses
 * this when round-tripping a tool result back through a request.
 */
export function toLanguageModelToolResultPart(
  toolResult: ChatToolResultPart,
): LanguageModelToolResultPart {
  return new LanguageModelToolResultPart(toolResult.callId, [
    new LanguageModelTextPart(
      Array.isArray(toolResult.content)
        ? toolResult.content
            .map((piece) => (typeof piece === 'string' ? piece : JSON.stringify(piece)))
            .join('\n')
        : JSON.stringify(toolResult.content),
    ),
  ]);
}
