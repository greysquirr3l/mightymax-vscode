/**
 * T31 — Per-slot flight-deck view.
 *
 * The view replaces the 10-item `handleManageApiKeys` with a per-slot
 * pick list. Each row is one slot; tapping a row opens an action
 * sheet (Set / Test / Clear / Make active / Rename). The "Make
 * active" action is hidden when the slot is already active.
 *
 * Slot labels are user-chosen strings stored in `globalState` — see
 * `src/lib/domain/slot-labels.ts`. The view consumes the same
 * `ManageUi` / `KeyProvider` / `Logger` ports as the rest of the
 * command tree.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import type { KeySlot } from '../ports/key-provider.js';
import { createInMemorySecretStore } from './manage-command.test-helpers.js';
import { makeTestKeyProvider } from '../test-helpers/key-provider-test-double.js';

import {
  buildFlightDeckItems,
  runSlotActionSheet,
  type FlightDeckState,
} from './flight-deck-view.js';

function makeState(overrides: Partial<FlightDeckState> = {}): FlightDeckState {
  return {
    activeSlot: 1,
    stored: [1],
    cooldown: new Map(),
    labels: new Map(),
    autoRotateEnabled: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-slot row view
// ─────────────────────────────────────────────────────────────────────────────

describe('buildFlightDeckItems — per-slot row layout', () => {
  it('renders one row per stored slot', () => {
    const items = buildFlightDeckItems(makeState({ activeSlot: 1, stored: [1, 2, 3] }));
    strictEqual(items.length, 3);
    ok(items[0]?.label.includes('Slot 1'), `expected slot 1 row; got: ${items[0]?.label}`);
    ok(items[2]?.label.includes('Slot 3'), `expected slot 3 row; got: ${items[2]?.label}`);
  });

  it('shows the active slot with ★ and the others with ●', () => {
    const items = buildFlightDeckItems(makeState({ activeSlot: 2, stored: [1, 2, 3] }));
    const activeRow = items[1]?.label ?? '';
    ok(activeRow.includes('★'), `expected ★ on active slot row; got: ${activeRow}`);
    ok((items[0]?.label ?? '').includes('●'), 'expected ● on non-active slot');
    ok((items[2]?.label ?? '').includes('●'), 'expected ● on non-active slot');
  });

  it('uses the stored label when present, falls back to "Slot N" otherwise', () => {
    const items = buildFlightDeckItems(
      makeState({
        activeSlot: 1,
        stored: [1, 2],
        labels: new Map<KeySlot, string>([
          [1, 'personal account'],
          [2, 'work account'],
        ]),
      }),
    );
    ok(
      items[0]?.label.includes('personal account'),
      `expected custom label; got: ${items[0]?.label}`,
    );
    ok(items[1]?.label.includes('work account'), `expected custom label; got: ${items[1]?.label}`);
  });

  it('falls back to "Slot N" when no label is stored', () => {
    const items = buildFlightDeckItems(makeState({ stored: [2] }));
    ok(items[0]?.label.includes('Slot 2'), `expected "Slot 2" fallback; got: ${items[0]?.label}`);
  });

  it('renders ○ when the slot is in cooldown', () => {
    const items = buildFlightDeckItems(
      makeState({
        activeSlot: 1,
        stored: [1, 2],
        cooldown: new Map<KeySlot, number>([[2, 47_000]]),
      }),
    );
    ok(
      (items[1]?.label ?? '').includes('○'),
      `expected ○ on cooldown slot; got: ${items[1]?.label}`,
    );
    ok(
      (items[0]?.label ?? '').includes('★'),
      `expected ★ on active healthy slot; got: ${items[0]?.label}`,
    );
  });

  it('returns no rows when no keys are stored', () => {
    const items = buildFlightDeckItems(makeState({ stored: [] }));
    strictEqual(items.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-slot action sheet
// ─────────────────────────────────────────────────────────────────────────────

describe('runSlotActionSheet — action sheet shape', () => {
  it('shows Set, Test, Clear, Make active, and Rename for an inactive slot', async () => {
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(2, 'sk-key-2');
    const calls: { labels: string[] }[] = [];
    const ui = {
      showQuickPick: async (items: readonly { label: string }[]) => {
        calls.push({ labels: items.map((i) => i.label) });
        return undefined;
      },
      showInputBox: async () => undefined,
      showInfoMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    };
    await runSlotActionSheet({
      slot: 2,
      keyProvider: kp,
      ui,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      labels: new Map(),
      fireChange: () => undefined,
      baseUrl: 'https://api.minimax.io',
    });
    const shown = calls[0]?.labels ?? [];
    ok(
      shown.some((l) => l.includes('Set')),
      `expected Set action; got: ${JSON.stringify(shown)}`,
    );
    ok(
      shown.some((l) => l.includes('Test')),
      `expected Test action; got: ${JSON.stringify(shown)}`,
    );
    ok(
      shown.some((l) => l.includes('Clear')),
      `expected Clear action; got: ${JSON.stringify(shown)}`,
    );
    ok(
      shown.some((l) => l.includes('Make active')),
      `expected Make active action; got: ${JSON.stringify(shown)}`,
    );
    ok(
      shown.some((l) => l.includes('Rename')),
      `expected Rename action; got: ${JSON.stringify(shown)}`,
    );
  });

  it('hides Make active when the slot is already the active slot', async () => {
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    const calls: { labels: string[] }[] = [];
    const ui = {
      showQuickPick: async (items: readonly { label: string }[]) => {
        calls.push({ labels: items.map((i) => i.label) });
        return undefined;
      },
      showInputBox: async () => undefined,
      showInfoMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    };
    await runSlotActionSheet({
      slot: 1,
      keyProvider: kp,
      ui,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      labels: new Map(),
      fireChange: () => undefined,
      baseUrl: 'https://api.minimax.io',
    });
    const shown = calls[0]?.labels ?? [];
    ok(
      !shown.some((l) => l.includes('Make active')),
      `expected Make active hidden; got: ${JSON.stringify(shown)}`,
    );
  });
});
