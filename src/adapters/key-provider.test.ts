// Unit tests for KeyProviderAdapter. The adapter wires the pure
// key-pool domain over the SecretStore port + Memento. We use a
// hand-rolled in-memory SecretStore double + Memento double — no
// vscode stub required.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { KeyProviderAdapter } from './key-provider.js';
import type { SecretStore } from '../ports/secret-store.js';
import type * as vscode from 'vscode';
import type { KeySlot } from '../ports/key-provider.js';

/**
 * In-memory `SecretStore` double. Maps logical names to values; the
 * production `SecretStore` adapter namespaces them with `mightyMax.`
 * internally, so we do the same here to match the real storage shape.
 */
class FakeSecretStore implements SecretStore {
  private readonly data = new Map<string, string>();

  async getSecret(name: string): Promise<string | undefined> {
    return this.data.get(`mightyMax.${name}`);
  }
  async storeSecret(name: string, value: string): Promise<void> {
    this.data.set(`mightyMax.${name}`, value);
  }
  async deleteSecret(name: string): Promise<void> {
    this.data.delete(`mightyMax.${name}`);
  }
  async hasSecret(name: string): Promise<boolean> {
    return this.data.has(`mightyMax.${name}`);
  }
}

/**
 * Minimal Memento double. Mirrors the `get`/`update` surface that
 * the adapter needs. Keys are already namespaced by the adapter
 * (`mightyMax.*`), so we use them as-is.
 */
class FakeMemento {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
    return Promise.resolve();
  }
}

interface Setup {
  store: FakeSecretStore;
  memento: FakeMemento;
  adapter: KeyProviderAdapter;
}

const SLOT_NAMES: Readonly<Record<KeySlot, string>> = {
  1: 'apiKey',
  2: 'apiKey2',
  3: 'apiKey3',
};

function setup(
  initial: { stored?: Partial<Record<KeySlot, string>>; activeSlot?: KeySlot } = {},
): Setup {
  const store = new FakeSecretStore();
  const memento = new FakeMemento();
  const adapter = new KeyProviderAdapter({
    secretStore: store,
    globalState: memento as unknown as vscode.Memento,
  });
  if (initial.stored) {
    for (const slot of [1, 2, 3] as const) {
      const value = initial.stored[slot];
      if (value !== undefined) {
        void store.storeSecret(SLOT_NAMES[slot], value);
      }
    }
  }
  if (initial.activeSlot !== undefined) {
    void memento.update('mightyMax.activeKeySlot', initial.activeSlot);
  }
  return { store, memento, adapter };
}

void test('listStoredKeys returns stored slots in slot order', async () => {
  const { adapter } = setup({ stored: { 2: 'k2', 1: 'k1' } });
  const keys = await adapter.listStoredKeys();
  assert.deepEqual(
    keys.map((k) => k.slot),
    [1, 2],
  );
  assert.deepEqual(
    keys.map((k) => k.key),
    ['k1', 'k2'],
  );
});

void test('listStoredKeys omits empty slots', async () => {
  const { adapter } = setup({ stored: { 2: 'k2' } });
  const keys = await adapter.listStoredKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.slot, 2);
});

void test('pickKey returns undefined when no keys are stored', async () => {
  const { adapter } = setup();
  const pick = await adapter.pickKey();
  assert.equal(pick, undefined);
});

void test('pickKey returns the active slot by default', async () => {
  const { adapter } = setup({ stored: { 1: 'k1', 2: 'k2' }, activeSlot: 2 });
  const pick = await adapter.pickKey();
  assert.ok(pick !== undefined);
  assert.equal(pick.slot, 2);
  assert.equal(pick.key, 'k2');
  assert.equal(pick.fellBack, false);
});

void test('pickKey falls back to slot 1 when active slot is empty', async () => {
  const { adapter } = setup({ stored: { 1: 'k1' }, activeSlot: 2 });
  const pick = await adapter.pickKey();
  assert.ok(pick !== undefined);
  assert.equal(pick.slot, 1);
  assert.equal(pick.fellBack, true);
});

