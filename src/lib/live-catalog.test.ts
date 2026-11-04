/**
 * T42 — live model catalog sync.
 *
 * The `/v1/models` endpoint is fetched during API-key validation, but
 * the ids it returns were DISCARDED — the validator only used them to
 * prove the key worked. `CatalogAdapter.setLiveModels()` had no call
 * site at all, so `mergeCatalog(BUILT_IN_CATALOG, [])` always merged
 * against an empty live set and a newly-released MiniMax model stayed
 * invisible until someone hand-edited the static catalog and shipped
 * a release.
 *
 * These tests pin the rules for turning the live id list into catalog
 * entries:
 *
 *   1. A model the static catalog already covers keeps the CURATED
 *      entry (token budgets, thinking style, tool cap). The live list
 *      never overrides curated metadata.
 *   2. A model the static catalog does NOT cover is added, with sane
 *      defaults — crucially `toolCalling: true`, because a model
 *      without it is hidden from agent mode.
 *   3. The retired MiniMax models (M1, M2, M2.5, M2.7, and the
 *      M3.1-Flash-Preview alias) must NOT be resurrected by the live
 *      list. MiniMax has wound those down; the platform still lists
 *      them, and a live sync that re-adds them puts dead models back
 *      in the picker.
 *   4. Media models (H3, H3-Max, image-01) are NOT chat models and
 *      must never enter the chat picker.
 */

import { describe, it } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import {
  applyContextWindow,
  BUILT_IN_CATALOG,
  coerceContextWindow,
  CURRENT_MODEL_IDS,
  mergeCatalog,
  resolveRetiredModel,
} from './domain/catalog.js';
import type { CatalogEntry } from './domain/catalog.js';

/** Model ids MiniMax has retired — the platform still lists them. */
const RETIRED_MODEL_IDS = [
  'MiniMax-M1',
  'MiniMax-M2',
  'MiniMax-M2.5',
  'MiniMax-M2.7',
  'MiniMax-M3.1-Flash-Preview',
] as const;

/** Non-chat models served by the same platform. */
const MEDIA_MODEL_IDS = ['MiniMax-H3', 'MiniMax-H3-Max', 'image-01'] as const;

/**
 * Build the catalog entry a live sync would produce for a bare model
 * id. Mirrors the shape `fillLiveDefaults` expects.
 */
function liveEntry(id: string): CatalogEntry {
  return {
    id,
    displayName: id,
    vendor: 'minimax',
    family: 'minimax',
    maxInputTokens: 200_000,
    maxOutputTokens: 8_192,
    capabilities: {
      toolCalling: true,
      imageInput: false,
      thinking: false,
      videoInput: false,
    },
    thinkingStyle: 'none',
    detail: 'live',
  };
}

