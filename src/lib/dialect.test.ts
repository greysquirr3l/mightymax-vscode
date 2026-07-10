/**
 * Tests for `dialectForModel`. T17 RED — drove the `dialectForModel`
 * addition to the domain. All 5 catalog entries must map to the
 * expected dialect, plus an unknown live model with default
 * `thinkingStyle: 'openai'` resolves to `'openai'`.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert/strict';

import { BUILT_IN_CATALOG } from './domain/catalog.js';
import { dialectForModel } from './domain/dialect.js';

describe('dialectForModel', () => {
  it('routes MiniMax-M3 to the Anthropic dialect', () => {
    const m3 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');
    assert.ok(m3, 'MiniMax-M3 must exist in BUILT_IN_CATALOG');
    assert.equal(dialectForModel(m3), 'anthropic');
  });

  it('routes MiniMax-M2.7 to the OpenAI dialect', () => {
    const e = BUILT_IN_CATALOG.find((x) => x.id === 'MiniMax-M2.7');
    assert.ok(e);
    assert.equal(dialectForModel(e), 'openai');
  });

  it('routes MiniMax-M2.5 to the OpenAI dialect', () => {
    const e = BUILT_IN_CATALOG.find((x) => x.id === 'MiniMax-M2.5');
    assert.ok(e);
    assert.equal(dialectForModel(e), 'openai');
  });

  it('routes MiniMax-M2 to the OpenAI dialect', () => {
    const e = BUILT_IN_CATALOG.find((x) => x.id === 'MiniMax-M2');
    assert.ok(e);
    assert.equal(dialectForModel(e), 'openai');
  });

  it('routes MiniMax-M1 to the OpenAI dialect', () => {
    const e = BUILT_IN_CATALOG.find((x) => x.id === 'MiniMax-M1');
    assert.ok(e);
    assert.equal(dialectForModel(e), 'openai');
  });

  it('routes an unknown live model with default thinkingStyle to the OpenAI dialect', () => {
    const unknown = {
      id: 'MiniMax-Future-X',
      name: 'Future',
      vendor: 'minimax',
      family: 'minimax',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { imageInput: true, toolCalling: true },
      thinkingStyle: 'openai' as const,
    };
    assert.equal(dialectForModel(unknown), 'openai');
  });

  it('never defaults to anthropic for openai thinkingStyle', () => {
    const unknown = {
      id: 'MiniMax-Future-X',
      name: 'Future',
      vendor: 'minimax',
      family: 'minimax',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      capabilities: { imageInput: true, toolCalling: true },
      thinkingStyle: 'openai' as const,
    };
    // Belt-and-braces: assert not-equal in addition to the positive case.
    assert.notEqual(dialectForModel(unknown), 'anthropic');
  });
});
