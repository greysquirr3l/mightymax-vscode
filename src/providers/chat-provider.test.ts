/**
 * T07 — ChatProvider tests.
 *
 * Unit-level tests for the `LanguageModelChatProvider` glue:
 *   - `provideLanguageModelChatInformation` with `silent: true` returns
 *     `[]` when no API key is present and never asks the user for one.
 *     A `silent: false` call returns whatever the catalog adapter
 *     produced.
 *   - `provideLanguageModelChatResponse` drives the message + tool
 *     mapping, calls the `MiniMaxClient`, and reports each mapped
 *     response part (text, tool call, usage) through `progress.report`.
 *   - A follow-up call carrying a tool-result message maps back to
 *     a `role: 'tool'` MiniMax wire message with the matching call
 *     id so the agent loop can continue across rounds.
 *   - `provideTokenCount` returns a positive integer for both `string`
 *     and `LanguageModelChatRequestMessage` inputs and the
 *     family-aware heuristic produces a different number for M3
 *     (Anthropic-flavored) than for M2.5 (OpenAI-flavored).
 *   - `toolMode` on the per-request options maps to `tool_choice` on
 *     the wire request.
 *   - M3 is routed through the Anthropic dialect by default; the
 *     other M-series go through OpenAI.
 *
 * The chat-provider imports `vscode` directly (it's the host-side
 * adapter glue). To run without the VS Code host we mock the
 * `vscode` namespace using a hand-rolled stub injected via the
 * existing `vscode-stub.cjs` (see `.tmp-test/run-all.cjs`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vscode from 'vscode';

import { ChatProvider, toLanguageModelChatInformation } from './chat-provider.js';
import {
  MiniMaxClientError,
  type MiniMaxClient,
  type MiniMaxCompletionRequest,
  type MiniMaxStreamEvent,
} from '../ports/minimax-client.js';
import type { Logger } from '../ports/logger.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-mighty-max-1234567890';

function makeRecordingLogger(): Logger & {
  readonly calls: ReadonlyArray<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
    error?: unknown;
  }>;
} {
  const calls: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
    error?: unknown;
  }> = [];
  const rec: Logger & { calls: typeof calls } = {
    debug: (message, context) => {
      calls.push({ level: 'debug', message, ...(context !== undefined ? { context } : {}) });
    },
    info: (message, context) => {
      calls.push({ level: 'info', message, ...(context !== undefined ? { context } : {}) });
    },
    warn: (message, context) => {
      calls.push({ level: 'warn', message, ...(context !== undefined ? { context } : {}) });
    },
    error: (message, error, context) => {
      const entry: (typeof calls)[number] = { level: 'error', message };
      if (error !== undefined) entry.error = error;
      if (context !== undefined) entry.context = context;
      calls.push(entry);
    },
    calls,
  };
  return rec;
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
  maxInputTokens: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { toolCalling: true, imageInput: false, thinking: true },
  thinkingStyle: 'openai',
  detail: '200K ctx, 8K out',
};

interface RecordedCall {
  request: MiniMaxCompletionRequest;
  apiKey: string;
}

/** Fake MiniMaxClient that captures the request + replays scripted events. */
function makeFakeClient(
  events: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>>,
): MiniMaxClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let attempt = 0;
  return {
    calls,
    streamCompletion: (request, apiKey, _signal, _logger) => {
      calls.push({ request, apiKey });
      const index = Math.min(attempt, events.length - 1);
      const batch = events[index] ?? events[0] ?? [];
      attempt += 1;
      // Replay the scripted events asynchronously so callers can
      // `for await` over the returned iterable.
      return (async function* () {
        for (const ev of batch) {
          yield ev;
        }
      })();
    },
  };
}

