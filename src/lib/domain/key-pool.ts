/**
 * Key-pool — pure domain for picking among up-to-3 stored MiniMax API keys.
 *
 * This module has zero I/O. It takes a `KeySnapshot` (what's stored +
 * which slot is active) plus an in-memory `CooldownState` (which slots
 * have failed recently) plus a clock, and returns:
 *
 *   - `pickKey(snapshot, state)` — the best slot to use next, or
 *     `undefined` when no stored key is healthy.
 *   - `withFailure(state, slot, kind, nowMs)` — a new `CooldownState`
 *     with the slot marked unhealthy for the kind-appropriate duration.
 *   - `withSuccess(state, slot)` — a new `CooldownState` with the slot's
 *     cooldown cleared.
 *
 * Persistence (SecretStorage, Memento) and HTTP (401/403/429) live in
 * the adapter layer. This keeps the rotation logic testable in
 * microseconds with deterministic clock input.
 *
 * Implementation: T25 (multi-key rotation).
 */

export type KeySlot = 1 | 2 | 3;

/** Why a request failed. Drives the cooldown duration. */
export type FailureKind = 'auth' | 'rate-limit' | 'http' | 'network' | 'other';

export interface KeySnapshotEntry {
  readonly slot: KeySlot;
  readonly key: string;
}

/**
 * Snapshot of what the user has stored plus their current preference.
 * Snapshot is captured once per pick — calling code is responsible for
 * keeping it fresh, but `pickKey` itself never reads storage.
 */
export interface KeySnapshot {
  readonly stored: ReadonlyArray<KeySnapshotEntry>;
  readonly activeSlot: KeySlot;
  readonly nowMs: number;
}

/**
 * Per-slot cooldown bookkeeping. Lives in memory only; cleared on
 * every activation (a deliberate choice — restart = fresh start).
 *
 * `failedAtMs` is the wall-clock ms when the slot entered cooldown.
 * `failureKinds` is the kind that drove that cooldown; needed because
 * different kinds have different durations.
 */
export interface CooldownState {
  readonly failedAtMs: ReadonlyMap<KeySlot, number>;
  readonly failureKinds: ReadonlyMap<KeySlot, FailureKind>;
}

export interface PickResult {
  readonly slot: KeySlot;
  readonly key: string;
  /**
   * `true` when we did NOT use the user's preferred active slot —
   * either because it was in cooldown, or because the user picked
   * a slot they hadn't yet stored a key into. The chat-provider
   * uses this to decide whether to surface a hint to the user.
   */
  readonly fellBack: boolean;
}

/** Cooldown durations per failure kind, in milliseconds. */
const COOLDOWN_MS: Readonly<Record<FailureKind, number>> = {
  auth: 60_000, // 60s — Anthropic/MiniMax auth tokens take a moment to propagate after a revoke
  'rate-limit': 30_000, // 30s — short enough to retry soon, long enough to back off
  http: 15_000, // 15s — generic 5xx-ish, brief back-off
  network: 10_000, // 10s — transient network blips
  other: 5_000, // 5s — anything we don't recognize, try again quickly
};

/** Ordered list of slots for deterministic iteration. */
export const SLOT_ORDER: ReadonlyArray<KeySlot> = [1, 2, 3];

/** Type guard: narrows a candidate (e.g. JSON-parsed value) to KeySlot. */
export function isKeySlot(value: unknown): value is KeySlot {
  return value === 1 || value === 2 || value === 3;
}

/** Convenience for iteration / test fixtures. */
export function orderedSlots(): ReadonlyArray<KeySlot> {
  return SLOT_ORDER;
}

/**
 * Pick the best slot from a snapshot + cooldown state.
 *
 * Algorithm:
 *   1. Try the user's `activeSlot`. If it's stored and not in cooldown, use it.
 *   2. Otherwise, walk the slot order and pick the first stored,
 *      non-cooldown slot.
 *   3. If none qualify, return `undefined` — caller must surface the
 *      "all keys in cooldown / no key stored" condition.
 *
 * `fellBack` is `true` whenever step 2 was used, even if the active
 * slot was empty (rather than failing). That lets the UI distinguish
 * "user hasn't stored that slot yet" from "active key succeeded".
 */
export function pickKey(snapshot: KeySnapshot, state: CooldownState): PickResult | undefined {
  const storedBySlot = new Map<KeySlot, string>();
  for (const entry of snapshot.stored) {
    storedBySlot.set(entry.slot, entry.key);
  }

  const activeKey = storedBySlot.get(snapshot.activeSlot);
  if (activeKey !== undefined && !isInCooldown(snapshot.activeSlot, state, snapshot.nowMs)) {
    return { slot: snapshot.activeSlot, key: activeKey, fellBack: false };
  }

  for (const slot of SLOT_ORDER) {
    const key = storedBySlot.get(slot);
    if (key === undefined) continue;
    if (isInCooldown(slot, state, snapshot.nowMs)) continue;
    return { slot, key, fellBack: true };
  }

  return undefined;
}

/** True if `slot` is in cooldown at `nowMs`. */
function isInCooldown(slot: KeySlot, state: CooldownState, nowMs: number): boolean {
  const failedAt = state.failedAtMs.get(slot);
  if (failedAt === undefined) return false;
  const kind = state.failureKinds.get(slot);
  if (kind === undefined) return false;
  return nowMs - failedAt < COOLDOWN_MS[kind];
}

/** Return a new `CooldownState` with `slot` marked failed at `nowMs`. */
export function withFailure(
  state: CooldownState,
  slot: KeySlot,
  kind: FailureKind,
  nowMs: number,
): CooldownState {
  const failedAtMs = new Map(state.failedAtMs);
  const failureKinds = new Map(state.failureKinds);
  failedAtMs.set(slot, nowMs);
  failureKinds.set(slot, kind);
  return { failedAtMs, failureKinds };
}

/** Return a new `CooldownState` with `slot`'s cooldown cleared. */
export function withSuccess(state: CooldownState, slot: KeySlot): CooldownState {
  if (!state.failedAtMs.has(slot) && !state.failureKinds.has(slot)) {
    // No-op fast path — avoids allocating new maps when nothing to clear.
    return state;
  }
  const failedAtMs = new Map(state.failedAtMs);
  const failureKinds = new Map(state.failureKinds);
  failedAtMs.delete(slot);
  failureKinds.delete(slot);
  return { failedAtMs, failureKinds };
}

/** Convenience: an empty cooldown state. */
export function emptyCooldownState(): CooldownState {
  return { failedAtMs: new Map(), failureKinds: new Map() };
}
