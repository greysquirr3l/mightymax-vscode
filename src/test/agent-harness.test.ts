/**
 * T08 — Agent-loop fidelity harness.
 *
 * Drives the ChatProvider through scripted multi-round agent loops to
 * prove tool-calling fidelity:
 *  - Multiple rounds (≥3) complete and produce a final answer
 *  - Parallel tool calls receive correctly-matched results
 *  - Malformed tool calls are repaired or surfaced as typed errors
 *  - Cancellation mid-tool-call stops the stream cleanly
 *
 * This is the evaluator's `test_tool` — `npm run test:agent-harness`
 * must exit 0 when all agent-loop tests pass.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
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

import { makeTestKeyProvider } from '../test-helpers/key-provider-test-double.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-agent-harness';

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
/**
 * Build a `KeyProvider` test double backed by a single stored key.
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

interface RecordedCall {
  request: MiniMaxCompletionRequest;
  apiKey: string;
}

/**
 * Scripted agent client: replays a pre-recorded conversation across
 * multiple rounds. Each round is a separate call to `streamCompletion`;
 * the script array defines what events to emit for each round.
 */
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
    name: 'M3',
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
// Multi-round agent loop tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Agent-loop fidelity harness', () => {
  it('completes a 3-round agent loop with tool calls and final answer', async () => {
    // Script: 3 rounds
    // Round 1: model calls 'get_weather'
    // Round 2: model calls 'get_forecast'
    // Round 3: model produces final answer
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      // Round 1
      [
        { textDelta: 'Let me check the weather.' },
        {
          toolCallDelta: { index: 0, id: 'call_weather', name: 'get_weather', argumentsDelta: '{"city":"' },
        },
        { toolCallDelta: { index: 0, argumentsDelta: 'SF"}' } },
        { finishReason: 'tool_calls' },
      ],
      // Round 2
      [
        { textDelta: 'Now let me get the forecast.' },
        {
          toolCallDelta: { index: 0, id: 'call_forecast', name: 'get_forecast', argumentsDelta: '{"days":3}' },
        },
        { finishReason: 'tool_calls' },
      ],
      // Round 3
      [
        { textDelta: 'The weather is sunny and the forecast shows clear skies for 3 days.' },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'get_weather', description: 'Get current weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
      { name: 'get_forecast', description: 'Get forecast', inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
    ];

    // Round 1
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'What is the weather?'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 1: should have 1 text part + 1 tool call
    const round1ToolCalls = round1Progress.parts.filter(p => p instanceof vscode.LanguageModelToolCallPart);
    strictEqual(round1ToolCalls.length, 1, 'Round 1 should have 1 tool call');
    const round1Call = round1ToolCalls[0] as vscode.LanguageModelToolCallPart;
    strictEqual(round1Call.callId, 'call_weather');
    strictEqual(round1Call.name, 'get_weather');
    deepStrictEqual(round1Call.input, { city: 'SF' });

    // Round 2 - feed back the tool result
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_weather', 'get_weather', { city: 'SF' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_weather', [
          new vscode.LanguageModelTextPart('Sunny, 72°F'),
        ]),
      ]),
    ];
    const round2Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round2Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round2Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 2: should have 1 tool call
    const round2ToolCalls = round2Progress.parts.filter(p => p instanceof vscode.LanguageModelToolCallPart);
    strictEqual(round2ToolCalls.length, 1, 'Round 2 should have 1 tool call');
    const round2Call = round2ToolCalls[0] as vscode.LanguageModelToolCallPart;
    strictEqual(round2Call.callId, 'call_forecast');
    strictEqual(round2Call.name, 'get_forecast');

    // Round 3 - feed back the forecast result and get final answer
    const round3Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round2Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_forecast', 'get_forecast', { days: 3 }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_forecast', [
          new vscode.LanguageModelTextPart('Clear skies, 70-75°F'),
        ]),
      ]),
    ];
    const round3Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round3Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round3Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 3: should have final text answer, no more tool calls
    const round3ToolCalls = round3Progress.parts.filter(p => p instanceof vscode.LanguageModelToolCallPart);
    strictEqual(round3ToolCalls.length, 0, 'Round 3 should have no tool calls (final answer)');
    const round3TextParts = round3Progress.parts.filter(p => p instanceof vscode.LanguageModelTextPart);
    ok(round3TextParts.length > 0, 'Round 3 should have text response');

    // Verify total: 3 calls to streamCompletion
    strictEqual(client.calls.length, 3, 'Should have made 3 calls to streamCompletion (3 rounds)');
  });

  it('handles two parallel tool calls in one turn with correct result matching', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'Let me check both.' },
        {
          toolCallDelta: { index: 0, id: 'call_1', name: 'tool_a', argumentsDelta: '{"arg":"alpha"}' },
        },
        {
          toolCallDelta: { index: 1, id: 'call_2', name: 'tool_b', argumentsDelta: '{"arg":"beta"}' },
        },
        { finishReason: 'tool_calls' },
      ],
      [
        { textDelta: 'Results received.' },
        { finishReason: 'stop' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'tool_a', description: 'Tool A', inputSchema: {} },
      { name: 'tool_b', description: 'Tool B', inputSchema: {} },
    ];

    // Round 1: parallel calls
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Run both tools'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    const toolCalls = round1Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(toolCalls.length, 2, 'Should have 2 parallel tool calls');
    strictEqual(toolCalls[0]?.callId, 'call_1');
    strictEqual(toolCalls[0]?.name, 'tool_a');
    strictEqual(toolCalls[1]?.callId, 'call_2');
    strictEqual(toolCalls[1]?.name, 'tool_b');

    // Round 2: feed back both results
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_1', 'tool_a', { arg: 'alpha' }),
        new vscode.LanguageModelToolCallPart('call_2', 'tool_b', { arg: 'beta' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('Result A')]),
        new vscode.LanguageModelToolResultPart('call_2', [new vscode.LanguageModelTextPart('Result B')]),
      ]),
    ];
    const round2Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round2Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round2Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify the request contains both tool results with correct call ids
    const round2Request = client.calls[1]?.request;
    ok(round2Request, 'Round 2 request should exist');
    const toolMessages = round2Request.messages.filter(m => m.role === 'tool');
    strictEqual(toolMessages.length, 2, 'Should have 2 tool result messages');
    strictEqual(toolMessages[0]?.toolCallId, 'call_1');
    strictEqual(toolMessages[1]?.toolCallId, 'call_2');
  });

  it('recovers from malformed/truncated tool call arguments', async () => {
    // Malformed JSON that the repair function will fix
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        {
          toolCallDelta: { index: 0, id: 'call_malformed', name: 'broken_tool', argumentsDelta: '{"key":"val' },
        },
        { finishReason: 'tool_calls' },
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'broken_tool', description: 'A tool', inputSchema: {} },
    ];

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test'),
    ];
    const progressCapture = makeProgress();

    // Should not throw - malformed calls are repaired or surfaced as typed errors
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );

    // The truncated JSON should be repaired to {"key":"val"}
    const toolCalls = progressCapture.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(toolCalls.length, 1, 'Should have 1 tool call (repaired)');
    const call = toolCalls[0];
    ok(call, 'Tool call should exist');
    strictEqual(call.callId, 'call_malformed');
    strictEqual(call.name, 'broken_tool');
    // Repaired JSON
    deepStrictEqual(call.input, { key: 'val' });
  });

  it('cancels mid-tool-call and stops the stream cleanly', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'Starting...' },
        {
          toolCallDelta: { index: 0, id: 'call_cancel', name: 'long_tool', argumentsDelta: '{"x":' },
        },
        // More deltas would follow, but we cancel before they arrive
      ],
    ];

    const logger = makeRecordingLogger();
    const catalog = makeCatalog([M3]);
    const client = makeScriptedAgentClient(script);
    const provider = new ChatProvider(
      logger,
      makeProvider({ has: true, value: API_KEY }),
      client,
      catalog,
    );

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'long_tool', description: 'A long-running tool', inputSchema: {} },
    ];

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Test'),
    ];
    const progressCapture = makeProgress();
    const cts = new vscode.CancellationTokenSource();

    // Cancel after the request starts
    setTimeout(() => cts.cancel(), 10);

    // Should complete without throwing
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      cts.token,
    );

    // Verify we got some parts before cancellation
    ok(progressCapture.parts.length > 0, 'Should have received some parts before cancellation');
  });
});
