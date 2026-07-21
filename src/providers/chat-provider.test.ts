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
 * adapter glue). This file (like `stream-pump.test.ts`) is not run by
 * the `unit` @vscode/test-cli profile — see the comment on that
 * profile in `.vscode-test.mjs` for why. It runs instead via
 * `npm run test:unit`, which invokes
 * `scripts/run-vscode-stub-tests.cjs`: a hand-rolled `vscode`
 * namespace stub (`scripts/vscode-stub.cjs`) injected via a
 * `Module._resolveFilename` hook, requiring this compiled test file
 * directly under plain Node — no VS Code host needed for these
 * host-glue-but-otherwise-pure tests.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vscode from 'vscode';

import {
  ChatProvider,
  toLanguageModelChatInformation,
  vscodeToDomainMessage,
} from './chat-provider.js';
import {
  MiniMaxClientError,
  type MiniMaxClient,
  type MiniMaxCompletionRequest,
  type MiniMaxStreamEvent,
} from '../ports/minimax-client.js';
import type { Logger } from '../ports/logger.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';
import { makeTestKeyProvider } from '../test-helpers/key-provider-test-double.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

// (Helpers previously used for stubbing `vscode.workspace` were
// removed: the chat-provider now accepts a `configReader` callback
// in its constructor, so the auto-rotation tests inject the
// setting directly rather than monkey-patching the host.)

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
  // Per-name storage so multiple keys (apiKey, apiKey2, apiKey3)
  // can coexist in the same fake. The original single-value shape
  // worked when only one key existed in the system; the multi-key
  // T25 feature needs per-name entries. Backwards compat: when the
  // caller passes `initial.has: true, initial.value: '...'`, the
  // helper seeds the legacy 'apiKey' slot with that value, so
  // pre-T25 tests behave identically.
  const data = new Map<string, string>();
  if (initial?.has && initial.value !== undefined) {
    data.set('mightyMax.apiKey', initial.value);
  }
  return {
    getSecret: async (name) => data.get(`mightyMax.${name}`),
    storeSecret: async (name, value) => {
      data.set(`mightyMax.${name}`, value);
    },
    deleteSecret: async (name) => {
      data.delete(`mightyMax.${name}`);
    },
    hasSecret: async (name) => data.has(`mightyMax.${name}`),
  };
}

/**
 * Build a `KeyProvider` test double backed by a single stored key.
 * Preserves the legacy `makeSecretStore({has, value})` shape so
 * call-site changes are minimal — every test that previously did
 * `makeSecretStore({...})` can now do `makeProvider({...})`.
 */
