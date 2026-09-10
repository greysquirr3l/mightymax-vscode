/**
 * T35 — Pure domain tests for the `minimax_subagent` tool shape.
 *
 * Pattern matches `src/lib/subagent-synthesis.test.ts` and
 * `src/lib/mcp-search-tools.test.ts`: `node:test` `describe`/`it`,
 * `node:assert/strict` equality, no `vscode` imports.
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  buildSubAgentDescriptor,
  buildSubAgentToolResult,
  MINIMAX_SUBAGENT_TOOL,
  validateSubAgentInput,
  type UnderlyingInvoker,
} from './domain/subagent-tool.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool name + descriptor
// ─────────────────────────────────────────────────────────────────────────────

describe('MINIMAX_SUBAGENT_TOOL constant', () => {
  it('is the string `minimax_subagent` (must not collide with `runSubagent`)', () => {
    strictEqual(MINIMAX_SUBAGENT_TOOL, 'minimax_subagent');
  });
});

describe('buildSubAgentDescriptor', () => {
  it('returns a descriptor with the expected name + schema shape', () => {
    const d = buildSubAgentDescriptor();
    strictEqual(d.name, MINIMAX_SUBAGENT_TOOL);
    strictEqual(d.inputSchema.type, 'object');
    ok(d.description.length > 0, 'description is non-empty');
    deepStrictEqual([...d.inputSchema.required].sort(), ['description', 'prompt']);
    ok(d.inputSchema.properties['description'] !== undefined, 'description property declared');
    ok(d.inputSchema.properties['prompt'] !== undefined, 'prompt property declared');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSubAgentInput', () => {
  it('rejects non-object input', () => {
    const v = validateSubAgentInput('not an object');
    strictEqual(v.ok, false);
    ok(v.errorMessage !== undefined);
  });

  it('rejects input missing the `description` field', () => {
    const v = validateSubAgentInput({ prompt: 'do thing' });
    strictEqual(v.ok, false);
    ok(v.errorMessage?.includes('description'), 'error names the missing field');
  });

  it('rejects an empty `description`', () => {
    const v = validateSubAgentInput({ description: '', prompt: 'do thing' });
    strictEqual(v.ok, false);
  });

  it('rejects input missing the `prompt` field', () => {
    const v = validateSubAgentInput({ description: 'x' });
    strictEqual(v.ok, false);
    ok(v.errorMessage?.includes('prompt'), 'error names the missing field');
  });

  it('rejects an empty `prompt`', () => {
    const v = validateSubAgentInput({ description: 'x', prompt: '' });
    strictEqual(v.ok, false);
  });

  it('accepts a minimal valid input', () => {
    const v = validateSubAgentInput({
      description: 'tidy the foo',
      prompt: 'please tidy the foo module',
    });
    strictEqual(v.ok, true);
    deepStrictEqual(v.value, { description: 'tidy the foo', prompt: 'please tidy the foo module' });
  });

  it('passes `subagent_type` through when provided and non-empty', () => {
    const v = validateSubAgentInput({
      description: 'x',
      prompt: 'y',
      subagent_type: 'general-purpose',
    });
    strictEqual(v.ok, true);
    strictEqual(v.value?.subagent_type, 'general-purpose');
  });

  it('drops `subagent_type` when it is an empty string', () => {
    const v = validateSubAgentInput({ description: 'x', prompt: 'y', subagent_type: '' });
    strictEqual(v.ok, true);
    strictEqual(v.value?.subagent_type, undefined, 'empty string is treated as absent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSubAgentToolResult (synthesizes the per-call tool result text)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSubAgentToolResult', () => {
  it('wraps an empty parts list in a `<task>` envelope', () => {
    const text = buildSubAgentToolResult([], 'completed');
    ok(text.includes('<task id="minimax_subagent" state="completed">'), 'opens task envelope');
    ok(text.includes('<task_result>'), 'opens task_result');
    ok(text.includes('</task_result>'), 'closes task_result');
    ok(text.includes('</task>'), 'closes task');
  });

  it('uses the <task_error> tag when state is "error"', () => {
    const text = buildSubAgentToolResult([], 'error');
    ok(text.includes('<task_error>'), 'error tag present');
    ok(!text.includes('<task_result>'), 'no result tag when state is error');
  });

  it('emits a single text result regardless of part count', () => {
    const parts = [
      { value: 'first' },
      { value: 'second' },
      { value: 'third' },
      // Tool-call shape — synthesized as <tool_use>.
      { name: 'grep_search', callId: 'c1', input: { pattern: 'foo' } },
    ];
    const text = buildSubAgentToolResult(parts, 'completed');
    // The model sees ONE string. There must NOT be multiple top-level
    // XML blocks — that would be the same problem we are fixing.
    const taskOpenCount = (text.match(/<task id=/g) ?? []).length;
    strictEqual(taskOpenCount, 1, 'exactly one <task> envelope');
  });

  it('appends an HTML-comment summary when one is provided', () => {
    const text = buildSubAgentToolResult([], 'completed', {}, 'Background task completed: foo');
    ok(
      text.includes('<!-- summary: Background task completed: foo -->'),
      'summary in HTML comment',
    );
  });

  it('truncates the body when it exceeds the per-call cap', () => {
    const longText = 'y'.repeat(500);
    const text = buildSubAgentToolResult([{ value: longText }], 'completed', { maxChars: 30 });
    ok(text.includes('[...truncated'), 'truncation marker present');
    ok(text.length < longText.length, 'output shorter than input');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UnderlyingInvoker integration smoke
// ─────────────────────────────────────────────────────────────────────────────

describe('UnderlyingInvoker contract', () => {
  it('is awaited once and its `parts` flow into the synthesizer', () => {
    let invoked = false;
    const fake: UnderlyingInvoker = async (input) => {
      invoked = true;
      strictEqual(input.description, 'describe-x');
      strictEqual(input.prompt, 'please describe x');
      return { parts: [{ value: 'answer to x' }], state: 'completed' };
    };
    // Use the API the adapter will use: a minimal integration check
    // that the typed shape matches expectations.
    const result = fake(
      { description: 'describe-x', prompt: 'please describe x' },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => {},
      },
    );
    return result.then((r) => {
      ok(invoked, 'invoker was called');
      const text = buildSubAgentToolResult(r.parts, r.state);
      ok(text.includes('answer to x'), 'synthesizer saw the invoker output');
    });
  });
});