function makeModelInfo(id: string): vscode.LanguageModelChatInformation {
  const entry = id === 'MiniMax-M3' ? M3 : M2_5;
  return toLanguageModelChatInformation(entry);
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
// provideLanguageModelChatInformation
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider.provideLanguageModelChatInformation', () => {
  it('returns the mapped catalog entries (silent=false)', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3, M2_5]);
    const provider = new ChatProvider(logger, makeSecretStore(), makeFakeClient([]), catalog);
    const result = await provider.provideLanguageModelChatInformation(
      { silent: false },
      new vscode.CancellationTokenSource().token,
    );
    strictEqual(result.length, 2);
    strictEqual(result[0]?.id, 'MiniMax-M3');
    strictEqual(result[1]?.id, 'MiniMax-M2.5');
    ok(result[0]?.capabilities.toolCalling === true, 'M3 must advertise toolCalling=true');
  });

  it('returns [] with silent=true when no API key is stored (no prompt)', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const provider = new ChatProvider(logger, makeSecretStore(), makeFakeClient([]), catalog);
    const result = await provider.provideLanguageModelChatInformation(
      { silent: true },
      new vscode.CancellationTokenSource().token,
    );
    deepStrictEqual(result, []);
  });

  it('returns the catalog with silent=true when an API key IS stored', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3, M2_5]);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      makeFakeClient([]),
      catalog,
    );
    const result = await provider.provideLanguageModelChatInformation(
      { silent: true },
      new vscode.CancellationTokenSource().token,
    );
    strictEqual(result.length, 2);
  });

  it('returns [] when the cancellation token is already cancelled', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const provider = new ChatProvider(logger, makeSecretStore(), makeFakeClient([]), catalog);
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    const result = await provider.provideLanguageModelChatInformation(
      { silent: false },
      source.token,
    );
    deepStrictEqual(result, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// provideLanguageModelChatResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider.provideLanguageModelChatResponse', () => {
  it('reports text → tool call → usage in order via progress.report', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        { textDelta: 'Hello, ' },
        { textDelta: 'world!' },
        {
          toolCallDelta: { index: 0, id: 'call_1', name: 'read_file' },
        },
        {
          toolCallDelta: { index: 0, argumentsDelta: '{"path":"/etc/hosts"}' },
        },
        { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
        { finishReason: 'tool_calls' },
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        'Read the hosts file',
      ),
    ];
    const tools: vscode.LanguageModelChatTool[] = [
      {
        name: 'read_file',
        description: 'Reads a file from disk.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    // 2 text parts, 1 tool-call part, 1 usage marker.
    strictEqual(parts.length, 4);

    const textParts = parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
    );
    // The first two text parts are 'Hello, ' and 'world!'; the third
    // is the usage marker (encoded as a text part with a special
    // prefix so the host introspection surface stays portable across
    // vscode versions that don't yet expose LanguageModelDataPart).
    strictEqual(textParts.length, 3);
    strictEqual(textParts[0]?.value, 'Hello, ');
    strictEqual(textParts[1]?.value, 'world!');
    ok(
      textParts[2]?.value.startsWith('__minimax_usage__:'),
      `expected usage marker prefix, got: ${textParts[2]?.value}`,
    );

    const toolCallPart = parts.find((p) => p instanceof vscode.LanguageModelToolCallPart);
    ok(toolCallPart, 'expected a tool-call part to be reported');
    if (toolCallPart instanceof vscode.LanguageModelToolCallPart) {
      strictEqual(toolCallPart.callId, 'call_1');
      strictEqual(toolCallPart.name, 'read_file');
      deepStrictEqual(toolCallPart.input, { path: '/etc/hosts' });
    }

    // The client was called with the right request shape.
    strictEqual(client.calls.length, 1);
    const sent = client.calls[0]?.request;
    ok(sent, 'request should be captured');
    if (!sent) return;
    strictEqual(sent.model, 'MiniMax-M3');
    strictEqual(sent.dialect, 'anthropic');
    strictEqual(sent.messages.length, 1);
    strictEqual(sent.messages[0]?.role, 'user');
    strictEqual(sent.messages[0]?.content, 'Read the hosts file');
    strictEqual(sent.tools?.length, 1);
    strictEqual(sent.tools?.[0]?.function.name, 'read_file');
    strictEqual(client.calls[0]?.apiKey, API_KEY);
  });

  it('maps a follow-up tool-result message into a role:tool wire message with the call id', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([[{ textDelta: 'Done.' }]]);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { progress } = makeProgress();

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(
        vscode.LanguageModelChatMessageRole.User,
        'Read the hosts file',
      ),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_1', 'read_file', { path: '/etc/hosts' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_1', [
          new vscode.LanguageModelTextPart('127.0.0.1 localhost'),
        ]),
      ]),
    ];

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    strictEqual(client.calls.length, 1);
    const sent = client.calls[0]?.request;
    ok(sent);
    if (!sent) return;

    // The wire history is: user, assistant (tool call), tool (result).
    strictEqual(sent.messages.length, 3);
    strictEqual(sent.messages[0]?.role, 'user');
    strictEqual(sent.messages[1]?.role, 'assistant');
    strictEqual(sent.messages[2]?.role, 'tool');
    const toolWire = sent.messages[2];
    strictEqual(toolWire?.toolCallId, 'call_1');
    strictEqual(toolWire?.content, '127.0.0.1 localhost');
  });

  it('routes all models through the Anthropic dialect (VSCode prefers Anthropic)', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3, M2_5]);
    const client = makeFakeClient([[{ textDelta: 'ok' }], [{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M2.5'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    // Both M3 and M2.x now use Anthropic (VSCode is deprecating OpenAI)
    strictEqual(client.calls[0]?.request.dialect, 'anthropic');
    strictEqual(client.calls[1]?.request.dialect, 'anthropic');
  });

  it('maps toolMode=Required to tool_choice=required on the wire', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M2_5]);
    const client = makeFakeClient([[{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M2.5'),
      messages,
      {
        tools: [
          { name: 'a', description: 'A', inputSchema: {} },
          { name: 'b', description: 'B', inputSchema: {} },
        ],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    strictEqual(client.calls[0]?.request.toolChoice, 'required');
  });

  it('throws a typed error if the API key is missing on a non-silent request', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([[{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(logger, makeSecretStore(), client, catalog);
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    let threw = false;
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progress,
        new vscode.CancellationTokenSource().token,
      );
    } catch (err) {
      threw = true;
      ok(err instanceof Error, 'expected an Error');
      // Should not be a MiniMaxClientError — this is a credential
      // failure on the chat-provider side, not a transport error.
      ok(!(err instanceof MiniMaxClientError), 'should not surface as a transport error');
    }
    ok(threw, 'expected provideLanguageModelChatResponse to throw when no key is stored');
    strictEqual(client.calls.length, 0, 'transport should not be called without a key');
  });

  it('surfaces transport errors as user-visible chat errors without crashing the host', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);

    // Create a client that throws a MiniMaxClientError (simulating a transport failure)
    const errorClient: MiniMaxClient = {
      streamCompletion(_request, _apiKey, _signal, _logger): AsyncIterable<MiniMaxStreamEvent> {
        const error = new MiniMaxClientError('rate-limit', 'Rate limit exceeded', { status: 429, retriable: true });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw error;
              },
            };
          },
        };
      },
    };

    const provider = new ChatProvider(
      logger,
      makeSecretStore({ has: true, value: API_KEY }),
      errorClient,
      catalog,
    );
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    let threw = false;
    let caughtError: unknown;
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progress,
        new vscode.CancellationTokenSource().token,
      );
    } catch (err) {
      threw = true;
      caughtError = err;
    }

    ok(threw, 'expected transport error to be caught and re-thrown');
    ok(caughtError instanceof Error, 'expected a plain Error (not MiniMaxClientError)');
    ok(!(caughtError instanceof MiniMaxClientError), 'transport error should be wrapped');
    if (caughtError instanceof Error) {
      ok(
        caughtError.message.includes('rate-limit'),
        'error message should include the kind',
      );
    }

    // Verify the error was logged
    const errorLogs = logger.calls.filter((c) => c.level === 'error');
    ok(errorLogs.length > 0, 'transport error should be logged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// provideTokenCount
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider.provideTokenCount', () => {
  it('returns a positive integer for a string', async () => {
    const logger = makeRecordingLogger();
    const provider = new ChatProvider(
      logger,
      makeSecretStore(),
      makeFakeClient([]),
      makeCatalog([M3]),
    );
    const count = await provider.provideTokenCount(
      makeModelInfo('MiniMax-M3'),
      'Hello, world!',
      new vscode.CancellationTokenSource().token,
    );
    ok(Number.isInteger(count), 'count must be an integer');
    ok(count > 0, 'count must be positive');
  });

  it('returns a positive integer for a LanguageModelChatRequestMessage', async () => {
    const logger = makeRecordingLogger();
    const provider = new ChatProvider(
      logger,
      makeSecretStore(),
      makeFakeClient([]),
      makeCatalog([M3]),
    );
    const msg = new vscode.LanguageModelChatMessage(
      vscode.LanguageModelChatMessageRole.User,
      'Count me.',
    );
    const count = await provider.provideTokenCount(
      makeModelInfo('MiniMax-M3'),
      msg,
      new vscode.CancellationTokenSource().token,
    );
    ok(Number.isInteger(count), 'count must be an integer');
    ok(count > 0, 'count must be positive');
  });

  it('uses a different estimate for M3 than for M2.5 (family-aware heuristic)', async () => {
    const logger = makeRecordingLogger();
    const provider = new ChatProvider(
      logger,
      makeSecretStore(),
      makeFakeClient([]),
      makeCatalog([M3, M2_5]),
    );
    const longText = 'word '.repeat(10_000);
    const m3Count = await provider.provideTokenCount(
      makeModelInfo('MiniMax-M3'),
      longText,
      new vscode.CancellationTokenSource().token,
    );
    const m25Count = await provider.provideTokenCount(
      makeModelInfo('MiniMax-M2.5'),
      longText,
      new vscode.CancellationTokenSource().token,
    );
    ok(m3Count > 0 && m25Count > 0, 'both counts must be positive');
    // The family-aware heuristic must not produce the same number
    // for the two families — they have different tokenizer
    // characteristics and the M3 path is more conservative.
    ok(
      m3Count !== m25Count,
      `expected family-aware token counts to differ; got M3=${m3Count} M2.5=${m25Count}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// change emitter
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider change emitter', () => {
  it('fires onDidChangeLanguageModelChatInformation when fireChange() is called', () => {
    const logger = makeRecordingLogger();
    const provider = new ChatProvider(
      logger,
      makeSecretStore(),
      makeFakeClient([]),
      makeCatalog([M3]),
    );
    let fired = 0;
    const sub = provider.onDidChangeLanguageModelChatInformation(() => {
      fired += 1;
    });
    provider.fireChange();
    provider.fireChange();
    strictEqual(fired, 2);
    sub.dispose();
  });
});
