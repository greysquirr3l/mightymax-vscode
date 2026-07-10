/**
 * T18 — Tool-call ID fidelity across turns (MiniMax error 2013).
 *
 * These tests reproduce the four failure modes from the live console:
 *  1. Orphan tool results (tool_call id present in tool-result but
 *     missing from the immediately-prior assistant turn) → adopt.
 *  2. Tool-call parts arriving in a user-role message → hoist.
 *  3. IDs round-trip byte-identical regardless of Unicode/_-/etc.
 *  4. Empty-text assistant messages carrying toolCalls survive both
 *     serializers (otherwise the next tool_result orphans).
 *
 * Migration status: T18 was originally "delete-and-warning"; it is now
 * "adopt-and-hoist". Each test below pins one of the spec requirements
 * against `mapRequestToMiniMax`. Integration coverage lives in the
 * `agent-harness` and `tool-parity` test suites.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert/strict';

import { mapRequestToMiniMax, type ChatMessage } from './domain/messages.js';

const MODEL = { id: 'MiniMax-M3', thinkingStyle: 'anthropic' as const };

/**
 * Narrow a wire message into the shape tests inspect: the
 * discriminated union types in `MiniMaxWireMessage` are wide; the
 * adapter tests cast through `unknown` to a narrow shape that
 * matches the property used in each assertion.
 */
type NarrowedWire = ReadonlyArray<{
  role: string;
  content?: unknown;
  toolCalls?: ReadonlyArray<{
    id: string;
    name?: string;
    arguments?: string;
    function?: { name: string; arguments: string };
  }>;
  toolCallId?: string;
}>;
const asWire = (msgs: ReadonlyArray<unknown>): NarrowedWire =>
  msgs as unknown as NarrowedWire;

describe('T18 — orphan tool-result adoption', () => {
  it('synthesizes a minimal assistant tool_use when no prior assistant carried the id', () => {
    // Reproduces the production failure: a user-role tool-result
    // whose `callId` does not match any assistant `tool_call` id
    // earlier in the conversation. T18's spec requires ADOPTION,
    // not deletion — the wire body must contain a tool_use with
    // the matching id immediately before the tool-result so the
    // upstream API sees a valid tool_use_id reference.
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', value: 'let me look that up' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: {
              callId: 'call_orphan_123',
              content: ['{"temp":72,"unit":"F"}'],
            },
          },
        ],
      },
    ];
    const result = mapRequestToMiniMax(MODEL, messages);
    const wireMessages = asWire(result.messages as unknown[]);
    const assistantIdx = wireMessages.findIndex(
      (m) =>
        m.role === 'assistant' &&
        (m.toolCalls ?? []).some((tc) => tc.id === 'call_orphan_123'),
    );
    ok(assistantIdx >= 0, 'expected adopted assistant turn in wire list');
    const toolMsg = wireMessages[assistantIdx + 1];
    ok(
      toolMsg !== undefined && toolMsg.role === 'tool' && toolMsg.toolCallId === 'call_orphan_123',
      `expected tool-result immediately after adopted assistant with id call_orphan_123, got ${JSON.stringify(toolMsg)}`,
    );
  });

  it('does NOT emit an orphan-dropped warning when adoption succeeds', () => {
    // The T18 spec calls for ADOPTION, not deletion. The previous
    // behavior emitted `unsupported-content` warnings for every
    // dropped orphan; adoption should be silent (tool output is
    // preserved, the turn continues, no warning noise).
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', value: 'on it' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: {
              callId: 'call_orphan_quiet',
              content: ['ok'],
            },
          },
        ],
      },
    ];
    const result = mapRequestToMiniMax(MODEL, messages);
    const hasDropWarn = result.warnings.some(
      (w) => w.kind === 'unsupported-content' && w.reason.includes('orphan tool-result dropped'),
    );
    notStrictEqual(hasDropWarn, true, 'expected no orphan-dropped warning after adoption');
  });
});