void test('pickKey skips a slot in cooldown and returns the next healthy one', async () => {
  const { adapter } = setup({ stored: { 1: 'k1', 2: 'k2' }, activeSlot: 2 });
  adapter.markFailed(2, 'auth');
  const pick = await adapter.pickKey();
  assert.ok(pick !== undefined);
  assert.equal(pick.slot, 1, 'should fall through to slot 1');
  assert.equal(pick.fellBack, true);
});

void test('pickKey returns undefined when every stored slot is in cooldown', async () => {
  const { adapter } = setup({ stored: { 1: 'k1', 2: 'k2' }, activeSlot: 1 });
  adapter.markFailed(1, 'auth');
  adapter.markFailed(2, 'auth');
  const pick = await adapter.pickKey();
  assert.equal(pick, undefined);
});

void test('markSucceeded clears the cooldown so the slot can be picked again', async () => {
  const { adapter } = setup({ stored: { 1: 'k1' }, activeSlot: 1 });
  adapter.markFailed(1, 'auth');
  assert.equal(await adapter.pickKey(), undefined);
  adapter.markSucceeded(1);
  const pick = await adapter.pickKey();
  assert.ok(pick !== undefined);
  assert.equal(pick.slot, 1);
});

void test('setKey stores under the namespaced secret key', async () => {
  const { store, adapter } = setup();
  await adapter.setKey(1, 'sk-test');
  assert.equal(await store.getSecret('apiKey'), 'sk-test');
  await adapter.setKey(2, 'sk-test-2');
  assert.equal(await store.getSecret('apiKey2'), 'sk-test-2');
  await adapter.setKey(3, 'sk-test-3');
  assert.equal(await store.getSecret('apiKey3'), 'sk-test-3');
});

void test('setKey with null deletes the stored key', async () => {
  const { store, adapter } = setup({ stored: { 1: 'k1', 2: 'k2' } });
  await adapter.setKey(1, null);
  assert.equal(await store.getSecret('apiKey'), undefined);
  // Slot 2 untouched
  assert.equal(await store.getSecret('apiKey2'), 'k2');
  const remaining = await adapter.listStoredKeys();
  assert.deepEqual(
    remaining.map((k) => k.slot),
    [2],
  );
});

void test('setActiveSlot persists to globalState under namespaced key', async () => {
  const { memento, adapter } = setup();
  await adapter.setActiveSlot(3);
  assert.equal(memento.get('mightyMax.activeKeySlot'), 3);
});

void test('getActiveSlot returns the persisted preference or defaults to 1', async () => {
  const { adapter: a1 } = setup();
  assert.equal(await a1.getActiveSlot(), 1);

  const { adapter: a2 } = setup({ activeSlot: 2 });
  assert.equal(await a2.getActiveSlot(), 2);
});

void test('getActiveSlot throws away invalid persisted values', async () => {
  const { memento, adapter } = setup();
  void memento.update('mightyMax.activeKeySlot', 7);
  assert.equal(
    await adapter.getActiveSlot(),
    1,
    'should default to 1 when persisted value is invalid',
  );
});

void test('hasAnyKey returns true if any slot has a stored key', async () => {
  const { adapter } = setup({ stored: { 2: 'k2' } });
  assert.equal(await adapter.hasAnyKey(), true);
  await adapter.setKey(2, null);
  assert.equal(await adapter.hasAnyKey(), false);
});

void test('listHealthySlots returns only stored slots not in cooldown', async () => {
  const { adapter } = setup({ stored: { 1: 'k1', 2: 'k2', 3: 'k3' } });
  let healthy = await adapter.listHealthySlots();
  assert.deepEqual(healthy, [1, 2, 3]);
  adapter.markFailed(2, 'auth');
  healthy = await adapter.listHealthySlots();
  assert.deepEqual(healthy, [1, 3]);
});

void test('pickKey does not mutate the active slot preference', async () => {
  const { adapter } = setup({ stored: { 1: 'k1', 2: 'k2' }, activeSlot: 2 });
  await adapter.pickKey();
  adapter.markFailed(2, 'auth');
  await adapter.pickKey();
  // even after fallback, active slot is unchanged
  assert.equal(await adapter.getActiveSlot(), 2);
});
