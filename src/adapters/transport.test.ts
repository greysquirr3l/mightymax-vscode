/**
 * T05 — Streaming MiniMax API client.
 *
 * The transport adapter speaks both OpenAI- and Anthropic-compatible
 * SSE dialects against platform.minimax.io. These tests stand up an
 * in-process `http.createServer()` that emits hand-crafted SSE
 * sequences (text, tool-call deltas, parallel tool calls, usage
 * blocks, 429 responses) and assert the client yields the right
 * `MiniMaxStreamEvent` shape.
 *
 * Test layout:
 *   1. SSE wire format parser (chunk boundaries, multi-line data).
 *   2. OpenAI dialect — text, tool-call, usage, finish.
 *   3. Parallel tool calls — distinct ids surface in order.
 *   4. Anthropic dialect — thinking blocks → thinkingDelta.
 *   5. OpenAI dialect — reasoning_content → reasoningDelta.
 *   6. 429 — bounded backoff → typed MiniMaxClientError('rate-limit').
 *   7. Cancellation — AbortSignal aborts the in-flight stream.
 *   8. Secret redaction — the API key never appears in logger output.
 *   9. Endpoint routing — M3 → Anthropic, M2 → OpenAI.
 *
 * The mock server lives in this file (not a separate fixture) so
 * each test can construct exactly the SSE sequence it needs. The
 * server is closed in a `finally` block to avoid leaking ports.
 */

import { deepStrictEqual, fail, ok, rejects, strictEqual } from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MiniMaxClientAdapter } from './transport.js';
import type { Logger } from '../ports/logger.js';
import {
  MiniMaxClientError,
  type MiniMaxCompletionRequest,
  type MiniMaxStreamEvent,
} from '../ports/minimax-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock SSE server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A request handler that emits an SSE body. The body is a list of
 * `{ event?, data, id? }` records, serialized per the SSE spec:
 *
 *   event: foo\n
 *   data: line1\n
 *   data: line2\n
 *   \n
 *
 * The trailing blank line terminates a record. Multiple records
 * chained together form a stream; the handler is responsible for
 * ending the response when done.
 */
type SseRecord = { event?: string; data: string; id?: string };

function serializeSse(records: ReadonlyArray<SseRecord>): string {
  const parts: string[] = [];
  for (const record of records) {
    if (record.id !== undefined) parts.push(`id: ${record.id}`);
    if (record.event !== undefined) parts.push(`event: ${record.event}`);
    // Per spec, data lines are split on newlines and prefixed individually.
    for (const line of record.data.split('\n')) {
      parts.push(`data: ${line}`);
    }
    parts.push(''); // blank line terminator
  }
  return parts.join('\n');
}

interface MockServerHandle {
  url: string;
  /** Most recent request path the server received. */
  readonly lastPath: () => string;
  /** Most recent request body the server received. */
  readonly lastBody: () => string;
  /** Most recent Authorization header the server received (raw, NEVER log this). */
  readonly lastAuthHeader: () => string | undefined;
  /** Most recent Content-Type the server received. */
  readonly lastContentType: () => string | undefined;
  /** Stop the server. */
  readonly close: () => Promise<void>;
}

/**
 * Start a mock SSE server with the given handler. The handler
 * receives the request and a response it must close (or keep open
 * for streaming).
 */
