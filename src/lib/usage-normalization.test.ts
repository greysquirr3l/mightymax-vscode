/**
 * Token Plan usage normalizer — fixture-driven truth table.
 *
 * Semantics asserted here (see `usage-normalization.ts` docstring
 * for the full invariant list):
 * - Envelope with `status_code: 0, status_msg: 'success'` parses.
 * - `null` / missing `status_code` is accepted when `status_msg` is
 *   `'success'` (MiniMax occasionally returns that shape).
 * - Failed envelope throws.
 * - Payloads without `model_remains` throw.
 * - Among multiple entries, `model_name === 'general'` wins.
 * - If `general` is absent, the first ACTIVE entry with a numeric
 *   remaining percent wins.
 * - Percentages are inverted (REMAINING → used) and rounded.
 * - `remains_time` is RELATIVE ms from `now`; the rendered `resetsAt`
 *   is `now + remains_time` as ISO (the adapter formats on display).
 * - Windows with status `3` (not in plan) are dropped, even when the
 *   payload lies by reporting 100% remaining.
 * - When every window is filtered out, the function throws so the
 *   transport surfaces a clean UsageUnavailableError.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';

import {
  parseModelRemains,
  selectEntry,
  normalizeTokenPlanRemains,
  describeWindow,
  bindingWindow,
} from './domain/usage-normalization.js';

const FIXTURE = {
  base_resp: { status_code: 0, status_msg: 'success' },
  model_remains: [
    {
      model_name: 'general',
      current_interval_status: 1,
      current_interval_remaining_percent: 38,
      remains_time: 5_400_000,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 81,
      weekly_remains_time: 172_800_000,
    },
    {
      model_name: 'MiniMax-M3',
      current_interval_status: 1,
      current_interval_remaining_percent: 40,
      remains_time: 5_400_000,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 82,
      weekly_remains_time: 172_800_000,
    },
  ],
} as const;

const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);

describe('parseModelRemains — envelope validation', () => {
  it('accepts a successful envelope', () => {
    strictEqual(parseModelRemains(FIXTURE).length, 2);
  });

  it('accepts null/absent status_code when status_msg is success', () => {
    const p = { base_resp: { status_msg: 'success' }, model_remains: [] };
    deepStrictEqual(parseModelRemains(p), []);
  });

  it('rejects a failed envelope', () => {
    const p = { base_resp: { status_code: 1004, status_msg: 'auth failed' }, model_remains: [] };
    throws(() => parseModelRemains(p), /envelope not successful/);
  });

  it('rejects payloads without model_remains', () => {
    const p = { base_resp: { status_code: 0, status_msg: 'success' } };
    throws(() => parseModelRemains(p), /no model_remains array/);
  });

  it('rejects non-object payloads', () => {
    throws(() => parseModelRemains('not json'), /not an object/);
  });
});

describe('selectEntry — entry selection', () => {
  it('prefers the "general" record', () => {
    strictEqual(selectEntry(parseModelRemains(FIXTURE))?.model_name, 'general');
  });

  it('falls back to the first active entry with a percent', () => {
    const entries = [
      { model_name: 'x', current_interval_status: 3 },
      {
        model_name: 'MiniMax-M3',
        current_interval_status: 1,
        current_interval_remaining_percent: 55,
      },
    ];
    strictEqual(selectEntry(entries)?.model_name, 'MiniMax-M3');
  });
});

describe('normalizeTokenPlanRemains — semantics', () => {
  it('inverts remaining → used and builds both windows', () => {
    const u = normalizeTokenPlanRemains(FIXTURE, NOW);
    strictEqual(u.windows.length, 2);
    deepStrictEqual(u.windows[0], {
      label: '5-hour window',
      short: '5h',
      percentUsed: 62,
      resetsAt: new Date(NOW + 5_400_000).toISOString(),
    });
    deepStrictEqual(u.windows[1], {
      label: 'Weekly window',
      short: 'wk',
      percentUsed: 19,
      resetsAt: new Date(NOW + 172_800_000).toISOString(),
    });
    // Overall = binding constraint = most-consumed window.
    strictEqual(u.percentUsed, 62);
  });

  it('drops windows with status 3 (phantom 100%-remaining buckets)', () => {
    const p = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'general',
          current_interval_status: 1,
          current_interval_remaining_percent: 10,
          remains_time: 1000,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 100,
          weekly_remains_time: 0,
        },
      ],
    };
    const u = normalizeTokenPlanRemains(p, NOW);
    strictEqual(u.windows.length, 1);
    strictEqual(u.windows[0]?.label, '5-hour window');
    strictEqual(u.percentUsed, 90);
  });

  it('clamps inverted percentages to [0,100]', () => {
    const p = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'general',
          current_interval_status: 1,
          current_interval_remaining_percent: -7, // malformed; inverted to 107 → clamp to 100
          current_weekly_status: 1,
          current_weekly_remaining_percent: 150, // malformed; inverted to -50 → clamp to 0
        },
      ],
    };
    const u = normalizeTokenPlanRemains(p, NOW);
    strictEqual(u.windows[0]?.percentUsed, 100);
    strictEqual(u.windows[1]?.percentUsed, 0);
  });

  it('omits resetsAt when remains_time is missing or non-finite', () => {
    const p = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'general',
          current_interval_status: 1,
          current_interval_remaining_percent: 50,
        },
      ],
    };
    const u = normalizeTokenPlanRemains(p, NOW);
    strictEqual(u.windows[0]?.resetsAt, undefined);
  });

  it('throws when no model_remains entry is usable', () => {
    const p = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        { model_name: 'general', current_interval_status: 3, current_weekly_status: 3 },
      ],
    };
    throws(() => normalizeTokenPlanRemains(p, NOW), /Token plan entry reported no active windows/);
  });

  it('throws when payload has envelope ok but missing model_remains', async () => {
    // A successful envelope with no `model_remains` array — the
    // envelope check passes, then the array-shape check fires.
    const p = { base_resp: { status_code: 0, status_msg: 'success' } };
    await rejects(async () => normalizeTokenPlanRemains(p, NOW), /no model_remains array/);
  });

  it('throws when envelope reports a failure', async () => {
    const p = { base_resp: { status_code: 9999, status_msg: 'down' }, model_remains: [] };
    await rejects(async () => normalizeTokenPlanRemains(p, NOW), /envelope not successful/);
  });

  it('carries the raw payload and a fetchedAt timestamp', () => {
    const u = normalizeTokenPlanRemains(FIXTURE, NOW);
    ok(u.raw);
    strictEqual(u.fetchedAt.toISOString(), new Date(NOW).toISOString());
  });
});

describe('window naming and pools', () => {
  const H = 3_600_000;
  it('names windows by their real length', () => {
    deepStrictEqual(describeWindow(5 * H, 'interval'), { label: '5-hour window', short: '5h' });
    deepStrictEqual(describeWindow(24 * H, 'interval'), { label: 'Daily window', short: 'day' });
    deepStrictEqual(describeWindow(168 * H, 'weekly'), { label: 'Weekly window', short: 'wk' });
    deepStrictEqual(describeWindow(12 * H, 'interval'), { label: '12-hour window', short: '12h' });
    deepStrictEqual(describeWindow(undefined, 'weekly'), { label: 'Weekly window', short: 'wk' });
  });

  it('surfaces the video pool with counts and a daily window, and drops per-model text entries', () => {
    const live = {
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'general',
          start_time: 0,
          end_time: 5 * H,
          remains_time: H,
          current_interval_status: 1,
          current_interval_remaining_percent: 74,
          weekly_start_time: 0,
          weekly_end_time: 168 * H,
          weekly_remains_time: 100 * H,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 71,
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
        },
        {
          model_name: 'video',
          start_time: 0,
          end_time: 24 * H,
          remains_time: 10 * H,
          current_interval_status: 1,
          current_interval_remaining_percent: 100,
          current_interval_total_count: 3,
          current_interval_usage_count: 0,
          weekly_start_time: 0,
          weekly_end_time: 168 * H,
          weekly_remains_time: 100 * H,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 100,
          current_weekly_total_count: 21,
          current_weekly_usage_count: 0,
        },
        { model_name: 'MiniMax-M3', current_interval_status: 1, current_interval_remaining_percent: 50 },
      ],
    };
    const u = normalizeTokenPlanRemains(live, NOW);
    strictEqual(u.windows[0]?.usedCount, undefined, 'percent-only pool carries no counts');
    strictEqual(u.pools?.length, 1);
    const video = u.pools?.[0];
    strictEqual(video?.label, 'Video');
    strictEqual(video?.windows[0]?.label, 'Daily window');
    strictEqual(video?.windows[0]?.totalCount, 3);
    strictEqual(video?.windows[1]?.totalCount, 21);
    strictEqual(u.percentUsed, 29, 'pools never drive the headline percentage');
  });

  it('picks the most-consumed window as the binding one', () => {
    const u = normalizeTokenPlanRemains(FIXTURE, NOW);
    strictEqual(bindingWindow(u)?.short, '5h');
  });
});