describe('T42 — live model catalog sync', () => {
  it('adds a model the static catalog does not cover', () => {
    const merged = mergeCatalog(BUILT_IN_CATALOG, [liveEntry('MiniMax-M4')]);
    const m4 = merged.find((e) => e.id === 'MiniMax-M4');
    ok(m4, 'a brand-new live model must reach the merged catalog');
    // AGENTS.md invariant: no toolCalling means hidden from agent mode.
    equal(m4.capabilities.toolCalling, true);
  });

  it('keeps the CURATED entry when the live list repeats a static id', () => {
    // The live list carries no token budgets, so a naive merge would
    // replace M3's curated 872K/128K budget with the live default.
    const merged = mergeCatalog(BUILT_IN_CATALOG, [liveEntry('MiniMax-M3')]);
    const m3 = merged.find((e) => e.id === 'MiniMax-M3');
    const curated = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');
    ok(m3, 'M3 must be present');
    ok(curated, 'M3 must be curated');
    equal(m3.maxInputTokens, curated.maxInputTokens);
    equal(m3.maxOutputTokens, curated.maxOutputTokens);
    equal(m3.thinkingStyle, curated.thinkingStyle);
  });

  it('never resurrects a retired model the live list still reports', () => {
    // The platform's `/v1/models` keeps listing the wound-down models.
    // A live sync that re-adds them puts dead models back in the picker.
    const live = RETIRED_MODEL_IDS.map((id) => liveEntry(id));
    const merged = mergeCatalog(BUILT_IN_CATALOG, live);
    for (const id of RETIRED_MODEL_IDS) {
      const entry = merged.find((e) => e.id === id);
      if (!entry) continue; // not in the static catalog at all — fine
      equal(
        entry.deprecated,
        true,
        `${id} must stay deprecated even when the live list reports it`,
      );
    }
  });

  it('never lets a media model into the chat catalog', () => {
    const live = MEDIA_MODEL_IDS.map((id) => liveEntry(id));
    const merged = mergeCatalog(BUILT_IN_CATALOG, live);
    for (const id of MEDIA_MODEL_IDS) {
      equal(
        merged.some((e) => e.id === id),
        false,
        `${id} is not a chat model and must not reach the chat picker`,
      );
    }
  });

  it('keeps the current model list free of retired and media ids', () => {
    // The picker is driven by CURRENT_MODEL_IDS plus any live extras.
    // Nothing retired or media-shaped may appear there.
    for (const id of CURRENT_MODEL_IDS) {
      ok(!RETIRED_MODEL_IDS.includes(id as never), `${id} must not be a retired id`);
      ok(!MEDIA_MODEL_IDS.includes(id as never), `${id} must not be a media id`);
    }
  });
});

describe('resolveRetiredModel', () => {
  const m2 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M2.5');
  const m3 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');

  it('swaps a deprecated model the platform no longer lists', () => {
    const served = new Set(['MiniMax-M3.1-Flash']);
    equal(resolveRetiredModel(m2, served), 'MiniMax-M3.1-Flash');
  });

  it('prefers the first current model that is actually served', () => {
    const served = new Set(['MiniMax-M3', 'MiniMax-M3.1-Flash']);
    equal(resolveRetiredModel(m2, served), 'MiniMax-M3');
  });

  it('leaves a deprecated model alone while the platform still lists it', () => {
    equal(resolveRetiredModel(m2, new Set(['MiniMax-M2.5', 'MiniMax-M3'])), undefined);
  });

  it('never swaps a current model, even one missing from the live list', () => {
    equal(resolveRetiredModel(m3, new Set(['something-else'])), undefined);
  });

  it('does nothing before a live list is known', () => {
    equal(resolveRetiredModel(m2, undefined), undefined);
  });

  it('does not touch an alias that already names its stand-in', () => {
    const preview = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3.1-Flash-Preview');
    equal(resolveRetiredModel(preview, new Set(['MiniMax-M3'])), undefined);
  });
});

describe('applyContextWindow', () => {
  const m3 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M3');

  it('sizes the input budget as window minus output budget', () => {
    ok(m3);
    const [small] = applyContextWindow([m3], 512_000);
    equal(small?.maxInputTokens, 512_000 - m3.maxOutputTokens);
    const [big] = applyContextWindow([m3], 1_000_000);
    equal(big?.maxInputTokens, 872_000);
  });

  it('rewrites the picker detail and flags the larger window as higher usage', () => {
    ok(m3);
    equal(applyContextWindow([m3], 512_000)[0]?.detail.startsWith('512K ctx · 128K out'), true);
    equal(applyContextWindow([m3], 1_000_000)[0]?.detail.startsWith('1M ctx (higher usage)'), true);
  });

  it('leaves models without window options untouched', () => {
    const m25 = BUILT_IN_CATALOG.find((e) => e.id === 'MiniMax-M2.5');
    ok(m25);
    equal(applyContextWindow([m25], 512_000)[0], m25);
  });

  it('only accepts offered windows from a setting value', () => {
    equal(coerceContextWindow(512000), 512_000);
    equal(coerceContextWindow('1000000'), 1_000_000);
    equal(coerceContextWindow(300_000), undefined);
    equal(coerceContextWindow('big'), undefined);
  });
});
