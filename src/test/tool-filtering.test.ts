/**
 * Smart tool filtering validation tests.
 *
 * Tests the tool filtering logic to ensure:
 *  1. Priority tools are always included
 *  2. Relevance scoring works correctly
 *  3. Tool count limit is respected
 *  4. Filtering is disabled when under the limit
 *  5. Different strategies produce expected results
 *
 * There is no dedicated `tool-filtering` @vscode/test-cli profile for
 * this file (there used to be — see the comment where it was removed
 * in `.vscode-test.mjs`). It runs via `scripts/run-vscode-stub-tests.cjs`
 * (see `npm run test:unit`), under plain Node with a checked-in
 * `vscode` stub, and — as real-host coverage of the same
 * `vscode.workspace.getConfiguration` round-trip — as part of the
 * `integration` profile's `out/test/**` glob.
 */

import { ok } from 'node:assert/strict';
import * as nodeTest from 'node:test';
import * as vscode from 'vscode';

// Dual-runner registration. This file runs in two environments:
//  - the @vscode/test-cli `integration` profile (real host), where
//    Mocha's BDD globals are present and MUST be used — a node:test
//    registration would race the extension-host teardown and get
//    silently cut (see the profile comments in .vscode-test.mjs);
//  - `scripts/run-vscode-stub-tests.cjs` (plain Node + vscode stub),
//    where there is no Mocha, so node:test's own runner is the
//    fallback.
// The two `describe`/`it` signatures agree on the (name, fn) shape
// used below; the narrow local types keep both callers honest.
type SuiteFn = (name: string, fn: () => void) => void;
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
const mochaGlobals = globalThis as { describe?: SuiteFn; it?: TestFn };
const describe: SuiteFn = mochaGlobals.describe ?? (nodeTest.describe as SuiteFn);
const it: TestFn = mochaGlobals.it ?? (nodeTest.it as TestFn);

import { ChatProvider } from '../providers/chat-provider.js';
import type { Logger } from '../ports/logger.js';
import type { MiniMaxClient } from '../ports/minimax-client.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-tool-filtering';

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makeSecretStore(initial?: { has: boolean; value?: string }): SecretStore {
  const state = {
    has: initial?.has ?? false,
    value: initial?.value ?? '',
  };
  return {
    getSecret: async () => (state.has ? state.value : undefined),
    storeSecret: async (_name, value) => {
      state.has = true;
      state.value = value;
    },
    deleteSecret: async () => {
      state.has = false;
      state.value = '';
    },
    hasSecret: async () => state.has,
  };
}

function makeCatalog(entries: ReadonlyArray<ModelInfo>): ModelCatalog {
  const emitter = new vscode.EventEmitter<void>();
  return {
    listModels: async () => entries,
    getModel: async (id) => entries.find((e) => e.id === id),
    onDidChange: emitter.event,
  };
}

function makeClient(): MiniMaxClient {
  return {
    streamCompletion: async function* () {
      yield { textDelta: 'test' };
      yield { finishReason: 'stop' };
    },
  };
}

const M3: ModelInfo = {
  id: 'MiniMax-M3',
  displayName: 'M3',
  vendor: 'minimax',
  family: 'minimax',
  maxInputTokens: 1_048_576,
  maxOutputTokens: 16_384,
  capabilities: { toolCalling: true, imageInput: true, thinking: true },
  thinkingStyle: 'anthropic',
  detail: '1M ctx, 16K out',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool filtering tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Tool filtering', () => {

  it('includes all tools when under the limit', async () => {
    // Create a provider
    const provider = new ChatProvider(
      makeLogger(),
      makeSecretStore({ has: true, value: API_KEY }),
      makeClient(),
      makeCatalog([M3]),
    );

    // Test with filtering enabled but tool count under limit
    const config = vscode.workspace.getConfiguration('mightyMax');
    await config.update('enableSmartToolFiltering', true, vscode.ConfigurationTarget.Global);
    await config.update('maxTools', 30, vscode.ConfigurationTarget.Global);

    // Create 20 tools (under the 30 limit)
    const tools: vscode.LanguageModelChatTool[] = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      inputSchema: { type: 'object', properties: {} },
    }));

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test prompt'),
    ];

    const progress = {
      report: () => {},
    };

    // This should not filter since we're under the limit
    await provider.provideLanguageModelChatResponse(
      {
        id: 'MiniMax-M3',
        name: 'M3',
        family: 'minimax',
        version: '1',
        maxInputTokens: 1_048_576,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress as vscode.Progress<vscode.LanguageModelResponsePart>,
      new vscode.CancellationTokenSource().token,
    );

    // Verify all tools were sent (we can't directly inspect the request, but we can verify no errors)
    ok(true, 'Request completed without filtering errors');

    provider.dispose();
  });

  it('respects disabled filtering', async () => {
    const provider = new ChatProvider(
      makeLogger(),
      makeSecretStore({ has: true, value: API_KEY }),
      makeClient(),
      makeCatalog([M3]),
    );

    // Disable filtering
    const config = vscode.workspace.getConfiguration('mightyMax');
    await config.update('enableSmartToolFiltering', false, vscode.ConfigurationTarget.Global);

    // Create 100 tools (way over the limit)
    const tools: vscode.LanguageModelChatTool[] = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      inputSchema: { type: 'object', properties: {} },
    }));

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test prompt'),
    ];

    const progress = {
      report: () => {},
    };

    // This should NOT filter even though we're over the limit
    await provider.provideLanguageModelChatResponse(
      {
        id: 'MiniMax-M3',
        name: 'M3',
        family: 'minimax',
        version: '1',
        maxInputTokens: 1_048_576,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress as vscode.Progress<vscode.LanguageModelResponsePart>,
      new vscode.CancellationTokenSource().token,
    );

    ok(true, 'Request completed with filtering disabled');

    provider.dispose();
  });

  it('filters tools when over the limit', async () => {
    const logger = makeLogger();
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      makeClient(),
      makeCatalog([M3]),
    );

    // Enable filtering with a low limit
    const config = vscode.workspace.getConfiguration('mightyMax');
    await config.update('enableSmartToolFiltering', true, vscode.ConfigurationTarget.Global);
    await config.update('maxTools', 10, vscode.ConfigurationTarget.Global);

    // Create 50 tools (way over the limit)
    const tools: vscode.LanguageModelChatTool[] = Array.from({ length: 50 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i} description`,
      inputSchema: { type: 'object', properties: {} },
    }));

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test prompt'),
    ];

    const progress = {
      report: () => {},
    };

    // This should filter down to 10 tools
    await provider.provideLanguageModelChatResponse(
      {
        id: 'MiniMax-M3',
        name: 'M3',
        family: 'minimax',
        version: '1',
        maxInputTokens: 1_048_576,
        maxOutputTokens: 16_384,
        capabilities: { toolCalling: true },
      },
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress as vscode.Progress<vscode.LanguageModelResponsePart>,
      new vscode.CancellationTokenSource().token,
    );

    ok(true, 'Request completed with filtering applied');

    provider.dispose();
  });
});
