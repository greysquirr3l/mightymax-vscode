/**
 * Domain: Anthropic-dialect request post-processing.
 *
 * Pure, framework-free. Houses the per-request helpers that adapt our
 * domain shapes to the Anthropic wire spec — the things opencode's
 * `transform.ts` does for M3 that we want to do too:
 *
 *  - `sanitizeSurrogates` strips unpaired UTF-16 surrogates from
 *    text and tool-result content. Anthropic returns HTTP 400 for
 *    strings with lone surrogates; VS Code tool results (file
 *    contents, terminal output, error pages) routinely contain them.
 *
 *  - `sanitizeAnthropicSchema` lowers a JSON Schema to the subset
 *    Anthropic's tool validator accepts. Drops `const`, `examples`,
 *    `$ref` siblings; collapses tuple `items: [a, b]` to `items: a`;
 *    ensures every object has `type: 'object'` and every array has
 *    `items`. Bounded: never invents content the upstream didn't ship.
 *
 *  - `applyAnthropicRequestTransform` is the outbound pre-flight:
 *    strips empty text parts / empty messages, sanitizes surrogate
 *    code points in every text payload, and returns a "system +
 *    last 2 messages" marker that the transport uses to stamp
 *    `cache_control: { type: 'ephemeral' }` on the request.
 *
 *  - `getModelSampler` returns the temperature / topP / topK
 *    triplet tuned for each model. M-series models are tuned at
 *    specific values; sending the SDK default (or omitting the
 *    params entirely) produces noticeably different outputs.
 *
 *  - `getMaxTokensForModel` clamps `max_tokens` so an agent turn
 *    cannot burn the whole context window on a runaway
 *    completion. M3 supports up to ~32K completion; we clamp to
 *    that.
 *
 *  - `getThinkingConfig` returns the M3-native `thinking` body
 *    block. M3's Anthropic interface defaults thinking **off**,
 *    unlike Chat Completions; the chat-provider must opt in
 *    explicitly.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

import type { ThinkingStyle } from '../../ports/model-catalog.js';
import type {
  MiniMaxWireContentPart,
  MiniMaxWireMessage,
} from '../../ports/minimax-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Surrogate sanitization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD. Anthropic returns
 * HTTP 400 for strings with unpaired surrogates (the JSON encoder
 * the model uses cannot represent them). The check matches
 * opencode's `sanitizeSurrogates` 1:1.
 *
 * The lone-surrogate detection is the inverse of a well-formed
 * surrogate pair: a high surrogate (D800-DBFF) not followed by a
 * low surrogate (DC00-DFFF) is unpaired; a low surrogate not
 * preceded by a high surrogate is unpaired.
 */
export function sanitizeSurrogates(content: string): string {
  return content.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema lowering for Anthropic tool input_schema
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'object',
  'array',
  'null',
]);

/**
 * Standard JSON Schema keywords that Anthropic's tool validator
 * passes through. Anything not in this set (or in the special
 * handling list above) is preserved verbatim so we don't drop
 * validation keywords like `minimum`, `maximum`, `pattern`,
 * `format`, `minLength`, etc.
 */
const PASSTHROUGH_KEYWORDS = new Set([
  'title',
  'description',
  'enum',
  'const',
  'type',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
  '$ref',
  '$defs',
  'definitions',
]);

/**
 * Lower a JSON Schema to the subset Anthropic's tool validator
 * accepts. The function is recursive, bounded, and never invents
 * content. Returns a new object — does not mutate the input.
 *
 * Rules:
 *  - `const` collapses to `enum: [const]`.
 *  - `$ref` siblings are dropped (Anthropic expands refs and
 *    rejects unknown sibling keywords).
 *  - Tuple `items: [a, b]` collapses to `items: a` (Anthropic
 *    requires a single schema, not an array).
 *  - Object schemas get `type: 'object'` and a `properties: {}`
 *    skeleton if missing.
 *  - Array schemas get `type: 'array'` and an `items: { type: 'string' }`
 *    skeleton if missing.
 *  - Booleans (JSON Schema's `true`/`false` schema form) are
 *    converted to `{ type: 'string' }` — Anthropic does not
 *    accept the boolean form.
 *  - `additionalProperties: false` is dropped (Anthropic rejects
 *    the strict form). `true` is preserved; a schema form is
 *    recursively lowered.
 *  - All other standard JSON Schema keywords (`minimum`,
 *    `maximum`, `pattern`, `format`, `minLength`, `maxLength`,
 *    `minItems`, `maxItems`, `uniqueItems`, `minProperties`,
 *    `maxProperties`, `default`, `examples`, `title`, `not`,
 *    `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`) are
 *    preserved verbatim. Anthropic's tool validator accepts
 *    these; dropping them would lose constraints the upstream
 *    tool author intended.
 *  - `$defs` / `definitions` keywords are preserved (lowered
 *    recursively) so a schema can reference a local definition
 *    via `#/$defs/...`.
 */
