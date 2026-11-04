import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import {
  FILE_REF_SCHEME,
  MIN_UPLOAD_BYTES,
  base64ByteLength,
  patchMediaBlocks,
  purposeForMediaType,
} from './domain/files-api.js';

const big = Buffer.alloc(MIN_UPLOAD_BYTES + 10, 1).toString('base64');
const small = Buffer.alloc(10, 1).toString('base64');

const image = (data: string, media_type = 'image/png'): Record<string, unknown> => ({
  type: 'image',
  source: { type: 'base64', media_type, data },
});

describe('files-api patching', () => {
  it('replaces a large inline image with a reference', async () => {
    const block = image(big);
    const n = await patchMediaBlocks([{ content: [block] }], () => Promise.resolve('42'));
    strictEqual(n, 1);
    deepStrictEqual(block['source'], { type: 'url', url: `${FILE_REF_SCHEME}42` });
  });

  it('leaves small media inline without uploading', async () => {
    let calls = 0;
    const block = image(small);
    await patchMediaBlocks([{ content: [block] }], () => {
      calls += 1;
      return Promise.resolve('1');
    });
    strictEqual(calls, 0);
    strictEqual((block['source'] as { type: string }).type, 'base64');
  });

  it('is fail-open: no id keeps the inline block', async () => {
    const block = image(big);
    const n = await patchMediaBlocks([{ content: [block] }], () => Promise.resolve(undefined));
    strictEqual(n, 0);
    strictEqual((block['source'] as { type: string }).type, 'base64');
  });

  it('reaches media nested inside tool_result content', async () => {
    const block = image(big);
    const n = await patchMediaBlocks(
      [{ content: [{ type: 'tool_result', tool_use_id: 'x', content: [block] }] }],
      () => Promise.resolve('7'),
    );
    strictEqual(n, 1);
  });

  it('ignores string content and url-sourced blocks', async () => {
    const urlBlock = { type: 'image', source: { type: 'url', url: 'https://x/y.png' } };
    const n = await patchMediaBlocks([{ content: 'hi' }, { content: [urlBlock] }], () =>
      Promise.resolve('1'),
    );
    strictEqual(n, 0);
  });

  it('maps media types to upload purposes', () => {
    strictEqual(purposeForMediaType('image', 'image/jpeg'), 'image_understanding');
    strictEqual(purposeForMediaType('video', 'video/mp4'), 'video_understanding');
    strictEqual(purposeForMediaType('image', 'application/pdf'), undefined);
  });

  it('computes decoded length from base64', () => {
    strictEqual(base64ByteLength(Buffer.alloc(100).toString('base64')), 100);
    strictEqual(base64ByteLength(Buffer.alloc(101).toString('base64')), 101);
  });
});
