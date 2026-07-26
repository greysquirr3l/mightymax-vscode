import { describe, it } from 'node:test';
import { deepStrictEqual, equal, ok, strictEqual } from 'node:assert/strict';

import type { KeySlot } from '../ports/key-provider.js';
import type { SlotLabelsStore } from './manage-command.js';

import {
  type ManageDeps,
  type ManagePickItem,
  type ManageUi,
  runManageCommand,
} from './manage-command.js';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';
import { makeTestKeyProvider } from '../test-helpers/key-provider-test-double.js';

/**
 * Build a Logger that captures every call so tests can assert that no
 * log line ever includes the API key, the Authorization header, or
 * the validation response.
 */
function createCapturingLogger(): Logger & {
  lines: Array<{ level: string; msg: string; ctx?: unknown; err?: unknown }>;
} {
  const lines: Array<{ level: string; msg: string; ctx?: unknown; err?: unknown }> = [];
  const make = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    if (ctx === undefined) lines.push({ level, msg });
    else lines.push({ level, msg, ctx });
  };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: (msg: string, err?: unknown, ctx?: Record<string, unknown>) => {
      const e: { level: string; msg: string; ctx?: unknown; err?: unknown } = {
        level: 'error',
        msg,
      };
      if (err !== undefined) e.err = err;
      if (ctx !== undefined) e.ctx = ctx;
      lines.push(e);
    },
    lines,
  };
}

/**
 * In-memory SecretStore. Mirrors `vscode.SecretStorage` semantics
 * (Promise-returning methods, undefined for missing keys).
 */
function createInMemorySecretStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getSecret: async (name) => data.get('mightyMax.' + name),
    storeSecret: async (name, value) => {
      data.set('mightyMax.' + name, value);
    },
    deleteSecret: async (name) => {
      data.delete('mightyMax.' + name);
    },
    hasSecret: async (name) => data.has('mightyMax.' + name),
  };
}

interface UiScriptStep {
  /** Value the user "selected" from a quick pick (or undefined for cancel). */
  pick?: ManagePickItem | undefined;
  /** Value the user typed into an input (or undefined for cancel). */
  input?: string | undefined;
  /** Value the user picked from an info message (always undefined for these tests). */
  info?: string | undefined;
  /** Value the user picked from an error message (always undefined for these tests). */
  error?: string | undefined;
}

/** Build a UI driver that walks a script of canned user actions. */
function scriptedUi(script: UiScriptStep[]): {
  ui: ManageUi;
  shown: { picks: ManagePickItem[][]; inputs: Array<{ prompt?: string; password?: boolean }> };
} {
  const shown = {
    picks: [] as ManagePickItem[][],
    inputs: [] as Array<{ prompt?: string; password?: boolean }>,
  };
  let i = 0;
  const ui: ManageUi = {
    showQuickPick: async (items) => {
      shown.picks.push([...items]);
      const step = script[i++];
      return step?.pick;
    },
    showInputBox: async (options) => {
      shown.inputs.push({
        ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
        ...(options?.password !== undefined ? { password: options.password } : {}),
      });
      const step = script[i++];
      return step?.input;
    },
    showInfoMessage: async () => {
      i++;
      return undefined;
    },
    showErrorMessage: async () => {
      i++;
      return undefined;
    },
  };
  return { ui, shown };
}