function makeProvider(initial?: { has: boolean; value?: string }) {
  const secretStore = makeSecretStore(initial);
  const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
  if (initial?.has && initial.value !== undefined) {
    void kp.setKey(1, initial.value);
  }
  return kp;
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
    const provider = new ChatProvider(logger, makeProvider(), makeFakeClient([]), catalog);
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
    const provider = new ChatProvider(logger, makeProvider(), makeFakeClient([]), catalog);
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
      makeProvider({ has: true, value: API_KEY }),
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
    const provider = new ChatProvider(logger, makeProvider(), makeFakeClient([]), catalog);
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
      makeProvider({ has: true, value: API_KEY }),
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

    // T19: usage is no longer emitted as a visible chat text part.
    // 2 text parts ('Hello, ' + 'world!') and 1 tool-call part.
    strictEqual(parts.length, 3);

    const textParts = parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
    );
    strictEqual(textParts.length, 2);
    strictEqual(textParts[0]?.value, 'Hello, ');
    strictEqual(textParts[1]?.value, 'world!');
    // Belt-and-braces: the T19 fix deleted the
    // `__minimax_usage__:` text emission — no string starting with
    // that prefix may appear in the visible-text lane.
    for (const tp of textParts) {
      ok(!tp.value.includes('__minimax_usage__'), `usage leaked into visible text: ${tp.value}`);
    }

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

    // Per-model sampling parameters (opencode defaults): the M-series
    // is tuned at temp=1.0, topP=0.95, topK=20.
    strictEqual(sent.temperature, 1.0);
    strictEqual(sent.topP, 0.95);
    strictEqual(sent.topK, 20);
    // Output token clamp (opencode OUTPUT_TOKEN_MAX).
    strictEqual(sent.maxTokens, 32_000);
    // M3 native thinking is opted in with `adaptive` (opencode
    // transform.ts:680-688, 1147-1150). M3's Anthropic interface
    // defaults thinking off; the chat-provider must opt in.
    // `adaptive` lets the model decide its own per-request budget
    // instead of locking it at a fraction of max_tokens.
    ok(sent.thinking, 'expected thinking to be set for M3 on anthropic dialect');
    if (sent.thinking) {
      strictEqual(sent.thinking.type, 'adaptive');
      strictEqual(
        sent.thinking.budgetTokens,
        undefined,
        'adaptive thinking must not carry an explicit budgetTokens',
      );
    }
    // Default M3 system prompt is sent on every M3 request.
    ok(sent.systemPrompt, 'expected a default system prompt on M3 requests');
    if (sent.systemPrompt) {
      ok(
        sent.systemPrompt.includes('coding assistant'),
        `expected the default preamble, got: ${sent.systemPrompt}`,
      );
    }
    // Cache markers: the last message in the (single-message) user
    // history gets a cache_control stamp on the wire.
    deepStrictEqual(sent.cacheMarkers, [1]);
  });

  it('maps a follow-up tool-result message into a role:tool wire message with the call id', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([[{ textDelta: 'Done.' }]]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
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

  it('routes M3 through the Anthropic dialect and M2.5 through OpenAI (T17)', async () => {
    // T17 corrected the divergent 0.1.x behavior: M3 (Anthropic-style
    // thinking blocks) routes through the Anthropic dialect; M2.x
    // and M1 (OpenAI-style reasoning_content, no native thinking)
    // route through the OpenAI-compatible endpoint. This test was
    // previously titled `routes all models through Anthropic`.
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3, M2_5]);
    const client = makeFakeClient([[{ textDelta: 'ok' }], [{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
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

    strictEqual(client.calls[0]?.request.dialect, 'anthropic');
    strictEqual(client.calls[1]?.request.dialect, 'openai');
  });

  it('maps toolMode=Required to tool_choice=required on the wire', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M2_5]);
    const client = makeFakeClient([[{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
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

    const sent = client.calls[0]?.request;
    ok(sent, 'request should be captured');
    if (!sent) return;
    strictEqual(sent.toolChoice, 'required');
    // M2.x is NOT in the M3 thinking opt-in list — the
    // chat-provider must NOT enable native thinking for it.
    strictEqual(sent.thinking, undefined);
    // M2.x still gets the per-model sampler (temp=1.0, topP=0.95,
    // topK=40 for the M2.5 variant family per opencode defaults).
    strictEqual(sent.temperature, 1.0);
    strictEqual(sent.topP, 0.95);
    strictEqual(sent.topK, 40);
  });

  it('throws a typed error if the API key is missing on a non-silent request', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([[{ textDelta: 'ok' }]]);
    const provider = new ChatProvider(logger, makeProvider(), client, catalog);
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    let caughtError: Error | undefined;
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progress,
        new vscode.CancellationTokenSource().token,
      );
    } catch (err) {
      caughtError = err as Error;
    }
    ok(caughtError !== undefined, 'expected an error to surface');
    // Should not be a MiniMaxClientError — this is a credential
    // failure on the chat-provider side, not a transport error.
    ok(!(caughtError instanceof MiniMaxClientError), 'should not surface as a transport error');
    ok(
      caughtError?.message.includes('not configured') &&
        caughtError?.message.includes('Mighty Max: Manage'),
      `expected an actionable "no key configured" message; got: ${caughtError?.message}`,
    );
    strictEqual(client.calls.length, 0, 'transport should not be called without a key');
  });

  it('throws a distinct cooldown message when keys exist but every slot is in cooldown', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([[{ textDelta: 'ok' }]]);
    const secretStore = makeSecretStore({ has: false });
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');
    // Put every stored slot in cooldown.
    kp.markFailed(1, 'auth');
    kp.markFailed(2, 'auth');

    // Sanity: pickKey really does return undefined in this state.
    const precheck = await kp.pickKey();
    strictEqual(
      precheck,
      undefined,
      `precheck: pickKey should return undefined when every slot is in cooldown; got ${JSON.stringify(precheck)}`,
    );

    const provider = new ChatProvider(logger, kp, client, catalog);
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    let caughtError: Error | undefined;
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progress,
        new vscode.CancellationTokenSource().token,
      );
    } catch (err) {
      caughtError = err as Error;
    }
    ok(
      caughtError !== undefined,
      `expected an error to surface; got: ${JSON.stringify(caughtError)}`,
    );
    ok(
      caughtError?.message.includes('in cooldown'),
      `expected a cooldown-specific message; got: ${caughtError?.message}`,
    );
    ok(
      caughtError?.message.includes('Manage'),
      `expected the message to point at the manage command; got: ${caughtError?.message}`,
    );
    ok(
      caughtError?.message.includes('Active slot'),
      `expected the message to mention the active-slot picker; got: ${caughtError?.message}`,
    );
    strictEqual(client.calls.length, 0, 'transport should not be called when no slot is pickable');
  });

  it('surfaces transport errors as user-visible chat errors without crashing the host', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);

    // Create a client that throws a MiniMaxClientError (simulating a transport failure)
    const errorClient: MiniMaxClient = {
      streamCompletion(_request, _apiKey, _signal, _logger): AsyncIterable<MiniMaxStreamEvent> {
        const error = new MiniMaxClientError('rate-limit', 'Rate limit exceeded', {
          status: 429,
          retriable: true,
        });
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
      makeProvider({ has: true, value: API_KEY }),
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
      ok(caughtError.message.includes('rate-limit'), 'error message should include the kind');
    }

    // Verify the error was logged
    const errorLogs = logger.calls.filter((c) => c.level === 'error');
    ok(errorLogs.length > 0, 'transport error should be logged');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T25 — auto-rotation toggle (mightyMax.enableAutoKeyRotation)
  // ───────────────────────────────────────────────────────────────────────────

  it('falls back to the next stored key on auth failure when auto-rotation is enabled (default)', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);

    // First call (with key 1) throws an auth error; second call (with
    // key 2) succeeds. The provider must rotate transparently.
    let attempt = 0;
    let secondAttemptApiKey: string | undefined;
    const rotatingClient: MiniMaxClient = {
      streamCompletion(_request, apiKey, _signal, _logger): AsyncIterable<MiniMaxStreamEvent> {
        attempt += 1;
        if (attempt === 1) {
          throw new MiniMaxClientError('auth', 'invalid api key', {
            status: 401,
            retriable: false,
          });
        }
        if (attempt === 2) {
          // Sanity: the second attempt used a DIFFERENT key.
          secondAttemptApiKey = apiKey;
          return (async function* () {
            yield { textDelta: 'second-slot-worked' };
            yield { stopReason: 'stop' } as MiniMaxStreamEvent;
          })();
        }
        throw new Error(`unexpected attempt ${attempt}`);
      },
    };

    // Multi-key provider: slot 1 has key-1, slot 2 has key-2.
    const secretStore = makeSecretStore({ has: false });
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-first-key');
    await kp.setKey(2, 'sk-second-key');

    const provider = new ChatProvider(logger, kp, rotatingClient, catalog);
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    // Default test harness has no `mightyMax.enableAutoKeyRotation`
    // value — the helper defaults to true (auto-rotation on). We
    // don't need to stub anything here.
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    strictEqual(attempt, 2, 'should have made exactly two attempts');
    strictEqual(
      secondAttemptApiKey,
      'sk-second-key',
      'second attempt must use the next healthy slot, not the same slot',
    );
    const warnLogs = logger.calls.filter((c) => c.level === 'warn');
    ok(
      warnLogs.some((c) => c.message.includes('falling back')),
      'expected a warn log about the auth failure + fallback',
    );
  });

  it('surfaces an auth error directly when auto-rotation is disabled (toggle off)', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);

    let attempt = 0;
    const failingClient: MiniMaxClient = {
      streamCompletion(_request, _apiKey, _signal, _logger): AsyncIterable<MiniMaxStreamEvent> {
        attempt += 1;
        throw new MiniMaxClientError('auth', 'invalid api key', { status: 401, retriable: false });
      },
    };

    const secretStore = makeSecretStore({ has: false });
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');
    await kp.setKey(2, 'sk-key-2');

    const provider = new ChatProvider(logger, kp, failingClient, catalog, (key) =>
      key === 'enableAutoKeyRotation' ? false : undefined,
    );
    const { progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi'),
    ];

    let caughtError: Error | undefined;
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        messages,
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        progress,
        new vscode.CancellationTokenSource().token,
      );
    } catch (err) {
      caughtError = err as Error;
    }

    strictEqual(attempt, 1, 'should have made exactly ONE attempt (no fallback)');
    ok(caughtError !== undefined, 'expected an auth error to surface');
    ok(
      caughtError?.message.includes('Auto-rotation is disabled'),
      `expected user-facing message about disabled rotation; got: ${caughtError?.message}`,
    );
    ok(
      caughtError?.message.includes('Manage'),
      `expected message to point at the manage command; got: ${caughtError?.message}`,
    );

    const failedSlots = Object.entries(kp.__state.failures).filter(([, v]) => v !== undefined);
    strictEqual(
      failedSlots.length,
      0,
      'no slot should have been markFailed under disabled rotation',
    );
  });

  it('does NOT call markFailed even when auth fails under disabled rotation', async () => {
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const failingClient: MiniMaxClient = {
      streamCompletion() {
        throw new MiniMaxClientError('auth', 'rejected', { status: 401, retriable: false });
      },
    };

    const secretStore = makeSecretStore({ has: false });
    const kp = makeTestKeyProvider(secretStore, { activeSlot: 1 });
    await kp.setKey(1, 'sk-key-1');

    const provider = new ChatProvider(logger, kp, failingClient, catalog, (key) =>
      key === 'enableAutoKeyRotation' ? false : undefined,
    );
    try {
      await provider.provideLanguageModelChatResponse(
        makeModelInfo('MiniMax-M3'),
        [new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'hi')],
        { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
        { report: () => undefined },
        new vscode.CancellationTokenSource().token,
      );
    } catch {
      // expected
    }
    strictEqual(
      kp.__state.failures[1],
      undefined,
      'slot 1 must NOT have a recorded failure under disabled rotation',
    );
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
      makeProvider(),
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
      makeProvider(),
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
      makeProvider(),
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
      makeProvider(),
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

// ─────────────────────────────────────────────────────────────────────────────
// vscodeToDomainMessage — tool-result content normalization
//
// Regression for the `[object Object]` rendering bug. A non-text
// tool-result content part with no recognizable shape must land in
// the domain message as a JSON-encoded string, NOT the literal
// `[object Object]` that `String(payload)` produces. Mirrors the
// defensive `JSON.stringify` in the message mapper at
// `src/lib/domain/messages.ts:mapRequestToMiniMax`.
//
// `LanguageModelDataPart`-shaped pieces are handled BEFORE that
// fallback: Copilot stamps prompt-cache breakpoints into tool-result
// content as data parts with mime `cache_control`, and stringifying
// those leaks `{"mimeType":"cache_control","data":{...}}` byte-map
// garbage into the model-visible tool output (models read it as an
// injection attempt). Metadata mimes are dropped, textual payloads
// are decoded, binary payloads collapse to a short marker.
// ─────────────────────────────────────────────────────────────────────────────

describe('vscodeToDomainMessage — tool-result content normalization', () => {
  it('JSON-encodes a structured object in tool-result content (not [object Object])', () => {
    // Build a tool-result content list that holds a structured
    // object — analogous to what `LanguageModelDataPart` would
    // look like to the converter.
    const structuredPayload = { errors: ['one', 'two'], path: 'src/foo.ts' };
    const msg: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      // `name` is a required field on `LanguageModelChatRequestMessage`
      // even though our domain `ChatMessage` makes it optional.
      // Pass undefined to satisfy the vscode type without changing
      // observable behavior in the chat-provider.
      name: undefined,
      content: [
        new vscode.LanguageModelToolResultPart('call_e1', [
          // A non-LanguageModelTextPart content item. The chat-provider
          // branch we just fixed is the fallback path for these.
          structuredPayload,
        ]),
      ],
    };
    const domain = vscodeToDomainMessage(msg);
    strictEqual(domain.role, 'user');
    strictEqual(domain.content.length, 1);
    const part = domain.content[0]!;
    strictEqual(part.type, 'tool-result');
    if (part.type !== 'tool-result') return;
    strictEqual(part.toolResult.callId, 'call_e1');
    const resultContent = part.toolResult.content;
    strictEqual(resultContent.length, 1);
    const serialized = resultContent[0];
    // The serialized form must be a string — never the
    // `[object Object]` produced by `String(obj)`.
    strictEqual(typeof serialized, 'string');
    if (typeof serialized !== 'string') return;
    ok(
      !serialized.includes('[object Object]'),
      `tool-result content must not be the literal '[object Object]'; got: ${serialized}`,
    );
    // And it must be parseable back to the original payload —
    // i.e. `JSON.stringify` was the encode path.
    const parsed = JSON.parse(serialized) as { errors: string[]; path: string };
    deepStrictEqual(parsed.errors, ['one', 'two']);
    strictEqual(parsed.path, 'src/foo.ts');
  });

  it('emits a marker string when JSON.stringify throws on circular content', () => {
    // Build a circular object. `JSON.stringify` will throw with
    // "Converting circular structure to JSON". The chat-provider
    // must catch the error and fall back to a typed marker that
    // the model can see. The helper is a pure function (not a
    // class method) so it does not log — the marker string is
    // itself the diagnostic, both on the wire and in any
    // downstream chat transcript.
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular['self'] = circular;
    const msg: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelToolResultPart('call_circ', [circular])],
    };
    const domain = vscodeToDomainMessage(msg);
    const part = domain.content[0]!;
    if (part.type !== 'tool-result') {
      ok(false, 'expected a tool-result part');
      return;
    }
    const serialized = part.toolResult.content[0];
    strictEqual(typeof serialized, 'string');
    if (typeof serialized !== 'string') return;
    // The marker string is what's emitted on the fallback path.
    // It must contain the constructor name (here `Object`) so the
    // model and the wire payload both have a hint about what
    // failed.
    ok(
      serialized.startsWith('[unserializable tool result content:'),
      `expected the unserializable marker; got: ${serialized}`,
    );
    ok(
      serialized.includes('Object'),
      `marker should include the constructor name 'Object'; got: ${serialized}`,
    );
  });

  // Build a `LanguageModelDataPart`-shaped piece. The real value
  // class exists on VS Code 1.99+ hosts; the converter also
  // duck-types on `{mimeType, data}` so stubs and cross-realm
  // instances behave identically — the plain-object form is what
  // these tests exercise.
  const makeDataPart = (mimeType: string, payload: string) => ({
    mimeType,
    data: new TextEncoder().encode(payload),
  });

  it('drops cache_control (and other metadata-mime) data parts from tool-result content', () => {
    const msg: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelToolResultPart('call_cc', [
          new vscode.LanguageModelTextPart('127.0.0.1 localhost'),
          // Copilot's cache breakpoint, exactly as the built-in
          // extension constructs it: encode("ephemeral") under
          // mime "cache_control".
          makeDataPart('cache_control', 'ephemeral'),
          makeDataPart('stateful_marker', 'x'),
        ]),
      ],
    };
    const domain = vscodeToDomainMessage(msg);
    const part = domain.content[0]!;
    strictEqual(part.type, 'tool-result');
    if (part.type !== 'tool-result') return;
    deepStrictEqual(part.toolResult.content, ['127.0.0.1 localhost']);
    ok(
      !JSON.stringify(part.toolResult.content).includes('cache_control'),
      'cache_control must never appear in model-visible tool result content',
    );
  });

  it('decodes textual data parts (application/json, text/*) instead of byte-mapping them', () => {
    const msg: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelToolResultPart('call_json', [
          makeDataPart('application/json', '{"rows":3}'),
          makeDataPart('text/plain', 'plain text'),
        ]),
      ],
    };
    const domain = vscodeToDomainMessage(msg);
    const part = domain.content[0]!;
    if (part.type !== 'tool-result') {
      ok(false, 'expected a tool-result part');
      return;
    }
    deepStrictEqual(part.toolResult.content, ['{"rows":3}', 'plain text']);
  });

  it('collapses binary data parts to a short marker instead of a Uint8Array byte map', () => {
    const msg: vscode.LanguageModelChatRequestMessage = {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelToolResultPart('call_png', [
          {
            mimeType: 'image/png',
            data: new Uint8Array([137, 80, 78, 71]),
          },
        ]),
      ],
    };
    const domain = vscodeToDomainMessage(msg);
    const part = domain.content[0]!;
    if (part.type !== 'tool-result') {
      ok(false, 'expected a tool-result part');
      return;
    }
    deepStrictEqual(part.toolResult.content, ['[tool result data omitted: image/png, 4 bytes]']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T19 — Response-part correctness: thinking parts, usage leak, tool-call
// finalization on every terminal path.
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatProvider T19 — response-part correctness', () => {
  it('reports thinking parts via progress.report, NEVER as LanguageModelTextPart', async () => {
    // T19 invariant 1: thinking content must NEVER appear as a
    // LanguageModelTextPart value. The provider must surface the
    // thinking through progress.report (currently via a
    // LanguageModelDataPart with a distinguishing MIME; will move
    // to LanguageModelThinkingPart when it lands in @types/vscode).
    //
    // The test stubs in the unit runner do not yet export
    // `LanguageModelDataPart`, so the chat-provider falls back to
    // the cached LRU replay path (thinking is preserved into the
    // next request's Anthropic wire signature field). The
    // NEGATIVE assertion on the visible-text lane is the load-bearing
    // invariant we assert here.
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        { thinkingDelta: 'planning the next step' },
        { thinkingSignature: 'sig_xyz' },
        { textDelta: 'On it.' },
        { finishReason: 'stop' },
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'do a thing'),
    ];
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    // The visible-text lane must NOT contain the thinking text.
    const textParts = parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
    );
    for (const tp of textParts) {
      ok(
        !tp.value.includes('planning the next step'),
        `thinking content leaked into a LanguageModelTextPart value: ${tp.value}`,
      );
    }
  });

  it('never emits `__minimax_usage__:` as a LanguageModelTextPart value', async () => {
    // T19 invariant 3: the previous behavior emitted usage JSON
    // as a text part with a `__minimax_usage__:` prefix; users
    // saw this in their chat transcripts. The T19 fix drops the
    // text emission entirely (or routes it via LanguageModelDataPart).
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        { textDelta: 'done.' },
        {
          usage: {
            promptTokens: 100,
            completionTokens: 5,
            cacheReadTokens: 95,
          },
        },
        { finishReason: 'stop' },
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'go'),
    ];
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );

    const textParts = parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart,
    );
    for (const tp of textParts) {
      ok(
        !tp.value.includes('__minimax_usage__'),
        `usage leaked into LanguageModelTextPart: ${tp.value}`,
      );
    }
  });

  it('emits a tool call when the stream ends with finishReason=stop after a tool-call delta', async () => {
    // T19 invariant 4a: when the model emits a tool_call and
    // then finishes with `stop` instead of `tool_calls` (some
    // M2.x behavior), the partial tool call must still be
    // flushed to progress.
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        {
          toolCallDelta: { index: 0, id: 'call_partial', name: 'noop' },
        },
        {
          toolCallDelta: { index: 0, argumentsDelta: '{}' },
        },
        { finishReason: 'stop' },
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'go'),
    ];
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );
    const toolCalls = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
    ok(toolCalls.length >= 1, 'expected tool call to be flushed on stop');
  });

  it('emits accumulated tool calls when the stream ends without a finish marker', async () => {
    // T19 invariant 4b: when the stream ends with no finish
    // event (abandonment path), the partial tool calls must
    // still be flushed to progress before the surface returns.
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        {
          toolCallDelta: { index: 0, id: 'call_stranded', name: 'noop' },
        },
        {
          toolCallDelta: { index: 0, argumentsDelta: '{}' },
        },
        // No finishReason, no usage — the stream just ends.
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'go'),
    ];
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progress,
      new vscode.CancellationTokenSource().token,
    );
    const toolCalls = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
    ok(toolCalls.length >= 1, 'expected stranded tool call flushed on stream end');
  });

  it('emits accumulated tool calls before surfacing a mid-stream transport error', async () => {
    // T19 invariant 4c: a mid-stream transport error after a
    // complete tool call must NOT swallow the tool call. The
    // provider reports it first, then surfaces the error to the
    // host.
    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeFakeClient([
      [
        {
          toolCallDelta: { index: 0, id: 'call_pre_error', name: 'noop' },
        },
        {
          toolCallDelta: { index: 0, argumentsDelta: '{}' },
        },
        { error: { message: 'transport stalled', retriable: false } },
      ],
    ]);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );
    const { parts, progress } = makeProgress();
    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'go'),
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
    } catch {
      threw = true;
    }
    ok(threw, 'expected the provider to throw on a mid-stream error');
    const toolCalls = parts.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
    ok(
      toolCalls.length >= 1,
      'expected the in-flight tool call to be flushed before the error is surfaced',
    );
  });
});
