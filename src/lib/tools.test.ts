/**
 * T03 — Tool schema mapping tests.
 *
 * Pure-function tests for the domain layer's tool mapping. These run
 * under the `unit` label (no VS Code host) and exercise the round
 * trips, the streaming accumulator, the bounded JSON repair, and the
 * tool-result encoding.
 *
 * Pattern matches `src/lib/catalog.test.ts`: node:test `suite`/`test`,
 * `node:assert/strict` deep equality, no `vscode` imports.
 */

import { deepEqual, deepStrictEqual, equal, fail, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accumulatorSeed,
  accumulateToolCallDelta,
  finalizeAccumulator,
  isToolSchemaError,
  mapToolModeToChoice,
  mapToolResultToMiniMax,
  mapToolsToMiniMax,
  repairTruncatedJson,
  serializeToolResultContent,
  type ChatTool,
  type ChatToolResultPart,
  type ToolSchemaError,
} from './domain/tools.js';

import type { MiniMaxToolDefinition } from '../ports/minimax-client.js';
import type { MiniMaxWireMessage } from '../ports/minimax-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: VS Code tools -> MiniMax tool definitions
// ─────────────────────────────────────────────────────────────────────────────

describe('mapToolsToMiniMax', () => {
  it('returns an empty array for an empty input', () => {
    deepStrictEqual(mapToolsToMiniMax([]), []);
  });

  it('throws for an invalid empty tool name because the wire request would be unusable', () => {
    const tools: ChatTool[] = [{ name: '', description: 'broken tool' }];
    failIfDoesNotThrow(() => mapToolsToMiniMax(tools));
  });

  it('preserves the name and description for a single tool', () => {
    const tools: ChatTool[] = [{ name: 'read_file', description: 'Reads a file from disk.' }];
    const mapped = mapToolsToMiniMax(tools);
    equal(mapped.length, 1);
    equal(mapped[0]?.type, 'function');
    equal(mapped[0]?.function.name, 'read_file');
    equal(mapped[0]?.function.description, 'Reads a file from disk.');
  });

  it('passes tool schemas through verbatim (lowering happens at the Anthropic serializer boundary only)', () => {
    // T17 split the role: the domain mapper preserves the VS Code-style
    // schema shape (so the same `MiniMaxToolDefinition` array can be
    // serialized to either the Anthropic or OpenAI wire), and the
    // Anthropic serializer (`src/adapters/transport.ts`)
    // `sanitizeAnthropicSchema`-lowers the schema right before the
    // Anthropic request is constructed. The OpenAI-compatible endpoint
    // accepts the lowered shapes too, so cross-dialect calls don't
    // need a separate schema pass.
    //
    // The lowering-specific regression test lives in
    // `src/adapters/transport.test.ts` under "Anthropic dialect body
    // shape (regression)". Here we assert that `mapToolsToMiniMax`
    // does NOT lower — `additionalProperties: false`, `const`,
    // boolean sub-schemas, etc. all survive verbatim.
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mode: { const: 'strict' },
      },
      required: ['path'],
      additionalProperties: false,
    };
    const tools: ChatTool[] = [
      { name: 'read_file', description: 'Reads a file.', inputSchema: schema },
    ];
    const mapped = mapToolsToMiniMax(tools);
    const params = mapped[0]?.function.parameters as Record<string, unknown>;
    deepStrictEqual(params, schema);
  });

  it('omits the parameters key when inputSchema is undefined', () => {
    const tools: ChatTool[] = [{ name: 'ping', description: 'Pings the model.' }];
    const mapped = mapToolsToMiniMax(tools);
    const params = mapped[0]?.function.parameters;
    // MiniMax requires `parameters` (defaults to {}), but the *inputSchema*
    // absence is signalled by an empty object schema.
    deepStrictEqual(params, {});
  });

  it('treats built-in, extension, and MCP tools uniformly (no origin special-casing)', () => {
    // Simulated "uniform" shape — origin is just the `name` prefix.
    const tools: ChatTool[] = [
      { name: 'vscode_edit', description: 'Built-in apply edit.', inputSchema: {} },
      { name: 'vscode_run_in_terminal', description: 'Built-in CLI tool.', inputSchema: {} },
      { name: 'extension_myTool', description: 'Extension-provided tool.', inputSchema: {} },
      { name: 'mcp_myServer_myTool', description: 'MCP server tool.', inputSchema: {} },
    ];
    const mapped = mapToolsToMiniMax(tools);
    equal(mapped.length, 4);
    for (const entry of mapped) {
      equal(entry.type, 'function');
      ok(entry.function.name.length > 0);
      // The domain always supplies `description`; the wire-spec field
      // is optional, but for the tools we mapped the domain has set
      // it to a non-empty string.
      const desc = entry.function.description ?? '';
      ok(desc.length > 0);
    }
    // Order preserved: the domain never reorders tools.
    deepStrictEqual(
      mapped.map((m) => m.function.name),
      tools.map((t) => t.name),
    );
  });

  it('round-trips tool names and JSON-schema parameters through the mapper', () => {
    const tools: ChatTool[] = [
      {
        name: 'search',
        description: 'Search the workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxResults: { type: 'number', minimum: 1 },
          },
          required: ['query'],
        },
      },
    ];
    const mapped = mapToolsToMiniMax(tools);
    const round = mapped.map((m) => ({
      name: m.function.name,
      description: m.function.description,
      inputSchema: m.function.parameters,
    }));
    deepStrictEqual(round[0]?.name, tools[0]?.name);
    deepStrictEqual(round[0]?.description, tools[0]?.description);
    deepStrictEqual(round[0]?.inputSchema, tools[0]?.inputSchema);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: VS Code tool mode -> MiniMax tool_choice
