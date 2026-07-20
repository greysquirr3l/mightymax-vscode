import { describe, it } from 'node:test';
import { deepStrictEqual, equal, fail, ok, rejects } from 'node:assert/strict';

import { validateApiKey, type FetchLike, type ValidationResult } from './api-key-validator.js';

/**
 * Mock fetch for the validator tests. Each call appends a record so we
 * can assert that the validator hit the expected URL, sent the
 * expected Authorization header (without leaking the key in the wrong
 * place), and respected the AbortSignal.
 */
interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  calls: FetchCall[];
  setResponse(status: number, body: unknown): void;
  setNetworkError(message: string): void;
}

function createMockFetch(): MockFetch {
  const calls: FetchCall[] = [];
  let response: { status: number; body: string } | null = null;
  let networkError: { message: string } | null = null;

  const fn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (networkError) {
      throw new TypeError(networkError.message);
    }
    const r = response ?? { status: 200, body: JSON.stringify({ data: [] }) };
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as MockFetch;

  fn.calls = calls;
  fn.setResponse = (status: number, body: unknown) => {
    response = { status, body: JSON.stringify(body) };
    networkError = null;
  };
  fn.setNetworkError = (message: string) => {
    networkError = { message };
    response = null;
  };
  return fn;
}

describe('validateApiKey', () => {
  it('returns ok with model ids on 200', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2' }] });
    const result: ValidationResult = await validateApiKey(
      'sk-test-1234567890',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, true);
    if (result.ok) {
      deepStrictEqual(result.modelIds, ['MiniMax-M3', 'MiniMax-M2']);
    }
  });

  it('returns ok with empty modelIds for 200 with empty list', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: [] });
    const result = await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, true);
    if (result.ok) {
      deepStrictEqual(result.modelIds, []);
    }
  });

  it('returns ok with empty modelIds for 200 with object-shaped list', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: { id: 'MiniMax-M3' } });
    const result = await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, true);
    if (result.ok) {
      deepStrictEqual(result.modelIds, []);
    }
  });

  it('returns unauthorized on 401', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(401, { error: { message: 'invalid api key' } });
    const result = await validateApiKey(
      'sk-bad-key',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.reason, 'unauthorized');
      equal(result.status, 401);
    }
  });

  it('returns unauthorized on 403', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(403, { error: { message: 'forbidden' } });
    const result = await validateApiKey(
      'sk-bad-key',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.reason, 'unauthorized');
      equal(result.status, 403);
    }
  });

  it('returns malformed on 200 with non-JSON body', async () => {
    // Build a one-off fetch that returns a 200 with a non-JSON body so
    // response.json() throws SyntaxError. The validator must surface
    // this as `malformed` rather than letting the exception escape.
    const fetchImpl: FetchLike = async () => new Response('not json', { status: 200 });
    const result = await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetchImpl,
    );
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.reason, 'malformed');
    }
  });

  it('returns network on TypeError', async () => {
    const fetch_ = createMockFetch();
    fetch_.setNetworkError('fetch failed');
    const result = await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.reason, 'network');
    }
  });

  it('returns malformed on unexpected non-200/401/403 status', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(500, { error: 'internal' });
    const result = await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetch_,
    );
    equal(result.ok, false);
    if (!result.ok) {
      equal(result.reason, 'malformed');
      equal(result.status, 500);
    }
  });

  it('strips a trailing slash from the base URL', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: [] });
    await validateApiKey('sk-test', 'https://api.minimax.io/', fetch_);
    equal(fetch_.calls.length, 1);
    equal(fetch_.calls[0]?.url, 'https://api.minimax.io/v1/models');
  });

  it('sends Authorization: Bearer <key>', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: [] });
    await validateApiKey(
      'sk-test-1234567890',
      'https://api.minimax.io',
      fetch_,
    );
    const call = fetch_.calls[0];
    ok(call, 'expected fetch to be called once');
    const headers = call.init.headers as Record<string, string>;
    equal(headers['Authorization'], 'Bearer sk-test-1234567890');
  });

  it('rejects if the API key is empty', async () => {
    await rejects(
      validateApiKey('', 'https://api.minimax.io', createMockFetch()),
      /empty/i,
    );
  });

  it('rejects if the API key is whitespace-only', async () => {
    await rejects(
      validateApiKey('   ', 'https://api.minimax.io', createMockFetch()),
      /empty/i,
    );
  });

  it('rejects if the base URL is empty', async () => {
    await rejects(
      validateApiKey('sk-test', '', createMockFetch()),
      /base ?url/i,
    );
  });

  it('passes the AbortSignal to fetch', async () => {
    const fetch_ = createMockFetch();
    fetch_.setResponse(200, { data: [] });
    const ac = new AbortController();
    await validateApiKey(
      'sk-test',
      'https://api.minimax.io',
      fetch_,
      ac.signal,
    );
    const call = fetch_.calls[0];
    ok(call, 'expected fetch to be called once');
    equal(call.init.signal, ac.signal);
  });

  it('never throws on fetch errors — returns a typed ValidationResult', async () => {
    const fetch_ = createMockFetch();
    fetch_.setNetworkError('boom');
    let result: ValidationResult | undefined;
    try {
      result = await validateApiKey(
        'sk-test',
        'https://api.minimax.io',
        fetch_,
      );
    } catch (err) {
      fail(`validateApiKey should not throw: ${String(err)}`);
    }
    equal(result?.ok, false);
    if (result && !result.ok) {
      equal(result.reason, 'network');
    }
  });
});
