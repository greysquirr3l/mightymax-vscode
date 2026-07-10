/**
 * Domain unit tests for the Anthropic-dialect request post-processing
 * (T07-followup). Pure-function tests; no vscode, no HTTP. Verifies:
 *
 *  - `sanitizeSurrogates` replaces lone high/low surrogates with
 *    U+FFFD; well-formed surrogate pairs survive.
 *  - `sanitizeAnthropicSchema` lowers `const` → `enum`, collapses
 *    tuple `items`, ensures `type: 'object'` + `properties: {}`,
 *    drops `additionalProperties: false`, drops `$ref` siblings.
 *  - `applyAnthropicRequestTransform` strips empty text parts /
 *    empty messages, sanitizes surrogate code points, and returns
 *    the last-2 indices for cache_control marking.
 *  - `getModelSampler` returns the right (temperature, topP, topK)
 *    per model family.
 *  - `getMaxTokensForModel` returns 32_000 for the M-series.
 *  - `getThinkingConfig` opts M3 into the `enabled` thinking block
 *    with a budgetTokens value in the 1024-31999 Anthropic range.
 *
 * Pattern: node:test `describe`/`it`, `node:assert/strict` deep
 * equality, no vscode imports.
 */

import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAnthropicRequestTransform,
  getMaxTokensForModel,
  getModelSampler,
  getThinkingConfig,
  sanitizeAnthropicSchema,
  sanitizeSurrogates,
} from './domain/anthropic-transform.js';
import type { MiniMaxWireMessage } from '../ports/minimax-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeSurrogates
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeSurrogates', () => {
  it('passes through plain ASCII unchanged', () => {
    equal(sanitizeSurrogates('Hello, world!'), 'Hello, world!');
  });

  it('preserves well-formed surrogate pairs (emoji)', () => {
    // U+1F600 (😀) is encoded as the surrogate pair D83D DE00 in UTF-16.
    equal(sanitizeSurrogates('😀'), '😀');
  });

  it('replaces a lone high surrogate with U+FFFD', () => {
    // D800 is a high surrogate with no low surrogate following it.
    equal(sanitizeSurrogates('a\uD800b'), 'a\uFFFDb');
  });

  it('replaces a lone low surrogate with U+FFFD', () => {
    // DC00 is a low surrogate with no high surrogate preceding it.
    equal(sanitizeSurrogates('a\uDC00b'), 'a\uFFFDb');
  });

  it('handles multiple lone surrogates in a single string', () => {
    // \uD800\uDC00 is a real pair (U+10000, 𐀀) → preserved. \uD801
    // at the end has no low surrogate following → replaced with
    // \uFFFD.
    equal(sanitizeSurrogates('\uD800\uDC00\uD801'), '𐀀\uFFFD');
  });

  it('returns an empty string unchanged', () => {
    equal(sanitizeSurrogates(''), '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeAnthropicSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeAnthropicSchema', () => {
  it('passes a primitive type through unchanged', () => {
    deepStrictEqual(sanitizeAnthropicSchema({ type: 'string' }), { type: 'string' });
  });

  it('passes an object schema with properties and required through', () => {
    const input = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    deepStrictEqual(sanitizeAnthropicSchema(input), input);
  });

  it('collapses `const` to `enum: [const]`', () => {
    const out = sanitizeAnthropicSchema({ const: 'fixed' }) as Record<string, unknown>;
    deepStrictEqual(out.enum, ['fixed']);
  });

  it('keeps an existing `enum` array', () => {
    const out = sanitizeAnthropicSchema({ enum: ['a', 'b'] }) as Record<string, unknown>;
    deepStrictEqual(out.enum, ['a', 'b']);
  });

  it('drops `additionalProperties: false` (Anthropic rejects it)', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      properties: { x: { type: 'number' } },
      additionalProperties: false,
    }) as Record<string, unknown>;
    equal('additionalProperties' in out, false);
  });

  it('keeps `additionalProperties: true`', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      additionalProperties: true,
    }) as Record<string, unknown>;
    equal(out.additionalProperties, true);
  });

  it('lowers a `additionalProperties: schema` form', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      additionalProperties: { type: 'string' },
    }) as Record<string, unknown>;
    deepStrictEqual(out.additionalProperties, { type: 'string' });
  });

  it('collapses tuple `items: [a, b]` to `items: a`', () => {
    const out = sanitizeAnthropicSchema({
      type: 'array',
      items: [{ type: 'string' }, { type: 'number' }],
    }) as Record<string, unknown>;
    deepStrictEqual(out.items, { type: 'string' });
  });

  it('passes through single-schema `items`', () => {
    const out = sanitizeAnthropicSchema({
      type: 'array',
      items: { type: 'string' },
    }) as Record<string, unknown>;
    deepStrictEqual(out.items, { type: 'string' });
  });

  it('drops $ref siblings (keeps $ref only)', () => {
    const out = sanitizeAnthropicSchema({
      $ref: '#/definitions/Foo',
      description: 'A foo',
    }) as Record<string, unknown>;
    equal(out.$ref, '#/definitions/Foo');
    equal('description' in out, false);
  });

  it('infers `type: object` from `properties` keyword', () => {
    const out = sanitizeAnthropicSchema({ properties: { x: { type: 'number' } } }) as Record<
      string,
      unknown
    >;
    deepStrictEqual(out.type, 'object');
  });

  it('infers `type: array` from `items` keyword', () => {
    const out = sanitizeAnthropicSchema({ items: { type: 'string' } }) as Record<string, unknown>;
    deepStrictEqual(out.type, 'array');
  });

  it('infers `type: string` from `enum` keyword', () => {
    const out = sanitizeAnthropicSchema({ enum: ['a'] }) as Record<string, unknown>;
    deepStrictEqual(out.type, 'string');
  });

  it('infers `type: number` from `minimum` keyword', () => {
    const out = sanitizeAnthropicSchema({ minimum: 0 }) as Record<string, unknown>;
    deepStrictEqual(out.type, 'number');
  });

  it('preserves the `description` field on a property', () => {
    const input = {
      type: 'object',
      properties: { x: { type: 'string', description: 'A name' } },
    };
    const out = sanitizeAnthropicSchema(input) as Record<string, unknown>;
    const props = out.properties as Record<string, unknown>;
    deepStrictEqual(props['x'], { type: 'string', description: 'A name' });
  });

  it('handles a boolean schema form (true / false)', () => {
    deepStrictEqual(sanitizeAnthropicSchema(true), { type: 'string' });
    deepStrictEqual(sanitizeAnthropicSchema(false), { type: 'string' });
  });

  it('lowered anyOf branches recursively', () => {
    const out = sanitizeAnthropicSchema({
      anyOf: [{ type: 'string' }, { const: 'fixed' }],
    }) as Record<string, unknown>;
    const branches = out.anyOf as Array<Record<string, unknown>>;
    equal(branches.length, 2);
    deepStrictEqual(branches[0], { type: 'string' });
    // The `const` branch gets `type: 'string'` inferred from the
    // const keyword (Anthropic requires a `type` on every schema
    // branch). The collapsed `enum` is preserved alongside.
    deepStrictEqual(branches[1], { type: 'string', enum: ['fixed'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyAnthropicRequestTransform
// ─────────────────────────────────────────────────────────────────────────────

describe('applyAnthropicRequestTransform', () => {
  it('returns the messages and the system string unchanged for clean input', () => {
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = applyAnthropicRequestTransform(messages, 'You are helpful.');
    deepStrictEqual(result.messages, messages);
    equal(result.system, 'You are helpful.');
    deepStrictEqual(result.cacheMarkers, [1, 2]);
    equal(result.warnings.length, 0);
  });

  it('strips empty text parts from a multi-part message', () => {
    const messages: MiniMaxWireMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'hello' },
        ],
      },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    equal(result.messages.length, 1);
    const content = result.messages[0]?.content as ReadonlyArray<{ type: string; text?: string }>;
    equal(content.length, 1);
    equal(content[0]?.text, 'hello');
    ok(result.warnings.some((w) => w.kind === 'empty-part'));
  });

  it('drops a message whose only content was empty', () => {
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'kept' },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    equal(result.messages.length, 1);
    equal(result.messages[0]?.content, 'kept');
    ok(result.warnings.some((w) => w.kind === 'empty-part'));
  });

  it('drops a message whose only text part is empty', () => {
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: 'kept' },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    equal(result.messages.length, 1);
    equal(result.messages[0]?.content, 'kept');
  });

  it('keeps a message whose only surviving parts are non-text (image_url)', () => {
    const messages: MiniMaxWireMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    equal(result.messages.length, 1);
    const content = result.messages[0]?.content as ReadonlyArray<{ type: string }>;
    equal(content.length, 1);
    equal(content[0]?.type, 'image_url');
  });

  it('sanitizes surrogate code points in text content', () => {
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: 'a\uD800b' },
    ];
    const result = applyAnthropicRequestTransform(messages, 'sys\uDC00tem');
    equal(result.messages[0]?.content, 'a\uFFFDb');
    equal(result.system, 'sys\uFFFDtem');
    ok(result.warnings.some((w) => w.kind === 'surrogate-fix'));
  });

  it('sanitizes surrogate code points in text content parts', () => {
    const messages: MiniMaxWireMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'emoji \uD800 broken' }],
      },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    const content = result.messages[0]?.content as ReadonlyArray<{ type: string; text: string }>;
    equal(content[0]?.text, 'emoji \uFFFD broken');
  });

  it('sanitizes surrogate code points in thinking parts', () => {
    const messages: MiniMaxWireMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'a\uD800b', signature: 'sig' },
          { type: 'text', text: 'response' },
        ],
      },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    const content = result.messages[0]?.content as ReadonlyArray<{
      type: string;
      thinking?: string;
      signature?: string;
    }>;
    const thinking = content.find((p) => p.type === 'thinking');
    ok(thinking);
    equal(thinking?.thinking, 'a\uFFFDb');
    equal(thinking?.signature, 'sig');
  });

  it('returns cache markers for the last two surviving messages (1-indexed, short history)', () => {
    // Three messages falls into the "tail" branch (< 4 surviving)
    // so the last two are marked.
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    deepStrictEqual(result.cacheMarkers, [2, 3]);
  });

  it('returns a single cache marker when only one message survives', () => {
    const result = applyAnthropicRequestTransform(
      [{ role: 'user', content: 'only' }],
      '',
    );
    deepStrictEqual(result.cacheMarkers, [1]);
  });

  it('returns no cache markers when no messages survive', () => {
    const result = applyAnthropicRequestTransform(
      [{ role: 'user', content: '' }],
      '',
    );
    deepStrictEqual(result.cacheMarkers, []);
    deepStrictEqual(result.messages, []);
  });

  it('spreads four evenly-spaced cache markers across long histories', () => {
    // For ≥4 messages, 4 breakpoints at 25/50/75/100% let the
    // Anthropic prefix cache build incrementally across rounds.
    // With 103 messages the positions are roughly 26, 52, 77, 103.
    const messages: MiniMaxWireMessage[] = Array.from({ length: 103 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${String(i)}`,
    }));
    const result = applyAnthropicRequestTransform(messages, '');
    deepStrictEqual(result.cacheMarkers, [26, 52, 77, 103]);
  });

  it('caps cache markers at four (Anthropic hard limit)', () => {
    // For very long histories the Set dedupes any overlap so the
    // final list never exceeds 4 entries.
    const messages: MiniMaxWireMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${String(i)}`,
    }));
    const result = applyAnthropicRequestTransform(messages, '');
    equal(result.cacheMarkers.length, 4);
  });

  it('emits three distinct positions for the 4-message boundary (dedup works)', () => {
    // With exactly 4 messages, frac=0.25 → floor(0.75)+1 = 1,
    // frac=0.5 → floor(1.5)+1 = 2, frac=0.75 → floor(2.25)+1 = 3,
    // frac=1.0 → floor(3)+1 = 4 — all four positions distinct, no
    // dedup needed.
    const messages: MiniMaxWireMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ];
    const result = applyAnthropicRequestTransform(messages, '');
    deepStrictEqual(result.cacheMarkers, [1, 2, 3, 4]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getModelSampler
// ─────────────────────────────────────────────────────────────────────────────

describe('getModelSampler', () => {
  it('returns temp=1.0, topP=0.95, topK=20 for M3', () => {
    deepStrictEqual(getModelSampler('MiniMax-M3'), {
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
    });
  });

  it('returns topK=40 for M2.x (m2., m25, m21 variants)', () => {
    const sampler = getModelSampler('MiniMax-M2.5');
    equal(sampler.topK, 40);
    equal(sampler.temperature, 1.0);
    equal(sampler.topP, 0.95);
  });

  it('returns topK=20 for the bare M2 id (no dot variant)', () => {
    // opencode `transform.ts:316-322` reserves topK=40 for the `m2.`
    // variant family (M2.5, M2.7); bare M2 falls through to topK=20.
    const sampler = getModelSampler('MiniMax-M2');
    equal(sampler.topK, 20);
  });

  it('returns temp=1.0 for an unknown model id', () => {
    const sampler = getModelSampler('MiniMax-M99-preview');
    equal(sampler.temperature, 1.0);
    equal(sampler.topP, 0.95);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMaxTokensForModel
// ─────────────────────────────────────────────────────────────────────────────

describe('getMaxTokensForModel', () => {
  it('caps the M-series at 32_000 (opencode OUTPUT_TOKEN_MAX)', () => {
    equal(getMaxTokensForModel('MiniMax-M3'), 32_000);
    equal(getMaxTokensForModel('MiniMax-M2.5'), 32_000);
    equal(getMaxTokensForModel('MiniMax-M1'), 32_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getThinkingConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('getThinkingConfig', () => {
  it('opts M3 in to `adaptive` thinking (no explicit budget)', () => {
    // opencode's transform.ts:680-688 + 1147-1150 sets
    //   { thinking: { type: 'adaptive' } }
    // for M3 on the Anthropic interface because M3's Anthropic
    // endpoint defaults thinking OFF (unlike Chat Completions
    // which defaults it ON). The model decides its own budget
    // in `adaptive` mode; sending `enabled` with an explicit
    // budget_tokens locks the budget at half of max_tokens and
    // burns output tokens on planning the model would not have
    // spent on its own.
    const cfg = getThinkingConfig('MiniMax-M3', 'anthropic', 32_000);
    ok(cfg, 'expected a thinking config for M3 on anthropic dialect');
    equal(cfg?.thinking.type, 'adaptive');
    equal(
      cfg?.thinking.budgetTokens,
      undefined,
      'adaptive thinking must not carry an explicit budget_tokens',
    );
  });

  it('returns undefined for an M2.x model even on the anthropic dialect', () => {
    equal(getThinkingConfig('MiniMax-M2.5', 'anthropic', 32_000), undefined);
  });

  it('returns undefined for M3 on the openai dialect (M2.x territory)', () => {
    equal(getThinkingConfig('MiniMax-M3', 'openai', 32_000), undefined);
  });

  it('returns undefined for M1 (no thinking in catalog)', () => {
    equal(getThinkingConfig('MiniMax-M1', 'none', 32_000), undefined);
  });
});
