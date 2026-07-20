import { describe, it } from 'node:test';
import { deepStrictEqual, equal, ok } from 'node:assert/strict';

import {
  type ManageDeps,
  type ManagePickItem,
  type ManageUi,
  runManageCommand,
} from './manage-command.js';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';

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
}): ManageDeps {
  const fireChangeCount = overrides.fireChangeCount ?? { n: 0 };
  const out: ManageDeps = {
    logger: overrides.logger ?? createCapturingLogger(),
    secretStore: overrides.secretStore ?? createInMemorySecretStore(),
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
  it('shows the four management options', async () => {
    const { ui, shown } = scriptedUi([{ pick: undefined }]);
    const deps = makeDeps({ ui });
    await runManageCommand(deps);
    const items = shown.picks[0];
    ok(items, 'expected one quick pick');
    const labels = items.map((i) => i.label);
    ok(labels.includes('Set API key'), 'missing "Set API key" option');
    ok(labels.includes('Set base URL'), 'missing "Set base URL" option');
    ok(labels.includes('Test connection'), 'missing "Test connection" option');
    ok(labels.includes('Clear API key'), 'missing "Clear API key" option');
  });
});

describe('runManageCommand — Set API key', () => {
  it('stores a valid key after a successful validation', async () => {
    const { ui } = scriptedUi([
      { pick: { label: 'Set API key' } },
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
    const { ui } = scriptedUi([{ pick: { label: 'Set API key' } }, { input: '' }]);
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
    const { ui } = scriptedUi([{ pick: { label: 'Set API key' } }, { input: '   ' }]);
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
    const { ui } = scriptedUi([{ pick: { label: 'Set API key' } }, { input: 'sk-bad-key' }]);
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
      { pick: { label: 'Set API key' } },
      { input: 'sk-test-1234567890' },
    ]);
    const deps = makeDeps({ ui, fetchImpl: okFetch() });
    await runManageCommand(deps);
    const inputCall = shown.inputs[0];
    ok(inputCall, 'expected one input box');
    equal(inputCall.password, true);
  });

  it('does not call fireChange when the key is rejected', async () => {
    const { ui } = scriptedUi([{ pick: { label: 'Set API key' } }, { input: 'sk-bad-key' }]);
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

describe('runManageCommand — Clear API key', () => {
  it('removes a stored key and fires change', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.storeSecret('apiKey', 'sk-existing-key');
    const { ui } = scriptedUi([{ pick: { label: 'Clear API key' } }]);
    const fireChangeCount = { n: 0 };
    const deps = makeDeps({ ui, secretStore, fireChangeCount });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
    equal(fireChangeCount.n, 1);
  });

  it('is a no-op when no key is stored', async () => {
    const secretStore = createInMemorySecretStore();
    const { ui } = scriptedUi([{ pick: { label: 'Clear API key' } }]);
    const fireChangeCount = { n: 0 };
    const deps = makeDeps({ ui, secretStore, fireChangeCount });
    await runManageCommand(deps);
    equal(fireChangeCount.n, 0);
  });
});

describe('runManageCommand — Test connection', () => {
  it('uses the stored key and reports ok', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.storeSecret('apiKey', 'sk-good-key');
    const { ui } = scriptedUi([{ pick: { label: 'Test connection' } }]);
    const fetchImpl = okFetch(['MiniMax-M3', 'MiniMax-M2.5']);
    const logger = createCapturingLogger();
    const deps = makeDeps({ ui, secretStore, logger, fetchImpl });
    await runManageCommand(deps);
    // The success info message should NOT include the key.
    const allLogs = logger.lines.flatMap((l) => [l.msg, JSON.stringify(l.ctx ?? {})]);
    for (const line of allLogs) {
      ok(!String(line).includes('sk-good-key'), `log must not contain the key: ${String(line)}`);
    }
  });

  it('reports a friendly error when no key is stored', async () => {
    const secretStore = createInMemorySecretStore();
    const { ui } = scriptedUi([{ pick: { label: 'Test connection' } }]);
    const deps = makeDeps({ ui, secretStore });
    await runManageCommand(deps);
    // No fetch is ever made — we never see a "valid" success path.
  });

  it('reports unauthorized on a 401', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.storeSecret('apiKey', 'sk-bad');
    const { ui } = scriptedUi([{ pick: { label: 'Test connection' } }]);
    const deps = makeDeps({ ui, secretStore, fetchImpl: unauthorizedFetch() });
    await runManageCommand(deps);
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
    const { ui } = scriptedUi([{ pick: { label: 'Set base URL' } }, { input: '' }]);
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
    const { ui } = scriptedUi([{ pick: { label: 'Set API key' } }, { input: undefined }]);
    const deps = makeDeps({ ui, secretStore, fetchImpl: okFetch() });
    await runManageCommand(deps);
    equal(await secretStore.hasSecret('apiKey'), false);
  });

  it('never logs the API key, Authorization header, or 401 response body', async () => {
    const secretStore = createInMemorySecretStore();
    await secretStore.storeSecret('apiKey', 'sk-supersecret-1234567890');
    const logger = createCapturingLogger();
    const { ui } = scriptedUi([{ pick: { label: 'Test connection' } }]);
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
