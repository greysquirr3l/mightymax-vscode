/**
 * KeyProviderAdapter — adapter for the `KeyProvider` port.
 *
 * Wires the pure `key-pool` domain over the `SecretStore` port (for
 * the keys themselves) and `vscode.Memento` (for the active-slot
 * preference). Cooldown state lives in-memory only — restart = fresh
 * start, which is deliberate: we don't want stale cooldowns to deny
 * the user access to a key that's actually working now.
 *
 * Persistence shape (logical → real):
 *
 *   activeSlot:
 *     globalState['mightyMax.activeKeySlot'] = KeySlot (1 | 2 | 3)
 *
 *   slot 1 key (legacy):
 *     secrets['mightyMax.apiKey'] = string
 *
 *   slot 2 key:
 *     secrets['mightyMax.apiKey2'] = string
 *
 *   slot 3 key:
 *     secrets['mightyMax.apiKey3'] = string
 *
 * Implementation: T25 (multi-key rotation).
 */

import type * as vscode from 'vscode';

import {
  emptyCooldownState,
  isKeySlot,
  pickKey as purePickKey,
  withFailure,
  withSuccess,
  type CooldownState,
  type FailureKind,
  type KeySlot,
} from '../lib/domain/key-pool.js';

import type { KeyPick, KeyProvider, StoredKey } from '../ports/key-provider.js';
import type { SecretStore } from '../ports/secret-store.js';

const SLOT_ORDER: ReadonlyArray<KeySlot> = [1, 2, 3];
const ACTIVE_KEY_STATE_KEY = 'mightyMax.activeKeySlot';

/**
 * Logical-name → SecretStorage-name mapping for the keys. Slot 1 keeps
 * the legacy `apiKey` form so existing single-key users stay working
 * with no migration. The `SecretStore` adapter takes a logical name
 * and prefixes the `mightyMax.` namespace internally.
 */
function logicalKeyName(slot: KeySlot): string {
  return slot === 1 ? 'apiKey' : `apiKey${slot}`;
}

export interface KeyProviderDeps {
  secretStore: SecretStore;
  globalState: vscode.Memento;
  /** Optional monotonic clock used by the cooldown math. Defaults to `Date.now`. */
  now?: () => number;
}

export class KeyProviderAdapter implements KeyProvider {
  private readonly secretStore: SecretStore;
  private readonly globalState: vscode.Memento;
  private readonly now: () => number;
  /** In-memory only; never serialized. Cleared on every activation. */
  private cooldown: CooldownState = emptyCooldownState();
  /** Snapshot of the persisted active-slot preference so we can fall back to a sensible default. */
  private cachedActiveSlot: KeySlot | undefined;

  constructor(deps: KeyProviderDeps) {
    this.secretStore = deps.secretStore;
    this.globalState = deps.globalState;
    this.now = deps.now ?? Date.now;
  }

  async pickKey(): Promise<KeyPick | undefined> {
    const stored = await this.listStoredKeys();
    const activeSlot = await this.getActiveSlot();
    const snapshot = { stored, activeSlot, nowMs: this.now() };
    const picked = purePickKey(snapshot, this.cooldown);
    if (picked === undefined) return undefined;
    return {
      slot: picked.slot,
      key: picked.key,
      fellBack: picked.fellBack,
    };
  }

  async listStoredKeys(): Promise<ReadonlyArray<StoredKey>> {
    const out: StoredKey[] = [];
    for (const slot of SLOT_ORDER) {
      const raw = await this.secretStore.getSecret(logicalKeyName(slot));
      if (raw !== undefined && raw !== '') {
        out.push({ slot, key: raw });
      }
    }
    return out;
  }

  getActiveSlot(): Promise<KeySlot> {
    if (this.cachedActiveSlot !== undefined) return Promise.resolve(this.cachedActiveSlot);
    const raw = this.globalState.get<unknown>(ACTIVE_KEY_STATE_KEY);
    const slot = isKeySlot(raw) ? raw : 1;
    this.cachedActiveSlot = slot;
    return Promise.resolve(slot);
  }

  async setActiveSlot(slot: KeySlot): Promise<void> {
    this.cachedActiveSlot = slot;
    await this.globalState.update(ACTIVE_KEY_STATE_KEY, slot);
  }

  async setKey(slot: KeySlot, value: string | null): Promise<void> {
    const name = logicalKeyName(slot);
    if (value === null) {
      await this.secretStore.deleteSecret(name);
    } else {
      await this.secretStore.storeSecret(name, value);
    }
  }

  async hasAnyKey(): Promise<boolean> {
    const stored = await this.listStoredKeys();
    return stored.length > 0;
  }

  markFailed(slot: KeySlot, kind: FailureKind): void {
    this.cooldown = withFailure(this.cooldown, slot, kind, this.now());
  }

  markSucceeded(slot: KeySlot): void {
    this.cooldown = withSuccess(this.cooldown, slot);
  }

  async listHealthySlots(): Promise<ReadonlyArray<KeySlot>> {
    const stored = await this.listStoredKeys();
    const healthy: KeySlot[] = [];
    for (const slot of SLOT_ORDER) {
      const entry = stored.find((s) => s.slot === slot);
      if (!entry) continue;
      const candidate = purePickKey(
        { stored: [entry], activeSlot: slot, nowMs: this.now() },
        this.cooldown,
      );
      if (candidate !== undefined) {
        healthy.push(slot);
      }
    }
    return healthy;
  }
}
