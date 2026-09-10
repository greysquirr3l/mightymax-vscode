/**
 * T35 — Pure domain tests for the sub-agent output synthesizer.
 *
 * The synthesizer collapses the multi-part content VS Code hands us
 * for `runSubagent` / `minimax_subagent` tool results into a single
 * text string shaped like opencode's `<task>` block. That single
 * string is what we ship to the model — and what we emit as the
 * result of our custom `minimax_subagent` tool — so the chat widget
 * renders exactly one box instead of N collapsible parts.
 *
 * Pattern matches `src/lib/mcp-search-tools.test.ts`: `node:test`
 * `describe`/`it`, `node:assert/strict` equality, no `vscode`
 * imports. These run under `npm run test:unit:node`.
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  buildCallIdToToolNameMap,
  collapseSubAgentToolResultsInDomain,
  synthesizeSubAgentOutput,
  type SubAgentPart,
  type SubAgentState,
} from './domain/subagent-synthesis.js';
import type { ChatMessage, ChatMessageContentPart } from '../ports/message-mapping.js';
import type { ChatToolResultPart } from '../ports/tool-schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_ID = 'subagent-abc123';
const TEXT_PART = (value: string): SubAgentPart => ({ kind: 'text', value });
const THINKING_PART = (value: string): SubAgentPart => ({ kind: 'thinking', value });
const TOOL_USE_PART = (name: string, input: unknown, callId = 'call_x'): SubAgentPart => ({
  kind: 'tool-use',
  name,
  callId,
  input,
});
const TOOL_RESULT_PART = (callId: string, value: string): SubAgentPart => ({
  kind: 'tool-result',
  callId,
  value,
});
const DATA_PART = (mimeType: string, size: number): SubAgentPart => ({
  kind: 'data',
  mimeType,
  size,
});

function synth(
  parts: ReadonlyArray<SubAgentPart>,
  opts: {
    state?: SubAgentState;
    summary?: string;
    maxChars?: number;
    sessionId?: string;
  } = {},
): string {
  const result = synthesizeSubAgentOutput(parts, {
    sessionId: opts.sessionId ?? SESSION_ID,
    state: opts.state ?? 'completed',
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
  });
  return result.text;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML envelope
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSubAgentOutput — XML envelope', () => {
  it('wraps an empty part list in the <task> envelope with empty <task_result>', () => {
    const text = synth([]);
    deepStrictEqual(
      text.split('\n'),
      [`<task id="${SESSION_ID}" state="completed">`, '<task_result>', '</task_result>', '</task>'],
      'empty body still produces a well-formed XML block',
    );
  });

  it('emits <task_error>...</task_error> when state is "error"', () => {
    const text = synth([TEXT_PART('boom')], { state: 'error' });
    ok(text.includes('<task_error>'), 'error tag present');
    ok(text.includes('</task_error>'), 'error tag closed');
    ok(!text.includes('<task_result>'), 'no result tag when state is error');
    ok(text.includes('boom'), 'body still contains the text');
  });

  it('emits <task_result> by default and for "completed"/"running" states', () => {
    for (const state of ['completed', 'running'] as const) {
      const text = synth([TEXT_PART('hi')], { state });
      ok(text.includes('<task_result>'), `state=${state} uses task_result tag`);
      ok(!text.includes('<task_error>'), `state=${state} does not use task_error tag`);
    }
  });

  it('includes the session id as the task id attribute', () => {
    const text = synth([], { sessionId: 'subagent-xyz789' });
    ok(text.startsWith('<task id="subagent-xyz789"'), 'session id is in the opening tag');
  });

  it('includes the state attribute verbatim', () => {
    const text = synth([], { state: 'running' });
    ok(text.includes('state="running"'), 'state attribute preserved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary line
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSubAgentOutput — summary', () => {
  it('omits <summary> when no summary is provided', () => {
    const text = synth([TEXT_PART('body')]);
    ok(!text.includes('<summary>'), 'no summary tag when summary is absent');
  });

  it('inserts <summary> between the task tag and the result tag when provided', () => {
    const text = synth([TEXT_PART('body')], { summary: 'Background task completed: foo' });
    const summaryIdx = text.indexOf('<summary>');
    const resultIdx = text.indexOf('<task_result>');
    const closingIdx = text.indexOf('</task>');
    ok(summaryIdx !== -1, 'summary tag present');
    ok(resultIdx !== -1, 'result tag present');
    ok(closingIdx !== -1, 'closing task tag present');
    ok(summaryIdx < resultIdx, 'summary precedes the result tag');
    ok(resultIdx < closingIdx, 'result tag precedes the closing task tag');
    ok(text.includes('Background task completed: foo'), 'summary text preserved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Body rendering
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSubAgentOutput — body content', () => {
  it('concatenates text parts inside the <task_result> body', () => {
    const text = synth([TEXT_PART('first'), TEXT_PART('second')]);
    ok(
      text.includes('<task_result>\nfirst\nsecond\n</task_result>'),
      'text parts joined by newlines',
    );
  });

  it('omits thinking parts by default (parent agent does not re-reason about sub-agent thinking)', () => {
    const text = synth([
      TEXT_PART('visible'),
      THINKING_PART('private reasoning that should not leak'),
    ]);
    ok(text.includes('visible'), 'text part present');
    ok(!text.includes('private reasoning'), 'thinking text omitted from output');
  });

  it('renders tool-use parts as compact <tool_use> tags', () => {
    const text = synth([TOOL_USE_PART('read_file', { filePath: '/a/b.ts' }, 'call_1')]);
    ok(text.includes('<tool_use name="read_file" id="call_1">'), 'tool-use tag with name + id');
    // JSON is XML-escaped inside the body — `&quot;` replaces `"`.
    ok(
      text.includes('&quot;filePath&quot;:&quot;/a/b.ts&quot;'),
      'input serialized as escaped JSON',
    );
    ok(text.includes('</tool_use>'), 'tool-use tag closed');
  });

  it('renders tool-result parts as compact <tool_result> tags', () => {
    const text = synth([TOOL_RESULT_PART('call_1', 'file contents here')]);
    ok(text.includes('<tool_result id="call_1">'), 'tool-result tag with id');
    ok(text.includes('file contents here'), 'tool-result text preserved');
    ok(text.includes('</tool_result>'), 'tool-result tag closed');
  });

  it('replaces data parts with a marker instead of dumping bytes', () => {
    const text = synth([DATA_PART('image/png', 4096)]);
    ok(text.includes('[data omitted: image/png, 4096 bytes]'), 'data marker present');
  });

  it('escapes XML special characters in text parts', () => {
    const text = synth([TEXT_PART('a < b && b > c')]);
    ok(text.includes('a &lt; b &amp;&amp; b &gt; c'), 'XML special chars escaped');
    ok(!text.includes('a < b'), 'raw < not present in body');
  });

  it('escapes XML special characters in tool-use and tool-result values', () => {
    const text = synth([
      TOOL_USE_PART('grep', { pattern: 'a<b' }, 'call_a'),
      TOOL_RESULT_PART('call_a', 'matched <tag>'),
    ]);
    ok(text.includes('a&lt;b'), 'tool-use input escaped');
    ok(text.includes('matched &lt;tag&gt;'), 'tool-result text escaped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncation
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSubAgentOutput — truncation', () => {
  it('does not truncate when the body fits within maxChars', () => {
    const text = synth([TEXT_PART('short body')], { maxChars: 100 });
    ok(text.includes('short body'), 'body present');
    ok(!text.includes('truncated'), 'no truncation marker');
  });

  it('truncates the body and appends a marker when maxChars is exceeded', () => {
    const longText = 'x'.repeat(500);
    const result = synthesizeSubAgentOutput([TEXT_PART(longText)], {
      sessionId: SESSION_ID,
      state: 'completed',
      maxChars: 50,
    });
    ok(result.text.includes('[...truncated'), 'truncation marker present');
    ok(!result.text.includes('x'.repeat(200)), 'long body cut off');
    strictEqual(result.truncated, true, 'truncated flag set');
  });

  it('truncation marker mentions the original length so the model knows what was dropped', () => {
    const longText = 'x'.repeat(200);
    const result = synthesizeSubAgentOutput([TEXT_PART(longText)], {
      sessionId: SESSION_ID,
      state: 'completed',
      maxChars: 20,
    });
    ok(/200/.test(result.text), 'truncation marker references the original length');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Defensive behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('synthesizeSubAgentOutput — defensive', () => {
  it('handles unknown part kinds gracefully (skips them, logs nothing)', () => {
    const text = synth([
      TEXT_PART('ok'),
      // Cast as SubAgentPart to simulate a future part kind that
      // the synthesizer doesn't know about. The synthesizer must
      // not throw — it must skip and keep going.
      { kind: 'unknown-future-kind', value: 'should be dropped' } as unknown as SubAgentPart,
    ]);
    ok(text.includes('ok'), 'known part kept');
    ok(!text.includes('should be dropped'), 'unknown part skipped');
  });

  it('handles tool-use with circular input JSON without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const text = synth([TOOL_USE_PART('circular', circular)]);
    ok(text.includes('<tool_use name="circular"'), 'tool-use tag emitted');
    ok(text.includes('[unserializable tool input'), 'circular input marker present');
  });

  it('handles a part missing required fields (no text/value) without throwing', () => {
    const text = synth([
      TEXT_PART('before'),
      { kind: 'text' } as unknown as SubAgentPart, // no value
      TEXT_PART('after'),
    ]);
    ok(text.includes('before'), 'first text part kept');
    ok(text.includes('after'), 'second text part kept');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inbound collapse (post-mapping)
// ─────────────────────────────────────────────────────────────────────────────

const toolCallPart = (callId: string, name: string): ChatMessageContentPart => ({
  type: 'tool-call',
  toolCall: { callId, name, input: {} },
});
const toolResultPart = (
  callId: string,
  content: ReadonlyArray<string>,
): ChatMessageContentPart => ({
  type: 'tool-result',
  toolResult: {
    callId,
    content: content as unknown as ReadonlyArray<unknown>,
  } satisfies ChatToolResultPart,
});
const textPart = (value: string): ChatMessageContentPart => ({ type: 'text', value });

describe('buildCallIdToToolNameMap', () => {
  it('collects callId → toolName from every assistant turn in order', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_a', 'runSubagent')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_a', ['hi'])],
      },
      {
        role: 'assistant',
        content: [toolCallPart('call_b', 'read_file'), toolCallPart('call_c', 'minimax_subagent')],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    strictEqual(map.size, 3, 'all three tool calls indexed');
    strictEqual(map.get('call_a'), 'runSubagent');
    strictEqual(map.get('call_b'), 'read_file');
    strictEqual(map.get('call_c'), 'minimax_subagent');
  });

  it('skips tool-call parts with empty callId (synthesized turns)', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('', 'synthesized')],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    strictEqual(map.size, 0, 'empty callId not indexed');
  });
});

describe('collapseSubAgentToolResultsInDomain', () => {
  it('collapses a runSubagent tool result into a single text content entry', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_sub', 'runSubagent')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_sub', ['first text', 'second text'])],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map);
    const userMsg = collapsed[1]!;
    const resultPart = userMsg.content.find((p) => p.type === 'tool-result');
    ok(resultPart !== undefined, 'tool-result part still present');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    strictEqual(resultPart.toolResult.content.length, 1, 'collapsed to a single content entry');
    const text = resultPart.toolResult.content[0] as string;
    ok(text.startsWith('<task id="call_sub" state="completed">'), 'wrapped in <task> envelope');
    ok(text.includes('first text'), 'first text chunk present in body');
    ok(text.includes('second text'), 'second text chunk present in body');
  });

  it('also collapses minimax_subagent tool results (our custom tool)', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_min', 'minimax_subagent')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_min', ['done'])],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map);
    const resultPart = collapsed[1]!.content.find((p) => p.type === 'tool-result');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    strictEqual(resultPart.toolResult.content.length, 1, 'collapsed to a single content entry');
  });

  it('does NOT collapse non-sub-agent tool results', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_r', 'read_file')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_r', ['line1', 'line2'])],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map);
    const resultPart = collapsed[1]!.content.find((p) => p.type === 'tool-result');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    strictEqual(resultPart.toolResult.content.length, 2, 'read_file result kept multi-part');
  });

  it('does NOT collapse tool results whose callId is not in the map', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'user',
        content: [toolResultPart('call_unknown', ['hi'])],
      },
    ];
    const collapsed = collapseSubAgentToolResultsInDomain(messages, new Map());
    const resultPart = collapsed[0]!.content.find((p) => p.type === 'tool-result');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    strictEqual(resultPart.toolResult.content.length, 1, 'single-entry tool result unchanged');
    strictEqual(resultPart.toolResult.content[0], 'hi', 'content unchanged');
  });

  it('returns the same message object reference when no collapse applies (cheap path)', () => {
    const messages: ReadonlyArray<ChatMessage> = [{ role: 'user', content: [textPart('hello')] }];
    const collapsed = collapseSubAgentToolResultsInDomain(messages, new Map());
    strictEqual(collapsed[0], messages[0], 'no-copy when nothing collapsed');
  });

  it('escapes XML special characters in the synthesized body', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_esc', 'runSubagent')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_esc', ['a < b && b > c'])],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map);
    const resultPart = collapsed[1]!.content.find((p) => p.type === 'tool-result');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    const text = resultPart.toolResult.content[0] as string;
    ok(text.includes('a &lt; b &amp;&amp; b &gt; c'), 'XML special chars escaped in body');
  });

  it('honors maxChars when set on the options bag', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_long', 'runSubagent')],
      },
      {
        role: 'user',
        content: [toolResultPart('call_long', ['x'.repeat(500)])],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map, { maxChars: 30 });
    const resultPart = collapsed[1]!.content.find((p) => p.type === 'tool-result');
    if (resultPart === undefined || resultPart.type !== 'tool-result') return;
    const text = resultPart.toolResult.content[0] as string;
    ok(text.includes('[...truncated'), 'truncation marker present');
  });

  it('preserves non-tool-result parts on the same message (text, image, tool-call)', () => {
    const messages: ReadonlyArray<ChatMessage> = [
      {
        role: 'assistant',
        content: [toolCallPart('call_sub', 'runSubagent')],
      },
      {
        role: 'user',
        content: [
          textPart('human note'),
          toolResultPart('call_sub', ['agent output 1', 'agent output 2']),
        ],
      },
    ];
    const map = buildCallIdToToolNameMap(messages);
    const collapsed = collapseSubAgentToolResultsInDomain(messages, map);
    const userMsg = collapsed[1]!;
    strictEqual(userMsg.content.length, 2, 'still two parts on the user message');
    const [first, second] = userMsg.content;
    strictEqual(first!.type, 'text', 'first part is text, unchanged');
    ok(second!.type === 'tool-result', 'second part is the collapsed tool result');
  });
});
