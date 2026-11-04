import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { FilesApiUploader } from './files-api-adapter.js';
import type { Logger } from '../ports/logger.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const media = { mediaType: 'image/png', data: 'AAAA', purpose: 'image_understanding' } as const;

function uploader(respond: () => Response, counter: { n: number }, now = () => 0): FilesApiUploader {
  return new FilesApiUploader({
    baseUrl: () => 'https://api.minimax.io/',
    logger,
    now,
    fetchImpl: () => {
      counter.n += 1;
      return Promise.resolve(respond());
    },
  });
}

const ok = (): Response =>
  new Response(
    JSON.stringify({ file: { file_id: 459588355547617 }, base_resp: { status_code: 0 } }),
  );

describe('FilesApiUploader', () => {
  it('returns the numeric file id as a string and caches it', async () => {
    const counter = { n: 0 };
    const u = uploader(ok, counter);
    strictEqual(await u.upload('k', media), '459588355547617');
    strictEqual(await u.upload('k', media), '459588355547617');
    strictEqual(counter.n, 1);
  });

  it('re-uploads after the cache entry expires', async () => {
    const counter = { n: 0 };
    let t = 0;
    const u = uploader(ok, counter, () => t);
    await u.upload('k', media);
    t = 43_200_001;
    await u.upload('k', media);
    strictEqual(counter.n, 2);
  });

  it('fails open on a non-2xx response', async () => {
    const u = uploader(() => new Response('no', { status: 401 }), { n: 0 });
    strictEqual(await u.upload('k', media), undefined);
  });

  it('fails open on a non-zero base_resp status', async () => {
    const u = uploader(
      () => new Response(JSON.stringify({ base_resp: { status_code: 1004 } })),
      { n: 0 },
    );
    strictEqual(await u.upload('k', media), undefined);
  });

  it('fails open when fetch throws', async () => {
    const u = new FilesApiUploader({
      baseUrl: () => 'https://x',
      logger,
      fetchImpl: () => Promise.reject(new TypeError('boom')),
    });
    strictEqual(await u.upload('k', media), undefined);
  });
});
