import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import {
  DYNAMIC_MAX_TOKENS_FLOOR,
  DYNAMIC_MAX_TOKENS_SAFETY_MARGIN,
  clampMaxTokensToContext,
  estimateInputTokens,
  capMaxTokensForEffort,
  thinkingReserveTokens,
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

describe('capMaxTokensForEffort', () => {
  it('caps low and medium, leaves high and unknown alone', () => {
    strictEqual(capMaxTokensForEffort(64_000, 'low'), 16_384);
    strictEqual(capMaxTokensForEffort(64_000, 'medium'), 32_768);
    strictEqual(capMaxTokensForEffort(64_000, 'high'), 64_000);
    strictEqual(capMaxTokensForEffort(64_000, undefined), 64_000);
  });
  it('never raises a smaller budget', () => {
    strictEqual(capMaxTokensForEffort(8_000, 'medium'), 8_000);
  });
});

describe('thinking reserve', () => {
  it('reserves by depth and nothing when thinking is off', () => {
    strictEqual(thinkingReserveTokens('adaptive', 'low'), 2_048);
    strictEqual(thinkingReserveTokens('adaptive', 'medium'), 8_192);
    strictEqual(thinkingReserveTokens('adaptive', undefined), 16_384);
    strictEqual(thinkingReserveTokens('disabled', 'high'), 0);
    strictEqual(thinkingReserveTokens(undefined, 'high'), 0);
  });
  it('is deducted from the room left for output', () => {
    const window = 100_000;
    const without = clampMaxTokensToContext(64_000, window, 40_000);
    const withReserve = clampMaxTokensToContext(64_000, window, 40_000, 8_192);
    strictEqual(without - withReserve, 8_192);
  });
});
