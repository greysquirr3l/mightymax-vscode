/**
 * T32 — flight-deck tooltip renderer unit tests.
 *
 * Pure renderers, so the tests just feed `FlightDeckTooltipInput`
 * snapshots in and assert on the rendered markdown. No host / vscode
 * import. Covers the four states the T32 spec calls out explicitly:
 *
 *   1. healthy — all slots stored and not in cooldown
 *   2. one-slot-cooldown — slot 3 just failed; "cooldown 47s"
 *   3. last-fallback-set — recent sticky fallback recorded
 *   4. no-keys — no slot stored at all → onboarding hint
 *
 * Plus a smoke test for `buildFlightDeckText` covering the `$(error)`
 * suffix and a "PAYG / usage unavailable" tooltip variant.
 */
import { describe, it } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';

import {
  buildFlightDeckText,
  buildFlightDeckTooltip,
  isActiveInCooldown,
  FLIGHT_DECK_ICON,
  type FlightDeckTooltipInput,
} from './flight-deck-tooltip.js';
import type { KeySlot } from './key-pool.js';
import type { TokenPlanUsage } from './usage-normalization.js';

function baseInput(overrides: Partial<FlightDeckTooltipInput> = {}): FlightDeckTooltipInput {
  return {
    activeSlot: 1,
    stored: [1, 2, 3],
    healthySlots: new Set<KeySlot>([1, 2, 3]),
    cooldownMsRemaining: new Map<KeySlot, number>(),
    labels: new Map<KeySlot, string>(),
    autoRotationEnabled: true,
    lastFallback: undefined,
    usage: {
      percentUsed: 42,
      windows: [
        { label: '5-hour window', percentUsed: 42 },
        { label: 'Weekly window', percentUsed: 18 },
      ],
      raw: {},
      fetchedAt: new Date(0),
    },
    nowMs: Date.UTC(2025, 0, 1, 16, 24, 3),
    noKey: false,
    usageUnavailable: false,
    ...overrides,
  };
}

describe('buildFlightDeckTooltip', () => {
  it('renders the healthy state with all three slots marked healthy and ★ on the active', () => {
    const md = buildFlightDeckTooltip(baseInput());
    equal(md.includes('▼ Mighty Max · Flight Deck'), true);
    equal(md.includes('Slot 1 ● healthy ★'), true);
    equal(md.includes('Slot 2 ● healthy'), true);
    equal(md.includes('Slot 3 ● healthy'), true);
    equal(md.includes('Auto-rotation: ON'), true);
    equal(md.includes('Last fallback: (none yet)'), true);
    equal(md.includes('5h window: 42% used'), true);
    equal(md.includes('Weekly:    18% used'), true);
    equal(md.includes('as of 16:24:03 · click for details'), true);
  });

  it('renders one-slot-cooldown with the "cooldown Ns" line', () => {
    const cooldownMsRemaining = new Map<KeySlot, number>([
      [3, 47_000], // 47s remaining
    ]);
    const input = baseInput({
      cooldownMsRemaining,
      healthySlots: new Set<KeySlot>([1, 2]),
    });
    const md = buildFlightDeckTooltip(input);
    equal(md.includes('Slot 3 ○ cooldown 47s'), true);
    equal(md.includes('Slot 1 ● healthy ★'), true);
    equal(md.includes('Slot 2 ● healthy'), true);
  });

  it('renders the last-fallback-set state with the relative-ago math', () => {
    const now = Date.UTC(2025, 0, 1, 16, 24, 3);
    const input = baseInput({
      activeSlot: 2, // fallback promoted slot 2 to active
      lastFallback: {
        slot: 2,
        fellBackFrom: 1, // slot 1 had failed
        atMs: now - 3 * 60_000, // 3m ago
      },
      nowMs: now,
    });
    const md = buildFlightDeckTooltip(input);
    equal(md.includes('Last fallback: slot 1 · 3m ago'), true);
    equal(md.includes('Slot 2 ● healthy ★'), true);
  });

  it('renders the no-keys state with the onboarding hint and no Token Plan lines', () => {
    const input = baseInput({
      noKey: true,
      stored: [],
      healthySlots: new Set<KeySlot>(),
      usage: undefined,
    });
    const md = buildFlightDeckTooltip(input);
    equal(md, 'Mighty Max — no API key set. Run `Mighty Max: Manage`.');
  });

  it('renders the usage-unavailable line when PAYG key returns no quota', () => {
    const input = baseInput({
      usage: undefined,
      usageUnavailable: true,
    });
    const md = buildFlightDeckTooltip(input);
    equal(md.includes('_usage unavailable (pay-as-you-go keys have no Token Plan bar)_'), true);
    equal(md.includes('5h window:'), false);
  });

  it('falls back to "just now" for sub-minute last-fallback ages', () => {
    const now = Date.UTC(2025, 0, 1, 16, 24, 3);
    const md = buildFlightDeckTooltip(
      baseInput({
        lastFallback: { slot: 2, fellBackFrom: 1, atMs: now - 5_000 },
        nowMs: now,
      }),
    );
    equal(md.includes('Last fallback: slot 1 · just now'), true);
  });

  it('clamps to default labels when the user has not renamed any slot', () => {
    const md = buildFlightDeckTooltip(baseInput({ labels: new Map() }));
    equal(md.includes('★'), true);
  });

  it('renders OFF for the auto-rotation toggle when disabled', () => {
    const md = buildFlightDeckTooltip(baseInput({ autoRotationEnabled: false }));
    equal(md.includes('Auto-rotation: OFF'), true);
  });
});

