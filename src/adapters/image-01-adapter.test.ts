/**
 * Unit tests for Image01Adapter.
 *
 * Stubbed `fetch` throughout — the suite never touches the real
 * MiniMax endpoint.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_IMAGE_BASE_URL,
  Image01Adapter,
  ImageGenerationError,
  buildGenerateBody,
  type FetchLike,
} from './image-01-adapter.js';
import type { Logger } from '../ports/logger.js';
import type { ImageRequest } from '../lib/domain/image.js';

const API_KEY = 'sk-test-key';

function logger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function req(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return { model: 'image-01', prompt: 'a neon crab', ...overrides };
}

/** base64 for the 3 bytes 0x00 0x01 0x02. */
const B64 = 'AAEC';

class Scripted {
  readonly calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  private readonly queue: Array<() => Response> = [];

  json(status: number, body: unknown): this {
    this.queue.push(
      () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );
    return this;
  }

  bytes(status: number, b: Uint8Array, type = 'image/png'): this {
    this.queue.push(() => new Response(b, { status, headers: { 'content-type': type } }));
    return this;
  }

  fetch: FetchLike = async (url, init) => {
    this.calls.push({ url: String(url), init });
    const next = this.queue.shift();
    if (!next) throw new Error(`Scripted: no response for ${String(url)}`);
    return next();
  };
}

describe('buildGenerateBody', () => {
  it('requests base64 up front (the spec warns URLs expire in 24h)', () => {
    const body = buildGenerateBody(req());
    assert.equal(body['response_format'], 'base64');
  });

  it('emits aspect_ratio when no explicit dimensions', () => {
    const body = buildGenerateBody(req({ aspectRatio: '16:9' }));
    assert.equal(body['aspect_ratio'], '16:9');
    assert.equal(body['width'], undefined);
  });

  it('emits width/height and omits aspect_ratio when dimensions are given', () => {
    const body = buildGenerateBody(req({ width: 1024, height: 768 }));
    assert.equal(body['width'], 1024);
    assert.equal(body['height'], 768);
    assert.equal(body['aspect_ratio'], undefined);
  });

  it('includes n / seed / prompt_optimizer only when set', () => {
    const bare = buildGenerateBody(req());
    assert.equal(bare['n'], undefined);
    assert.equal(bare['seed'], undefined);
    assert.equal(bare['prompt_optimizer'], undefined);

    const full = buildGenerateBody(req({ count: 3, seed: 7, promptOptimizer: true }));
    assert.equal(full['n'], 3);
    assert.equal(full['seed'], 7);
    assert.equal(full['prompt_optimizer'], true);
  });
});

describe('Image01Adapter.generate', () => {
  it('POSTs to /v1/image_generation with bearer auth', async () => {
    const s = new Scripted().json(200, {
      data: { image_base64: [B64] },
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await adapter.generate(req(), API_KEY, new AbortController().signal);
    assert.equal(s.calls[0]?.url, `${DEFAULT_IMAGE_BASE_URL}/v1/image_generation`);
    const headers = s.calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Bearer ${API_KEY}`);
    assert.equal(s.calls[0]?.init?.method, 'POST');
  });

  it('decodes base64 image bytes', async () => {
    const s = new Scripted().json(200, {
      data: { image_base64: [B64] },
      base_resp: { status_code: 0 },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    const out = await adapter.generate(req(), API_KEY, new AbortController().signal);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.bytes.length, 3);
    assert.equal(out[0]?.bytes[0], 0);
    assert.equal(out[0]?.bytes[2], 2);
    assert.equal(out[0]?.mime, 'image/png');
  });

  it('returns multiple images in response order', async () => {
    const s = new Scripted().json(200, {
      data: { image_base64: [B64, B64, B64] },
      base_resp: { status_code: 0 },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    const out = await adapter.generate(req({ count: 3 }), API_KEY, new AbortController().signal);
    assert.equal(out.length, 3);
  });

  it('falls back to downloading image_urls when the server returns them', async () => {
    const s = new Scripted()
      .json(200, {
        data: { image_urls: ['https://cdn.example.com/a.png'] },
        base_resp: { status_code: 0 },
      })
      .bytes(200, new Uint8Array([9, 9]), 'image/png');
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    const out = await adapter.generate(req(), API_KEY, new AbortController().signal);
    assert.equal(out[0]?.sourceUrl, 'https://cdn.example.com/a.png');
    assert.equal(out[0]?.bytes.length, 2);
  });

  it('maps base_resp 1026 to a sensitive-content error', async () => {
    const s = new Scripted().json(200, {
      data: {},
      base_resp: { status_code: 1026, status_msg: 'sensitive' },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'sensitive',
    );
  });

  it('maps base_resp 1002 to a rate-limit error', async () => {
    const s = new Scripted().json(200, {
      data: {},
      base_resp: { status_code: 1002, status_msg: 'rate limit' },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'rate-limit',
    );
  });

  it('maps base_resp 1008 to insufficient-balance', async () => {
    const s = new Scripted().json(200, {
      data: {},
      base_resp: { status_code: 1008, status_msg: 'no balance' },
    });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'insufficient-balance',
    );
  });

  it('maps HTTP 401 to an auth error', async () => {
    const s = new Scripted().json(401, {});
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'auth',
    );
  });

  it('maps a non-JSON 200 to a parse error', async () => {
    const s = new Scripted().json(200, 'not-an-object');
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'parse',
    );
  });

  it('rejects a 200 with neither image_base64 nor image_urls', async () => {
    const s = new Scripted().json(200, { data: {}, base_resp: { status_code: 0 } });
    const adapter = new Image01Adapter({ fetchImpl: s.fetch, logger: logger() });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'parse',
    );
  });

  it('maps a fetch rejection to a network error', async () => {
    const adapter = new Image01Adapter({
      fetchImpl: async () => {
        throw new TypeError('terminated');
      },
      logger: logger(),
    });
    await assert.rejects(
      adapter.generate(req(), API_KEY, new AbortController().signal),
      (e: unknown) => e instanceof ImageGenerationError && e.kind === 'network',
    );
  });

  it('honours an already-aborted signal', async () => {
    const adapter = new Image01Adapter({ fetchImpl: s_abort(), logger: logger() });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      adapter.generate(req(), API_KEY, ac.signal),
      (e: unknown) => e instanceof Error && e.name === 'AbortError',
    );
  });
});

function s_abort(): FetchLike {
  return async (_url, init) => {
    const sig: AbortSignal | null | undefined = init?.signal ?? undefined;
    if (sig?.aborted === true) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Response('{}', { status: 200 });
  };
}
