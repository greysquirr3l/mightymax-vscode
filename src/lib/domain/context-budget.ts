/**
 * Dynamic `max_tokens` clamping (pure).
 *
 * MiniMax rejects a request whose `input_tokens + max_tokens` exceeds
 * the model's context window (HTTP 400). A fixed `max_tokens` is
 * therefore either wasteful early in a conversation or illegal late in
 * one. The effective value is the configured ceiling, reduced by what
 * the input already occupies:
 *
 *   effective = clamp(contextWindow − estimatedInput − margin, floor, configured)
 *
 * The floor keeps a nearly full context from asking for a uselessly
 * small output; if the floor itself overflows, the server's own
 * context error is the honest signal, and compaction is the remedy.
 */

import type { MiniMaxWireMessage, MiniMaxToolDefinition } from '../../ports/minimax-client.js';

export const DYNAMIC_MAX_TOKENS_FLOOR = 16_384;
export const DYNAMIC_MAX_TOKENS_SAFETY_MARGIN = 2_048;

/** Characters per token for the estimate. Under-counts chars-per-token on purpose (over-counts tokens). */
const CHARS_PER_TOKEN = 3;
/** Flat cost per inline image / video block; their base64 length says little about token cost. */
const IMAGE_TOKENS = 2_000;
const VIDEO_TOKENS = 8_000;

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough input-token estimate for a request. Deliberately pessimistic. */
export function estimateInputTokens(
  messages: ReadonlyArray<MiniMaxWireMessage>,
  tools: ReadonlyArray<MiniMaxToolDefinition> | undefined,
  systemPrompt: string | undefined,
): number {
  let total = systemPrompt === undefined ? 0 : textTokens(systemPrompt);
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += textTokens(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') total += textTokens(part.text);
        else if (part.type === 'thinking') total += textTokens(part.thinking);
        else if (part.type === 'video_url') total += VIDEO_TOKENS;
        else total += IMAGE_TOKENS;
      }
    }
    for (const call of message.toolCalls ?? []) {
      total += textTokens(call.function.name) + textTokens(call.function.arguments);
    }
  }
  if (tools !== undefined) total += textTokens(JSON.stringify(tools));
  return total;
}

/**
 * Clamp the configured output ceiling to the room left in the context
 * window. `contextWindow` is input + output capacity of the model.
 */
export function clampMaxTokensToContext(
  configured: number,
  contextWindow: number,
  estimatedInputTokens: number,
): number {
  const room = contextWindow - estimatedInputTokens - DYNAMIC_MAX_TOKENS_SAFETY_MARGIN;
  return Math.min(configured, Math.max(DYNAMIC_MAX_TOKENS_FLOOR, room));
}
