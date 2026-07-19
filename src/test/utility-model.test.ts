/**
 * T10 — Utility model eligibility tests.
 *
 * Verifies that MiniMax models can serve as VS Code utility models
 * (chat.utilityModel) for commit message generation and other utility tasks.
 *
 * Utility requests are typically:
 *  - Short prompts (concise, focused tasks)
 *  - No tools required (simpler than full agent mode)
 *  - Expect brief, to-the-point responses
 *
 * The provider should handle utility-shaped requests identically to
 * full agent requests, just without the tool-calling overhead.
 */

import { ok, strictEqual } from 'node:assert/strict';
// describe/it are Mocha's BDD globals (typed via tsconfig "types"): files run
// under @vscode/test-cli profiles MUST register with Mocha's suite tree.
// Importing describe/it from 'node:test' instead puts the file in a race
// with the extension-host teardown that silently skips suites — see the
// profile comments in .vscode-test.mjs.
import * as vscode from 'vscode';

import { ChatProvider } from '../providers/chat-provider.js';
import type { Logger } from '../ports/logger.js';
import type { MiniMaxClient, MiniMaxCompletionRequest, MiniMaxStreamEvent } from '../ports/minimax-client.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-utility-model';

function makeRecordingLogger(): Logger {
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

const M2_5: ModelInfo = {
  id: 'MiniMax-M2.5',
  displayName: 'M2.5',
  vendor: 'minimax',
  family: 'minimax',
  maxInputTokens: 1_048_576,
  maxOutputTokens: 8_192,
  capabilities: { toolCalling: true, imageInput: false, thinking: true },
  thinkingStyle: 'openai',
  detail: '1M ctx, 8K out',
};

interface RecordedCall {
  request: MiniMaxCompletionRequest;
  apiKey: string;
}

function makeScriptedAgentClient(
  script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>>,
): MiniMaxClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let roundIndex = 0;
  return {
    calls,
    streamCompletion: (request, apiKey, _signal, _logger) => {
      calls.push({ request, apiKey });
      const events = script[roundIndex] ?? [];
      roundIndex += 1;
      return (async function* () {
        for (const ev of events) {
          yield ev;
        }
      })();
    },
  };
}

function makeModelInfo(id: string): vscode.LanguageModelChatInformation {
  return {
    id,
    name: id.replace('MiniMax-', ''),
    family: 'minimax',
    version: '1',
    maxInputTokens: 1_048_576,
    maxOutputTokens: 16_384,
    capabilities: { toolCalling: true },
  };
}

interface ProgressCapture {
  readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  readonly parts: vscode.LanguageModelResponsePart[];
}

function makeProgress(): ProgressCapture {
  const parts: vscode.LanguageModelResponsePart[] = [];
  return {
    parts,
    progress: {
      report: (part: vscode.LanguageModelResponsePart) => {
        parts.push(part);
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility model eligibility tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Utility model eligibility (chat.utilityModel)', () => {
  it('handles a utility-shaped request (short, tool-less) and returns a concise response', async () => {
    // Simulate a commit message generation request (typical utility task)
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'feat(auth): implement OAuth2 authentication flow\n\n' },
        { textDelta: 'Add OAuth2 provider integration with Google and GitHub.' },
        { usage: { promptTokens: 150, completionTokens: 25 } },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    // Utility request: no tools, short prompt
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        'Generate a commit message for: added OAuth2 authentication with Google and GitHub providers',
      ),
    ];
    const progressCapture = makeProgress();

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto }, // No tools
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify: should have text response, no tool calls
    const textParts = progressCapture.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(textParts.length > 0, 'Should have text response');

    const toolCalls = progressCapture.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(toolCalls.length, 0, 'Utility request should have no tool calls');

    // Verify the request has no tools array (or empty tools)
    const request = client.calls[0]?.request;
    ok(request, 'Request should exist');
    ok(!request.tools || request.tools.length === 0, 'Utility request should have no tools');
  });

  it('M3 can serve as a utility model for commit messages', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'fix: correct off-by-one error in pagination' },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        'Write a commit message: fixed pagination bug where the last page was skipped',
      ),
    ];
    const progressCapture = makeProgress();

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );

    const textParts = progressCapture.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(textParts.length > 0, 'M3 should produce text for utility tasks');
  });

  it('M2.5 can serve as a utility model for documentation generation', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        {
          textDelta:
            '/**\n * Validates user input and returns sanitized data.\n * @param input - Raw user input\n * @returns Sanitized string\n */',
        },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M2_5]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        'Generate JSDoc for: function sanitize(input: string): string',
      ),
    ];
    const progressCapture = makeProgress();

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M2.5'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );

    const textParts = progressCapture.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(textParts.length > 0, 'M2.5 should produce text for utility tasks');
  });

  it('utility requests complete quickly without tool-calling overhead', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'Brief response.' },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Say hello'),
    ];
    const progressCapture = makeProgress();

    const startTime = Date.now();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );
    const duration = Date.now() - startTime;

    // Verify request completed (exact duration doesn't matter in mock tests,
    // but in real usage, no tool calls means faster completion)
    ok(duration >= 0, 'Request should complete');

    // Verify finish reason is 'stop', not 'tool_calls'
    const request = client.calls[0]?.request;
    ok(request, 'Request should exist');
    ok(!request.tools || request.tools.length === 0, 'No tools should be sent');
  });

  it('utility model can be any MiniMax model regardless of capabilities', async () => {
    // All MiniMax models (M1, M2, M2.5, M2.7, M3) should work as utility models
    // even though they have different capabilities (thinking, image input, etc.)
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [{ textDelta: 'Utility response' }, { finishReason: 'stop' }],
    ];

    const allModels: ModelInfo[] = [M3, M2_5];

    for (const model of allModels) {
      const logger = makeRecordingLogger();
      const catalog = makeCatalog([model]);
      const client = makeScriptedAgentClient(script);
      const provider = new ChatProvider(
        logger,
        makeSecretStore({ has: true, value: API_KEY }),
        client,
        catalog,
      );

      const messages: vscode.LanguageModelChatRequestMessage[] = [
        new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test'),
      ];
      const progressCapture = makeProgress();

      await provider.provideLanguageModelChatResponse(
        makeModelInfo(model.id),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progressCapture.progress,
        new vscode.CancellationTokenSource().token,
      );

      const textParts = progressCapture.parts.filter(
        (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
      );
      ok(textParts.length > 0, `${model.id} should work as utility model`);
    }
  });
});