function makeDeps(overrides: {
  logger?: Logger;
  secretStore?: SecretStore;
  baseUrl?: string;
  ui: ManageUi;
  fireChange?: () => void;
  fireChangeCount?: { n: number };
  fetchImpl?: typeof fetch;
  getConfig?: () => {
    get: (k: string) => unknown;
    update: (k: string, v: unknown) => Promise<unknown>;
  };
  slotLabels?: SlotLabelsStore;
}): ManageDeps {
  const fireChangeCount = overrides.fireChangeCount ?? { n: 0 };
  const secretStore = overrides.secretStore ?? createInMemorySecretStore();
  const out: ManageDeps = {
    logger: overrides.logger ?? createCapturingLogger(),
    secretStore,
    keyProvider: makeTestKeyProvider(secretStore, { activeSlot: 1 }),
    baseUrl: overrides.baseUrl ?? 'https://api.minimax.io',
    ui: overrides.ui,
    fireChange:
      overrides.fireChange ??
      (() => {
        fireChangeCount.n++;
      }),
  };
  if (overrides.fetchImpl !== undefined) out.fetchImpl = overrides.fetchImpl;
  if (overrides.getConfig !== undefined) out.getConfig = overrides.getConfig;
  if (overrides.slotLabels !== undefined) out.slotLabels = overrides.slotLabels;
  // Suppress "unused" warning on the counter when a custom fireChange is provided.
  void fireChangeCount;
  return out;
}

/** Minimal fetch stub that returns a successful /v1/models response. */
function okFetch(modelIds: string[] = ['MiniMax-M3', 'MiniMax-M2']): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ data: modelIds.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function unauthorizedFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: 'invalid api key' }), {
      status: 401,
    });
}

