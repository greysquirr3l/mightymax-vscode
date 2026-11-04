import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import {
  DYNAMIC_MAX_TOKENS_FLOOR,
  DYNAMIC_MAX_TOKENS_SAFETY_MARGIN,
  clampMaxTokensToContext,
  estimateInputTokens,
} from './domain/context-budget.js';

describe('clampMaxTokensToContext', () => {
  it('leaves the configured ceiling alone when there is plenty of room', () => {
    strictEqual(clampMaxTokensToContext(64_000, 1_000_000, 10_000), 64_000);
  });

  it('shrinks to the remaining room minus the safety margin', () => {
    strictEqual(
      clampMaxTokensToContext(64_000, 1_000_000, 950_000),
      1_000_000 - 950_000 - DYNAMIC_MAX_TOKENS_SAFETY_MARGIN,
    );
  });

  it('never goes below the floor', () => {
    strictEqual(clampMaxTokensToContext(64_000, 1_000_000, 999_000), DYNAMIC_MAX_TOKENS_FLOOR);
  });

  it('never exceeds a ceiling below the floor', () => {
    strictEqual(clampMaxTokensToContext(8_000, 1_000_000, 999_000), 8_000);
  });
});

describe('estimateInputTokens', () => {
  it('counts text, tool calls, tools, the system prompt, and flat media costs', () => {
    const n = estimateInputTokens(
      [
        { role: 'user', content: 'x'.repeat(300) },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ],
      undefined,
      'y'.repeat(30),
    );
    // 100 (text) + 2000 (image) + 1 + 1 (call) + 10 (system)
    strictEqual(n, 2112);
  });

  it('is zero for an empty request', () => {
    strictEqual(estimateInputTokens([], undefined, undefined), 0);
  });
});
