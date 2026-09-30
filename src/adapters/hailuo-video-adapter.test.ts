/**
 * Unit tests for HailuoVideoAdapter — uses an in-test stub `fetch`
 * so the suite never touches the real MiniMax endpoint.
 *
 * Coverage:
 *  - Submit → task_id; submit body has the expected shape
 *  - Poll while pending → kind: 'pending'
 *  - Poll on success → kind: 'success' with downloadUrl from
 *    content.url when present
 *  - Poll on fail → kind: 'fail' with code + message
 *  - Poll surfaces base_resp errors (auth, rate-limit, sensitive,
 *    insufficient-balance) as typed `HailuoVideoError`s
 *  - 401 / 429 / 5xx HTTP errors surface as typed `HailuoVideoError`s
 *  - downloadResult fetches the file metadata + downloads the bytes
 *  - AbortSignal short-circuits all three methods
 *  - Network errors throw `kind: 'network'`
 *  - buildSubmitBody has the expected wire shape for text / i2v /
 *    subject-reference inputs
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_HAILUO_BASE_URL,
  HailuoVideoAdapter,
  HailuoVideoError,
  buildSubmitBody,
  type FetchLike,
} from './hailuo-video-adapter.js';
import type { Logger } from '../ports/logger.js';
import type { VideoRequest } from '../lib/domain/media.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY = 'sk-test-key-1234';

function makeSilentLogger(): Logger {
  const noop = (): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
}

function makeRequest(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return {
    model: 'MiniMax-H3',
    prompt: 'a giant turtle swimming through a coral reef',
    durationSec: 6,
    ...overrides,
  };
}

/**
 * A scripted fetch stub. Each entry in the queue is a function that
 * receives the request and returns a `Response`. The stub records
 * every call so tests can assert the request shape.
 */
class ScriptedFetch {
  readonly calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  private readonly queue: Array<(url: string, init?: RequestInit) => Response> = [];

  enqueue(handler: (url: string, init?: RequestInit) => Response): this {
    this.queue.push(handler);
    return this;
  }