describe('runManageCommand — show-only flow', () => {
  it('shows the flight-deck primary actions (3 CTAs after the status header)', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    const items = shown.picks[0];
    ok(items, 'expected one quick pick');
    const labels = items.map((i) => i.label);
    // T30 — collapsed to 3 primary CTAs.
    ok(
      labels.some((l) => l.startsWith('➕') && l.includes('Add or rotate API key')),
      `expected primary "Add or rotate API key" CTA; got: ${JSON.stringify(labels)}`,
    );
    ok(
      labels.some((l) => l.includes('Manage keys')),
      `expected "Manage keys" CTA; got: ${JSON.stringify(labels)}`,
    );
    ok(labels.includes('⚙ Settings'), `expected "⚙ Settings" CTA; got: ${JSON.stringify(labels)}`);
    // T30 — Set base URL / Test connection / Clear API key are no longer top-level.
    ok(
      !labels.includes('Set base URL'),
      `expected Set base URL to move to Settings submenu; got: ${JSON.stringify(labels)}`,
    );
    ok(
      !labels.includes('Test connection'),
      `expected Test connection to move to Settings submenu; got: ${JSON.stringify(labels)}`,
    );
    ok(
      !labels.includes('Clear API key'),
      `expected Clear API key to move to Settings submenu; got: ${JSON.stringify(labels)}`,
    );
  });

  it('renders the T29 status header as the first row (kind=separator, alwaysShown)', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    const items = shown.picks[0] ?? [];
    const header = items[0] as unknown as
      { kind?: string; alwaysShown?: boolean; label?: string } | undefined;
    ok(header, 'expected the status header to be the first row');
    strictEqual(header?.kind, 'separator');
    strictEqual(header?.alwaysShown, true);
    ok(
      typeof header?.label === 'string' && header.label.length > 0,
      `expected a non-empty header label; got: ${header?.label}`,
    );
  });

  it('renders the primary CTA with the active-healthy label by default', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    const items = shown.picks[0] ?? [];
    // Header + 3 CTAs. The primary CTA is items[1].
    const primary = items[1] as unknown as { label?: string } | undefined;
    ok(
      primary?.label?.includes('Add or rotate API key'),
      `expected "Add or rotate API key" as primary CTA; got: ${primary?.label}`,
    );
    ok(
      !primary?.label?.includes('⚠ Rotate to a healthy key'),
      `expected non-warning primary CTA when active is healthy; got: ${primary?.label}`,
    );
  });

  it('flips the primary CTA to the warning label when the active slot is in cooldown', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');
    kp.markFailed(1, 'auth');
    const deps = makeDeps({ ui, secretStore });
    // Replace the default keyProvider with one that has slot 1 in cooldown
    // so listHealthySlots() returns [2] and active-slot-in-cooldown is detected.
    Object.assign(deps, { keyProvider: kp });
    await runManageCommand(deps);
    const items = shown.picks[0] ?? [];
    const primary = items[1] as unknown as { label?: string } | undefined;
    ok(
      primary?.label?.includes('⚠ Rotate to a healthy key'),
      `expected the warning CTA when active is in cooldown; got: ${primary?.label}`,
    );
  });

  it('renders the Manage-keys row with the stored-key count', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');
    const deps = makeDeps({ ui, secretStore });
    Object.assign(deps, { keyProvider: kp });
    await runManageCommand(deps);
    const items = shown.picks[0] ?? [];
    const manageRow = items[2] as unknown as { label?: string } | undefined;
    ok(
      manageRow?.label?.includes('Manage keys') && manageRow.label.includes('(2'),
      `expected "Manage keys (2 slots)" with the stored-key count; got: ${manageRow?.label}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T30 — primary CTA ("Add or rotate API key") + Settings submenu
// ─────────────────────────────────────────────────────────────────────────────

describe('runManageCommand — T30 primary CTA', () => {
  it('routes the primary CTA through the same flow as "Set API key" (validates + stores)', async () => {
    const { ui } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: 'sk-test-1234567890' },
    ]);
    const secretStore = createInMemorySecretStore();
    const fireChangeCount = { n: 0 };
    const deps = makeDeps({
      ui,
      secretStore,
      fireChangeCount,
      fetchImpl: okFetch(),
    });
    await runManageCommand(deps);
    strictEqual(
      await secretStore.getSecret('apiKey'),
      'sk-test-1234567890',
      'primary CTA must write the validated key to the active slot',
    );
    strictEqual(fireChangeCount.n, 1, 'fireChange must be called so the picker re-fires');
  });
});

describe('runManageCommand — T30 Settings submenu', () => {
  it('opens a second QuickPick when "⚙ Settings" is picked', async () => {
    const { ui, shown } = scriptedUi([
      { pick: { label: '⚙ Settings' } },
      { pick: undefined }, // dismiss the submenu
    ]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    ok(
      shown.picks.length >= 2,
      `expected Settings to open a second QuickPick; got ${shown.picks.length} pick calls`,
    );
  });

  it('Settings submenu lists Set base URL, Test all stored keys, Configure utility models, Log level, and Auto-rotate toggle', async () => {
    const { ui, shown } = scriptedUi([{ pick: { label: '⚙ Settings' } }, { pick: undefined }]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    const submenuItems = shown.picks[1] ?? [];
    const labels = submenuItems.map((i) => i.label);
    ok(labels.includes('Set base URL'), `missing Set base URL; got: ${JSON.stringify(labels)}`);
    ok(
      labels.some((l) => l.includes('Test all stored keys')),
      `missing Test all stored keys; got: ${JSON.stringify(labels)}`,
    );
    ok(
      labels.some((l) => l.includes('Configure utility models')),
      `missing Configure utility models; got: ${JSON.stringify(labels)}`,
    );
    ok(
      labels.some((l) => l.includes('Log level')),
      `missing Log level; got: ${JSON.stringify(labels)}`,
    );
    ok(
      labels.some((l) => l.includes('Auto-rotate')),
      `missing Auto-rotate toggle; got: ${JSON.stringify(labels)}`,
    );
  });

  it('Log level row shows the current value', async () => {
    const { ui, shown } = scriptedUi([{ pick: { label: '⚙ Settings' } }, { pick: undefined }]);
    const deps = makeDeps({
      ui,
      getConfig: () => ({
        get: (k) => (k === 'logLevel' ? 'debug' : undefined),
        update: async () => undefined,
      }),
    });
    await runManageCommand(deps);
    const submenuItems = shown.picks[1] ?? [];
    const logRow = submenuItems.find((i) => i.label.startsWith('Log level'));
    ok(logRow, `expected a Log level row; got: ${JSON.stringify(submenuItems)}`);
    ok(
      logRow?.label?.includes('debug'),
      `expected Log level row to name the current value; got: ${logRow?.label}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T31 — per-slot flight-deck view from the "Manage keys" CTA
// ─────────────────────────────────────────────────────────────────────────────

describe('runManageCommand — T31 flight-deck view', () => {
  it('opens a per-slot view (one row per stored key) when Manage keys is picked', async () => {
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');
    const { ui, shown } = scriptedUi([
      { pick: { label: '🔑 Manage keys (2 slots)' } },
      { pick: undefined }, // dismiss the flight-deck
    ]);
    const deps = makeDeps({ ui, secretStore });
    Object.assign(deps, { keyProvider: kp });
    await runManageCommand(deps);
    const flightDeckItems = shown.picks[1] ?? [];
    strictEqual(flightDeckItems.length, 2, 'expected one row per stored key');
  });

  it('persists slot-label changes via the SlotLabelsStore', async () => {
    const secretStore = createInMemorySecretStore();
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');
    // In-memory slot-labels store, observable from the test.
    let persisted: ReadonlyMap<KeySlot, string> = new Map();
    const slotLabels = {
      getAll: async () => persisted,
      set: async (m: ReadonlyMap<KeySlot, string>) => {
        persisted = new Map(m);
      },
    };
    // Script: pick Manage keys → pick slot 2 → pick Rename → enter "work account" → confirm.
    const { ui } = scriptedUi([
      { pick: { label: '🔑 Manage keys (2 slots)' } },
      { pick: { label: 'Slot 2  ●' } },
      { pick: { label: 'Rename slot' } },
      { input: 'work account' },
    ]);
    const deps = makeDeps({ ui, secretStore, slotLabels });
    Object.assign(deps, { keyProvider: kp });
    await runManageCommand(deps);
    ok(
      persisted.get(2) === 'work account',
      `expected slot 2 label "work account" to be persisted; got: ${JSON.stringify([...persisted])}`,
    );
  });
});

describe('runManageCommand — Set API key', () => {
  it('stores a valid key after a successful validation', async () => {
    const { ui } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: 'sk-test-1234567890' },
    ]);
    const secretStore = createInMemorySecretStore();
    const logger = createCapturingLogger();
    const fireChangeCount = { n: 0 };
    const deps = makeDeps({
      ui,
      secretStore,
      logger,
      fireChangeCount,
      fetchImpl: okFetch(),
    });
    await runManageCommand(deps);
    equal(await secretStore.getSecret('apiKey'), 'sk-test-1234567890');
    equal(fireChangeCount.n, 1);
  });

  it('rejects an empty key and does NOT store it', async () => {
    const { ui } = scriptedUi([{ pick: { label: '➕ Add or rotate API key' } }, { input: '' }]);
    const secretStore = createInMemorySecretStore();
    const deps = makeDeps({
      ui,
      secretStore,
      fetchImpl: okFetch(),
    });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('rejects a whitespace-only key and does NOT store it', async () => {
    const { ui } = scriptedUi([{ pick: { label: '➕ Add or rotate API key' } }, { input: '   ' }]);
    const secretStore = createInMemorySecretStore();
    const deps = makeDeps({
      ui,
      secretStore,
      fetchImpl: okFetch(),
    });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('does NOT store an unauthorized key', async () => {
    const { ui } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: 'sk-bad-key' },
    ]);
    const secretStore = createInMemorySecretStore();
    const deps = makeDeps({
      ui,
      secretStore,
      fetchImpl: unauthorizedFetch(),
    });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('masks the input box (password: true)', async () => {
    const { ui, shown } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: 'sk-test-1234567890' },
    ]);
    const deps = makeDeps({ ui, fetchImpl: okFetch() });
    await runManageCommand(deps);
    const inputCall = shown.inputs[0];
    ok(inputCall, 'expected one input box');
    equal(inputCall.password, true);
  });

  it('does not call fireChange when the key is rejected', async () => {
    const { ui } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: 'sk-bad-key' },
    ]);
    const fireChangeCount = { n: 0 };
    const deps = makeDeps({
      ui,
      fireChangeCount,
      fetchImpl: unauthorizedFetch(),
    });
    await runManageCommand(deps);
    equal(fireChangeCount.n, 0);
  });
});

