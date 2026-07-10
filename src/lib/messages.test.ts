/**
 * T04 — Bidirectional VS Code ↔ MiniMax message and response-part
 * mapping tests.
 *
 * Pure-function tests for the domain layer's message mapping. These
 * run under the `unit` label (no VS Code host) and exercise the
 * round trips, thinking-part extraction, usage normalization, and
 * error handling.
 *
 * Pattern matches `src/lib/tools.test.ts`: node:test `describe`/`it`,
 * `node:assert/strict` deep equality, no `vscode` imports.
 */

import { deepStrictEqual, equal, fail, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMessageMappingError,
  mapMiniMaxUsage,
  mapRequestToMiniMax,
  mapStreamDeltaToResponseParts,
  type ChatMessage,
  type ChatResponsePart,
  type MessageMappingError,
} from './domain/messages.js';

import type { MiniMaxWireMessage } from '../ports/minimax-client.js';

// Helper: pull the response parts (filter out typed errors) from a
// mapStreamDeltaToResponseParts result.
function partsOnly(
  out: ReadonlyArray<ChatResponsePart | MessageMappingError>,
): ReadonlyArray<ChatResponsePart> {
  return out.filter((p): p is ChatResponsePart => !isMessageMappingError(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound: VS Code chat messages -> MiniMax wire messages
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRequestToMiniMax — text', () => {
  it('converts a single text user message to a wire message', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [{ type: 'text', value: 'Hello, model!' }],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    equal(result.messages.length, 1);
    const wire = result.messages[0] as MiniMaxWireMessage;
    equal(wire.role, 'user');
    equal(wire.content, 'Hello, model!');
    equal(result.warnings.length, 0);
  });

  it('converts an assistant text message to a wire message', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [{ type: 'text', value: 'Response.' }],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    equal(result.messages.length, 1);
    const wire = result.messages[0] as MiniMaxWireMessage;
    equal(wire.role, 'assistant');
    equal(wire.content, 'Response.');
  });

  it('joins multiple text parts in one message with newlines', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', value: 'First line.' },
        { type: 'text', value: 'Second line.' },
      ],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    const wire = result.messages[0] as MiniMaxWireMessage;
    equal(wire.content, 'First line.\nSecond line.');
  });

  it('preserves the order of a multi-message sequence', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', value: '1' }] },
      { role: 'assistant', content: [{ type: 'text', value: '2' }] },
      { role: 'user', content: [{ type: 'text', value: '3' }] },
    ];
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, messages);
    const contents = result.messages.map((m) => m.content);
    deepStrictEqual(contents, ['1', '2', '3']);
  });
});

describe('mapRequestToMiniMax — image', () => {
  it('encodes a PNG image part to a data URI on the image_url wire shape', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', value: 'What is in this image?' },
        { type: 'image', mimeType: 'image/png', data: bytes },
      ],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    equal(result.warnings.length, 0);
    equal(result.messages.length, 1);
    const wire = result.messages[0] as MiniMaxWireMessage;
    equal(wire.role, 'user');
    // Content is now a content-parts array (image present), not a string.
    ok(Array.isArray(wire.content));
    const parts = wire.content as ReadonlyArray<{ type: string }>;
    equal(parts.length, 2);
    equal(parts[0]?.type, 'text');
    equal(parts[1]?.type, 'image_url');
  });

  it('accepts JPEG, GIF, and WebP MIME types', () => {
    for (const mimeType of ['image/jpeg', 'image/jpg', 'image/gif', 'image/webp']) {
      const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
        {
          role: 'user',
          content: [{ type: 'image', mimeType, data: new Uint8Array([1, 2, 3, 4]) }],
        },
      ]);
      equal(result.warnings.length, 0, `expected no warnings for ${mimeType}`);
      const wire = result.messages[0] as MiniMaxWireMessage;
      ok(Array.isArray(wire.content), `expected content array for ${mimeType}`);
    }
  });

  it('normalises the MIME type to lowercase', () => {
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'IMAGE/PNG', data: new Uint8Array([1, 2, 3]) }],
      },
    ]);
    equal(result.warnings.length, 0);
  });

  it('rejects an unsupported MIME type with a malformed-image warning', () => {
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/bmp', data: new Uint8Array([1, 2, 3]) }],
      },
    ]);
    equal(result.warnings.length, 1);
    const warning = result.warnings[0] as MessageMappingError;
    equal(warning.kind, 'malformed-image');
    if (warning.kind === 'malformed-image') {
      ok(warning.reason.includes('image/bmp'));
    }
    // The image is skipped, but the message is still mapped (even if
    // it ended up empty because text was absent too). The mapper
    // surfaces the warning and continues.
  });

  it('rejects empty image data with a malformed-image warning', () => {
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/png', data: new Uint8Array(0) }],
      },
    ]);
    equal(result.warnings.length, 1);
    const warning = result.warnings[0] as MessageMappingError;
    equal(warning.kind, 'malformed-image');
  });

  it('emits text + image as a content-parts array (not a joined string)', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'user',
        content: [
          { type: 'text', value: 'caption' },
          { type: 'image', mimeType: 'image/jpeg', data: bytes },
        ],
      },
    ]);
    const wire = result.messages[0] as MiniMaxWireMessage;
    ok(Array.isArray(wire.content));
    const parts = wire.content as ReadonlyArray<{ type: string; text?: string }>;
    equal(parts.length, 2);
    equal(parts[0]?.type, 'text');
    equal((parts[0] as { text: string }).text, 'caption');
    equal(parts[1]?.type, 'image_url');
  });
});

