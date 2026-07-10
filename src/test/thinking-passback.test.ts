/**
 * Thinking pass-back validation test.
 *
 * Tests the complete thinking + tool-calling flow to ensure:
 *  1. Thinking blocks with signatures are captured during streaming
 *  2. Thinking blocks are cached and rehydrated on subsequent rounds
 *  3. Consecutive tool results are coalesced into single user messages
 *  4. Anthropic wire format includes thinking blocks with signatures
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';

import { ChatProvider } from '../providers/chat-provider.js';
import type { Logger } from '../ports/logger.js';
import type { MiniMaxClient, MiniMaxCompletionRequest, MiniMaxStreamEvent } from '../ports/minimax-client.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures (copied from agent-harness.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-thinking-passback';

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
// Thinking pass-back tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Thinking pass-back', () => {
  it('captures thinking blocks with signatures and replays them in subsequent rounds', async () => {
    const THINKING_TEXT = 'I need to analyze this request carefully before calling the tool.';
    const THINKING_SIG = 'abc123signature';

    // Script: 2 rounds with thinking
    // Round 1: thinking + tool call
    // Round 2: final answer (should include thinking from round 1 in the request)
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      // Round 1: thinking delta, then tool call
      [
        { thinkingDelta: THINKING_TEXT, thinkingSignature: THINKING_SIG },
        { textDelta: 'Let me check that.' },
        {
          toolCallDelta: { index: 0, id: 'call_check', name: 'check_data', argumentsDelta: '{"id":"123"}' },
        },
        { finishReason: 'tool_calls' },
      ],
      // Round 2: final answer
      [
        { textDelta: 'Based on the data, the answer is 42.' },
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

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'check_data', description: 'Check data', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ];

    // Round 1
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Analyze this'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Verify Round 1 captured the tool call
    const round1ToolCalls = round1Progress.parts.filter(p => p instanceof vscode.LanguageModelToolCallPart);
    strictEqual(round1ToolCalls.length, 1, 'Round 1 should have 1 tool call');

    // Round 2 - feed back the tool result
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_check', 'check_data', { id: '123' }),
      ]),
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [
        new vscode.LanguageModelToolResultPart('call_check', [
          new vscode.LanguageModelTextPart('Data: 42'),
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

    // Verify Round 2 request includes the thinking block from Round 1
    const round2Request = client.calls[1]?.request;
    ok(round2Request, 'Round 2 request should exist');

    // Log the entire request for debugging removed (no-console).

    // Find the assistant message with tool calls
    const assistantMessages = round2Request.messages.filter(m => m.role === 'assistant');
    ok(assistantMessages.length > 0, 'Should have at least one assistant message');

    // Check if any assistant message has thinking in its content
    let foundThinking = false;
    for (const msg of assistantMessages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'thinking') {
            foundThinking = true;
            // console.log debug helper removed (no-console).
            // Verify thinking content and signature
            strictEqual((part as { thinking?: string }).thinking, THINKING_TEXT, 'Thinking content should match');
            strictEqual((part as { signature?: string }).signature, THINKING_SIG, 'Thinking signature should match');
          }
        }
      }
    }

    ok(foundThinking, 'Round 2 request should include thinking block from Round 1');
  });

  it('coalesces parallel tool results into a single user message', async () => {
    const script: ReadonlyArray<ReadonlyArray<MiniMaxStreamEvent>> = [
      // Round 1: two parallel tool calls
      [
        { textDelta: 'Checking both.' },
        {
          toolCallDelta: { index: 0, id: 'call_1', name: 'tool_a', argumentsDelta: '{"x":1}' },
        },
        {
          toolCallDelta: { index: 1, id: 'call_2', name: 'tool_b', argumentsDelta: '{"y":2}' },
        },
        { finishReason: 'tool_calls' },
      ],
      // Round 2: final answer
      [
        { textDelta: 'Done.' },
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

    const tools: vscode.LanguageModelChatTool[] = [
      { name: 'tool_a', description: 'Tool A', inputSchema: {} },
      { name: 'tool_b', description: 'Tool B', inputSchema: {} },
    ];

    // Round 1
    const round1Messages: vscode.LanguageModelChatRequestMessage[] = [
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, 'Run both'),
    ];
    const round1Progress = makeProgress();
    await provider.provideLanguageModelChatResponse(
      makeModelInfo('MiniMax-M3'),
      round1Messages,
      { tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
      round1Progress.progress,
      new vscode.CancellationTokenSource().token,
    );

    // Round 2 with both tool results
    const round2Messages: vscode.LanguageModelChatRequestMessage[] = [
      ...round1Messages,
      new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
        new vscode.LanguageModelToolCallPart('call_1', 'tool_a', { x: 1 }),
        new vscode.LanguageModelToolCallPart('call_2', 'tool_b', { y: 2 }),
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

    const round2Request = client.calls[1]?.request;
    ok(round2Request, 'Round 2 request should exist');

    // Log the request to verify coalescing removed (no-console).

    // Count user messages with tool_result content
    const userMessages = round2Request.messages.filter(m => m.role === 'user');
    // Verbose debug helper removed (no-console).

    // Find the user message containing tool results
    let toolResultMessage: typeof round2Request.messages[number] | undefined;
    for (const msg of userMessages) {
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          part => typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool_result'
        );
        if (hasToolResult) {
          toolResultMessage = msg;
          break;
        }
      }
    }

    ok(toolResultMessage, 'Should have a user message with tool results');
    ok(Array.isArray(toolResultMessage.content), 'Tool result message content should be an array');

    // Count tool_result blocks in this message
    const toolResultBlocks = (toolResultMessage.content as Array<unknown>).filter(
      part => typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool_result'
    );

    // console.log debug helper removed (no-console).
    strictEqual(
      toolResultBlocks.length,
      2,
      'Both tool results should be coalesced into a single user message with 2 tool_result blocks'
    );
  });
});
