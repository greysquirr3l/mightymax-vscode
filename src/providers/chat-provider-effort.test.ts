/**
 * Host reasoning-effort plumbing tests for the chat provider.
 *
 * These cover the bug that made VS Code's thinking-level control
 * inert: the plugin published its effort under `thinkingEffort`, a key
 * that appears in NEITHER of the host's two lookup lists —
 *
 *   - the workbench's BYOK `listModels` handler reads ONLY
 *     `configurationSchema?.properties?.reasoningEffort`;
 *   - the workbench's `Bir()` mapper scans
 *     `["reasoningEffort", "thinkingLevel"]` for the property that
 *     owns a chosen effort.
 *
 * So raising the host thinking level changed nothing and every
 * request fell back to the `mightyMax.m31ThinkingEffort` setting.
 *
 * The provider imports `vscode`, so this file runs under the vscode
 * stub runner (`scripts/run-vscode-stub-tests.cjs`).
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vscode from 'vscode';

import { ChatProvider, toLanguageModelChatInformation } from './chat-provider.js';
import type {
  MiniMaxClient,
  MiniMaxCompletionRequest,
  MiniMaxStreamEvent,
} from '../ports/minimax-client.js';
import type { Logger } from '../ports/logger.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { SecretStore } from '../ports/secret-store.js';
import { makeTestKeyProvider } from '../test-helpers/key-provider-test-double.js';

const API_KEY = 'test-key';

const M3_1_FLASH: ModelInfo = {
  id: 'MiniMax-M3.1-Flash',
  displayName: 'M3.1 Flash',
  vendor: 'minimax',
  family: 'minimax',
  maxInputTokens: 872_000,
  maxOutputTokens: 128_000,
  capabilities: { toolCalling: 128, imageInput: true, thinking: true, videoInput: true },
  thinkingStyle: 'anthropic',
  detail: '1M ctx, 128K out',
};

/** The subset of the wire request these tests assert on. */
interface RecordedCall {
  thinking?: { type: string };
  outputConfig?: { effort: string };
  maxTokens?: number;
}

function makeFakeClient(): MiniMaxClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const events: MiniMaxStreamEvent[] = [{ textDelta: 'ok' }, { finishReason: 'stop' }];
  const client: MiniMaxClient & { calls: RecordedCall[] } = {
    calls,
    streamCompletion(request: MiniMaxCompletionRequest) {
      calls.push(request);
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
  return client;
}

function makeLogger(): Logger {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    trace: noop,
    isLevelEnabled: () => false,
    setLevel: noop,
    child: () => makeLogger(),
  } as unknown as Logger;
}

function makeKeyProvider(): KeyProvider {
  const data = new Map<string, string>();
  data.set('mightyMax.apiKey', API_KEY);
  const secretStore: SecretStore = {
    getSecret: async (name) => data.get(`mightyMax.${name}`),
    storeSecret: async (name, value) => {
      data.set(`mightyMax.${name}`, value);
    },
    deleteSecret: async (name) => {
      data.delete(`mightyMax.${name}`);
    },
    hasSecret: async (name) => data.has(`mightyMax.${name}`),
  };
  return makeTestKeyProvider(secretStore, { activeSlot: 1 });
}

function makeCatalog(entries: ModelInfo[]): ModelCatalog {
  const emitter = new vscode.EventEmitter<void>();
  const catalog: ModelCatalog = {
    listModels: async () => entries,
    getModel: async (id: string) => entries.find((entry) => entry.id === id),
    onDidChange: emitter.event,
  };
  return catalog;
}