async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
): Promise<MockServerHandle> {
  let lastPath = '';
  let lastBody = '';
  let lastAuthHeader: string | undefined;
  let lastContentType: string | undefined;

  const server: Server = createServer((req, res) => {
    lastPath = req.url ?? '';
    lastAuthHeader = req.headers.authorization;
    lastContentType = req.headers['content-type'];

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      try {
        // The handler may be sync or async; swallow rejected promises
        // here and surface them as 500 responses instead of crashing
        // the test process. The handler is responsible for calling
        // `res.end()` itself; we only catch *unexpected* failures.
        void Promise.resolve(handler(req, res, lastBody)).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain' });
          }
          res.end(`mock server error: ${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        // Surface the error to the client rather than crashing the test.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
        }
        res.end(`mock server error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    lastPath: () => lastPath,
    lastBody: () => lastBody,
    lastAuthHeader: () => lastAuthHeader,
    lastContentType: () => lastContentType,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger fixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Logger that records every call. Tests assert that the API key
 * never appears in any of the captured payloads.
 */
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
  const record = (entry: (typeof calls)[number]): void => {
    calls.push(entry);
  };
  return {
    get calls() {
      return calls;
    },
    debug(message, context) {
      record({ level: 'debug', message, ...(context !== undefined && { context }) });
    },
    info(message, context) {
      record({ level: 'info', message, ...(context !== undefined && { context }) });
    },
    warn(message, context) {
      record({ level: 'warn', message, ...(context !== undefined && { context }) });
    },
    error(message, error, context) {
      const entry: (typeof calls)[number] = { level: 'error', message };
      if (error !== undefined) entry.error = error;
      if (context !== undefined) entry.context = context;
      record(entry);
    },
  };
}

/** Stringify a call for the redaction assertion. */
function stringifyCall(call: ReturnType<typeof makeRecordingLogger>['calls'][number]): string {
  const parts = [call.message];
  if (call.context) parts.push(JSON.stringify(call.context));
  if (call.error !== undefined) {
    if (call.error instanceof Error) {
      parts.push(call.error.message, call.error.stack ?? '');
    } else {
      parts.push(String(call.error));
    }
  }
  return parts.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Client fixture
// ─────────────────────────────────────────────────────────────────────────────

const TEST_API_KEY = 'sk-test-MiniMax-DO-NOT-LOG-1234567890';

function makeClient(baseUrl: () => string): MiniMaxClientAdapter {
  return new MiniMaxClientAdapter({
    baseUrl,
    maxRetries: 2,
    initialBackoffMs: 1,
    maxBackoffMs: 5,
  });
}

const defaultRequest: MiniMaxCompletionRequest = {
  model: 'MiniMax-M2',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
};

const neverAbort: AbortSignal = AbortSignal.timeout(5_000);

beforeEach(() => {});
afterEach(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SSE parser
// ─────────────────────────────────────────────────────────────────────────────

// We import the parser as an internal export for direct testing.
// It is not part of the public surface; the public surface is the
// `streamCompletion` async iterable.
async function collectEvents(
  client: MiniMaxClientAdapter,
  request: MiniMaxCompletionRequest,
  signal: AbortSignal,
  logger: Logger,
): Promise<MiniMaxStreamEvent[]> {
  const events: MiniMaxStreamEvent[] = [];
  for await (const event of client.streamCompletion(request, TEST_API_KEY, signal, logger)) {
    events.push(event);
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OpenAI dialect — text + tool-call + usage in order
// ─────────────────────────────────────────────────────────────────────────────

// Skipping OpenAI dialect tests - we now use Anthropic for all models
describe.skip('MiniMaxClientAdapter — OpenAI dialect (deprecated)', () => {
  it('yields text, tool-call, and usage deltas in order', async () => {
    const openaiRequest: MiniMaxCompletionRequest = {
      ...defaultRequest,
      model: 'MiniMax-M2',
    };
    const records: SseRecord[] = [
      { data: JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: ', world' } }] }) },
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'echo', arguments: '{"x":' },
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '1}' } }],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      },
      { data: '[DONE]' },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = makeClient(() => server.url);
      const logger = makeRecordingLogger();
      const events = await collectEvents(client, openaiRequest, neverAbort, logger);

      strictEqual(events.length, 5);
      const first = events[0];
      const second = events[1];
      const third = events[2];
      const fourth = events[3];
      const fifth = events[4];
      if (!first || !second || !third || !fourth || !fifth) {
        fail('expected 5 events, got fewer');
        return;
      }
      strictEqual(first.textDelta, 'Hello');
      strictEqual(second.textDelta, ', world');
      // Tool-call start (id + name + first argument fragment)
      strictEqual(third.toolCallDelta?.index, 0);
      strictEqual(third.toolCallDelta?.id, 'call_abc');
      strictEqual(third.toolCallDelta?.name, 'echo');
      strictEqual(third.toolCallDelta?.argumentsDelta, '{"x":');
      // Tool-call argument continuation
      strictEqual(fourth.toolCallDelta?.index, 0);
      strictEqual(fourth.toolCallDelta?.argumentsDelta, '1}');
      ok(fourth.toolCallDelta?.id === undefined, 'id should not be re-emitted on continuation');
      // Usage + finish
      strictEqual(fifth.usage?.promptTokens, 10);
      strictEqual(fifth.usage?.completionTokens, 4);
      strictEqual(fifth.finishReason, 'tool_calls');
    } finally {
      await server.close();
    }
  });

  it('surfaces two parallel tool calls with distinct ids', async () => {
    const records: SseRecord[] = [
      {
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'alpha', arguments: '{}' },
                  },
                  {
                    index: 1,
                    id: 'call_2',
                    type: 'function',
                    function: { name: 'beta', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      },
      {
        data: JSON.stringify({
          choices: [{ finish_reason: 'tool_calls' }],
        }),
      },
      { data: '[DONE]' },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = makeClient(() => server.url);
      const events = await collectEvents(client, defaultRequest, neverAbort, makeRecordingLogger());

      // The parallel tool calls collapse to a single delta event with
      // both tool_call fragments — the consumer (T03 accumulator) splits
      // by `index`. Assert both ids are present and distinct.
      const toolDeltas = events
        .map((e) => e.toolCallDelta)
        .filter((d): d is NonNullable<typeof d> => d !== undefined);
      const ids = toolDeltas.map((d) => d.id);
      ok(ids.includes('call_1'), 'expected call_1 in tool deltas');
      ok(ids.includes('call_2'), 'expected call_2 in tool deltas');
      const indices = toolDeltas.map((d) => d.index);
      ok(indices.includes(0) && indices.includes(1), 'expected both indices 0 and 1');
      const last = events[events.length - 1];
      strictEqual(last?.finishReason, 'tool_calls');
    } finally {
      await server.close();
    }
  });

  it('surfaces reasoning_content deltas as reasoningDelta', async () => {
    const records: SseRecord[] = [
      { data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }) },
      { data: JSON.stringify({ choices: [{ delta: { content: 'visible' } }] }) },
      { data: JSON.stringify({ choices: [{ finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = makeClient(() => server.url);
      const events = await collectEvents(client, defaultRequest, neverAbort, makeRecordingLogger());
      const reasoning = events.find((e) => e.reasoningDelta !== undefined);
      ok(reasoning, 'expected a reasoningDelta event');
      strictEqual(reasoning?.reasoningDelta, 'thinking…');
      // Reasoning must NEVER be emitted as visible text.
      for (const event of events) {
        if (event.textDelta !== undefined) {
          ok(!event.textDelta.includes('thinking…'), 'reasoning leaked into visible text');
        }
      }
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Anthropic dialect — thinking blocks
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — Anthropic dialect', () => {
  it('surfaces thinking content blocks as thinkingDelta', async () => {
    const m3Request: MiniMaxCompletionRequest = {
      ...defaultRequest,
      model: 'MiniMax-M3',
      maxTokens: 1024,
    };
    const records: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reasoning step 1; ' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'step 2.' },
        }),
      },
      {
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
      },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'final answer' },
        }),
      },
      {
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 1 }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = makeClient(() => server.url);
      const events = await collectEvents(client, m3Request, neverAbort, makeRecordingLogger());
      const thinking = events.filter((e) => e.thinkingDelta !== undefined);
      strictEqual(thinking.length, 2, 'expected two thinking deltas');
      const concatenated = thinking.map((e) => e.thinkingDelta ?? '').join('');
      strictEqual(concatenated, 'reasoning step 1; step 2.');
      const text = events.find((e) => e.textDelta !== undefined);
      ok(text, 'expected a textDelta event');
      strictEqual(text?.textDelta, 'final answer');
      // Reasoning must NEVER leak into visible text.
      for (const event of events) {
        if (event.textDelta !== undefined) {
          ok(!event.textDelta.includes('reasoning'), 'thinking content leaked into visible text');
        }
      }
      const last = events[events.length - 1];
      strictEqual(last?.finishReason, 'stop');
    } finally {
      await server.close();
    }
  });

  it('surfaces tool_use blocks as toolCallDelta', async () => {
    const m3Request: MiniMaxCompletionRequest = {
      ...defaultRequest,
      model: 'MiniMax-M3',
      maxTokens: 1024,
    };
    const records: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
        }),
      },
      {
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = makeClient(() => server.url);
      const events = await collectEvents(client, m3Request, neverAbort, makeRecordingLogger());
      // First delta carries id + name + first argument fragment
      const firstTool = events.find((e) => e.toolCallDelta !== undefined);
      ok(firstTool, 'expected a toolCallDelta event');
      strictEqual(firstTool?.toolCallDelta?.id, 'toolu_01');
      strictEqual(firstTool?.toolCallDelta?.name, 'get_weather');
      strictEqual(firstTool?.toolCallDelta?.index, 0);
      // Continuation deltas carry the argument fragment only
      const allToolDeltas = events
        .map((e) => e.toolCallDelta)
        .filter((d): d is NonNullable<typeof d> => d !== undefined);
      const fragments = allToolDeltas.map((d) => d.argumentsDelta ?? '');
      deepStrictEqual(fragments, ['{"city":', '"Paris"}']);
      // Finish reason
      const last = events[events.length - 1];
      strictEqual(last?.finishReason, 'tool_calls');
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Endpoint routing
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — endpoint routing', () => {
  it('routes M3 to the Anthropic /v1/messages endpoint with Authorization: Bearer', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const server = await startMockServer((req, res) => {
      receivedPath = req.url ?? '';
      const a = req.headers['authorization'];
      receivedAuth = Array.isArray(a) ? (a[0] ?? '') : (a ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        serializeSse([
          { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
          {
            event: 'message_delta',
            data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          },
          { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
        ]),
      );
    });

    try {
      const client = makeClient(() => server.url);
      await collectEvents(
        client,
        { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
        neverAbort,
        makeRecordingLogger(),
      );
      ok(receivedPath.endsWith('/v1/messages'), `expected /v1/messages, got ${receivedPath}`);
      // MiniMax uses Authorization: Bearer for both OpenAI and Anthropic endpoints.
      ok(
        receivedAuth === `Bearer ${TEST_API_KEY}`,
        `expected 'Authorization: Bearer <key>', got ${receivedAuth}`,
      );
    } finally {
      await server.close();
    }
  });

  it('routes M2 to the Anthropic /v1/messages endpoint (all models use Anthropic)', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const server = await startMockServer((req, res) => {
      receivedPath = req.url ?? '';
      const a = req.headers['authorization'];
      receivedAuth = Array.isArray(a) ? (a[0] ?? '') : (a ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        serializeSse([
          { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
          {
            event: 'message_delta',
            data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          },
          { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
        ]),
      );
    });

    try {
      const client = makeClient(() => server.url);
      await collectEvents(client, defaultRequest, neverAbort, makeRecordingLogger());
      ok(receivedPath.endsWith('/v1/messages'), `expected /v1/messages, got ${receivedPath}`);
      ok(
        receivedAuth === `Bearer ${TEST_API_KEY}`,
        `expected 'Authorization: Bearer <key>', got ${receivedAuth}`,
      );
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 429 — bounded backoff → typed rate-limit error
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — 429 backoff', () => {
  it('retries on 429 then surfaces a typed rate-limit error after exhaustion', async () => {
    let attempts = 0;
    const server = await startMockServer((_req, res) => {
      attempts += 1;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }));
    });

    try {
      const client = makeClient(() => server.url);
      const logger = makeRecordingLogger();
      await rejects(collectEvents(client, defaultRequest, neverAbort, logger), (err: unknown) => {
        ok(err instanceof MiniMaxClientError, `expected MiniMaxClientError, got ${String(err)}`);
        strictEqual(err.kind, 'rate-limit');
        strictEqual(err.status, 429);
        return true;
      });
      // maxRetries=2 → 1 initial + 2 retries = 3 attempts.
      strictEqual(attempts, 3, `expected 3 attempts, got ${attempts}`);
      // Logger should have received a warn for each retry.
      const warns = logger.calls.filter((c) => c.level === 'warn');
      ok(warns.length >= 2, `expected at least 2 warn-level retry logs, got ${warns.length}`);
    } finally {
      await server.close();
    }
  });

  it('retries on 429 and succeeds on a later attempt', async () => {
    let attempts = 0;
    const server = await startMockServer((_req, res) => {
      attempts += 1;
      if (attempts < 2) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        serializeSse([
          { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
          {
            event: 'content_block_delta',
            data: JSON.stringify({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'ok' },
            }),
          },
          {
            event: 'message_delta',
            data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
          },
          { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
        ]),
      );
    });

    try {
      const client = makeClient(() => server.url);
      const events = await collectEvents(client, defaultRequest, neverAbort, makeRecordingLogger());
      strictEqual(attempts, 2);
      strictEqual(events[0]?.textDelta, 'ok');
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cancellation
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — cancellation', () => {
  it('aborts an in-flight stream promptly when the signal fires', async () => {
    const slowRecords = (): Promise<void> =>
      new Promise((resolve) => {
        // Server holds the connection open; we abort before it sends [DONE].
        setTimeout(() => {
          resolve();
        }, 5_000);
      });

    const server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        serializeSse([{ data: JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }) }]),
      );
      // Flush + keep alive
      res.write(': keep-alive\n\n');
      await slowRecords();
      res.end();
    });

    try {
      const client = makeClient(() => server.url);
      const controller = new AbortController();
      const logger = makeRecordingLogger();
      const collectionPromise = collectEvents(client, defaultRequest, controller.signal, logger);
      // Give the client a tick to connect.
      await new Promise((r) => setImmediate(r));
      controller.abort();
      await rejects(collectionPromise, (err: unknown) => {
        ok(err instanceof MiniMaxClientError, `expected MiniMaxClientError, got ${String(err)}`);
        strictEqual(err.kind, 'abort');
        return true;
      });
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Secret redaction
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — secret redaction', () => {
  it('never logs the API key, Authorization header, or x-api-key', async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        serializeSse([
          { data: JSON.stringify({ choices: [{ finish_reason: 'stop' }] }) },
          { data: '[DONE]' },
        ]),
      );
    });

    try {
      const client = makeClient(() => server.url);
      const logger = makeRecordingLogger();
      await collectEvents(client, defaultRequest, neverAbort, logger);
      for (const call of logger.calls) {
        const s = stringifyCall(call);
        ok(
          !s.includes(TEST_API_KEY),
          `API key leaked into log call: ${call.level} ${call.message}`,
        );
      }
    } finally {
      await server.close();
    }
  });

  it('never logs the Authorization header value on 401', async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }),
      );
    });

    try {
      const client = makeClient(() => server.url);
      const logger = makeRecordingLogger();
      await rejects(
        collectEvents(client, defaultRequest, neverAbort, logger),
        (err: unknown) => err instanceof MiniMaxClientError && err.kind === 'auth',
      );
      for (const call of logger.calls) {
        const s = stringifyCall(call);
        ok(
          !s.includes(TEST_API_KEY),
          `API key leaked into 401 log call: ${call.level} ${call.message}`,
        );
      }
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Non-2xx (non-auth, non-429) → typed http error
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — non-2xx', () => {
  it('surfaces 500 as a typed http error and does NOT retry', async () => {
    let attempts = 0;
    const server = await startMockServer((_req, res) => {
      attempts += 1;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'server exploded' } }));
    });

    try {
      const client = makeClient(() => server.url);
      await rejects(
        collectEvents(client, defaultRequest, neverAbort, makeRecordingLogger()),
        (err: unknown) => {
          ok(err instanceof MiniMaxClientError);
          strictEqual(err.kind, 'http');
          strictEqual(err.status, 500);
          return true;
        },
      );
      strictEqual(attempts, 1, '5xx should not be retried');
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Stream abandonment detection
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — stream abandonment', () => {
  /**
   * Slow-request warn: the transport logs at `warn` level when
   * elapsedMs > slowRequestThresholdMs. Tests lower the threshold
   * to a tiny value so the warn path fires in milliseconds rather
   * than 20 seconds.
   */
  it('emits a warn-level slow-request line when elapsedMs exceeds the threshold', async () => {
    // Stream that completes normally — message_start, one text
    // delta, message_delta with stop_reason, message_stop — so the
    // abandonment check does NOT fire and the slow-request warn is
    // the only anomaly the test observes.
    const records: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hi' },
        }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      // Threshold of 0ms: any completed request exceeds it.
      const client = new MiniMaxClientAdapter({
        baseUrl: () => server.url,
        maxRetries: 0,
        slowRequestThresholdMs: 0,
        abandonmentThresholdMs: 0,
      });
      const logger = makeRecordingLogger();
      await collectEvents(
        client,
        { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
        neverAbort,
        logger,
      );
      // The slow-request warn line must be present.
      const slowCalls = logger.calls.filter(
        (c) => c.level === 'warn' && c.message.includes('MiniMax request slow'),
      );
      ok(slowCalls.length >= 1, 'expected a slow-request warn line');
      // The completion info line is also still emitted.
      const completionCalls = logger.calls.filter(
        (c) =>
          c.level === 'info' &&
          typeof c.message === 'string' &&
          c.message.includes('MiniMax request complete'),
      );
      ok(completionCalls.length >= 1, 'expected a request-complete info line');
    } finally {
      await server.close();
    }
  });

  /**
   * Abandonment: the server sends a `message_start` + a text
   * delta, then closes the response body WITHOUT sending
   * `message_delta` or `message_stop`. The stream is alive but
   * the model never produced a finish marker. With
   * abandonmentThresholdMs=0, the transport must surface a
   * typed `abandoned` error to the caller.
   */
  it('surfaces MiniMaxClientError(abandoned) when the stream ends without a finish marker and the threshold is exceeded', async () => {
    const records: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: "I'll build the WXR exporter now" },
        }),
      },
      // NO message_delta, NO message_stop — stream ends after
      // the text delta. This is the abandonment case.
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = new MiniMaxClientAdapter({
        baseUrl: () => server.url,
        maxRetries: 0,
        slowRequestThresholdMs: 100_000, // far above elapsedMs — warn should NOT fire
        abandonmentThresholdMs: 0, // every completed request exceeds it
      });
      const logger = makeRecordingLogger();
      await rejects(
        collectEvents(
          client,
          { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
          neverAbort,
          logger,
        ),
        (err: unknown) => {
          ok(err instanceof MiniMaxClientError, `expected MiniMaxClientError, got ${String(err)}`);
          strictEqual(err.kind, 'abandoned');
          ok(err.retriable, 'abandoned should be retriable');
          ok(
            /finish marker/i.test(err.message),
            'message should mention the missing finish marker',
          );
          return true;
        },
      );
      // Slow-request warn must NOT fire when its threshold is far
      // above elapsedMs (the abandonment error path takes
      // precedence and we want clean signal in the log).
      const slowCalls = logger.calls.filter(
        (c) => c.level === 'warn' && c.message.includes('MiniMax request slow'),
      );
      strictEqual(slowCalls.length, 0, 'slow-request warn should not fire when threshold is high');
    } finally {
      await server.close();
    }
  });

  /**
   * Empty stream: the server returns 200 with no SSE records at
   * all (a malformed or zero-length body). The transport must
   * surface a typed `network` error, not `abandoned`, because
   * `sawAnyEvent` is false — the request never produced a usable
   * response.
   */
  it('surfaces MiniMaxClientError(network) when the stream ends with no events at all', async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(''); // zero-length SSE body
    });

    try {
      const client = new MiniMaxClientAdapter({
        baseUrl: () => server.url,
        maxRetries: 0,
        slowRequestThresholdMs: 100_000,
        abandonmentThresholdMs: 0,
      });
      await rejects(
        collectEvents(
          client,
          { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
          neverAbort,
          makeRecordingLogger(),
        ),
        (err: unknown) => {
          ok(err instanceof MiniMaxClientError, `expected MiniMaxClientError, got ${String(err)}`);
          // Empty stream: distinquished from 'abandoned' by the
          // sawAnyEvent flag. The transport throws 'network' here
          // (the response was structurally a stream but delivered
          // nothing — equivalent to a transport failure).
          strictEqual(err.kind, 'network');
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  /**
   * Negative control: when the stream completes cleanly
   * (message_start + text_delta + message_delta with
   * stop_reason + message_stop), the abandonment check must
   * not fire even with abandonmentThresholdMs=0.
   */
  it('does not throw abandoned when the stream ends with a finish marker', async () => {
    const records: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'final' },
        }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = new MiniMaxClientAdapter({
        baseUrl: () => server.url,
        maxRetries: 0,
        // Both thresholds at 0: with a clean finish marker, the
        // transport must NOT throw — the abandonment check is
        // gated on `!sawFinishReason` and never reaches the
        // threshold comparison.
        slowRequestThresholdMs: 0,
        abandonmentThresholdMs: 0,
      });
      const events = await collectEvents(
        client,
        { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
        neverAbort,
        makeRecordingLogger(),
      );
      // Stream completed cleanly.
      const last = events[events.length - 1];
      ok(last?.finishReason === 'stop', 'expected a stop finishReason on the last event');
    } finally {
      await server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Request-scoped state isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('MiniMaxClientAdapter — request-scoped state isolation', () => {
  /**
   * Regression for a state-leak class: `pendingToolUseStarts`
   * used to be a module-level Map shared across every concurrent
   * `streamCompletion` call. An abandoned stream that left a
   * tool-use header set but never delivered the matching
   * `input_json_delta` would have its entry inherited by the
   * NEXT concurrent request, causing that request's
   * `input_json_delta` to merge with the wrong `id`/`name`.
   *
   * The fix moves the Map onto `MutableParseState` so each
   * `streamCompletion` call owns its own buffer. This test
   * proves the isolation: two concurrent abandoned streams
   * that each leave a tool-use header set must NOT affect a
   * third normal stream's tool-call output.
   */
  it('does not leak pendingToolUseStarts entries across concurrent abandoned streams', async () => {
    // Two requests that each deliver ONLY a content_block_start
    // (a tool-use header) and then hang. Both should be classified
    // as abandoned by the transport and throw MiniMaxClientError
    // ('abandoned'). The map entries they leave in their
    // (now per-request) buffers must be discarded with the rest
    // of the MutableParseState when the generator returns.
    const abandonedRecords: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_LEAK_A', name: 'leak_a' },
        }),
      },
      // No content_block_delta, no message_delta, no message_stop.
      // The connection just hangs.
    ];
    const normalRecords: SseRecord[] = [
      { event: 'message_start', data: JSON.stringify({ type: 'message_start' }) },
      {
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_REAL', name: 'real_tool' },
        }),
      },
      {
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        }),
      },
      {
        event: 'content_block_stop',
        data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
      },
      {
        event: 'message_delta',
        data: JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        }),
      },
      { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
    ];

    // Mock server: serve abandonedRecords for the first N
    // requests (where N >= 2), then normalRecords for any
    // subsequent request.
    let requestCount = 0;
    const server = await startMockServer((_req, res) => {
      requestCount += 1;
      const records = requestCount <= 2 ? abandonedRecords : normalRecords;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(serializeSse(records));
    });

    try {
      const client = new MiniMaxClientAdapter({
        baseUrl: () => server.url,
        maxRetries: 0,
        // Both thresholds at 0 so any request with a clean
        // finish marker is fine, and any request without one
        // is classified as abandoned immediately.
        slowRequestThresholdMs: 0,
        abandonmentThresholdMs: 0,
      });
      const logger = makeRecordingLogger();

      // Fire two abandoned requests "concurrently" (sequentially
      // in this test, but each one starts and ends within its
      // own MutableParseState lifetime).
      for (let i = 0; i < 2; i += 1) {
        await rejects(
          collectEvents(
            client,
            { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
            neverAbort,
            logger,
          ),
          (err: unknown) =>
            err instanceof MiniMaxClientError &&
            (err.kind === 'abandoned' || err.kind === 'network'),
        );
      }

      // Now a normal request. The fact that two prior abandoned
      // requests left a tool-use header in some shared map
      // would show up as the wrong id/name in the resulting
      // toolCallDelta.
      const events = await collectEvents(
        client,
        { ...defaultRequest, model: 'MiniMax-M3', maxTokens: 1024 },
        neverAbort,
        makeRecordingLogger(),
      );
      const firstTool = events.find((e) => e.toolCallDelta !== undefined);
      ok(firstTool, 'expected a toolCallDelta event');
      strictEqual(
        firstTool?.toolCallDelta?.id,
        'toolu_REAL',
        'normal request must use its own id, not one leaked from an abandoned stream',
      );
      strictEqual(firstTool?.toolCallDelta?.name, 'real_tool');
    } finally {
      await server.close();
    }
  });
});
