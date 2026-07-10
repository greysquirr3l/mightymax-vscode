/**
 * Token Plan transport adapter — error-path and redaction tests.
 *
 * The pure schema logic is exercised in `usage-normalization.test.ts`.
 * This file pins the I/O surface:
 *   - 5xx / 4xx responses raise UsageUnavailableError (kind: 'unavailable').
 *   - Network errors raise UsageUnavailableError (kind: 'network').
 *   - Non-JSON bodies raise UsageUnavailableError (kind: 'parse').
 *   - The transport NEVER writes the API key or Authorization header
 *     to the logger at any level (AGENTS.md red-line). A planted
 *     sentinel is asserted-absent from every captured log line.
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import { UsageTransportAdapter, DEFAULT_REMAINS_URL } from './usage-transport.js';
import { UsageUnavailableError } from '../ports/usage-client.js';
import type { Logger } from '../ports/logger.js';

// Planted sentinel — must never appear in any captured log line.
const SENTINEL_API_KEY = 'MightyMax_Usage_Key_77cc';

interface RecordedCall {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

function makeCapturingLogger(): Logger & { readonly calls: ReadonlyArray<RecordedCall> } {
  const calls: RecordedCall[] = [];
  const rec = (level: RecordedCall['level']) =>
    (message: string, context?: Record<string, unknown>) => {
      calls.push(context === undefined ? { level, message } : { level, message, context });
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

const FIXTURE_BODY = JSON.stringify({
  base_resp: { status_code: 0, status_msg: 'success' },
  model_remains: [
    {
      model_name: 'general',
      current_interval_status: 1,
      current_interval_remaining_percent: 38,
      remains_time: 5_400_000,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 81,
      weekly_remains_time: 172_800_000,
    },
  ],
});

function fetchJsonOk(): typeof fetch {
  return (async () =>
    new Response(FIXTURE_BODY, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('UsageTransportAdapter — happy path', () => {
  it('returns normalized usage for a successful response', async () => {
    const logger = makeCapturingLogger();
    const adapter = new UsageTransportAdapter({
      logger,
      fetchImpl: fetchJsonOk(),
      now: () => Date.UTC(2026, 6, 10, 12, 0, 0),
    });

    const usage = await adapter.fetchUsage(SENTINEL_API_KEY);
    strictEqual(usage.percentUsed, 62);
    strictEqual(usage.windows.length, 2);

    const debug = logger.calls.find((c) => c.level === 'debug');
    ok(debug !== undefined, 'expected a debug log line on success');
    for (const c of logger.calls) {
      const blob = JSON.stringify(c);
      ok(!blob.includes(SENTINEL_API_KEY), `API key leaked: ${blob}`);
      ok(!blob.includes('Authorization: Bearer'), `Authorization header leaked: ${blob}`);
    }
  });

  it('defaults to the documented production endpoint', async () => {
    const logger = makeCapturingLogger();
    let requestedUrl: string | undefined;
    const fetchImpl: typeof fetch = (async (input: string | URL) => {
      requestedUrl = typeof input === 'string' ? input : input.toString();
      return new Response(FIXTURE_BODY, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });
    await adapter.fetchUsage(SENTINEL_API_KEY);
    strictEqual(requestedUrl, DEFAULT_REMAINS_URL);
  });
});

describe('UsageTransportAdapter — error mapping', () => {
  it('maps HTTP 4xx (PAYG key, no plan) to unavailable + non-retriable', async () => {
    const logger = makeCapturingLogger();
    const fetchImpl = (async () =>
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });

    let captured: UsageUnavailableError | undefined;
    try {
      await adapter.fetchUsage(SENTINEL_API_KEY);
    } catch (err) {
      if (err instanceof UsageUnavailableError) captured = err;
    }
    ok(captured !== undefined, 'expected UsageUnavailableError');
    if (captured !== undefined) {
      strictEqual(captured.kind, 'unavailable');
      strictEqual(captured.retriable, false);
    }
  });

  it('maps HTTP 5xx to unavailable + retriable', async () => {
    const logger = makeCapturingLogger();
    const fetchImpl = (async () =>
      new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });

    let captured: UsageUnavailableError | undefined;
    try {
      await adapter.fetchUsage(SENTINEL_API_KEY);
    } catch (err) {
      if (err instanceof UsageUnavailableError) captured = err;
    }
    ok(captured !== undefined, 'expected UsageUnavailableError');
    if (captured !== undefined) {
      strictEqual(captured.kind, 'unavailable');
      strictEqual(captured.retriable, true);
    }
  });

  it('maps network failures to kind "network" + retriable', async () => {
    const logger = makeCapturingLogger();
    const fetchImpl = (async () => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });

    let captured: UsageUnavailableError | undefined;
    try {
      await adapter.fetchUsage(SENTINEL_API_KEY);
    } catch (err) {
      if (err instanceof UsageUnavailableError) captured = err;
    }
    ok(captured !== undefined, 'expected UsageUnavailableError');
    if (captured !== undefined) {
      strictEqual(captured.kind, 'network');
      strictEqual(captured.retriable, true);
    }
  });

  it('maps non-JSON bodies to kind "parse"', async () => {
    const logger = makeCapturingLogger();
    const fetchImpl = (async () =>
      new Response('<html>bad gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });

    let captured: UsageUnavailableError | undefined;
    try {
      await adapter.fetchUsage(SENTINEL_API_KEY);
    } catch (err) {
      if (err instanceof UsageUnavailableError) captured = err;
    }
    ok(captured !== undefined, 'expected UsageUnavailableError');
    if (captured !== undefined) {
      strictEqual(captured.kind, 'parse');
    }
  });

  it('maps schema-failure payloads to kind "parse"', async () => {
    const logger = makeCapturingLogger();
    const fetchImpl = (async () =>
      new Response('{"weird":"shape"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const adapter = new UsageTransportAdapter({ logger, fetchImpl });

    let captured: UsageUnavailableError | undefined;
    try {
      await adapter.fetchUsage(SENTINEL_API_KEY);
    } catch (err) {
      if (err instanceof UsageUnavailableError) captured = err;
    }
    ok(captured !== undefined, 'expected UsageUnavailableError');
    if (captured !== undefined) {
      strictEqual(captured.kind, 'parse');
    }
  });
});