// ─────────────────────────────────────────────────────────────────────────────
// Published configuration schema
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider: published reasoningEffort schema', () => {
  it('publishes the effort under `reasoningEffort`, not `thinkingEffort`', () => {
    // The host reads ONLY `configurationSchema.properties.reasoningEffort`
    // and its `Bir()` mapper scans `["reasoningEffort","thinkingLevel"]`.
    // A `thinkingEffort` key is invisible to both, which is why the
    // host thinking-level control used to do nothing.
    const info = toLanguageModelChatInformation(M3_1_FLASH) as unknown as {
      configurationSchema?: {
        properties?: Record<string, { enum?: string[]; default?: string }>;
      };
    };
    const properties = info.configurationSchema?.properties ?? {};
    ok('reasoningEffort' in properties, 'must publish a `reasoningEffort` property');
    ok(!('thinkingEffort' in properties), 'must NOT publish `thinkingEffort`');
  });

  it('advertises an enum inside the host canonical vocabulary', () => {
    const info = toLanguageModelChatInformation(M3_1_FLASH) as unknown as {
      configurationSchema?: { properties?: Record<string, { enum?: string[] }> };
    };
    const values = info.configurationSchema?.properties?.['reasoningEffort']?.enum ?? [];
    deepStrictEqual(values, ['low', 'medium', 'high', 'xhigh', 'max']);
    // The agent host drops any advertised level outside its own
    // canonical set, which would remove the control entirely.
    for (const value of values) {
      ok(
        ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value),
        `${value} must be host-canonical`,
      );
    }
  });

  it('derives the published default from the plugin setting', () => {
    const forSetting = (effort: string): unknown =>
      (
        toLanguageModelChatInformation(M3_1_FLASH, {
          defaultEffort: effort as never,
        }) as unknown as {
          configurationSchema?: { properties?: Record<string, { default?: string }> };
        }
      ).configurationSchema?.properties?.['reasoningEffort']?.default;

    strictEqual(forSetting('low'), 'low');
    strictEqual(forSetting('medium'), 'medium');
    strictEqual(forSetting('high'), 'high');
    strictEqual(forSetting('xhigh'), 'xhigh');
    strictEqual(forSetting('max'), 'max');
    // `default` is the "let MiniMax choose" sentinel; the API's own
    // documented depth for it is `max`.
    strictEqual(forSetting('default'), 'max');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request path: the host's choice must reach the wire
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider: host reasoning effort reaches the wire', () => {
  const userMessage = (): vscode.LanguageModelChatRequestMessage =>
    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi');

  async function send(
    config: Record<string, unknown>,
    modelConfiguration: Record<string, unknown> | undefined,
  ): Promise<RecordedCall | undefined> {
    const client = makeFakeClient();
    const provider = new ChatProvider(
      makeLogger(),
      makeKeyProvider(),
      client,
      makeCatalog([M3_1_FLASH]),
      (key) => config[key],
    );
    const options = {
      tools: [],
      toolMode: vscode.LanguageModelChatToolMode.Auto,
      ...(modelConfiguration === undefined ? {} : { modelConfiguration }),
    } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
    await provider.provideLanguageModelChatResponse(
      toLanguageModelChatInformation(M3_1_FLASH),
      [userMessage()],
      options,
      { report: () => undefined },
      new vscode.CancellationTokenSource().token,
    );
    return client.calls[0];
  }

  it('honors an explicit host choice over the plugin setting', async () => {
    // Regression: the plugin read `modelConfiguration.thinkingEffort`,
    // which the host never sends. The host sends `reasoningEffort`.
    const call = await send({ m31ThinkingEffort: 'low' }, { reasoningEffort: 'high' });
    strictEqual(call?.outputConfig?.effort, 'high');
  });

  it('maps host-only levels onto the wire vocabulary', async () => {
    const minimal = await send({ m31ThinkingEffort: 'high' }, { reasoningEffort: 'minimal' });
    strictEqual(minimal?.outputConfig?.effort, 'low');

    const ultra = await send({ m31ThinkingEffort: 'low' }, { reasoningEffort: 'ultra' });
    strictEqual(ultra?.outputConfig?.effort, 'high');
  });

  it('ignores `none`, which the API rejects on M3.1-Flash', async () => {
    // `thinking: {type:"disabled"}` is a hard 400 for M3.1-Flash and
    // `none` has no wire equivalent, so the plugin keeps its own
    // setting rather than sending a request the API rejects.
    const call = await send({ m31ThinkingEffort: 'medium' }, { reasoningEffort: 'none' });
    strictEqual(call?.outputConfig?.effort, 'medium');
  });

  it('falls back to the plugin setting when the host sends nothing', async () => {
    const call = await send({ m31ThinkingEffort: 'high' }, undefined);
    strictEqual(call?.outputConfig?.effort, 'high');
  });

  it('keeps the plugin setting when the host echoes the published default', async () => {
    // The extension host merges the schema `default` into the stored
    // model configuration, so the host always sends a value. A value
    // equal to the published default means "not overridden".
    const call = await send({ m31ThinkingEffort: 'medium' }, { reasoningEffort: 'medium' });
    strictEqual(call?.outputConfig?.effort, 'medium');
  });

  it('uses the plugin setting when it is the `default` sentinel', async () => {
    // `default` omits `output_config` entirely so the API chooses.
    const call = await send({ m31ThinkingEffort: 'default' }, { reasoningEffort: 'max' });
    strictEqual(call?.outputConfig, undefined);
  });

  it('never disables thinking on M3.1-Flash', async () => {
    const call = await send({ m31ThinkingEffort: 'low' }, { reasoningEffort: 'none' });
    strictEqual(call?.thinking?.type, 'adaptive');
  });
});
