/**
 * T09 — Built-in tool and MCP parity integration tests.
 *
 * Verifies that MiniMax correctly invokes:
 *  - Built-in apply-edit tool (file edits)
 *  - Built-in run-in-terminal tool (CLI execution)
 *  - MCP server tools (no special-casing vs other tools)
 *
 * All tools are treated uniformly by the provider; this suite proves
 * the end-to-end flow works for each tool type.
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
// Test fixtures (reused from agent-harness.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-tool-parity';

function makeRecordingLogger(): Logger & {
  readonly calls: ReadonlyArray<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
  }>;
} {
  const calls: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const rec = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, context?: Record<string, unknown>): void => {
      calls.push(
        context === undefined ? { level, message } : { level, message, context },
      );
    };
  return {
    get calls() {
      return calls;
    },
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
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
/**
 * Build a `KeyProvider` test double backed by a single stored key.
 * Preserves the legacy `makeSecretStore({has, value})` shape so
 * call-site changes are minimal.
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
// Built-in and MCP tool integration tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Built-in tool and MCP parity', () => {
  it('applies an edit via the built-in edits_apply tool and feeds back the result', async () => {
    // Simulate a conversation where the model calls the edits_apply tool
    // to modify a file, then uses the result in the next turn.
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      // Round 1: model calls edits_apply
      [
        { textDelta: 'I will apply an edit to the file.' },
        {
          toolCallDelta: {
            index: 0,
            id: 'call_edit_1',
            name: 'edits_apply',
            argumentsDelta: '{"edits":[{"uri":"file:///test.ts","old":"foo","new":"bar"}]}',
          },
        },
        { finishReason: 'tool_calls' },
      ],
      // Round 2: model acknowledges the edit result
      [
        { textDelta: 'Edit applied successfully.' },
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

    // Define the edits_apply tool (simulates the built-in VS Code edit tool)
    const editTool: vscode.LanguageModelChatTool = {
      name: 'edits_apply',
      description: 'Apply edits to files',
      inputSchema: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                uri: { type: 'string' },
                old: { type: 'string' },
                new: { type: 'string' },
              },
            },
          },
        },
      },
    };

    // Round 1: model requests the edit
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Change foo to bar in test.ts'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools: [editTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 1: should have 1 tool call for edits_apply
    const round1ToolCalls = round1Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round1ToolCalls.length, 1, 'Should have 1 edits_apply call');
    const editCall = round1ToolCalls[0];
    ok(editCall, 'Edit call should exist');
    strictEqual(editCall.name, 'edits_apply');
    strictEqual(editCall.callId, 'call_edit_1');

    // Verify the request includes the edit tool definition
    const round1Request = client.calls[0]?.request;
    ok(round1Request, 'Round 1 request should exist');
    ok(round1Request.tools, 'Tools should be defined');
    strictEqual(round1Request.tools.length, 1, 'Should have 1 tool');
    strictEqual(round1Request.tools[0]?.function.name, 'edits_apply');

    // Round 2: feed back the edit result (simulated success)
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_edit_1', 'edits_apply', {
          edits: [{ uri: 'file:///test.ts', old: 'foo', new: 'bar' }],
        }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_edit_1', [
          new vscode.LanguageModelTextPart('Edit applied: changed 1 occurrence'),
        ]),
      ]),
    ];
    const round2Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round2Messages,
      { tools: [editTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round2Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 2: should have text response, no more tool calls
    const round2ToolCalls = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round2ToolCalls.length, 0, 'Round 2 should have no tool calls');
    const round2TextParts = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(round2TextParts.length > 0, 'Round 2 should have text response');
  });

  it('executes a CLI command via the run-in-terminal tool and consumes the output', async () => {
    // Simulate a conversation where the model calls run-in-terminal to
    // execute a command, then processes the output in the next turn.
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      // Round 1: model calls run-in-terminal
      [
        { textDelta: 'Let me check the Git status.' },
        {
          toolCallDelta: {
            index: 0,
            id: 'call_git_1',
            name: 'run_in_terminal',
            argumentsDelta: '{"command":"git status --short"}',
          },
        },
        { finishReason: 'tool_calls' },
      ],
      // Round 2: model summarizes the output
      [
        { textDelta: 'You have 2 modified files.' },
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

    // Define the run-in-terminal tool (simulates the built-in CLI tool)
    const cliTool: vscode.LanguageModelChatTool = {
      name: 'run_in_terminal',
      description: 'Execute a shell command and capture output',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    };

    // Round 1: model requests to run a command
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'What files are modified?'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools: [cliTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 1: should have 1 tool call for run_in_terminal
    const round1ToolCalls = round1Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round1ToolCalls.length, 1, 'Should have 1 run_in_terminal call');
    const cliCall = round1ToolCalls[0];
    ok(cliCall, 'CLI call should exist');
    strictEqual(cliCall.name, 'run_in_terminal');
    deepStrictEqual(cliCall.input, { command: 'git status --short' });

    // Round 2: feed back the command output (simulated git status result)
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_git_1', 'run_in_terminal', { command: 'git status --short' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_git_1', [
          new vscode.LanguageModelTextPart(' M src/file1.ts\n M src/file2.ts'),
        ]),
      ]),
    ];
    const round2Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round2Messages,
      { tools: [cliTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round2Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 2: model processes the output
    const round2ToolCalls = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round2ToolCalls.length, 0, 'Round 2 should have no tool calls');
    const round2TextParts = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(round2TextParts.length > 0, 'Round 2 should have text response');
  });

  it('invokes an MCP server tool with no special-casing vs built-in tools', async () => {
    // Simulate calling an MCP tool (e.g., from a weather MCP server).
    // The provider should treat it identically to built-in tools.
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'Checking the weather...' },
        {
          toolCallDelta: {
            index: 0,
            id: 'call_mcp_weather',
            name: 'weather_get_current',
            argumentsDelta: '{"location":"San Francisco"}',
          },
        },
        { finishReason: 'tool_calls' },
      ],
      [
        { textDelta: 'The weather in SF is sunny, 72°F.' },
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

    // Define an MCP tool (simulates a tool served by an MCP server)
    const mcpTool: vscode.LanguageModelChatTool = {
      name: 'weather_get_current',
      description: 'Get current weather for a location',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
    };

    // Round 1: model calls the MCP tool
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'What is the weather in San Francisco?'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools: [mcpTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify: MCP tool call is treated identically to built-in tools
    const round1ToolCalls = round1Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round1ToolCalls.length, 1, 'Should have 1 MCP tool call');
    const mcpCall = round1ToolCalls[0];
    ok(mcpCall, 'MCP call should exist');
    strictEqual(mcpCall.name, 'weather_get_current');
    deepStrictEqual(mcpCall.input, { location: 'San Francisco' });

    // Verify the MCP tool appears in the wire request with the same schema shape
    const round1Request = client.calls[0]?.request;
    ok(round1Request, 'Round 1 request should exist');
    ok(round1Request.tools, 'Tools should be defined');
    strictEqual(round1Request.tools.length, 1, 'Should have 1 tool');
    strictEqual(round1Request.tools[0]?.function.name, 'weather_get_current');
    strictEqual(round1Request.tools[0]?.type, 'function', 'Tool type should be function (no origin special-casing)');

    // Round 2: feed back the MCP tool result
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_mcp_weather', 'weather_get_current', { location: 'San Francisco' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_mcp_weather', [
          new vscode.LanguageModelTextPart('Sunny, 72°F'),
        ]),
      ]),
    ];
    const round2Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round2Messages,
      { tools: [mcpTool], toolMode: vscode.LanguageModelChatToolMode.Auto },
      round2Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 2: model uses the MCP result
    const round2ToolCalls = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
    );
    strictEqual(round2ToolCalls.length, 0, 'Round 2 should have no tool calls');
    const round2TextParts = round2Progress.parts.filter(
      (p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart
    );
    ok(round2TextParts.length > 0, 'Round 2 should have text response');
  });

  it('records usage metadata at debug without leaking as visible chat text (T19 invariant)', async () => {
    // T19 spec change: usage JSON MUST NEVER be emitted as a
    // `LanguageModelTextPart` (the previous behavior surfaced
    // `__minimax_usage__:${json}` to the user, where the model
    // saw its own token counts in chat). Usage is now logged at
    // `debug` with token counts only; the context-window widget
    // reads token counts from `provideTokenCount` separately.
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      [
        { textDelta: 'Hello' },
        { usage: { promptTokens: 100, completionTokens: 5 } },
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

    const messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Say hello'),
    ];
    const progressCapture = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      messages,
      { tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto },
      progressCapture.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Invariant 1: NO LanguageModelTextPart carries the
    // `__minimax_usage__:` marker (no usage-as-text leak).
    for (const part of progressCapture.parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        ok(
          !part.value.startsWith('__minimax_usage__:'),
          `usage leaked into chat text: ${part.value}`,
        );
      }
    }
    // Invariant 2: token counts reach the logger as metadata.
    const usageLog = logger.calls.find(
      (c) =>
        c.level === 'debug' &&
        (c.context?.promptTokens === 100 || c.message.includes('100')),
    );
    ok(usageLog !== undefined, 'expected a debug-level usage log with promptTokens');
  });
});