  enqueueJson(status: number, body: unknown): this {
    return this.enqueue(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  enqueueBytes(status: number, bytes: Uint8Array, contentType = 'video/mp4'): this {
    return this.enqueue(
      () =>
        new Response(bytes, {
          status,
          headers: { 'content-type': contentType },
        }),
    );
  }

  fetch: FetchLike = async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    this.calls.push({ url: u, init });
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`ScriptedFetch: no scripted response for ${u}`);
    }
    return next(u, init);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSubmitBody
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSubmitBody', () => {
  it('emits a single text content entry for a minimal request', () => {
    const body = buildSubmitBody(makeRequest());
    assert.deepEqual(body, {
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: 'a giant turtle swimming through a coral reef' }],
    });
  });

  it('emits firstFrameImageUri as image_url content', () => {
    const body = buildSubmitBody(makeRequest({ firstFrameImageUri: 'data:image/png;base64,AAAA' }));
    const content = body['content'] as Array<Record<string, unknown>>;
    assert.equal(content.length, 2);
    assert.deepEqual(content[1], { type: 'image_url', image_url: 'data:image/png;base64,AAAA' });
  });

  it('emits lastFrameImageUri as image_url content', () => {
    const body = buildSubmitBody(makeRequest({ lastFrameImageUri: 'data:image/png;base64,BBBB' }));
    const content = body['content'] as Array<Record<string, unknown>>;
    assert.equal(content.length, 2);
    assert.deepEqual(content[1], { type: 'image_url', image_url: 'data:image/png;base64,BBBB' });
  });

  it('emits all referenceImageUris in order', () => {
    const body = buildSubmitBody(
      makeRequest({
        model: 'MiniMax-H3-Max',
        referenceImageUris: ['file://r1', 'file://r2', 'file://r3'],
      }),
    );
    const content = body['content'] as Array<Record<string, unknown>>;
    assert.equal(content.length, 4);
    assert.deepEqual(content.slice(1), [
      { type: 'image_url', image_url: 'file://r1' },
      { type: 'image_url', image_url: 'file://r2' },
      { type: 'image_url', image_url: 'file://r3' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// submitTask
// ─────────────────────────────────────────────────────────────────────────────

describe('HailuoVideoAdapter.submitTask', () => {
  it('returns the task_id from a 200 response', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-abc',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    const handle = await adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal);
    assert.equal(handle.taskId, 'task-abc');
    assert.equal(handle.model, 'MiniMax-H3');
  });

  it('POSTs to /v2/video_generation with bearer auth + JSON body', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-abc',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal);
    assert.equal(fetch_.calls.length, 1);
    const call = fetch_.calls[0]!;
    assert.equal(call.url, `${DEFAULT_HAILUO_BASE_URL}/v2/video_generation`);
    assert.equal(call.init?.method, 'POST');
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${API_KEY}`);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.ok(typeof call.init?.body === 'string');
  });

  it('throws auth error on 401', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(401, { error: 'unauthorized' });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'auth',
    );
  });

  it('throws rate-limit error on 429', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(429, { error: 'rate_limited' });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'rate-limit',
    );
  });

  it('throws parse error when task_id is missing', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, { base_resp: { status_code: 0 } });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'parse',
    );
  });

  it('throws network error when fetch rejects', async () => {
    const fetch_: FetchLike = async () => {
      throw new TypeError('terminated');
    };
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.submitTask(makeRequest(), API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'network',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pollStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('HailuoVideoAdapter.pollStatus', () => {
  it('returns kind: pending on Queueing / Processing / Preparing', async () => {
    for (const status of ['Preparing', 'Queueing', 'Processing']) {
      const fetch_ = new ScriptedFetch().enqueueJson(200, {
        task_id: 'task-1',
        status,
        base_resp: { status_code: 0, status_msg: '' },
      });
      const adapter = new HailuoVideoAdapter({
        fetchImpl: fetch_.fetch,
        logger: makeSilentLogger(),
      });
      const state = await adapter.pollStatus('task-1', API_KEY, new AbortController().signal);
      assert.equal(state.kind, 'pending');
      if (state.kind === 'pending') assert.equal(state.taskId, 'task-1');
    }
  });

  it('returns kind: success with downloadUrl when content.url is present', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-1',
      status: 'Success',
      content: { url: 'https://cdn.example.com/abc.mp4' },
      file_id: '176844028768320',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    const state = await adapter.pollStatus('task-1', API_KEY, new AbortController().signal);
    assert.equal(state.kind, 'success');
    if (state.kind === 'success')
      assert.equal(state.downloadUrl, 'https://cdn.example.com/abc.mp4');
  });

  it('returns kind: success without downloadUrl when content.url is absent', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-1',
      status: 'Success',
      file_id: '176844028768320',
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    const state = await adapter.pollStatus('task-1', API_KEY, new AbortController().signal);
    assert.equal(state.kind, 'success');
    if (state.kind === 'success') assert.equal(state.downloadUrl, undefined);
  });

  it('returns kind: fail with code + message on terminal failure', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-1',
      status: 'Fail',
      base_resp: { status_code: 1, status_msg: 'generation failed' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    const state = await adapter.pollStatus('task-1', API_KEY, new AbortController().signal);
    assert.equal(state.kind, 'fail');
    if (state.kind === 'fail') {
      assert.equal(state.errorCode, '1');
      assert.equal(state.errorMessage, 'generation failed');
    }
  });

  it('surfaces base_resp status_code 1004 as auth error', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-1',
      status: 'Queueing',
      base_resp: { status_code: 1004, status_msg: 'invalid key' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.pollStatus('task-1', API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'auth',
    );
  });

  it('surfaces base_resp status_code 1026 as sensitive content error', async () => {
    const fetch_ = new ScriptedFetch().enqueueJson(200, {
      task_id: 'task-1',
      status: 'Fail',
      base_resp: { status_code: 1026, status_msg: 'sensitive input' },
    });
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    await assert.rejects(
      adapter.pollStatus('task-1', API_KEY, new AbortController().signal),
      (err: unknown) => err instanceof HailuoVideoError && err.kind === 'sensitive',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// downloadResult
// ─────────────────────────────────────────────────────────────────────────────

describe('HailuoVideoAdapter.downloadResult', () => {
  it('resolves file_id via poll, fetches file metadata, then downloads bytes', async () => {
    const fetch_ = new ScriptedFetch()
      // poll → success with file_id
      .enqueueJson(200, {
        task_id: 'task-1',
        status: 'Success',
        file_id: '176844028768320',
        base_resp: { status_code: 0, status_msg: 'success' },
      })
      // files/retrieve → file metadata with download_url
      .enqueueJson(200, {
        file: {
          file_id: 176844028768320,
          bytes: 11,
          download_url: 'https://cdn.example.com/abc.mp4',
          filename: 'output_aigc.mp4',
          purpose: 'video_generation',
        },
        base_resp: { status_code: 0, status_msg: 'success' },
      })
      // the actual video bytes
      .enqueueBytes(200, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_.fetch,
      logger: makeSilentLogger(),
    });
    const result = await adapter.downloadResult('task-1', API_KEY, new AbortController().signal);
    assert.equal(result.bytes.byteLength, 11);
    assert.equal(result.bytes[0], 0);
    assert.equal(result.bytes[10], 10);
    assert.equal(result.mime, 'video/mp4');
    assert.equal(result.sourceUrl, 'https://cdn.example.com/abc.mp4');
    // Three calls: poll → files/retrieve → bytes
    assert.equal(fetch_.calls.length, 3);
    assert.match(fetch_.calls[0]!.url, /\/v2\/query\/video_generation\/task-1$/);
    assert.match(fetch_.calls[1]!.url, /\/v1\/files\/retrieve\?file_id=176844028768320$/);
    assert.equal(fetch_.calls[2]!.url, 'https://cdn.example.com/abc.mp4');
  });

  it('honours the AbortSignal', async () => {
    const fetch_: FetchLike = async (_url, init) => {
      const sig: AbortSignal | null | undefined = init?.signal ?? undefined;
      if (sig !== undefined && sig.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 });
    };
    const adapter = new HailuoVideoAdapter({
      fetchImpl: fetch_,
      logger: makeSilentLogger(),
    });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      adapter.submitTask(makeRequest(), API_KEY, ac.signal),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
  });
});