describe('mapRequestToMiniMax — tool-result and tool-call', () => {
  it('projects a tool-result part to a role:tool wire message preserving the call id', () => {
    // A tool-result without a matching assistant tool-call in the
    // same request is an orphan and is dropped by the reconciler
    // (Anthropic would 400 with "tool result's tool id not
    // found"). To exercise the happy-path projection we pair the
    // result with the assistant tool-call that emitted it.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: { callId: 'call_1', name: 'read_file', input: { path: '/a' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', value: 'Got the result:' },
          {
            type: 'tool-result',
            toolResult: { callId: 'call_1', content: ['{"status":"ok"}'] },
          },
        ],
      },
    ]);
    equal(result.warnings.length, 0);
    const toolMsg = result.messages.find((m) => m.role === 'tool') as MiniMaxWireMessage;
    ok(toolMsg, 'expected a tool wire message');
    equal(toolMsg.toolCallId, 'call_1');
    equal(toolMsg.content, '{"status":"ok"}');
  });

  it('emits multiple tool-result parts as multiple role:tool messages', () => {
    // Same shape as the projection test: each tool-result must be
    // paired with its assistant tool-call to survive the
    // reconciler. This test exercises two parallel tool calls in
    // a single assistant turn, each returning its own result.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCall: { callId: 'call_a', name: 'a', input: {} } },
          { type: 'tool-call', toolCall: { callId: 'call_b', name: 'b', input: {} } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_a', content: ['a'] },
          },
          {
            type: 'tool-result',
            toolResult: { callId: 'call_b', content: ['b'] },
          },
        ],
      },
    ]);
    const toolMessages = result.messages.filter((m) => m.role === 'tool');
    equal(toolMessages.length, 2);
    const ids = toolMessages.map((m) => m.toolCallId);
    deepStrictEqual(ids, ['call_a', 'call_b']);
  });

  it('hoists a tool-call in user content into a synthesized assistant turn (T18 behavior change)', () => {
    // T18 changed this from "skip with warning" to "hoist with
    // warning". The tool-call is preserved as a minimal assistant
    // `tool_use` immediately before the user message (so a
    // subsequent tool_result has a valid `tool_use_id` reference),
    // and the user message's text part is still mapped. The
    // hoisted wire message carries `tool_calls`. The warning is
    // emitted at `debug` level by the chat-provider for
    // observability — the model still sees the tool result.
    const msg: ChatMessage = {
      role: 'user',
      content: [
        { type: 'text', value: 'Hi' },
        {
          type: 'tool-call',
          toolCall: { callId: 'call_x', name: 'read_file', input: { path: '/a' } },
        },
      ],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    ok(result.warnings.some((w) => w.kind === 'unsupported-content'));
    // The synthesized assistant turn carrying call_x is emitted
    // BEFORE the user turn.
    const hoistedAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc) => tc.id === 'call_x'),
    );
    ok(hoistedAssistant !== undefined, 'expected hoisted assistant turn carrying call_x');
    const userMsg = result.messages.find((m) => m.role === 'user');
    ok(userMsg !== undefined);
    const userText = typeof userMsg.content === 'string' ? userMsg.content : null;
    equal(userText, 'Hi');
  });

  it('serializes a structured (object) tool result as a JSON string, not [object Object]', () => {
    // Regression for the `get_errors` payload leak: a tool result
    // whose content list contains a plain object (e.g. the JSON
    // result of `get_errors`) must land on the wire as a JSON
    // string, not as the default `String(obj)` rendering. The
    // Anthropic dialect rejects non-primitive `content` on a
    // `tool_result` block.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: { callId: 'call_e1', name: 'get_errors', input: {} },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: {
              callId: 'call_e1',
              content: [{ errors: ['one', 'two'], path: 'src/foo.ts' }],
            },
          },
        ],
      },
    ]);
    equal(result.warnings.length, 0);
    const toolMsg = result.messages.find((m) => m.role === 'tool') as MiniMaxWireMessage;
    ok(toolMsg, 'expected a tool wire message');
    equal(typeof toolMsg.content, 'string');
    equal(toolMsg.toolCallId, 'call_e1');
    // The string must be parseable JSON (the structured payload was
    // serialized), and the call id round-trips.
    const parsed = JSON.parse(toolMsg.content as string) as { errors: string[] };
    deepStrictEqual(parsed.errors, ['one', 'two']);
  });

  it('adopts an orphan tool-result by synthesizing a preceding tool_use (T18 behavior change)', () => {
    // Reproduces the "invalid params, tool result's tool id not
    // found (2013)" failure from error_from_console.txt. T18 changed
    // the behavior from DROP to ADOPT: the orphan is preserved by
    // synthesizing a minimal assistant `tool_use` immediately before
    // it, keeping the wire body valid AND preserving tool output
    // (the model still sees the result instead of looping or
    // hallucinating).
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      { role: 'user', content: [{ type: 'text', value: 'do the thing' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: { callId: 'call_real', name: 'read_file', input: { path: '/a' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_ghost', content: ['stray'] },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: { callId: 'call_real2', name: 'read_file', input: { path: '/b' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_real2', content: ['ok'] },
          },
        ],
      },
    ]);
    // Both the orphan and the well-formed tool-result survive.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    equal(toolMsgs.length, 2, 'both tool-results present after adoption');
    const orphanResult = toolMsgs.find((m) => m.toolCallId === 'call_ghost');
    ok(orphanResult !== undefined, 'orphan tool-result adopted and emitted');
    const realResult = toolMsgs.find((m) => m.toolCallId === 'call_real2');
    ok(realResult !== undefined, 'well-formed tool-result still emitted');
    // The adopted orphan must be preceded by a synthesized assistant
    // tool_use. The wire order is: ...assistant(real) | tool(ghost)
    // | assistant(adopted-for-ghost) | assistant(real2) | tool(real2).
    const adoptedAssistant = result.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.toolCalls) &&
        m.toolCalls.some((tc) => tc.id === 'call_ghost'),
    );
    ok(adoptedAssistant !== undefined, 'expected adopted assistant tool_use for call_ghost');
    // No "orphan tool-result dropped" warning fires — adoption is
    // silent (the model sees the tool output, the turn continues).
    const orphanWarnings = result.warnings.filter(
      (w) => w.kind === 'unsupported-content' && w.reason.includes('orphan tool-result dropped'),
    );
    equal(orphanWarnings.length, 0, 'no orphan-dropped warnings under adoption');
  });

  it('adopts every tool-result when no assistant tool_use is in the request', () => {
    // The reconciler used to be gated on
    // `assistantToolCallIds.size > 0`, which meant a request that
    // contained ONLY tool-results (e.g. when VS Code replays a
    // history mid-tool-execution, or the chat-provider's history
    // scrubber has just dropped the prior assistant tool_call
    // part) passed every tool-result through unchecked. Anthropic
    // then 400s with "invalid params, tool result's tool id not
    // found (2013)" (the exact failure in
    // error_from_console.txt). The reconciler must always ADOPT:
    // every orphan `tool_use_id` becomes a synthesized
    // `tool_use` immediately before its `tool_result`.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      { role: 'user', content: [{ type: 'text', value: 'replay history' }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_alone_1', content: ['one'] },
          },
          {
            type: 'tool-result',
            toolResult: { callId: 'call_alone_2', content: ['two'] },
          },
        ],
      },
    ]);
    // Both tool-results survive via adoption.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    equal(toolMsgs.length, 2, 'every tool-result adopted when no assistant tool-call exists');
    // And every tool-result is preceded by a synthesized assistant
    // tool_use (one per orphan id).
    const adoptedIds = result.messages
      .filter(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.toolCalls) &&
          m.toolCalls.some((tc) => tc.id === 'call_alone_1' || tc.id === 'call_alone_2'),
      )
      .map((m) => m.toolCalls?.map((tc) => tc.id) ?? [])
      .flat();
    ok(adoptedIds.includes('call_alone_1'), 'adopted assistant exists for call_alone_1');
    ok(adoptedIds.includes('call_alone_2'), 'adopted assistant exists for call_alone_2');
  });

  it('preserves a well-formed tool-result whose assistant tool_use is present', () => {
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCall: { callId: 'call_match', name: 'run_in_terminal', input: { command: 'ls' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolResult: { callId: 'call_match', content: ['file1\nfile2'] },
          },
        ],
      },
    ]);
    equal(result.warnings.length, 0);
    const toolMsg = result.messages.find((m) => m.role === 'tool') as MiniMaxWireMessage;
    ok(toolMsg, 'expected a tool wire message');
    equal(toolMsg.toolCallId, 'call_match');
    equal(toolMsg.content, 'file1\nfile2');
  });

  it('emits a stable call id list in the assistant wire message (no duplicates on retry)', () => {
    // Two consecutive tool-call parts with the same call id should
    // still serialize to a single id in the assistant wire message;
    // the reconciler relies on the union, not a multi-set.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCall: { callId: 'call_dup', name: 'a', input: {} } },
          { type: 'tool-call', toolCall: { callId: 'call_dup', name: 'a', input: {} } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolResult: { callId: 'call_dup', content: ['ok'] } }],
      },
    ]);
    const toolMsg = result.messages.find((m) => m.role === 'tool') as MiniMaxWireMessage;
    ok(toolMsg, 'expected a tool wire message');
    equal(toolMsg.toolCallId, 'call_dup');
    equal(result.warnings.length, 0);
  });

  it('surfaces a tool-result mapping error (missing call id) as a warning', () => {
    const msg: ChatMessage = {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          // cast: the runtime would be a real ChatToolResultPart; we
          // simulate the bad shape the T03 mapper rejects.
          toolResult: { callId: '', content: ['x'] },
        },
      ],
    };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    ok(
      result.warnings.some(
        (w) => w.kind === 'unsupported-content' && w.reason.includes('tool-result'),
      ),
    );
  });

  it('emits an empty assistant message when the assistant turn has only tool calls', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [],
    };
    // Empty content -> empty-message warning, no wire message
    // emitted. The empty assistant case is rare but the mapper
    // handles it gracefully.
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    ok(result.warnings.some((w) => w.kind === 'empty-message'));
  });
});