describe('runManageCommand — Set base URL', () => {
  it('stores a new base URL in the workspace configuration', async () => {
    const updated: string[] = [];
    const fakeConfig = {
      get: (k: string) => (k === 'baseUrl' ? 'https://api.minimax.io' : undefined),
      update: async (k: string, v: unknown) => {
        updated.push(`${k}=${String(v)}`);
        return undefined;
      },
    };
    const { ui } = scriptedUi([
      { pick: { label: '⚙ Settings' } },
      { pick: { label: 'Set base URL' } },
      { input: 'https://example.test/v1' },
    ]);
    const deps = makeDeps({ ui, getConfig: () => fakeConfig });
    await runManageCommand(deps);
    deepStrictEqual(updated, ['baseUrl=https://example.test/v1']);
  });

  it('rejects an empty base URL', async () => {
    const updated: string[] = [];
    const fakeConfig = {
      get: (k: string) => (k === 'baseUrl' ? 'https://api.minimax.io' : undefined),
      update: async (k: string, v: unknown) => {
        updated.push(`${k}=${String(v)}`);
        return undefined;
      },
    };
    const { ui } = scriptedUi([
      { pick: { label: '⚙ Settings' } },
      { pick: { label: 'Set base URL' } },
      { input: '' },
    ]);
    const deps = makeDeps({ ui, getConfig: () => fakeConfig });
    await runManageCommand(deps);
    deepStrictEqual(updated, []);
  });
});

