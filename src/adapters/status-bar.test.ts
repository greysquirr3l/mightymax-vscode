/**
 * T32 — StatusBarAdapter flight-deck render tests.
 *
 * Covers the four T32 acceptance states by snapshotting the live
 * `KeyProvider` state (active slot, healthy slots, cooldown
 * remaining, last fallback) and asserting on the resulting
 * `item.text` and `item.tooltip`. The adapter is constructed with
 * injected `createItem`, `setIntervalImpl`, `now`, and
 * `isAutoRotationEnabled` so the test never touches real time or
 * the real VS Code host. The status-bar's `vscode` dependency is
 * resolved by the host-free stub at `scripts/vscode-stub.cjs`
 * (extended in this PR with `MarkdownString`, `ThemeColor`, and the
 * `StatusBarAlignment` enum).
 *
 * Pure renderer coverage lives in
 * `src/lib/domain/flight-deck-tooltip.test.ts`. These tests are the
 * adapter-layer integration: do the read-paths (active slot,
 * healthy slots, cooldown, labels, auto-rotation, last fallback)
 * actually surface in the rendered output?
 */
import { describe, it, beforeEach } from 'node:test';
import { equal, ok } from 'node:assert/strict';

import { StatusBarAdapter, type StatusBarDeps } from './status-bar.js';
import type { KeyProvider, KeySlot } from '../ports/key-provider.js';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { TokenPlanUsage, UsageClient } from '../ports/usage-client.js';
import { UsageUnavailableError } from '../ports/usage-client.js';
import {
  makeTestKeyProvider,
  type TestKeyProvider,
} from '../test-helpers/key-provider-test-double.js';