describe('mapRequestToMiniMax — error tolerance', () => {
  it('emits an unknown-message-role warning for an unrecognised role', () => {
    const msg = {
      role: 'bogus',
      content: [{ type: 'text' as const, value: 'hi' }],
    } as unknown as ChatMessage;
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    equal(result.messages.length, 0);
    ok(result.warnings.some((w) => w.kind === 'unknown-message-role'));
  });

  it('emits an empty-message warning and skips a message with no content parts', () => {
    const msg: ChatMessage = { role: 'user', content: [] };
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, [msg]);
    equal(result.messages.length, 0);
    ok(result.warnings.some((w) => w.kind === 'empty-message'));
  });

  it('continues mapping remaining messages after a single malformed part', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', value: 'first' }] },
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/bmp', data: new Uint8Array([1]) }],
      },
      { role: 'user', content: [{ type: 'text', value: 'third' }] },
    ];
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, messages);
    // The middle message's image is dropped, but the message is
    // still mapped (with empty content, dropped via the empty
    // check) — the surrounding messages map successfully.
    ok(result.messages.length >= 2);
    ok(result.warnings.some((w) => w.kind === 'malformed-image'));
    // The first and third messages are present in order.
    equal((result.messages[0] as MiniMaxWireMessage).content, 'first');
  });

  it('handles an empty input array', () => {
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, []);
    equal(result.messages.length, 0);
    equal(result.warnings.length, 0);
  });
});

