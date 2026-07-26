/**
 * T29 — Reusable QuickPick status header.
 *
 * Pure module under test: `src/commands/quickpick-header.ts`.
 * The header is rendered at the top of every manage QuickPick and
 * surfaces the live key state — active slot, per-slot health dots,
 * auto-rotation toggle, and (when the active slot is in cooldown) a
 * warning line with cooldown-remaining seconds.
 *
 * State shape (from the T29 spec):
 *   - `stored`: which slots have a key on file (1/2/3).
 *   - `activeSlot`: which slot is currently preferred.
 *   - `cooldown`: ms remaining per slot in cooldown (0 = healthy).
 *   - `autoRotateEnabled`: whether the manage-toggle is ON.
 *
 * The function returns a `kind: 'separator'` PickItem so VS Code's
 * QuickPick renders it as a non-selectable divider at index 0.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import { buildStatusHeader, type HeaderState } from './quickpick-header.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<HeaderState> = {}): HeaderState {
  return {
    activeSlot: 1,
    stored: [1],
    cooldown: new Map(),
    autoRotateEnabled: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Healthy states (active slot OK, no other cooldowns)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStatusHeader — healthy single-key', () => {
  it('renders "Active: Slot 1 ★   ●   Auto-rotate: ON" for one stored key', () => {
    const header = buildStatusHeader(makeState({ stored: [1] }));
    strictEqual(header.kind, 'separator');
    ok(header.alwaysShown, 'header must always show');
    ok(header.label.includes('Active: Slot 1'), `expected active-slot label; got: ${header.label}`);
    ok(header.label.includes('★'), `expected star marker for active; got: ${header.label}`);
    ok(header.label.includes('Auto-rotate: ON'), `expected auto-rotate ON; got: ${header.label}`);
    ok(header.label.includes('●'), `expected at least one healthy dot; got: ${header.label}`);
  });

  it('reflects Auto-rotate: OFF when the setting is false', () => {
    const header = buildStatusHeader(makeState({ stored: [1], autoRotateEnabled: false }));
    ok(header.label.includes('Auto-rotate: OFF'), `expected auto-rotate OFF; got: ${header.label}`);
  });

  it('renders three healthy dots (● ● ●) when all three slots are healthy', () => {
    const header = buildStatusHeader(
      makeState({ activeSlot: 1, stored: [1, 2, 3], autoRotateEnabled: true }),
    );
    ok(header.label.includes('Active: Slot 1'), `got: ${header.label}`);
    ok(header.label.includes('★'), 'expected active-star marker in prefix');
    const dotMatches = header.label.match(/●/g) ?? [];
    strictEqual(
      dotMatches.length,
      3,
      `expected exactly 3 healthy dots (one per stored slot); got ${dotMatches.length} in: ${header.label}`,
    );
    ok(
      !header.label.includes('○'),
      `healthy state must not render any empty dots; got: ${header.label}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Partial-cooldown states (active slot OK, at least one other slot cooling)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStatusHeader — partial cooldown', () => {
  it('renders an "○" for slots in cooldown when active slot is healthy', () => {
    const header = buildStatusHeader(
      makeState({
        activeSlot: 1,
        stored: [1, 2, 3],
        cooldown: new Map([[2, 47_000]]),
      }),
    );
    ok(header.label.includes('★'), 'active slot must still show ★');
    ok(
      header.label.includes('○'),
      `expected at least one empty dot for the cooling slot; got: ${header.label}`,
    );
    // Slot 3 should still be a healthy dot since it's not in cooldown.
    const dotMatches = header.label.match(/●/g) ?? [];
    ok(
      dotMatches.length >= 1,
      `expected at least one healthy dot for slot 3; got ${dotMatches.length} in: ${header.label}`,
    );
  });

  it('shows per-slot cooldown seconds in the description when a non-active slot is cooling', () => {
    const header = buildStatusHeader(
      makeState({
        activeSlot: 1,
        stored: [1, 2, 3],
        cooldown: new Map([[2, 58_000]]),
      }),
    );
    ok(
      (header.description ?? '').includes('58s'),
      `expected "58s" cooldown remaining in description; got: ${JSON.stringify(header.description ?? '')}`,
    );
    ok(
      header.label.includes('★') && header.label.includes('○'),
      `expected label to still show ★ active + ○ empty dots; got: ${header.label}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Active-slot-in-cooldown warning state
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStatusHeader — active slot in cooldown (warning)', () => {
  it('shows the ⚠ rejection line when the active slot is in cooldown', () => {
    const header = buildStatusHeader(
      makeState({
        activeSlot: 1,
        stored: [1, 2, 3],
        cooldown: new Map([[1, 47_000]]),
      }),
    );
    ok(header.label.includes('⚠'), `expected warning glyph; got: ${header.label}`);
    ok(
      header.label.includes('Slot 1') || (header.description ?? '').includes('Slot 1'),
      `expected the active slot id in the warning line; got: label=${JSON.stringify(header.label)} description=${JSON.stringify(header.description ?? '')}`,
    );
  });

  it('shows how many slots are ready (N of M) in the description', () => {
    const header = buildStatusHeader(
      makeState({
        activeSlot: 1,
        stored: [1, 2, 3],
        cooldown: new Map([[1, 12_000]]),
      }),
    );
    ok(
      (header.description ?? '').includes('2 of 3'),
      `expected "2 of 3" ready-count description; got: ${header.description ?? ''}`,
    );
  });

  it('rounds cooldown ms up to whole seconds', () => {
    const header = buildStatusHeader(
      makeState({
        activeSlot: 1,
        stored: [1, 2, 3],
        cooldown: new Map([[1, 47_500]]), // 47.5s → 48s
      }),
    );
    ok(
      header.label.includes('48s') || (header.description ?? '').includes('48s'),
      `expected rounded "48s" cooldown label; got: label=${JSON.stringify(header.label)} description=${JSON.stringify(header.description ?? '')}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No-keys onboarding state
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStatusHeader — no keys stored', () => {
  it('renders the onboarding hint when the stored list is empty', () => {
    const header = buildStatusHeader(
      makeState({ activeSlot: 1, stored: [], autoRotateEnabled: true }),
    );
    ok(
      header.label.includes('No MiniMax API keys stored'),
      `expected onboarding line; got: ${header.label}`,
    );
    ok(
      header.label.includes('Add or rotate key') ||
        (header.description ?? '').includes('Add or rotate key'),
      `expected the CTA hint; got: label=${JSON.stringify(header.label)} description=${JSON.stringify(header.description ?? '')}`,
    );
  });

  it('does not render slot dots or auto-rotate state in the onboarding line', () => {
    const header = buildStatusHeader(makeState({ stored: [] }));
    ok(!header.label.includes('★'), `onboarding header must not show a star; got: ${header.label}`);
    ok(
      !header.label.includes('Auto-rotate'),
      `onboarding header must not show auto-rotate state; got: ${header.label}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('buildStatusHeader — invariants', () => {
  it('always returns kind="separator" so the row is non-selectable', () => {
    for (const state of [
      makeState({ stored: [1] }),
      makeState({ stored: [1, 2, 3] }),
      makeState({ stored: [1, 2, 3], cooldown: new Map([[1, 10_000]]) }),
      makeState({ stored: [] }),
    ]) {
      const header = buildStatusHeader(state);
      strictEqual(
        header.kind,
        'separator',
        `expected separator kind for state ${JSON.stringify(state)}; got: ${header.kind}`,
      );
    }
  });

  it('always returns alwaysShown=true so the header sticks at the top', () => {
    const header = buildStatusHeader(makeState({ stored: [1] }));
    strictEqual(header.alwaysShown, true);
  });

  it('never returns an empty label for any state', () => {
    for (const state of [
      makeState({ stored: [1] }),
      makeState({ stored: [1, 2, 3], autoRotateEnabled: false }),
      makeState({ stored: [1, 2, 3], cooldown: new Map([[2, 30_000]]) }),
      makeState({ stored: [1, 2, 3], cooldown: new Map([[1, 30_000]]) }),
      makeState({ stored: [] }),
    ]) {
      const header = buildStatusHeader(state);
      ok(header.label.length > 0, `empty label for state ${JSON.stringify(state)}`);
    }
  });
});
