/**
 * Host reasoning-effort vocabulary unit tests.
 *
 * Pure mapping functions, no host / vscode import. Covers the
 * contract the VS Code host actually implements (verified by string
 * xref against the shipped workbench + agent-host bundles):
 *
 *  - The workbench reads ONLY `configurationSchema.properties.reasoningEffort`
 *    and takes its `.enum` / `.default` verbatim.
 *  - The agent host filters a provider-advertised enum against the
 *    canonical set `none|minimal|low|medium|high|xhigh|max|ultra`,
 *    silently dropping anything outside it.
 *  - The MiniMax wire vocabulary is narrower: `output_config.effort`
 *    accepts `low|medium|high|xhigh|max`, and `none` is a hard 400
 *    for M3.1-Flash (which always thinks).
 */
import { describe, it } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import {
  HOST_EFFORT_VALUES,
  PUBLISHED_EFFORT_VALUES,
  mapHostEffortToWire,
  publishedDefaultForEffort,
} from './host-effort.js';

describe('host-effort: published enum', () => {
  it('advertises only levels the host canonical set contains', () => {
    // The agent host filters the advertised enum against its own
    // canonical set and drops anything outside it — a level that
    // gets dropped makes the whole control disappear.
    for (const value of PUBLISHED_EFFORT_VALUES) {
      ok(HOST_EFFORT_VALUES.includes(value), `${value} must be a host-canonical effort`);
    }
  });

  it('omits none, because M3.1-Flash always thinks', () => {
    ok(!PUBLISHED_EFFORT_VALUES.includes('none'));
  });

  it('omits minimal, which collapses onto low on the wire', () => {
    ok(!PUBLISHED_EFFORT_VALUES.includes('minimal'));
  });

  it('advertises xhigh and max so the global thinking level can bind', () => {
    // Even though the wire value clamps to `high`, a model that does
    // not advertise these levels cannot be driven by the host's
    // global thinking-level control at all.
    ok(PUBLISHED_EFFORT_VALUES.includes('xhigh'));
    ok(PUBLISHED_EFFORT_VALUES.includes('max'));
  });
});

describe('host-effort: mapHostEffortToWire', () => {
  it('passes the wire-native levels through unchanged', () => {
    equal(mapHostEffortToWire('low'), 'low');
    equal(mapHostEffortToWire('medium'), 'medium');
    equal(mapHostEffortToWire('high'), 'high');
    equal(mapHostEffortToWire('xhigh'), 'xhigh');
    equal(mapHostEffortToWire('max'), 'max');
  });

  it('collapses minimal onto low', () => {
    equal(mapHostEffortToWire('minimal'), 'low');
  });

  it('collapses ultra onto max', () => {
    equal(mapHostEffortToWire('ultra'), 'max');
  });

  it('rejects none, which would 400 on M3.1-Flash', () => {
    equal(mapHostEffortToWire('none'), undefined);
  });

  it('rejects unknown and non-string values', () => {
    equal(mapHostEffortToWire('turbo'), undefined);
    equal(mapHostEffortToWire(undefined), undefined);
    equal(mapHostEffortToWire(null), undefined);
    equal(mapHostEffortToWire(42), undefined);
  });
});

describe('host-effort: publishedDefaultForEffort', () => {
  it('publishes the concrete levels unchanged', () => {
    equal(publishedDefaultForEffort('low'), 'low');
    equal(publishedDefaultForEffort('medium'), 'medium');
    equal(publishedDefaultForEffort('high'), 'high');
    equal(publishedDefaultForEffort('xhigh'), 'xhigh');
    equal(publishedDefaultForEffort('max'), 'max');
  });

  it('publishes the `default` sentinel as max', () => {
    // `default` omits `output_config` entirely so the API chooses,
    // and the API's own documented depth is `max`.
    equal(publishedDefaultForEffort('default'), 'max');
  });

  it('always publishes a value the host canonical set contains', () => {
    for (const effort of ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const published = publishedDefaultForEffort(effort);
      ok(
        HOST_EFFORT_VALUES.includes(published),
        `${effort} must publish a host-canonical default, got ${published}`,
      );
    }
  });

  it('keeps the published default inside the advertised enum', () => {
    // The host's `Bq()` default resolution only accepts a default
    // that is also in the advertised enum; otherwise it silently
    // substitutes its own fallback.
    for (const effort of ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const published = publishedDefaultForEffort(effort);
      ok(
        PUBLISHED_EFFORT_VALUES.includes(published),
        `${effort} must publish a default inside the advertised enum, got ${published}`,
      );
    }
  });
});

describe('host-effort: round trip', () => {
  it('maps every advertised level back to a wire effort', () => {
    const mapped = PUBLISHED_EFFORT_VALUES.map((value) => mapHostEffortToWire(value));
    deepEqual(
      mapped.filter((value) => value !== undefined),
      [...PUBLISHED_EFFORT_VALUES],
    );
  });
});