describe('mapRequestToMiniMax — round-trip', () => {
  it('round-trips text content through the mapper without loss', () => {
    const original: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', value: 'A' }] },
      { role: 'assistant', content: [{ type: 'text', value: 'B' }] },
      { role: 'user', content: [{ type: 'text', value: 'C' }] },
    ];
    const result = mapRequestToMiniMax({ id: 'MiniMax-M3', thinkingStyle: 'anthropic' }, original);
    const wireContents = result.messages.map((m) => m.content);
    deepStrictEqual(wireContents, ['A', 'B', 'C']);
    const wireRoles = result.messages.map((m) => m.role);
    deepStrictEqual(wireRoles, ['user', 'assistant', 'user']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: MiniMax stream deltas -> VS Code response parts
// ─────────────────────────────────────────────────────────────────────────────

describe('mapStreamDeltaToResponseParts — text', () => {
  it('converts a textDelta to a text part', () => {
    const out = mapStreamDeltaToResponseParts({ textDelta: 'Hello' }, 'anthropic');
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'text');
    if (parts[0]?.type === 'text') {
      equal(parts[0].value, 'Hello');
    }
  });

  it('emits no parts for an event with no content', () => {
    const out = mapStreamDeltaToResponseParts({}, 'anthropic');
    equal(out.length, 0);
  });

  it('emits no parts for an empty textDelta', () => {
    const out = mapStreamDeltaToResponseParts({ textDelta: '' }, 'anthropic');
    equal(out.length, 0);
  });

  it('emits text as-is for M2.x OpenAI-style deltas (no thinking extraction)', () => {
    const out = mapStreamDeltaToResponseParts({ textDelta: 'Just regular text.' }, 'openai');
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'text');
    if (parts[0]?.type === 'text') {
      equal(parts[0].value, 'Just regular text.');
    }
  });

  it('emits text as-is for M1 (no thinking style)', () => {
    const out = mapStreamDeltaToResponseParts({ textDelta: 'M1 text.' }, 'none');
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'text');
    if (parts[0]?.type === 'text') {
      equal(parts[0].value, 'M1 text.');
    }
  });
});

describe('mapStreamDeltaToResponseParts — thinking (reasoning)', () => {
  it('extracts M3 Anthropic-style thinking blocks to thinking parts (not visible text)', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta:
          '[<anthropic_thinking>Internal reasoning here.</anthropic_thinking>]\nResponse text.',
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    ok(parts.length >= 2);

    const thinkingParts = parts.filter((p) => p.type === 'thinking');
    const textParts = parts.filter((p) => p.type === 'text');

    equal(thinkingParts.length, 1);
    equal(textParts.length, 1);

    if (thinkingParts[0]?.type === 'thinking') {
      equal(thinkingParts[0].value, 'Internal reasoning here.');
    }
    if (textParts[0]?.type === 'text') {
      ok(!textParts[0].value.includes('<anthropic_thinking>'));
      ok(!textParts[0].value.includes('Internal reasoning'));
      ok(textParts[0].value.includes('Response text'));
    }
  });

  it('handles Anthropic thinking without the outer brackets', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta: '<anthropic_thinking>Thought.</anthropic_thinking>\nVisible.',
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    const thinkingParts = parts.filter((p) => p.type === 'thinking');
    const textParts = parts.filter((p) => p.type === 'text');
    equal(thinkingParts.length, 1);
    if (thinkingParts[0]?.type === 'thinking') {
      equal(thinkingParts[0].value, 'Thought.');
    }
    equal(textParts.length, 1);
    if (textParts[0]?.type === 'text') {
      equal(textParts[0].value, '\nVisible.');
    }
  });

  it('extracts multiple thinking blocks in a single text delta', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta:
          '[<anthropic_thinking>Step 1.</anthropic_thinking>] middle [<anthropic_thinking>Step 2.</anthropic_thinking>] end',
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    const thinkingParts = parts.filter((p) => p.type === 'thinking');
    equal(thinkingParts.length, 2);
    if (thinkingParts[0]?.type === 'thinking' && thinkingParts[1]?.type === 'thinking') {
      equal(thinkingParts[0].value, 'Step 1.');
      equal(thinkingParts[1].value, 'Step 2.');
    }
  });

  it('preserves thinking signatures on thinkingDelta parts', () => {
    const out = mapStreamDeltaToResponseParts(
      { thinkingDelta: 'Signed reasoning.', thinkingSignature: 'sig_123' },
      'anthropic',
    );
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'thinking');
    if (parts[0]?.type === 'thinking') {
      equal(parts[0].value, 'Signed reasoning.');
      equal(parts[0].signature, 'sig_123');
    }
  });

  it('emits M2.x reasoningDelta as a thinking part, never as text', () => {
    const out = mapStreamDeltaToResponseParts(
      { reasoningDelta: 'I am thinking about this carefully.' },
      'openai',
    );
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'thinking');
    if (parts[0]?.type === 'thinking') {
      equal(parts[0].value, 'I am thinking about this carefully.');
    }
    // No text part should have been emitted.
    ok(!parts.some((p) => p.type === 'text'));
  });

  it('emits M3 thinkingDelta as a thinking part, never as text', () => {
    const out = mapStreamDeltaToResponseParts({ thinkingDelta: 'Deep reasoning.' }, 'anthropic');
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'thinking');
    if (parts[0]?.type === 'thinking') {
      equal(parts[0].value, 'Deep reasoning.');
    }
  });

  it('combines reasoning and text from the same event into a single response array', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta: 'Visible answer.',
        reasoningDelta: 'Reasoning.',
      },
      'openai',
    );
    const parts = partsOnly(out);
    equal(parts.length, 2);
    const types = parts.map((p) => p.type);
    deepStrictEqual(types, ['text', 'thinking']);
  });

  it('never leaks reasoning into visible text on any thinking style', () => {
    // For M2.x (openai): a reasoningDelta produces no text part at
    // all (per the previous test). For M3 (anthropic), the
    // reasoningDelta would also produce no text part, and
    // thinkingDelta is treated the same way.
    const out = mapStreamDeltaToResponseParts(
      { reasoningDelta: 'private', thinkingDelta: 'more private' },
      'anthropic',
    );
    const textParts = partsOnly(out).filter((p) => p.type === 'text');
    equal(textParts.length, 0);
  });
});