describe('buildFlightDeckText', () => {
  it('renders icon + percent when usage is known and the active slot is healthy', () => {
    const text = buildFlightDeckText({
      icon: FLIGHT_DECK_ICON,
      percentUsed: 42,
      activeInCooldown: false,
    });
    equal(text, `${FLIGHT_DECK_ICON} 42%`);
  });

  it('appends $(error) when the active slot is in cooldown', () => {
    const text = buildFlightDeckText({
      icon: FLIGHT_DECK_ICON,
      percentUsed: 42,
      activeInCooldown: true,
    });
    equal(text.endsWith(' $(error)'), true);
  });

  it('renders just the icon when usage is unknown', () => {
    const text = buildFlightDeckText({
      icon: FLIGHT_DECK_ICON,
      percentUsed: undefined,
      activeInCooldown: false,
    });
    equal(text, FLIGHT_DECK_ICON);
  });

  it('still appends $(error) when usage is unknown and active slot is in cooldown', () => {
    const text = buildFlightDeckText({
      icon: FLIGHT_DECK_ICON,
      percentUsed: undefined,
      activeInCooldown: true,
    });
    equal(text, `${FLIGHT_DECK_ICON} $(error)`);
  });
});

describe('isActiveInCooldown', () => {
  it('returns true when the active slot has a positive cooldown remaining', () => {
    const input = baseInput({
      activeSlot: 2,
      cooldownMsRemaining: new Map<KeySlot, number>([[2, 5_000]]),
    });
    equal(isActiveInCooldown(input), true);
  });

  it('returns false when the active slot is healthy', () => {
    equal(isActiveInCooldown(baseInput()), false);
  });
});

// Smoke test: the rendered tooltip is stable across repeated renders
// with the same input. (Catches accidental hidden Date.now() or
// non-deterministic iteration.)
describe('flight-deck determinism', () => {
  it('produces identical output for identical inputs across two renders', () => {
    const input = baseInput();
    const a = buildFlightDeckTooltip(input);
    const b = buildFlightDeckTooltip(input);
    deepEqual(a, b);
    ok(a.length > 0);
  });
});

// Suppress unused-variable warning for TokenPlanUsage when this file
// is consumed by other tests in the future.
void ({} as TokenPlanUsage);
