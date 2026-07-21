/**
 * Test helper: a minimal `KeyProvider` double that wraps a `SecretStore`.
 *
 * Most tests don't need real cooldown math or active-slot persistence —
 * they just need a working `pickKey` and the basic lifecycle hooks. This
 * module lives outside `src/lib/domain` and `src/adapters` so it can't
 * accidentally end up in a production bundle; the project's esbuild
 * externals are configured to drop this path in production. (It is
 * never imported from production code.)
 *
 * Tests that need real cooldown behavior should construct a real
 * `KeyProviderAdapter` over a `SecretStoreAdapter` over a
 * `vscode.SecretStorage` double — see the `KeyProviderAdapter` tests
 * in `src/adapters/key-provider.test.ts` for that pattern.
 */
import type { KeyProvider, KeySlot, FailureKind, KeyPick } from '../ports/key-provider.js';
import type { SecretStore } from '../ports/secret-store.js';

export interface TestKeyProvider extends KeyProvider {
  /** Test-only: inspect the slot state. */
  readonly __state: {
    stored: Partial<Record<KeySlot, string>>;
    activeSlot: KeySlot;
    failures: Partial<Record<KeySlot, FailureKind>>;
  };
  /** Test-only: configure the active slot directly. */
  setActiveSlotSync(slot: KeySlot): void;
}

/**
 * Build a `KeyProvider` double backed by an in-memory `SecretStore`.
 * The double honors:
 *
 *   - `pickKey()` → the active slot if it has a stored value, else
 *     the first stored slot in numeric order.
 *   - `markFailed(slot, kind)` / `markSucceeded(slot)` — track state for
 *     test assertions.
 *   - `getActiveSlot()` / `setActiveSlot()` — in-memory only.
 *   - `hasAnyKey()` / `listStoredKeys()` / `listHealthySlots()` — reflect
 *     the underlying `SecretStore` state.
 *
 * To pre-populate stored keys, write them through `setKey(slot, value)`
 * after construction — the double reads from the `SecretStore` on every
 * `pickKey`, so the underlying store is the single source of truth.
 *
 * If the caller wants to simulate cooldown, set the active slot to one
 * slot and call `markFailed` on it; subsequent `pickKey` calls will
 * return the next stored slot in numeric order. (The real
 * `KeyProviderAdapter` enforces a time-based cooldown; this double is
 * time-agnostic — pass a fresh `KeyProviderAdapter` if you need to
 * test the timer logic.)
 */
export function makeTestKeyProvider(
  store: SecretStore,
  initial: { activeSlot?: KeySlot } = {},
): TestKeyProvider {
  const state: TestKeyProvider['__state'] = {
    stored: {},
    activeSlot: initial.activeSlot ?? 1,
    failures: {},
  };

  async function readStored(): Promise<Partial<Record<KeySlot, string>>> {
    const next: Partial<Record<KeySlot, string>> = {};
    for (const slot of [1, 2, 3] as const) {
      const v = await store.getSecret(slot === 1 ? 'apiKey' : `apiKey${slot}`);
      if (v !== undefined && v !== '') next[slot] = v;
    }
    return next;
  }

  return {
    __state: state,
    setActiveSlotSync(slot) {
      state.activeSlot = slot;
    },
    async pickKey(): Promise<KeyPick | undefined> {
      const stored = await readStored();
      // active slot, if stored AND not failed
      const activeKey = stored[state.activeSlot];
      if (activeKey !== undefined && state.failures[state.activeSlot] === undefined) {
        return { slot: state.activeSlot, key: activeKey, fellBack: false };
      }
      // first stored, non-failed slot
      for (const slot of [1, 2, 3] as const) {
        if (state.failures[slot] !== undefined) continue;
        const k = stored[slot];
        if (k !== undefined) {
          return { slot, key: k, fellBack: true };
        }
      }
      return undefined;
    },
    async listStoredKeys() {
      const stored = await readStored();
      return Object.entries(stored)
        .map(([slot, key]) => ({ slot: Number(slot) as KeySlot, key: key }))
        .sort((a, b) => a.slot - b.slot);
    },
    async getActiveSlot(): Promise<KeySlot> {
      await Promise.resolve();
      return state.activeSlot;
    },
    async setActiveSlot(slot: KeySlot): Promise<void> {
      await Promise.resolve();
      state.activeSlot = slot;
    },
    async setKey(slot: KeySlot, value: string | null) {
      const name = slot === 1 ? 'apiKey' : `apiKey${slot}`;
      if (value === null) {
        await store.deleteSecret(name);
        delete state.stored[slot];
      } else {
        await store.storeSecret(name, value);
        state.stored[slot] = value;
      }
    },
    async hasAnyKey() {
      const stored = await readStored();
      return Object.keys(stored).length > 0;
    },
    markFailed(slot: KeySlot, kind: FailureKind) {
      state.failures[slot] = kind;
    },
    markSucceeded(slot: KeySlot) {
      delete state.failures[slot];
    },
    async listHealthySlots() {
      const stored = await readStored();
      const out: KeySlot[] = [];
      for (const slot of [1, 2, 3] as const) {
        if (stored[slot] === undefined) continue;
        if (state.failures[slot] !== undefined) continue;
        out.push(slot);
      }
      return out;
    },
  };
}
