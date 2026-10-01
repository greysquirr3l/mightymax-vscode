/**
 * Domain unit tests for image types and validation (T36).
 *
 * Every expectation here is transcribed from the MiniMax Image
 * Generation OpenAPI spec
 * (`api-reference/image/generation/api/text-to-image.json`):
 * prompt max 1500; aspect_ratio enum of 8; width/height range
 * [512, 2048] divisible by 8; n range [1, 9]; response defaults
 * aspect_ratio=1:1, n=1, prompt_optimizer=false.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  IMAGE_ASPECT_DIMENSIONS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_COUNT_MAX,
  IMAGE_PROMPT_MAX_CHARS,
  renderImageNotificationBody,
  renderImageToolError,
  renderImageToolResult,
  validateImageRequest,
  type ImageResult,
} from './image.js';

const base = { model: 'image-01', prompt: 'a neon crab' } as const;

describe('validateImageRequest — defaults', () => {
  it('fills spec defaults for a minimal request', () => {
    const r = validateImageRequest(base);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.normalized.aspectRatio, '1:1');
      assert.equal(r.normalized.count, 1);
      assert.equal(r.normalized.promptOptimizer, false);
      assert.equal(r.normalized.prompt, 'a neon crab');
    }
  });

  it('trims the prompt', () => {
    const r = validateImageRequest({ ...base, prompt: '  padded  ' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.normalized.prompt, 'padded');
  });
});

describe('validateImageRequest — rejections', () => {
  it('rejects a non-object', () => {
    assert.equal(validateImageRequest('x').ok, false);
    assert.equal(validateImageRequest(null).ok, false);
  });

  it('rejects an unknown model', () => {
    const r = validateImageRequest({ ...base, model: 'image-99' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /image-01/);
  });

  it('rejects an empty prompt', () => {
    const r = validateImageRequest({ ...base, prompt: '   ' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /empty/);
  });

  it(`rejects a prompt over ${IMAGE_PROMPT_MAX_CHARS} chars`, () => {
    const r = validateImageRequest({ ...base, prompt: 'a'.repeat(IMAGE_PROMPT_MAX_CHARS + 1) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /exceeds/);
  });

  it('accepts a prompt exactly at the limit', () => {
    const r = validateImageRequest({ ...base, prompt: 'a'.repeat(IMAGE_PROMPT_MAX_CHARS) });
    assert.equal(r.ok, true);
  });

  it('rejects an unknown aspect ratio', () => {
    const r = validateImageRequest({ ...base, aspectRatio: '5:4' });
    assert.equal(r.ok, false);
  });

  it('accepts every documented aspect ratio', () => {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      const r = validateImageRequest({ ...base, aspectRatio: ratio });
      assert.equal(r.ok, true, `${ratio} must be accepted`);
    }
  });

  it('documents pixel dimensions for all 8 ratios', () => {
    assert.equal(Object.keys(IMAGE_ASPECT_DIMENSIONS).length, 8);
  });
});

describe('validateImageRequest — width/height', () => {
  it('requires width and height together', () => {
    const onlyW = validateImageRequest({ ...base, width: 1024 });
    const onlyH = validateImageRequest({ ...base, height: 1024 });
    assert.equal(onlyW.ok, false);
    assert.equal(onlyH.ok, false);
  });

  it('rejects dimensions out of the 512-2048 range', () => {
    assert.equal(validateImageRequest({ ...base, width: 256, height: 256 }).ok, false);
    assert.equal(validateImageRequest({ ...base, width: 4096, height: 4096 }).ok, false);
  });

  it('rejects dimensions not divisible by 8', () => {
    const r = validateImageRequest({ ...base, width: 1023, height: 1023 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /divisible by 8/);
  });

  it('accepts divisible in-range dimensions', () => {
    const r = validateImageRequest({ ...base, width: 1024, height: 768 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.normalized.width, 1024);
      assert.equal(r.normalized.height, 768);
    }
  });

  it('rejects non-integer dimensions', () => {
    assert.equal(validateImageRequest({ ...base, width: 1024.5, height: 768 }).ok, false);
  });

  it('rejects width+height together with aspectRatio (spec says aspect wins)', () => {
    // The spec says "If both width/height and aspect_ratio are
    // provided, aspect_ratio takes precedence" — which would
    // silently discard the caller's dimensions. We reject instead
    // of picking a winner.
    const r = validateImageRequest({
      ...base,
      width: 1024,
      height: 768,
      aspectRatio: '16:9',
    });
    assert.equal(r.ok, false);
  });
});

describe('validateImageRequest — count / seed / optimizer', () => {
  it('accepts count 1 through 9', () => {
    assert.equal(validateImageRequest({ ...base, count: 1 }).ok, true);
    assert.equal(validateImageRequest({ ...base, count: IMAGE_COUNT_MAX }).ok, true);
  });

  it('rejects count outside 1-9', () => {
    assert.equal(validateImageRequest({ ...base, count: 0 }).ok, false);
    assert.equal(validateImageRequest({ ...base, count: 10 }).ok, false);
  });

  it('rejects a non-integer count', () => {
    assert.equal(validateImageRequest({ ...base, count: 2.5 }).ok, false);
  });

  it('accepts an integer seed', () => {
    const r = validateImageRequest({ ...base, seed: 42 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.normalized.seed, 42);
  });

  it('rejects a non-integer seed', () => {
    assert.equal(validateImageRequest({ ...base, seed: 1.5 }).ok, false);
  });

  it('rejects a non-boolean promptOptimizer', () => {
    assert.equal(validateImageRequest({ ...base, promptOptimizer: 'yes' }).ok, false);
  });
});

describe('image renderers', () => {
  const result: ImageResult = {
    model: 'image-01',
    prompt: 'a neon crab',
    aspectRatio: '16:9',
    absolutePaths: ['/tmp/media/image01-a.png'],
    totalSizeBytes: 2_097_152,
    mime: 'image/png',
  };

  it('tool result is a single line naming the dimensions and path', () => {
    const text = renderImageToolResult(result);
    assert.equal(text.includes('\n'), false);
    assert.ok(text.includes('1280x720'));
    assert.ok(text.includes('/tmp/media/image01-a.png'));
    assert.ok(text.includes('2.00 MB'));
  });

  it('tool result uses the singular for one image', () => {
    assert.match(renderImageToolResult(result), /1 image\b/);
  });

  it('tool result pluralises for multiple images', () => {
    const two = { ...result, absolutePaths: ['/a.png', '/b.png'], totalSizeBytes: 100 };
    assert.match(renderImageToolResult(two), /2 images/);
    assert.ok(renderImageToolResult(two).includes('/a.png, /b.png'));
  });

  it('notification body is multi-line and lists every path', () => {
    const two = { ...result, absolutePaths: ['/a.png', '/b.png'] };
    const body = renderImageNotificationBody(two);
    assert.ok(body.includes('/a.png'));
    assert.ok(body.includes('/b.png'));
  });

  it('error renderer includes code and message', () => {
    const text = renderImageToolError('1026', 'sensitive prompt');
    assert.match(text, /1026/);
    assert.match(text, /sensitive prompt/);
  });
});
