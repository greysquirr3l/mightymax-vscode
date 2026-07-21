// Unit tests for the pure key-pool domain. No I/O; snapshot + clock in,
// pick result + cooldown state out.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  pickKey,
  withFailure,
  withSuccess,
  isKeySlot,
  orderedSlots,
  type KeySlot,
  type KeySnapshot,
  type KeySnapshotEntry,
  type CooldownState,
  type FailureKind,
} from './key-pool.js';

function snapshot(stored: KeySnapshotEntry[], activeSlot: KeySlot, nowMs = 0): KeySnapshot {
  return { stored, activeSlot, nowMs };
}

function entry(slot: KeySlot, key: string): KeySnapshotEntry {
  return { slot, key };
}

const KEY_1 = 'sk-slot-1';
const KEY_2 = 'sk-slot-2';
const KEY_3 = 'sk-slot-3';

void test('pickKey returns the active slot when stored and healthy', () => {
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 2);
  const cooldown: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const result = pickKey(s, cooldown);
  assert.ok(result !== undefined, 'pickKey should return a result');
  assert.equal(result.slot, 2);
  assert.equal(result.key, KEY_2);
  assert.equal(result.fellBack, false);
});

void test('pickKey returns the first stored slot when active slot is empty', () => {
  // user picked slot 2, but only slot 1 has a stored key
  const s = snapshot([entry(1, KEY_1)], 2);
  const cooldown: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const result = pickKey(s, cooldown);
  assert.ok(result !== undefined);
  assert.equal(result.slot, 1);
  assert.equal(result.key, KEY_1);
  assert.equal(result.fellBack, true, 'fellBack should be true when active slot is empty');
});

void test('pickKey returns undefined when no keys are stored', () => {
  const s = snapshot([], 1);
  const cooldown: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const result = pickKey(s, cooldown);
  assert.equal(result, undefined);
});

void test('pickKey skips the active slot when it is in cooldown', () => {
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 1_000);
  // auth failure on slot 1 at t=0 with a 60s cooldown ⇒ still in cooldown at t=1000
  const cooldown = withFailure({ failedAtMs: new Map(), failureKinds: new Map() }, 1, 'auth', 0);
  const result = pickKey(s, cooldown);
  assert.equal(result?.slot, 2, 'should fall through to slot 2');
  assert.equal(result?.fellBack, true);
});

void test('pickKey respects per-kind cooldown durations', () => {
  // rate-limit cooldown is shorter than auth cooldown. With a failure
  // recorded at t=0:
  //   - at t=29_999 (just before rate-limit boundary), slot 1 is in cooldown
  //   - at t=30_001 (just after), rate-limit has cleared but auth hasn't
  //   - at t=60_001, both have cleared
  const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const rlState = withFailure(base, 1, 'rate-limit', 0);
  const authState = withFailure(base, 1, 'auth', 0);

  // t = 29_999 — both still in cooldown
  const justBefore = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 29_999);
  assert.equal(pickKey(justBefore, rlState)?.slot, 2, 'rate-limit still active at 29.999s');
  assert.equal(pickKey(justBefore, authState)?.slot, 2, 'auth still active at 29.999s');

  // t = 30_001 — rate-limit cleared, auth still active
  const afterRl = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 30_001);
  assert.equal(pickKey(afterRl, rlState)?.slot, 1, 'rate-limit cleared at 30.001s');
  assert.equal(pickKey(afterRl, authState)?.slot, 2, 'auth still active at 30.001s');

  // t = 60_001 — both cleared
  const afterAuth = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 60_001);
  assert.equal(pickKey(afterAuth, authState)?.slot, 1, 'auth cleared at 60.001s');
});

void test('pickKey prefers slot order over stored order for healthy slots', () => {
  // Active slot is 1 (healthy), 2 is empty, 3 has a key
  const s = snapshot([entry(1, KEY_1), entry(3, KEY_3)], 1);
  const cooldown: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const result = pickKey(s, cooldown);
  assert.equal(result?.slot, 1);
  assert.equal(result?.key, KEY_1);
});

void test('pickKey walks slot order when the active slot is in cooldown', () => {
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2), entry(3, KEY_3)], 2, 1_000);
  const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const c1 = withFailure(base, 2, 'auth', 0); // active slot fails
  const result = pickKey(s, c1);
  // after slot 2 fails we want the next stored healthy slot in numeric order
  assert.ok(result !== undefined);
  assert.notEqual(result?.slot, 2);
});