// ─────────────────────────────────────────────────────────────────────────────

describe('mapToolModeToChoice', () => {
  it('returns "auto" for the Auto mode', () => {
    equal(mapToolModeToChoice('auto'), 'auto');
  });

  it('returns "required" for the Required mode', () => {
    equal(mapToolModeToChoice('required'), 'required');
  });

  it('returns undefined for an unknown mode so the transport can omit the field', () => {
    equal(mapToolModeToChoice('bogus'), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: VS Code tool-result -> MiniMax wire tool-result message
// ─────────────────────────────────────────────────────────────────────────────

describe('mapToolResultToMiniMax', () => {
  it('serializes a single text tool result as a tool-role wire message', () => {
    const part: ChatToolResultPart = {
      callId: 'call_abc',
      content: ['{"ok": true}'],
    };
    const out = mapToolResultToMiniMax(part);
    const expected: MiniMaxWireMessage = {
      role: 'tool',
      content: '{"ok": true}',
      toolCallId: 'call_abc',
    };
    deepStrictEqual(out, expected);
  });

  it('joins mixed text content with a newline so the model sees a single blob', () => {
    const part: ChatToolResultPart = {
      callId: 'call_xyz',
      content: ['line 1', 'line 2', 'line 3'],
    };
    const out = mapToolResultToMiniMax(part);
    if (isToolSchemaError(out)) {
      fail(`expected a wire message, got error: ${out.kind}`);
    }
    equal(out.role, 'tool');
    equal(out.toolCallId, 'call_xyz');
    equal(out.content, 'line 1\nline 2\nline 3');
  });

  it('serializes a structured payload via serializeToolResultContent', () => {
    const part: ChatToolResultPart = {
      callId: 'call_struct',
      content: [{ complex: 'object', n: 1 }],
    };
    const out = mapToolResultToMiniMax(part);
    if (isToolSchemaError(out)) {
      fail(`expected a wire message, got error: ${out.kind}`);
    }
    // T04 widened `MiniMaxWireMessage.content` to a `string |
    // content-parts array`. The T03 mapper always returns a string
    // for tool results, so narrow to that here.
    if (typeof out.content !== 'string') {
      fail(`expected string content from the T03 mapper`);
    }
    deepStrictEqual(JSON.parse(out.content), { complex: 'object', n: 1 });
    equal(out.toolCallId, 'call_struct');
  });

  it('returns a typed error envelope (not a throw) when the call id is missing', () => {
    const part = { callId: '', content: ['ok'] } as ChatToolResultPart;
    const out = mapToolResultToMiniMax(part);
    if (!isToolSchemaError(out)) {
      fail('expected a ToolSchemaError envelope, got a wire message');
    }
    deepStrictEqual(out, { kind: 'tool-result-missing-call-id' } satisfies ToolSchemaError);
  });

  it('returns a typed error when content is not an array', () => {
    const part = { callId: 'c1', content: 'not-a-list' } as unknown as ChatToolResultPart;
    const out = mapToolResultToMiniMax(part);
    if (!isToolSchemaError(out)) {
      fail('expected a ToolSchemaError envelope, got a wire message');
    }
    deepStrictEqual(out, {
      kind: 'tool-result-content-not-list',
      callId: 'c1',
    } satisfies ToolSchemaError);
  });

  it('exposes the helper serializeToolResultContent for direct use', () => {
    // The helper joins string pieces with '\n' and JSON-encodes
    // non-strings. Numbers are encoded individually and joined with
    // '\n' — JSON.parse cannot read the multi-document stream, so
    // the assertion is on the joined shape, not a single parse.
    const s = serializeToolResultContent([1, 2, 3]);
    deepStrictEqual(s, '1\n2\n3');
  });

  it('normalizes undefined content entries to JSON null instead of dropping them silently', () => {
    const s = serializeToolResultContent([undefined, null, 'tail']);
    deepStrictEqual(s, 'null\nnull\ntail');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: MiniMax tool-call deltas -> completed ChatToolCallParts
// ─────────────────────────────────────────────────────────────────────────────

describe('accumulateToolCallDelta', () => {
  it('returns the seed unchanged and no parts when no deltas have arrived', () => {
    const state = accumulatorSeed();
    const result = accumulateToolCallDelta(state, { index: 0, id: 'call_1', name: 'a' });
    deepStrictEqual(result.parts, []);
    equal(result.state.perIndex.size, 1);
  });

  it('accumulates a single call across one id+name event and one arguments delta', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'call_1', name: 'read_file' }).state;
    state = accumulateToolCallDelta(state, { index: 0, argumentsDelta: '{"path":' }).state;
    // Until finalizeAccumulator runs, the accumulator holds the raw string
    // and emits no completed parts. The truncated entry (mid-value
    // `{"path":`) is dropped by the bounded repair, leaving an empty
    // object — the call id and name are still preserved.
    const parts = finalizeAccumulator(state);
    equal(parts.length, 1);
    const first = parts[0];
    if (isToolSchemaError(first) || first === undefined) {
      fail('expected a ChatToolCallPart, got an error or undefined');
    }
    deepStrictEqual(first, {
      callId: 'call_1',
      name: 'read_file',
      input: {},
    });
  });

  it('preserves distinct call ids for two parallel tool calls in one assistant turn', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'call_a', name: 'tool_one' }).state;
    state = accumulateToolCallDelta(state, { index: 1, id: 'call_b', name: 'tool_two' }).state;
    state = accumulateToolCallDelta(state, { index: 0, argumentsDelta: '{"a":1}' }).state;
    state = accumulateToolCallDelta(state, { index: 1, argumentsDelta: '{"b":2}' }).state;
    const parts = finalizeAccumulator(state);
    equal(parts.length, 2);
    // Narrow to ChatToolCallPart — none of these should be errors.
    for (const p of parts) {
      if (isToolSchemaError(p)) {
        fail(`unexpected error envelope: ${p.kind}`);
      }
    }
    // Order is stable by index.
    deepStrictEqual(
      parts.map((p) => (isToolSchemaError(p) ? '' : p.callId)),
      ['call_a', 'call_b'],
    );
    deepStrictEqual(
      parts.map((p) => (isToolSchemaError(p) ? '' : p.name)),
      ['tool_one', 'tool_two'],
    );
    deepStrictEqual(
      parts.map((p) => (isToolSchemaError(p) ? null : p.input)),
      [{ a: 1 }, { b: 2 }],
    );
  });

  it('concatenates argument fragments per index without dropping characters', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'call_1', name: 'fn' }).state;
    const fragments = ['{"x":', '"hello"', ',"y":', '[1,', '2,3]}'];
    for (const fragment of fragments) {
      state = accumulateToolCallDelta(state, { index: 0, argumentsDelta: fragment }).state;
    }
    const parts = finalizeAccumulator(state);
    const first = parts[0];
    if (isToolSchemaError(first) || first === undefined) {
      fail('expected a ChatToolCallPart, got an error or undefined');
    }
    deepStrictEqual(first.input, { x: 'hello', y: [1, 2, 3] });
  });

  it('emits a typed ToolSchemaError when the same call id is reassigned to a different index', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'call_1', name: 'fn' }).state;
    // A second event that reuses the same id with a *new* index is a
    // protocol violation — the transport must surface it, not silently
    // overwrite.
    const result = accumulateToolCallDelta(state, { index: 1, id: 'call_1', name: 'fn2' });
    equal(result.parts.length, 1);
    const part = result.parts[0];
    if (!isToolSchemaError(part)) {
      fail('expected a duplicate-call-id error envelope, got a tool-call part');
    }
    deepStrictEqual(part, {
      kind: 'duplicate-call-id',
      callId: 'call_1',
      index: 1,
    } satisfies ToolSchemaError);
    // State is left untouched so the in-flight call at index 0 is
    // not lost.
    equal(result.state.perIndex.size, 1);
  });

  it('emits a typed ToolSchemaError when the same index is reassigned to a different call id', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'call_1', name: 'fn' }).state;
    const result = accumulateToolCallDelta(state, { index: 0, id: 'call_2', name: 'fn' });

    equal(result.parts.length, 1);
    const part = result.parts[0];
    if (!isToolSchemaError(part)) {
      fail('expected a duplicate-call-id error envelope, got a tool-call part');
    }
    deepStrictEqual(part, {
      kind: 'duplicate-call-id',
      callId: 'call_2',
      index: 0,
    } satisfies ToolSchemaError);
  });
});