export function sanitizeAnthropicSchema(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return { type: 'string' };
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeAnthropicSchema);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const input = value as Record<string, unknown>;

  // $ref short-circuit: Anthropic expands $ref; drop every
  // sibling keyword so the upstream validator does not reject
  // unknown siblings.
  if (typeof input['$ref'] === 'string') {
    return { $ref: input['$ref'] };
  }

  const out: Record<string, unknown> = {};

  // Standard validation / annotation keywords: pass through
  // verbatim. Anthropic accepts these; opencode's
  // `sanitizeOpenAISchema` does the same.
  for (const key of PASSTHROUGH_KEYWORDS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === undefined) continue;
    if (key === 'items') {
      const items = v;
      if (Array.isArray(items)) {
        out['items'] = items.length > 0 ? sanitizeAnthropicSchema(items[0]) : { type: 'string' };
      } else {
        out['items'] = sanitizeAnthropicSchema(items);
      }
      continue;
    }
    if (key === 'additionalProperties') {
      const ap = v;
      if (ap === false) {
        // Anthropic rejects the strict form; omit the key.
        continue;
      }
      if (ap === true) {
        out['additionalProperties'] = true;
        continue;
      }
      out['additionalProperties'] = sanitizeAnthropicSchema(ap);
      continue;
    }
    if (key === 'const') {
      // Collapse `const` to `enum: [const]` — Anthropic does
      // not accept the `const` keyword on tool input schemas.
      out['enum'] = [v];
      continue;
    }
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      if (Array.isArray(v)) {
        out[key] = v.map(sanitizeAnthropicSchema);
        continue;
      }
    }
    if (key === '$defs' || key === 'definitions') {
      if (isPlainObject(v)) {
        const defs: Record<string, unknown> = {};
        for (const [name, item] of Object.entries(v)) {
          defs[name] = sanitizeAnthropicSchema(item);
        }
        out[key] = defs;
        continue;
      }
    }
    if (key === 'required') {
      if (Array.isArray(v)) {
        out['required'] = v.filter((item): item is string => typeof item === 'string');
        continue;
      }
    }
    if (key === 'properties') {
      if (isPlainObject(v)) {
        const props: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v)) {
          props[k] = sanitizeAnthropicSchema(item);
        }
        out['properties'] = props;
        continue;
      }
    }
    if (key === 'type') {
      // Handle below (validation against ANTHROPIC_SCHEMA_TYPES).
      continue;
    }
    // Pass-through: title, description, enum, format, minimum,
    // maximum, pattern, minLength, maxLength, etc.
    out[key] = v;
  }

  // Type inference + validation: pick up `type` if present, or
  // infer it from the structural keywords we just lowered.
  const typeValue = out['type'] ?? input['type'];
  const schemaTypes: string[] = [];
  if (typeof typeValue === 'string' && ANTHROPIC_SCHEMA_TYPES.has(typeValue)) {
    schemaTypes.push(typeValue);
  } else if (Array.isArray(typeValue)) {
    for (const t of typeValue) {
      if (typeof t === 'string' && ANTHROPIC_SCHEMA_TYPES.has(t)) {
        schemaTypes.push(t);
      }
    }
  }

  if (schemaTypes.length === 0) {
    if (isCompositionKey(out)) {
      return out;
    }
    const inferred = inferTypeFromKeywords(input);
    if (inferred === null) return out;
    schemaTypes.push(...inferred);
  }

  out['type'] = schemaTypes.length === 1 ? schemaTypes[0] : schemaTypes;
  if (schemaTypes.includes('object') && out['properties'] === undefined) {
    out['properties'] = {};
  }
  if (schemaTypes.includes('array') && out['items'] === undefined) {
    out['items'] = { type: 'string' };
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCompositionKey(o: Record<string, unknown>): boolean {
  return 'anyOf' in o || 'oneOf' in o || 'allOf' in o;
}

function inferTypeFromKeywords(input: Record<string, unknown>): string[] | null {
  if (
    'properties' in input ||
    'required' in input ||
    'additionalProperties' in input
  ) {
    return ['object'];
  }
  if ('items' in input || 'prefixItems' in input) {
    return ['array'];
  }
  // `const` (collapsed to `enum`) and a direct `enum` imply a
  // string-typed scalar — the typical OpenAPI shape. Without this
  // special case a `{ const: 'foo' }` schema lowers to `{}` because
  // none of the structural keywords fire.
  if ('const' in input || 'enum' in input || 'format' in input) {
    return ['string'];
  }
  if (
    'minimum' in input ||
    'maximum' in input ||
    'exclusiveMinimum' in input ||
    'exclusiveMaximum' in input ||
    'multipleOf' in input
  ) {
    return ['number'];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound pre-flight: empty strip + surrogate sanitization + cache markers
// ─────────────────────────────────────────────────────────────────────────────

export interface AnthropicTransformResult {
  /** Messages with empty parts / surrogate-fixed strings. */
  readonly messages: ReadonlyArray<MiniMaxWireMessage>;
  /**
   * Ids of the last two message positions to receive
   * `cache_control: { type: 'ephemeral' }` (1-indexed, counting
   * from the start of `messages`). The transport stamps the block
   * onto the last text or tool_use block in each of these messages.
   * System messages are always cached first; these two indices are
   * the user's-history tail.
   */
  readonly cacheMarkers: ReadonlyArray<number>;
  /** Sanitized / forwarded system string. Empty string when no
   *  system message was supplied. */
  readonly system: string;
  /** Warnings surfaced during transform. */
  readonly warnings: ReadonlyArray<AnthropicTransformWarning>;
}

export type AnthropicTransformWarning =
  | { readonly kind: 'empty-part'; readonly role: string }
  | { readonly kind: 'empty-message'; readonly role: string }
  | { readonly kind: 'surrogate-fix' };

/**
 * Pre-flight the outbound message list for the Anthropic dialect.
 *
 *  - Strips empty `text` parts from otherwise-valid messages.
 *  - Strips messages whose content is fully empty after the strip
 *    (Anthropic rejects empty-content messages with HTTP 400).
 *  - Sanitizes surrogate code points in every text payload.
 *  - Returns the indices of the last two surviving messages so the
 *    transport can stamp `cache_control: { type: 'ephemeral' }`
 *    on them (opencode's `applyCaching` pattern, narrowed to
 *    user-history tail).
 *
 * Pure function; the system string is passed through separately
 * because the Anthropic wire format hoists it out of the messages
 * array.
 */
export function applyAnthropicRequestTransform(
  messages: ReadonlyArray<MiniMaxWireMessage>,
  system: string,
): AnthropicTransformResult {
  const cleaned: MiniMaxWireMessage[] = [];
  const warnings: AnthropicTransformWarning[] = [];
  let surrogateFixes = 0;

  for (const msg of messages) {
    const sanitizedSystemRole = sanitizeMessageForAnthropic(msg, warnings, () => {
      surrogateFixes += 1;
    });
    if (sanitizedSystemRole === undefined) continue;
    cleaned.push(sanitizedSystemRole);
  }

  if (surrogateFixes > 0) {
    warnings.push({ kind: 'surrogate-fix' });
  }

  const systemSanitized = sanitizeSurrogates(system);

  // The last two messages get cache_control. The transport also
  // stamps the system block; this list is the user-history tail
  // only. Filter to 1-indexed positions in the cleaned list.
  const cacheMarkers: number[] = [];
  for (let i = Math.max(0, cleaned.length - 2); i < cleaned.length; i += 1) {
    cacheMarkers.push(i + 1);
  }

  return {
    messages: cleaned,
    cacheMarkers,
    system: systemSanitized,
    warnings,
  };
}

function sanitizeMessageForAnthropic(
  msg: MiniMaxWireMessage,
  warnings: AnthropicTransformWarning[],
  onSurrogateFix: () => void,
): MiniMaxWireMessage | undefined {
  if (msg.role === 'system') {
    // System messages are returned as content strings; the
    // outbound serializer hoists them out of the messages array.
    // We sanitize and return as-is so the caller can pull the
    // system text from `msg.content` if it wants to.
    const fixed = typeof msg.content === 'string' ? sanitizeSurrogates(msg.content) : msg.content;
    if (typeof fixed === 'string' && fixed !== msg.content) onSurrogateFix();
    if (typeof fixed === 'string' && fixed.length === 0) {
      warnings.push({ kind: 'empty-message', role: 'system' });
      return undefined;
    }
    return { ...msg, content: fixed };
  }

  if (typeof msg.content === 'string') {
    const fixed = sanitizeSurrogates(msg.content);
    if (fixed !== msg.content) onSurrogateFix();
    if (fixed.length === 0) {
      // Preserve the message if it carries tool calls — the
      // Anthropic wire format requires the `tool_use` blocks even
      // when the surrounding text content is empty (the prior
      // assistant turn emitted only tool calls).
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        return { ...msg, content: '' };
      }
      warnings.push({ kind: 'empty-part', role: msg.role });
      // Empty string content for non-system messages is dropped.
      return undefined;
    }
    return { ...msg, content: fixed };
  }

  // Content is an array of parts. Strip empty text parts and
  // sanitize the rest.
  const parts: MiniMaxWireContentPart[] = [];
  for (const part of msg.content) {
    if (part.type === 'text') {
      const fixed = sanitizeSurrogates(part.text);
      if (fixed !== part.text) onSurrogateFix();
      if (fixed.length === 0) {
        warnings.push({ kind: 'empty-part', role: msg.role });
        continue;
      }
      parts.push({ type: 'text', text: fixed });
      continue;
    }
    if (part.type === 'thinking') {
      const fixed = sanitizeSurrogates(part.thinking);
      if (fixed !== part.thinking) onSurrogateFix();
      if (fixed.length === 0) {
        warnings.push({ kind: 'empty-part', role: msg.role });
        continue;
      }
      const next: MiniMaxWireContentPart = { type: 'thinking', thinking: fixed };
      if (part.signature !== undefined) {
        (next as { type: 'thinking'; thinking: string; signature?: string }).signature =
          part.signature;
      }
      parts.push(next);
      continue;
    }
    // image_url parts are forwarded as-is — the URL has already
    // been sanitized at the inbound boundary.
    parts.push(part);
  }

  if (parts.length === 0) {
    // Preserve the message if it carries tool calls — the
    // tool_use blocks are emitted on a separate `tool_calls` field
    // (not the content array) for the OpenAI dialect and become
    // `tool_use` blocks in the content array for the Anthropic
    // dialect. Either way, the message carries forward even when
    // every text / image part was empty / dropped.
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return { ...msg, content: '' };
    }
    warnings.push({ kind: 'empty-message', role: msg.role });
    return undefined;
  }

  // If the only surviving part is a non-text (image_url, thinking),
  // Anthropic is still happy — but we warn so the chat-provider can
  // log the edge case.
  return { ...msg, content: parts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-model sampling parameters
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelSampler {
  readonly temperature: number;
  readonly topP: number;
  readonly topK: number;
}

/**
 * Sampling parameters tuned per model family. Opencode's defaults
 * (in `transform.ts:286-322`) are the reference: the M-series is
 * tuned at `temp=1.0`, `topP=0.95`, `topK=20-40`. Sending the SDK
 * default or omitting the params produces noticeably different
 * outputs; this is one of the highest-leverage correctness wins
 * for M-series fidelity.
 */
export function getModelSampler(modelId: string): ModelSampler {
  const id = modelId.toLowerCase();
  if (id.includes('minimax-m2')) {
    const isM2x =
      id.includes('m2.') || id.includes('m2-') || id.includes('m25') || id.includes('m21');
    return {
      temperature: 1.0,
      topP: 0.95,
      topK: isM2x ? 40 : 20,
    };
  }
  if (id.includes('minimax-m3')) {
    return {
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
    };
  }
  // M1 (and any unknown model) — no special tuning, use the
  // Anthropic default temp = 1.0 which is also M1's expected
  // sampling range.
  return {
    temperature: 1.0,
    topP: 0.95,
    topK: 20,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-model max_tokens clamp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output-token cap for an agent turn. Opencode clamps to 32,000
 * (OUTPUT_TOKEN_MAX in `transform.ts:36`). MiniMax supports larger
 * outputs, but an agent turn that runs the full 65K burns through
 * the context window and the 200 RPM budget faster than necessary.
 * 32K is the opencode sweet spot.
 */
const AGENT_TURN_MAX_TOKENS = 32_000;

export function getMaxTokensForModel(_modelId: string): number {
  return AGENT_TURN_MAX_TOKENS;
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 thinking configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ThinkingConfig {
  /** Set on the Anthropic request body as `thinking: { type, budget_tokens? }`. */
  readonly thinking: {
    readonly type: 'enabled' | 'adaptive' | 'disabled';
    readonly budgetTokens?: number;
  };
}

/**
 * The thinking body param to send for a model.
 *
 * Opencode `transform.ts:680-688` and `1147-1150` set
 * `thinking: { type: 'adaptive' }` for M3 on the Anthropic
 * interface because M3's Anthropic endpoint defaults thinking
 * **off** (unlike Chat Completions which default it on).
 * `adaptive` lets M3 plan its own budget per request; sending
 * `enabled` with an explicit `budget_tokens` locks the budget
 * at a fixed fraction of `max_tokens` and burns output tokens
 * on planning the model would not have spent on its own. M3
 * is the only Anthropic-style model in the catalog today that
 * needs the opt-in; M2.x emit reasoning through the
 * Chat-Completions `reasoning_content` field instead.
 */
export function getThinkingConfig(
  modelId: string,
  thinkingStyle: ThinkingStyle,
  _maxTokens: number,
): ThinkingConfig | undefined {
  if (thinkingStyle !== 'anthropic') return undefined;
  const id = modelId.toLowerCase();
  if (!id.includes('minimax-m3')) return undefined;
  // `maxTokens` is intentionally ignored: adaptive thinking
  // does not take a budget, so the chat-provider's 32K
  // request-clamp is irrelevant here.
  void _maxTokens;
  return {
    thinking: {
      type: 'adaptive',
    },
  };
}