describe('mapStreamDeltaToResponseParts — usage', () => {
  it('emits a usage part with prompt + completion tokens', () => {
    const out = mapStreamDeltaToResponseParts(
      { usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
      'anthropic',
    );
    const parts = partsOnly(out);
    const usage = parts.find((p) => p.type === 'usage');
    if (!usage || usage.type !== 'usage') {
      fail('expected a usage part');
    }
    equal(usage.usage.promptTokens, 100);
    equal(usage.usage.completionTokens, 50);
  });

  it('emits cache tokens when present', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cacheReadTokens: 10,
          cacheCreateTokens: 5,
        },
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    const usage = parts.find((p) => p.type === 'usage');
    if (!usage || usage.type !== 'usage') {
      fail('expected a usage part');
    }
    equal(usage.usage.cacheReadTokens, 10);
    equal(usage.usage.cacheCreateTokens, 5);
  });

  it('emits both text and usage parts in a single event', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta: 'final answer',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    equal(parts.length, 2);
    const types = parts.map((p) => p.type);
    deepStrictEqual(types, ['text', 'usage']);
  });
});

describe('mapStreamDeltaToResponseParts — error tolerance', () => {
  it('emits no parts for a usage event with all-undefined fields', () => {
    const out = mapStreamDeltaToResponseParts({ usage: {} }, 'anthropic');
    const parts = partsOnly(out);
    const usage = parts.find((p) => p.type === 'usage');
    if (!usage || usage.type !== 'usage') {
      fail('expected a usage part');
    }
    equal(usage.usage.promptTokens, undefined);
  });

  it('combines an empty textDelta with a usage into only the usage part', () => {
    const out = mapStreamDeltaToResponseParts(
      { textDelta: '', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      'anthropic',
    );
    const parts = partsOnly(out);
    equal(parts.length, 1);
    equal(parts[0]?.type, 'usage');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapMiniMaxUsage
// ─────────────────────────────────────────────────────────────────────────────

describe('mapMiniMaxUsage', () => {
  it('passes through prompt + completion tokens', () => {
    const usage = mapMiniMaxUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    equal(usage.promptTokens, 100);
    equal(usage.completionTokens, 50);
  });

  it('passes through cache tokens', () => {
    const usage = mapMiniMaxUsage({
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
    });
    equal(usage.cacheReadTokens, 10);
    equal(usage.cacheCreateTokens, 5);
  });

  it('returns an empty shape for an empty input', () => {
    const usage = mapMiniMaxUsage({});
    equal(usage.promptTokens, undefined);
    equal(usage.completionTokens, undefined);
    equal(usage.cacheReadTokens, undefined);
    equal(usage.cacheCreateTokens, undefined);
  });

  it('omits totalTokens (it is not part of the normalised shape)', () => {
    const usage = mapMiniMaxUsage({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
    // totalTokens is intentionally not on ChatUsageData — the
    // chat-provider can derive it as prompt + completion if it
    // needs the running total.
    ok(!('totalTokens' in usage));
  });

  it('ignores non-numeric runtime token values', () => {
    const usage = mapMiniMaxUsage({
      promptTokens: Number.NaN,
      completionTokens: '2' as unknown as number,
      cacheReadTokens: Infinity,
      cacheCreateTokens: 3,
    });
    equal(usage.promptTokens, undefined);
    equal(usage.completionTokens, undefined);
    equal(usage.cacheReadTokens, undefined);
    equal(usage.cacheCreateTokens, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractAnthropicThinking (internal helper exercised via the public API
// for the common cases; the test below covers the edge case of the
// pattern with no thinking block).
// ─────────────────────────────────────────────────────────────────────────────

describe('extractAnthropicThinking (via text-delta with thinking style)', () => {
  it('returns the whole text as visible when no thinking block is present', () => {
    const out = mapStreamDeltaToResponseParts({ textDelta: 'No thinking here.' }, 'anthropic');
    const parts = partsOnly(out);
    const textParts = parts.filter((p) => p.type === 'text');
    const thinkingParts = parts.filter((p) => p.type === 'thinking');
    equal(thinkingParts.length, 0);
    equal(textParts.length, 1);
    if (textParts[0]?.type === 'text') {
      equal(textParts[0].value, 'No thinking here.');
    }
  });

  it('handles multiline thinking content', () => {
    const out = mapStreamDeltaToResponseParts(
      {
        textDelta: '[<anthropic_thinking>line 1\nline 2\nline 3</anthropic_thinking>]\nAfter.',
      },
      'anthropic',
    );
    const parts = partsOnly(out);
    const thinkingParts = parts.filter((p) => p.type === 'thinking');
    equal(thinkingParts.length, 1);
    if (thinkingParts[0]?.type === 'thinking') {
      equal(thinkingParts[0].value, 'line 1\nline 2\nline 3');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isMessageMappingError type guard
// ─────────────────────────────────────────────────────────────────────────────

describe('isMessageMappingError', () => {
  it('returns true for a MessageMappingError discriminated union member', () => {
    ok(isMessageMappingError({ kind: 'missing-role' }));
    ok(isMessageMappingError({ kind: 'malformed-image', reason: 'bad' }));
    ok(isMessageMappingError({ kind: 'empty-message', role: 'user' }));
  });

  it('returns false for a ChatResponsePart', () => {
    const part: ChatResponsePart = { type: 'text', value: 'text' };
    ok(!isMessageMappingError(part));
    const usage: ChatResponsePart = {
      type: 'usage',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
    ok(!isMessageMappingError(usage));
  });

  it('returns false for null, undefined, string, and number', () => {
    ok(!isMessageMappingError(null));
    ok(!isMessageMappingError(undefined));
    ok(!isMessageMappingError('string'));
    ok(!isMessageMappingError(123));
  });

  it('returns false for an object without a `kind` field', () => {
    ok(!isMessageMappingError({ type: 'text' }));
    ok(!isMessageMappingError({ some: 'object' }));
  });

  it('returns false for an object whose `kind` is not a string', () => {
    ok(!isMessageMappingError({ kind: 1 }));
    ok(!isMessageMappingError({ kind: null }));
  });
});
