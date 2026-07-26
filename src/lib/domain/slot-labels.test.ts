/**
 * T31 — slot-label domain tests.
 *
 * Pure helpers (`buildDefaultLabels`, `getLabel`, `setLabel`,
 * `parseLabelsFromGlobalState`, `serializeLabelsToGlobalState`,
 * `defaultLabelFor`) — no I/O, no vscode imports.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import {
  buildDefaultLabels,
  defaultLabelFor,
  getLabel,
  parseLabelsFromGlobalState,
  serializeLabelsToGlobalState,
  setLabel,
  type SlotLabelMap,
} from './slot-labels.js';

describe('buildDefaultLabels', () => {
  it('returns an empty map', () => {
    const map = buildDefaultLabels();
    strictEqual(map.size, 0);
  });
});

describe('defaultLabelFor', () => {
  it('returns "Slot N" for each slot', () => {
    strictEqual(defaultLabelFor(1), 'Slot 1');
    strictEqual(defaultLabelFor(2), 'Slot 2');
    strictEqual(defaultLabelFor(3), 'Slot 3');
  });
});

describe('getLabel', () => {
  const labels: SlotLabelMap = new Map([
    [1, 'personal'],
    [2, ''], // explicit empty is treated as "no label"
  ]);

  it('returns the stored label when set and non-empty', () => {
    strictEqual(getLabel(labels, 1, 'Slot 1'), 'personal');
  });

  it('falls back to the default when no label is stored', () => {
    strictEqual(getLabel(labels, 3, 'Slot 3'), 'Slot 3');
  });

  it('falls back to the default when the stored label is empty', () => {
    strictEqual(getLabel(labels, 2, 'Slot 2'), 'Slot 2');
  });
});

describe('setLabel', () => {
  it('returns a new map with the label added', () => {
    const before = buildDefaultLabels();
    const after = setLabel(before, 1, 'personal');
    strictEqual(after.get(1), 'personal');
    // Original is unchanged (no mutation).
    ok(!before.has(1), 'input map must not be mutated');
  });

  it('removes the entry when the new label is empty', () => {
    const before: SlotLabelMap = new Map([[1, 'personal']]);
    const after = setLabel(before, 1, '');
    ok(!after.has(1), 'empty-string label must delete the entry');
    ok(before.has(1), 'input map must not be mutated');
  });

  it('overwrites an existing label', () => {
    const before: SlotLabelMap = new Map([[1, 'old']]);
    const after = setLabel(before, 1, 'new');
    strictEqual(after.get(1), 'new');
  });
});

describe('parseLabelsFromGlobalState', () => {
  it('returns an empty map for null', () => {
    strictEqual(parseLabelsFromGlobalState(null).size, 0);
  });

  it('returns an empty map for undefined', () => {
    strictEqual(parseLabelsFromGlobalState(undefined).size, 0);
  });

  it('returns an empty map for non-objects', () => {
    strictEqual(parseLabelsFromGlobalState('hello').size, 0);
    strictEqual(parseLabelsFromGlobalState(42).size, 0);
    strictEqual(parseLabelsFromGlobalState(true).size, 0);
  });

  it('parses a valid labels object', () => {
    const map = parseLabelsFromGlobalState({ 1: 'personal', 2: 'work' });
    strictEqual(map.get(1), 'personal');
    strictEqual(map.get(2), 'work');
    strictEqual(map.size, 2);
  });

  it('drops out-of-range slots (0, 4, 5, fractional, negative)', () => {
    const map = parseLabelsFromGlobalState({
      0: 'zero',
      4: 'four',
      1.5: 'fractional',
      '-1': 'neg',
    });
    strictEqual(map.size, 0);
  });

  it('drops non-string values', () => {
    const map = parseLabelsFromGlobalState({
      1: 42,
      2: null,
      3: { nested: 'object' },
    });
    strictEqual(map.size, 0);
  });

  it('round-trips non-empty labels and drops empty ones', () => {
    const before: SlotLabelMap = new Map([
      [1, 'personal'],
      [2, 'work'],
      [3, ''], // empty is dropped on serialize (no key emitted)
    ]);
    const wire = serializeLabelsToGlobalState(before);
    const after = parseLabelsFromGlobalState(wire);
    strictEqual(after.size, 2);
    strictEqual(after.get(1), 'personal');
    strictEqual(after.get(2), 'work');
    ok(!after.has(3), 'empty labels are not serialized');
  });
});

describe('serializeLabelsToGlobalState', () => {
  it('round-trips with parseLabelsFromGlobalState', () => {
    const before: SlotLabelMap = new Map([
      [1, 'personal'],
      [2, 'work'],
      [3, ''], // empty is dropped on serialize (no key emitted)
    ]);
    const wire = serializeLabelsToGlobalState(before);
    const after = parseLabelsFromGlobalState(wire);
    strictEqual(after.size, 2);
    strictEqual(after.get(1), 'personal');
    strictEqual(after.get(2), 'work');
    ok(!after.has(3), 'empty labels are not serialized');
  });
});
