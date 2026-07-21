/**
 * KeyProvider — port for picking among up-to-3 stored MiniMax API keys.
 *
 * The user can store up to three independent MiniMax API keys (one per
 * slot). At any time one slot is "active" (the user's preferred pick).
 * The provider surfaces the active key for outgoing requests, tracks
 * per-slot cooldown when a request fails (auth/rate-limit/network), and
 * transparently falls back to the next healthy slot so a single bad key
 * doesn't break every chat turn.
 *
 * Implementations must satisfy the persistence and secrecy rules in
 * AGENTS.md: keys live in `vscode.SecretStorage` only, never in
 * settings / logs / errors. The active-slot preference is not
 * sensitive and lives in `Memento` (workspace or global state).
 *
 * Implementation: T25 (multi-key rotation).
 */

import type { KeySlot, FailureKind, CooldownState } from '../lib/domain/key-pool.js';

export type { KeySlot, FailureKind } from '../lib/domain/key-pool.js';

export interface StoredKey {
  readonly slot: KeySlot;
  readonly key: string;
}

export interface KeyPick {
  /** The slot the caller should use. */
  readonly slot: KeySlot;
  /** The key value for that slot. Never logged. */
  readonly key: string;
  /** True if this is NOT the user's preferred active slot. */
  readonly fellBack: boolean;
}

export interface KeyProvider {
  /**
   * Pick a key for the next request. Returns the active slot when
   * stored and not in cooldown, else the next stored-and-healthy slot,
   * else `undefined` if every stored slot is in cooldown (or nothing
   * is stored at all).
   */
  pickKey(): Promise<KeyPick | undefined>;

  /** All stored keys, in slot order. Used by the manage command's "view" view. */
  listStoredKeys(): Promise<ReadonlyArray<StoredKey>>;

  /** The user's preferred slot. Persisted across restarts. */
  getActiveSlot(): Promise<KeySlot>;

  /** Set the user's preferred slot. Persisted across restarts. */
  setActiveSlot(slot: KeySlot): Promise<void>;

  /**
   * Store or clear the key for a specific slot. `null` clears the slot.
   * The caller is responsible for validating the key before storing.
   */
  setKey(slot: KeySlot, value: string | null): Promise<void>;

  /** True if at least one slot has a stored key. */
  hasAnyKey(): Promise<boolean>;

  /** Mark a slot as failed. Cooldown applies based on the failure kind. */
  markFailed(slot: KeySlot, kind: FailureKind): void;

  /** Mark a slot as succeeded — clears any pending cooldown for it. */
  markSucceeded(slot: KeySlot): void;

  /**
   * Snapshot of which slots are currently healthy (not in cooldown
   * AND have a stored key). The status bar uses this to render
   * "● ● ○ (2/3 healthy)".
   */
  listHealthySlots(): Promise<ReadonlyArray<KeySlot>>;

  /** Expose the underlying cooldown state for tests/diagnostics. */
  readonly __testOnlyCooldown?: CooldownState;
}