describe('T18 — tool-call part hoist from user role', () => {
  it('hoists a tool-call part found in a user-role message into a synthesized assistant turn', () => {
    // VS Code can present a tool-call part inside a user-role
    // message (history scrubbing can shuffle content). The T18 spec
    // requires HOISTING: synthesize an assistant turn carrying the
    // tool_use IMMEDIATELY before the user message, so a paired
    // tool_result on the next user turn has a valid `tool_use_id`
    // reference.
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', value: 'first user turn' },
          {
            type: 'tool-call',
            toolCall: {
              callId: 'call_user_roled_99',
              name: 'echo',
              input: { hello: 'world' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: {
              callId: 'call_user_roled_99',
              content: ['done'],
            },
          },
        ],
      },
    ];
    const result = mapRequestToMiniMax(MODEL, messages);
    const wireMessages = asWire(result.messages as unknown[]);
    const hoisted = wireMessages.find(
      (m) =>
        m.role === 'assistant' &&
        (m.toolCalls ?? []).some((tc) => tc.id === 'call_user_roled_99'),
    );
    ok(hoisted !== undefined, 'expected hoisted assistant carrying call_user_roled_99');
  });

  it('preserves the tool name when hoisting (never substitutes unknown_tool)', () => {
    // The spec: "Recover the name from the tool-result part when VS
    // Code provides it." Here, the tool-call part itself carries
    // the name; the hoisted assistant must retain the original
    // function name.
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool-call',
            toolCall: {
              callId: 'call_named_42',
              name: 'lookup_zipcode',
              input: { zip: '94110' },
            },
          },
        ],
      },
    ];
    const result = mapRequestToMiniMax(MODEL, messages);
    const wireMessages = asWire(result.messages as unknown[]);
    const hoisted = wireMessages.find(
      (m) =>
        m.role === 'assistant' &&
        (m.toolCalls ?? []).some((tc) => tc.id === 'call_named_42'),
    );
    ok(hoisted !== undefined);
    const tc = (hoisted?.toolCalls ?? []).find((t) => t.id === 'call_named_42');
    // The wire `toolCalls` shape is `{id, type, function:{name,...}}`,
    // not `{id, name, arguments}`. We accept either shape (the
    // adapter may project to either at test boundaries).
    const tcName = tc?.name ?? tc?.function?.name;
    strictEqual(tcName, 'lookup_zipcode');
  });
});

describe('T18 — ID round-trip (byte-identical)', () => {
  // Property-style: a battery of opaque, special-character, and
  // unicode ids must survive every hop byte-identical. The test
  // asserts on the id that lands in `wireMessages[*].toolCalls[*].id`
  // (or the corresponding Anthropic `tool_use.id`).
  const cases: ReadonlyArray<{ id: string; hint: string }> = [
    { id: 'call_function_sdx5mhd9w4lr_1', hint: 'production-shaped MiniMax id' },
    { id: 'abc-123_XYZ.99', hint: 'punctuation mix' },
    { id: 'αβγ_δεζ', hint: 'greek letters' },
    { id: '你好_世界', hint: 'CJK' },
    { id: '🚀_call', hint: 'emoji' },
    { id: 'a'.repeat(255), hint: '255 char id' },
    { id: 'a_b_c', hint: 'underscores only' },
  ];

  for (const { id, hint } of cases) {
    it(`preserves id "${id}" byte-identical (${hint})`, () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCall: {
                callId: id,
                name: 'noop',
                input: {},
              },
            },
          ],
        },
      ];
      const result = mapRequestToMiniMax(MODEL, messages);
      const wireMessages = asWire(result.messages as unknown[]);
      const allToolCalls: Array<{ id: string }> = [];
      for (const m of wireMessages) {
        const toolCalls = m.toolCalls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            allToolCalls.push(tc as { id: string });
          }
        }
      }
      const tc = allToolCalls.find((t) => t.id === id);
      ok(tc !== undefined, `expected id ${id} to survive in tool_calls`);
      strictEqual(
        tc?.id,
        id,
        `id drifted during mapping: expected "${id}", got "${tc?.id}"`,
      );
    });
  }
});

describe('T18 — empty-text assistant with toolCalls survives the mapper', () => {
  it('emits an assistant wire message carrying toolCalls even when text is empty', () => {
    // The T18 spec calls out: "Assistant messages that carry
    // `toolCalls` must NEVER be elided, even if their text content
    // is empty." The mapper must produce a wire message so the
    // next tool_result has a valid `tool_use_id` reference.
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: {
              callId: 'call_no_text',
              name: 'noop',
              input: {},
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_no_text', content: ['ok'] },
          },
        ],
      },
    ];
    const result = mapRequestToMiniMax(MODEL, messages);
    const wireMessages = asWire(result.messages as unknown[]);
    const assistantIdx = wireMessages.findIndex(
      (m) =>
        m.role === 'assistant' &&
        (m.toolCalls ?? []).some((tc) => tc.id === 'call_no_text'),
    );
    ok(assistantIdx >= 0, 'expected assistant turn carrying call_no_text');
    // The next wire message after the assistant MUST be the
    // tool-result carrying the matching id — this is the ordering
    // invariant required by the Anthropic wire.
    const toolMsg = wireMessages[assistantIdx + 1];
    ok(
      toolMsg !== undefined && toolMsg.role === 'tool' && toolMsg.toolCallId === 'call_no_text',
      'expected tool_result immediately after the empty-text assistant turn',
    );
  });
});