class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  storeSecret(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  deleteSecret(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  hasSecret(key: string): Promise<boolean> {
    return Promise.resolve(this.map.has(key));
  }
}

interface FakeStatusBarItem {
  text: string;
  tooltip: string | { value: string };
  backgroundColor: unknown;
  command?: string;
  name?: string;
  show(): void;
  dispose(): void;
}

const NULL_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeUsageClient(usage: TokenPlanUsage | 'unavailable' | 'throw'): UsageClient {
  return {
    async fetchUsage(): Promise<TokenPlanUsage> {
      if (usage === 'throw') {
        throw new Error('usage fetch failed');
      }
      if (usage === 'unavailable') {
        throw new UsageUnavailableError('unavailable', 'no plan');
      }
      return usage;
    },
  };
}

const SAMPLE_USAGE: TokenPlanUsage = {
  percentUsed: 42,
  windows: [
    { label: '5-hour window', percentUsed: 42 },
    { label: 'Weekly window', percentUsed: 18 },
  ],
  raw: {},
  fetchedAt: new Date(0),
};

function makeAdapterHarness(opts: {
  keyProvider: TestKeyProvider;
  usage?: TokenPlanUsage | 'unavailable' | 'throw';
  autoRotationEnabled?: boolean;
  slotLabelsRaw?: unknown;
  nowMs?: number;
}): { adapter: StatusBarAdapter; item: FakeStatusBarItem } {
  const items: FakeStatusBarItem[] = [];
  const deps: StatusBarDeps = {
    logger: NULL_LOGGER,
    secretStore: new InMemorySecretStore(),
    keyProvider: opts.keyProvider,
    usageClient: makeUsageClient(opts.usage ?? SAMPLE_USAGE),
    isAutoRotationEnabled: () => opts.autoRotationEnabled ?? true,
    slotLabelsRaw: opts.slotLabelsRaw,
    now: () => opts.nowMs ?? Date.UTC(2025, 0, 1, 16, 24, 3),
    createItem: ((_id: string, _alignment: unknown, _priority: number) => {
      const item: FakeStatusBarItem = {
        text: '',
        tooltip: '',
        backgroundColor: undefined,
        show() {},
        dispose() {},
      };
      items.push(item);
      return item;
    }) as unknown as NonNullable<StatusBarDeps['createItem']>,
    setIntervalImpl: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalImpl: () => {},
  };
  const adapter = new StatusBarAdapter(deps);
  return { adapter, item: items[0]! };
}

function tooltipText(item: FakeStatusBarItem): string {
  return typeof item.tooltip === 'string' ? item.tooltip : item.tooltip.value;
}

describe('StatusBarAdapter — T32 flight-deck render states', () => {
  let store: InMemorySecretStore;
  let kp: TestKeyProvider;
  const NOW = Date.UTC(2025, 0, 1, 16, 24, 3);

  beforeEach(async () => {
    store = new InMemorySecretStore();
    // Align the test double's clock with the status bar's `now()`
    // so `markFailed`'s `failedAtMs = simulatedNowMs` lines up with
    // the value the renderer reads. Without this the cooldown
    // remaining math collapses to a negative number.
    kp = makeTestKeyProvider(store, { activeSlot: 1, nowMs: NOW });
    await kp.setKey(1, 'sk-slot1');
    await kp.setKey(2, 'sk-slot2');
    await kp.setKey(3, 'sk-slot3');
  });

  it('healthy: renders the dashboard with all three slots marked healthy and ★ on slot 1', async () => {
    const { adapter, item } = makeAdapterHarness({ keyProvider: kp, nowMs: NOW });
    await adapter.refresh();
    equal(
      item.text,
      '$(mightymax-head) 42%',
      'icon + percent + no $(error) suffix when active is healthy',
    );
    const md = tooltipText(item);
    ok(md.includes('▼ Mighty Max · Flight Deck'));
    ok(md.includes('Slot 1 ● healthy ★'));
    ok(md.includes('Slot 2 ● healthy'));
    ok(md.includes('Slot 3 ● healthy'));
    ok(md.includes('Auto-rotation: ON'));
    ok(md.includes('Last fallback: (none yet)'));
    ok(md.includes('5h window: 42% used'));
    ok(md.includes('Weekly:    18% used'));
    ok(md.includes('as of 16:24:03 · click for details'));
  });

  it('one-slot-cooldown: shows "cooldown Ns" on the cooled-down slot AND a $(error) text suffix when the active slot is the one in cooldown', async () => {
    kp.markFailed(3, 'rate-limit');
    // Make slot 3 the active slot too, so the cooldown-on-active path is exercised.
    await kp.setActiveSlot(3);
    const { adapter, item } = makeAdapterHarness({ keyProvider: kp, nowMs: NOW });
    await adapter.refresh();
    const md = tooltipText(item);
    ok(md.includes('Slot 3 ○ cooldown'), `slot 3 should show cooldown line, got: ${md}`);
    ok(
      md.match(/Slot 3 ○ cooldown \d+s/) !== null,
      `cooldown line should have seconds, got: ${md}`,
    );
    ok(
      item.text.endsWith(' $(error)'),
      'item text should have $(error) suffix when active slot is in cooldown',
    );
  });

  it('last-fallback-set: shows "Last fallback: slot N · Mm ago"', async () => {
    await kp.setActiveSlot(2);
    kp.setLastFallback(2, 1, NOW - 3 * 60_000); // 3m ago
    const { adapter, item } = makeAdapterHarness({ keyProvider: kp, nowMs: NOW });
    await adapter.refresh();
    const md = tooltipText(item);
    ok(md.includes('Last fallback: slot 1 · 3m ago'));
    ok(md.includes('Slot 2 ● healthy ★'));
  });

  it('no-keys: shows the onboarding hint with no Token Plan bars', async () => {
    const emptyStore = new InMemorySecretStore();
    const emptyKp = makeTestKeyProvider(emptyStore, { activeSlot: 1 });
    const { adapter, item } = makeAdapterHarness({
      keyProvider: emptyKp,
      usage: 'unavailable',
      nowMs: NOW,
    });
    await adapter.refresh();
    const md = tooltipText(item);
    equal(
      md,
      'Mighty Max — no API key set. Run `Mighty Max: Manage`.',
      'onboarding hint exactly, no flight-deck dashboard',
    );
    equal(item.text, '$(mightymax-head)');
  });
});

// Pull in `KeySlot` to make eslint happy when this file is read by
// other tools (the actual usage is in the type annotations above).
void ({} as KeySlot);
void ({} as KeyProvider);
