/**
 * Domain unit tests for the model catalog (T02).
 *
 * These are pure-data tests — no vscode, no HTTP. The point is to
 * guarantee that:
 *   1. The static BUILT_IN_CATALOG is well-formed and includes the
 *      entire M-series (M1, M2, M2.5, M2.7, M3).
 *   2. M3 advertises image input AND tool calling (the two flags
 *      that gate agent mode in VS Code's chat picker).
 *   3. Every agent-capable model in the static catalog has
 *      `toolCalling = true` — otherwise the model is hidden from
 *      agent mode and the entire feature is dead.
 *   4. Live-merge applies the default capabilities, especially
 *      `toolCalling = true`, to live models that the static list
 *      doesn't know about.
 *   5. Live-merge preserves static entries (static wins on collision).
 *   6. The merge is deterministic and pure.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BUILT_IN_CATALOG,
  DEFAULT_LIVE_DEFAULTS,
  mergeCatalog,
  normalizeModelId,
  validateCatalog,
  _internal,
} from './domain/catalog.js';
import type { CatalogEntry } from './domain/catalog.js';

const { formatTokenCount } = _internal;

describe('BUILT_IN_CATALOG', () => {
  it('ships the full M-series: M1, M2, M2.5, M2.7, M3', () => {
    const ids = BUILT_IN_CATALOG.map((e) => e.id);
    assert.deepEqual([...ids].sort(), [
      'MiniMax-M1',
      'MiniMax-M2',
      'MiniMax-M2.5',
      'MiniMax-M2.7',
      'MiniMax-M3',
    ]);
  });

  it('passes validateCatalog with no errors', () => {
    assert.deepEqual(validateCatalog(BUILT_IN_CATALOG), []);
  });

  it('M3 advertises image input AND a truthy toolCalling', () => {
    const m3 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');
    assert.ok(m3, 'M3 entry must exist');
    assert.equal(m3.capabilities.imageInput, true);
    assert.equal(m3.capabilities.toolCalling, true);
    assert.equal(m3.capabilities.thinking, true);
    assert.equal(m3.thinkingStyle, 'anthropic');
  });

  it('M3 advertises a 1M / 128K token budget matching models.dev', () => {
    // models.dev's "minimax" provider entry for MiniMax-M3 lists
    //   limit.context = 1_000_000
    //   limit.output  = 128_000
    // The static catalog must mirror these so VS Code's
    // context-window widget and utility-model sizing stay
    // accurate. The chat-provider still clamps the actual
    // request's max_tokens to 32K (opencode OUTPUT_TOKEN_MAX);
    // the catalog value drives the picker UI and the
    // utility-model budget math, not the request body.
    const m3 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');
    assert.ok(m3, 'M3 entry must exist');
    assert.equal(m3.maxInputTokens, 1_000_000);
    assert.equal(m3.maxOutputTokens, 128_000);
  });

  it('M2.x uses OpenAI-style thinking deltas', () => {
    for (const id of ['MiniMax-M2', 'MiniMax-M2.5', 'MiniMax-M2.7']) {
      const entry = BUILT_IN_CATALOG.find((e) => e.id === id);
      assert.ok(entry, `${id} entry must exist`);
      assert.equal(entry.thinkingStyle, 'openai');
      assert.equal(entry.capabilities.thinking, true);
      assert.equal(entry.capabilities.toolCalling, true);
    }
  });

  it('M1 has no native thinking and no image input', () => {
    const m1 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M1');
    assert.ok(m1, 'M1 entry must exist');
    assert.equal(m1.thinkingStyle, 'none');
    assert.equal(m1.capabilities.thinking, false);
    assert.equal(m1.capabilities.imageInput, false);
    assert.equal(m1.capabilities.toolCalling, true, 'M1 is still agent-capable');
  });

  it('every entry advertises toolCalling (agent-mode gate)', () => {
    for (const entry of BUILT_IN_CATALOG) {
      assert.equal(
        entry.capabilities.toolCalling,
        true,
        `${entry.id} must advertise toolCalling=true; otherwise it is hidden from agent mode`,
      );
    }
  });

  it('every entry has positive maxInputTokens and maxOutputTokens', () => {
    for (const entry of BUILT_IN_CATALOG) {
      assert.ok(entry.maxInputTokens > 0, `${entry.id} maxInputTokens > 0`);
      assert.ok(entry.maxOutputTokens > 0, `${entry.id} maxOutputTokens > 0`);
    }
  });

  it('every entry belongs to the minimax family with the minimax vendor', () => {
    for (const entry of BUILT_IN_CATALOG) {
      assert.equal(entry.family, 'minimax');
      assert.equal(entry.vendor, 'minimax');
    }
  });
});

describe('validateCatalog', () => {
  it('rejects entries missing the id field', () => {
    const errors = validateCatalog([makeEntry({ id: '' as unknown as CatalogEntry['id'] })]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'missing-required-field');
  });

  it('rejects duplicate ids', () => {
    const errors = validateCatalog([
      makeEntry({ id: 'MiniMax-M3' }),
      makeEntry({ id: 'MiniMax-M3' }),
    ]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'duplicate-id');
  });

  it('rejects non-positive token budgets', () => {
    const errors = validateCatalog([
      makeEntry({ id: 'broken', maxInputTokens: 0, maxOutputTokens: 8_192 }),
    ]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'invalid-token-budget');
  });

  it('rejects entries with non-boolean capability flags', () => {
    const errors = validateCatalog([
      {
        id: 'broken',
        displayName: 'broken',
        vendor: 'minimax',
        family: 'minimax',
        maxInputTokens: 1_000,
        maxOutputTokens: 1_000,
        capabilities: {
          // Intentional runtime violation — the validator must catch this
          // even though it would be a compile error in a typed call site.
          toolCalling: 'yes' as unknown as boolean,
          imageInput: false,
          thinking: false,
        },
        thinkingStyle: 'none',
        detail: 'broken',
      },
    ]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, 'invalid-capability');
  });
});

describe('mergeCatalog', () => {
  it('returns the static list when no live list is provided', () => {
    const merged = mergeCatalog(BUILT_IN_CATALOG, []);
    assert.equal(merged.length, BUILT_IN_CATALOG.length);
    for (const entry of merged) {
      assert.ok(BUILT_IN_CATALOG.some((e) => e.id === entry.id));
    }
  });

  it('applies default capabilities (including toolCalling=true) to live models that the static list does not know about', () => {
    const live: CatalogEntry[] = [
      {
        id: 'MiniMax-M4-preview',
        displayName: 'M4 Preview (MiniMax)',
        vendor: 'minimax',
        family: 'minimax',
        maxInputTokens: 500_000,
        maxOutputTokens: 8_192,
        capabilities: { toolCalling: false, imageInput: false, thinking: false },
        thinkingStyle: 'none',
        detail: 'preview',
      },
    ];
    const merged = mergeCatalog(BUILT_IN_CATALOG, live);
    const m4 = merged.find((e) => e.id === 'MiniMax-M4-preview');
    assert.ok(m4, 'live model should be merged in');
    // The default must override the live-supplied false so the model is
    // surfaced in agent mode (AGENTS.md invariant: toolCalling is the gate).
    assert.equal(m4.capabilities.toolCalling, true, 'default must force toolCalling=true');
    assert.equal(m4.capabilities.imageInput, true);
    assert.equal(m4.thinkingStyle, 'openai');
  });

  it('does NOT override a static entry when a live entry collides with its id', () => {
    const live: CatalogEntry[] = [
      {
        id: 'MiniMax-M3',
        displayName: 'WRONG',
        vendor: 'minimax',
        family: 'minimax',
        maxInputTokens: 1,
        maxOutputTokens: 1,
        capabilities: { toolCalling: false, imageInput: false, thinking: false },
        thinkingStyle: 'none',
        detail: 'should be ignored',
      },
    ];
    const merged = mergeCatalog(BUILT_IN_CATALOG, live);
    const m3 = merged.find((e) => e.id === 'MiniMax-M3');
    assert.ok(m3);
    assert.equal(m3.displayName, 'M3 (MiniMax)');
    assert.equal(m3.maxInputTokens, 1_000_000);
    assert.equal(m3.thinkingStyle, 'anthropic');
  });

  it('is pure — calling it twice with the same inputs produces the same output', () => {
    const live: CatalogEntry[] = [
      makeEntry({ id: 'MiniMax-M4-preview' }),
      makeEntry({ id: 'MiniMax-M3.5' }),
    ];
    const a = mergeCatalog(BUILT_IN_CATALOG, live);
    const b = mergeCatalog(BUILT_IN_CATALOG, live);
    assert.deepEqual(a, b);
  });

  it('appends live entries after the static ones, sorted alphabetically', () => {
    const live: CatalogEntry[] = [makeEntry({ id: 'MiniMax-M5' }), makeEntry({ id: 'MiniMax-M4' })];
    const merged = mergeCatalog(BUILT_IN_CATALOG, live);
    const staticCount = BUILT_IN_CATALOG.length;
    assert.equal(merged[staticCount]?.id, 'MiniMax-M4');
    assert.equal(merged[staticCount + 1]?.id, 'MiniMax-M5');
  });

  it('is deterministic regardless of input order', () => {
    const live: CatalogEntry[] = [makeEntry({ id: 'MiniMax-Z' }), makeEntry({ id: 'MiniMax-A' })];
    const a = mergeCatalog(BUILT_IN_CATALOG, [live[0]!, live[1]!]);
    const b = mergeCatalog(BUILT_IN_CATALOG, [live[1]!, live[0]!]);
    assert.deepEqual(a, b);
  });

  it('does not mutate the static list or the live list', () => {
    const live: CatalogEntry[] = [makeEntry({ id: 'MiniMax-X' })];
    const staticCopy = BUILT_IN_CATALOG.slice();
    const liveCopy = live.slice();
    mergeCatalog(BUILT_IN_CATALOG, live);
    assert.deepEqual(BUILT_IN_CATALOG, staticCopy);
    assert.deepEqual(live, liveCopy);
  });

  it('drops unusable live entries with missing ids or non-positive token budgets', () => {
    const merged = mergeCatalog(BUILT_IN_CATALOG, [
      makeEntry({ id: '' as unknown as CatalogEntry['id'] }),
      makeEntry({ id: 'MiniMax-bad-budget', maxOutputTokens: 0 }),
    ]);
    assert.equal(merged.length, BUILT_IN_CATALOG.length);
  });

  it('fills display, vendor, family, and detail defaults for sparse live entries', () => {
    const merged = mergeCatalog(BUILT_IN_CATALOG, [
      {
        id: 'MiniMax-M4-sparse',
        displayName: '',
        vendor: '',
        family: '',
        maxInputTokens: 123_000,
        maxOutputTokens: 7_000,
        capabilities: { toolCalling: true, imageInput: false, thinking: false },
        thinkingStyle: 'none',
        detail: '',
      },
    ]);
    const entry = merged.find((model) => model.id === 'MiniMax-M4-sparse');
    assert.ok(entry);
    assert.equal(entry.displayName, 'M (MiniMax-M4-sparse)');
    assert.equal(entry.vendor, 'minimax');
    assert.equal(entry.family, 'minimax');
    assert.equal(entry.detail, '130K ctx · 7K out');
  });
});

describe('normalizeModelId', () => {
  it('adds the MiniMax- prefix to bare ids', () => {
    assert.equal(normalizeModelId('M3'), 'MiniMax-M3');
    assert.equal(normalizeModelId('m2.7'), 'MiniMax-m2.7');
  });

  it('passes through ids that already have the prefix', () => {
    assert.equal(normalizeModelId('MiniMax-M3'), 'MiniMax-M3');
  });
});

describe('formatTokenCount', () => {
  it('formats millions', () => {
    assert.equal(formatTokenCount(1_000_000), '1M');
    assert.equal(formatTokenCount(2_000_000), '2M');
  });
  it('formats thousands', () => {
    assert.equal(formatTokenCount(1_000), '1K');
    assert.equal(formatTokenCount(200_000), '200K');
  });
  it('passes through non-round numbers verbatim', () => {
    assert.equal(formatTokenCount(1234), '1234');
  });
});

describe('export sanity', () => {
  it('exports DEFAULT_LIVE_DEFAULTS with toolCalling=true', () => {
    assert.equal(DEFAULT_LIVE_DEFAULTS.capabilities.toolCalling, true);
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function makeEntry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: overrides.id ?? 'MiniMax-test',
    displayName: overrides.displayName ?? 'test (MiniMax)',
    vendor: 'minimax',
    family: 'minimax',
    maxInputTokens: overrides.maxInputTokens ?? 8_192,
    maxOutputTokens: overrides.maxOutputTokens ?? 4_096,
    capabilities: overrides.capabilities ?? {
      toolCalling: true,
      imageInput: false,
      thinking: false,
    },
    thinkingStyle: overrides.thinkingStyle ?? 'none',
    detail: overrides.detail ?? 'test',
  };
}