describe('runManageCommand — cancellation and safety', () => {
  it('does nothing when the user dismisses the main quick pick', async () => {
    const secretStore = createInMemorySecretStore();
    const fireChangeCount = { n: 0 };
    const { ui } = scriptedUi([{ pick: undefined }]);
    const deps = makeDeps({ ui, secretStore, fireChangeCount, fetchImpl: okFetch() });
    await runManageCommand(deps);
    equal(fireChangeCount.n, 0);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('does nothing when the user dismisses the API key input', async () => {
    const secretStore = createInMemorySecretStore();
    const { ui } = scriptedUi([
      { pick: { label: '➕ Add or rotate API key' } },
      { input: undefined },
    ]);
    const deps = makeDeps({ ui, secretStore, fetchImpl: okFetch() });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('never logs the API key, Authorization header, or 401 response body', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.storeSecret('apiKey', 'sk-supersecret-1234567890');
    const logger = createCapturingLogger();
    const { ui } = scriptedUi([
      { pick: { label: '⚙ Settings' } },
      { pick: { label: 'Test connection' } },
    ]);
    const deps = makeDeps({
      ui,
      secretStore,
      logger,
      fetchImpl: unauthorizedFetch(),
    });
    await runManageCommand(deps);
    const allLogs = logger.lines.flatMap((l) => [
      l.msg,
      JSON.stringify(l.ctx ?? {}),
      l.err === undefined
        ? ''
        : l.err instanceof Error
          ? l.err.message
          : typeof l.err === 'string'
            ? l.err
            : (() => {
                try {
                  return JSON.stringify(l.err);
                } catch {
                  return '[unserializable]';
                }
              })(),
    ]);
    const joined = allLogs.join('\n');
    ok(
      !joined.includes('sk-supersecret-1234567890'),
      `logs must not contain the API key, got:\n${joined}`,
    );
    ok(
      !joined.toLowerCase().includes('bearer '),
      'logs must not contain the Authorization header value',
    );
    ok(!joined.includes('invalid api key'), 'logs must not echo the 401 response body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T28 — Toggle auto-rotation (mightyMax.enableAutoKeyRotation)
// ─────────────────────────────────────────────────────────────────────────────

describe('runManageCommand — Toggle auto-rotation', () => {
  it('flips enableAutoKeyRotation from ON to OFF and calls fireChange', async () => {
    const configCalls: Array<{ key: string; value: unknown }> = [];
    const fireChangeCount = { n: 0 };
    const { ui } = scriptedUi([
      { pick: { label: '● Auto-rotate on auth failure: ON' } },
      { info: undefined },
    ]);
    const deps = makeDeps({
      ui,
      fireChangeCount,
      getConfig: () => ({
        get: (k: string) => (k === 'enableAutoKeyRotation' ? true : undefined),
        update: async (k, v) => {
          configCalls.push({ key: k, value: v });
          return undefined;
        },
      }),
    });
    await runManageCommand(deps);
    equal(configCalls.length, 1, 'expected exactly one config.update call');
    equal(configCalls[0]?.key, 'enableAutoKeyRotation');
    equal(configCalls[0]?.value, false, 'expected the toggled value (false)');
    equal(fireChangeCount.n, 1, 'fireChange must be called so the picker re-fires');
  });

  it('flips enableAutoKeyRotation from OFF to ON and calls fireChange', async () => {
    const configCalls: Array<{ key: string; value: unknown }> = [];
    const fireChangeCount = { n: 0 };
    const { ui } = scriptedUi([
      { pick: { label: '○ Auto-rotate on auth failure: OFF' } },
      { info: undefined },
    ]);
    const deps = makeDeps({
      ui,
      fireChangeCount,
      getConfig: () => ({
        get: (k: string) => (k === 'enableAutoKeyRotation' ? false : undefined),
        update: async (k, v) => {
          configCalls.push({ key: k, value: v });
          return undefined;
        },
      }),
    });
    await runManageCommand(deps);
    equal(configCalls.length, 1, 'expected exactly one config.update call');
    equal(configCalls[0]?.key, 'enableAutoKeyRotation');
    equal(configCalls[0]?.value, true, 'expected the toggled value (true)');
    equal(fireChangeCount.n, 1, 'fireChange must be called so the picker re-fires');
  });

  it('renders the toggle row with the ON state when the setting is true', async () => {
    const { ui, shown } = scriptedUi([{ pick: { label: '⚙ Settings' } }, { pick: undefined }]);
    const deps = makeDeps({
      ui,
      getConfig: () => ({
        get: (k: string) => (k === 'enableAutoKeyRotation' ? true : undefined),
        update: async () => undefined,
      }),
    });
    await runManageCommand(deps);
    const labels = (shown.picks[1] ?? []).map((i) => i.label);
    ok(
      labels.includes('● Auto-rotate on auth failure: ON'),
      `expected ON-state toggle label in Settings submenu; got: ${JSON.stringify(labels)}`,
    );
  });

  it('renders the toggle row with the OFF state when the setting is false', async () => {
    const { ui, shown } = scriptedUi([{ pick: { label: '⚙ Settings' } }, { pick: undefined }]);
    const deps = makeDeps({
      ui,
      getConfig: () => ({
        get: (k: string) => (k === 'enableAutoKeyRotation' ? false : undefined),
        update: async () => undefined,
      }),
    });
    await runManageCommand(deps);
    const labels = (shown.picks[1] ?? []).map((i) => i.label);
    ok(
      labels.includes('○ Auto-rotate on auth failure: OFF'),
      `expected OFF-state toggle label in Settings submenu; got: ${JSON.stringify(labels)}`,
    );
  });

  it('defaults the toggle to ON when no setting value has been persisted', async () => {
    const { ui, shown } = scriptedUi([{ pick: { label: '⚙ Settings' } }, { pick: undefined }]);
    const deps = makeDeps({
      ui,
      getConfig: () => ({
        get: () => undefined, // nothing stored yet
        update: async () => undefined,
      }),
    });
    await runManageCommand(deps);
    const labels = (shown.picks[1] ?? []).map((i) => i.label);
    ok(
      labels.includes('● Auto-rotate on auth failure: ON'),
      `expected default-ON label in Settings submenu; got: ${JSON.stringify(labels)}`,
    );
  });
});