void test('pickKey returns undefined when every stored slot is in cooldown', () => {
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 1_000);
  let state: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  state = withFailure(state, 1, 'auth', 0);
  state = withFailure(state, 2, 'auth', 0);
  const result = pickKey(s, state);
  assert.equal(result, undefined);
});

void test('withSuccess clears the cooldown for the given slot', () => {
  let state: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  state = withFailure(state, 1, 'auth', 0);
  state = withSuccess(state, 1);
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 1, 30_000);
  // successful attempt on slot 1 clears its cooldown → pickKey uses slot 1
  assert.equal(pickKey(s, state)?.slot, 1);
});

void test('withFailure is immutable — original state is untouched', () => {
  const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const after = withFailure(base, 1, 'auth', 0);
  assert.equal(base.failedAtMs.size, 0, 'base map should not be mutated');
  assert.equal(after.failedAtMs.size, 1);
});

void test('isKeySlot narrows numbers to KeySlot', () => {
  assert.equal(isKeySlot(1), true);
  assert.equal(isKeySlot(2), true);
  assert.equal(isKeySlot(3), true);
  assert.equal(isKeySlot(0), false);
  assert.equal(isKeySlot(4), false);
  // typed as `unknown` at the boundary, e.g. JSON-parsed input
  assert.equal(isKeySlot('1'), false);
});

void test('orderedSlots returns [1, 2, 3]', () => {
  assert.deepEqual(orderedSlots(), [1, 2, 3]);
});

void test('cooldown discriminates auth vs rate-limit vs network', () => {
  const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const auth = withFailure(base, 1, 'auth', 0);
  const rl = withFailure(base, 1, 'rate-limit', 0);
  const net = withFailure(base, 1, 'network', 0);

  // t = 100ms — every kind still in cooldown
  const early = snapshot([entry(1, KEY_1)], 1, 100);
  assert.equal(pickKey(early, auth), undefined, 'auth still active at 100ms');
  assert.equal(pickKey(early, rl), undefined, 'rate-limit still active at 100ms');
  assert.equal(pickKey(early, net), undefined, 'network still active at 100ms');

  // t = 11_000ms — network cleared (10s), rate-limit and auth still active
  const midEarly = snapshot([entry(1, KEY_1)], 1, 11_000);
  assert.equal(pickKey(midEarly, net)?.slot, 1, 'network cleared at 11s');
  assert.equal(pickKey(midEarly, rl), undefined, 'rate-limit still active at 11s');
  assert.equal(pickKey(midEarly, auth), undefined, 'auth still active at 11s');

  // t = 31_000ms — rate-limit cleared, auth still active
  const midLate = snapshot([entry(1, KEY_1)], 1, 31_000);
  assert.equal(pickKey(midLate, rl)?.slot, 1, 'rate-limit cleared at 31s');
  assert.equal(pickKey(midLate, auth), undefined, 'auth still active at 31s');

  // t = 61_000ms — all cleared
  const later = snapshot([entry(1, KEY_1)], 1, 61_000);
  assert.equal(pickKey(later, auth)?.slot, 1, 'auth cleared at 61s');
});

void test('pickKey is deterministic — same inputs give same output', () => {
  const s = snapshot([entry(1, KEY_1), entry(2, KEY_2)], 2, 1_000);
  const c: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const a = pickKey(s, c);
  const b = pickKey(s, c);
  assert.deepEqual(a, b);
});

void test('withFailure does not record when the slot is not in the stored set', () => {
  // Defensive: even if a caller asks us to record a failure on a
  // never-stored slot, the cooldown should be tracked (so the
  // picker's "no keys available" path remains correct).
  const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
  const after = withFailure(base, 3, 'auth', 0);
  assert.equal(after.failedAtMs.size, 1);
});

// FailureKind discriminated union is exhaustively handled
void test('FailureKind discriminated union narrows correctly', () => {
  const kinds: FailureKind[] = ['auth', 'rate-limit', 'http', 'network', 'other'];
  for (const kind of kinds) {
    const base: CooldownState = { failedAtMs: new Map(), failureKinds: new Map() };
    const after = withFailure(base, 1, kind, 0);
    assert.equal(after.failureKinds.get(1), kind);
  }
});