describe('finalizeAccumulator', () => {
  it('returns an empty array when the seed is finalized without any deltas', () => {
    deepStrictEqual(finalizeAccumulator(accumulatorSeed()), []);
  });

  it('repairs truncated JSON so a final partial fragment does not abort the turn', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'c1', name: 'fn' }).state;
    state = accumulateToolCallDelta(state, {
      index: 0,
      argumentsDelta: '{"path": "src/foo.ts", "line": 42',
    }).state;
    const parts = finalizeAccumulator(state);
    equal(parts.length, 1);
    // The repair closes the unclosed `{` and parses cleanly.
    const first = parts[0];
    if (isToolSchemaError(first) || first === undefined) {
      fail('expected a ChatToolCallPart, got an error or undefined');
    }
    deepStrictEqual(first.input, { path: 'src/foo.ts', line: 42 });
  });

  it('surfaces a typed argument-parse-failed error when repair is not possible', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, id: 'c1', name: 'fn' }).state;
    // Pure garbage — repair cannot fix this; it is not truncated JSON.
    state = accumulateToolCallDelta(state, { index: 0, argumentsDelta: 'not-json-at-all' }).state;
    const parts = finalizeAccumulator(state);
    equal(parts.length, 1);
    const err = parts[0];
    if (!isToolSchemaError(err)) {
      fail('expected an argument-parse-failed error envelope, got a tool-call part');
    }
    deepStrictEqual(err, {
      kind: 'argument-parse-failed',
      callId: 'c1',
      index: 0,
      rawArguments: 'not-json-at-all',
      repairAttempted: true,
    } satisfies ToolSchemaError);
  });

  it('surfaces a typed argument-parse-failed error when a call never received an id or name', () => {
    let state = accumulatorSeed();
    state = accumulateToolCallDelta(state, { index: 0, argumentsDelta: '{"x":1}' }).state;

    const parts = finalizeAccumulator(state);
    equal(parts.length, 1);
    const err = parts[0];
    if (!isToolSchemaError(err)) {
      fail('expected an argument-parse-failed error envelope, got a tool-call part');
    }
    deepStrictEqual(err, {
      kind: 'argument-parse-failed',
      callId: '',
      index: 0,
      rawArguments: '{"x":1}',
      repairAttempted: false,
    } satisfies ToolSchemaError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounded JSON repair
// ─────────────────────────────────────────────────────────────────────────────

describe('repairTruncatedJson', () => {
  it('passes through a well-formed JSON object unchanged', () => {
    const input = '{"a": 1, "b": [2, 3]}';
    const out = repairTruncatedJson(input);
    deepStrictEqual(JSON.parse(out), { a: 1, b: [2, 3] });
  });

  it('closes an unclosed string and an unclosed brace', () => {
    const input = '{"name": "abc';
    const out = repairTruncatedJson(input);
    deepStrictEqual(JSON.parse(out), { name: 'abc' });
  });

  it('closes an unclosed array but not a closed one', () => {
    const input = '{"list": [1, 2';
    const out = repairTruncatedJson(input);
    deepStrictEqual(JSON.parse(out), { list: [1, 2] });
  });

  it('strips a trailing comma before closing the object', () => {
    const input = '{"a": 1,';
    const out = repairTruncatedJson(input);
    deepStrictEqual(JSON.parse(out), { a: 1 });
  });

  it('returns the original string when repair cannot produce valid JSON', () => {
    const input = 'not-json-at-all';
    const out = repairTruncatedJson(input);
    equal(out, input);
  });

  it('handles nested truncation (object inside array inside object)', () => {
    const input = '{"items": [{"a": 1';
    const out = repairTruncatedJson(input);
    deepStrictEqual(JSON.parse(out), { items: [{ a: 1 }] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire shape sanity (catches regressions in the port types)
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMax tool definition shape', () => {
  it('always uses the `function` wrapper type', () => {
    const tools: ChatTool[] = [{ name: 'x', description: 'y' }];
    const mapped: MiniMaxToolDefinition[] = mapToolsToMiniMax(tools);
    equal(mapped[0]?.type, 'function');
  });
});

// Suppress unused import warning for `deepEqual` — kept for future
// structural-comparison tests without changing imports later.
void deepEqual;

function failIfDoesNotThrow(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    fail('expected function to throw');
  }
}
