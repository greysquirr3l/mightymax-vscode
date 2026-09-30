/**
 * Domain unit tests for media types and validation (T36).
 *
 * Pure-data tests — no vscode, no HTTP. These pin the cross-model
 * validation rules in `media.ts` (prompt length cap, reference
 * image count cap, required fields) and the rendering helpers used
 * by the tool + command adapters.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  VIDEO_PROMPT_MAX_CHARS,
  VIDEO_REFERENCE_MAX_IMAGES,
  renderVideoNotificationBody,
  renderVideoToolError,
  renderVideoToolResult,
  validateVideoRequest,
  type VideoRequest,
  type VideoResult,
} from './media.js';

describe('validateVideoRequest', () => {
  const valid: VideoRequest = {
    model: 'MiniMax-H3',
    prompt: 'A giant turtle swimming through a coral reef at sunrise',
    durationSec: 6,
  };

  it('accepts a minimal valid request', () => {
    const result = validateVideoRequest(valid);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.normalizedPrompt, valid.prompt);
    }
  });

  it('trims whitespace from the prompt', () => {
    const result = validateVideoRequest({ ...valid, prompt: '  hello world  ' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.normalizedPrompt, 'hello world');
  });

  it('rejects a non-object payload', () => {
    const result = validateVideoRequest('not an object');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /object/);
  });

  it('rejects unknown model ids', () => {
    const result = validateVideoRequest({ ...valid, model: 'MiniMax-M3' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /MiniMax-H3/);
  });

  it('rejects durationSec other than 6 or 10', () => {
    const r1 = validateVideoRequest({ ...valid, durationSec: 5 });
    const r2 = validateVideoRequest({ ...valid, durationSec: 30 });
    const r3 = validateVideoRequest({ ...valid, durationSec: '6' });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, false);
  });

  it('rejects an empty prompt', () => {
    const result = validateVideoRequest({ ...valid, prompt: '   ' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /empty/);
  });

  it('rejects a prompt that exceeds VIDEO_PROMPT_MAX_CHARS', () => {
    const huge = 'a'.repeat(VIDEO_PROMPT_MAX_CHARS + 1);
    const result = validateVideoRequest({ ...valid, prompt: huge });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /exceeds/);
  });

  it('accepts a prompt exactly at the limit', () => {
    const exact = 'a'.repeat(VIDEO_PROMPT_MAX_CHARS);
    const result = validateVideoRequest({ ...valid, prompt: exact });
    assert.equal(result.ok, true);
  });

  it('rejects firstFrameImageUri when not a non-empty string', () => {
    const r1 = validateVideoRequest({ ...valid, firstFrameImageUri: '' });
    const r2 = validateVideoRequest({ ...valid, firstFrameImageUri: 42 });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
  });

  it('rejects lastFrameImageUri when not a non-empty string', () => {
    const r1 = validateVideoRequest({ ...valid, lastFrameImageUri: '' });
    assert.equal(r1.ok, false);
  });

  it('rejects referenceImageUris that is not an array', () => {
    const result = validateVideoRequest({ ...valid, referenceImageUris: 'nope' });
    assert.equal(result.ok, false);
  });

  it(`rejects more than ${VIDEO_REFERENCE_MAX_IMAGES} reference images`, () => {
    const refs = Array.from({ length: VIDEO_REFERENCE_MAX_IMAGES + 1 }, (_, i) => `file://r${i}`);
    const result = validateVideoRequest({ ...valid, referenceImageUris: refs });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /at most/);
  });

  it('accepts exactly VIDEO_REFERENCE_MAX_IMAGES reference images', () => {
    const refs = Array.from({ length: VIDEO_REFERENCE_MAX_IMAGES }, (_, i) => `file://r${i}`);
    const result = validateVideoRequest({ ...valid, referenceImageUris: refs });
    assert.equal(result.ok, true);
  });

  it('rejects reference URIs that are not non-empty strings', () => {
    const result = validateVideoRequest({ ...valid, referenceImageUris: ['file://ok', ''] });
    assert.equal(result.ok, false);
  });

  it('accepts a fully-loaded request', () => {
    const result = validateVideoRequest({
      ...valid,
      firstFrameImageUri: 'file://first.png',
      lastFrameImageUri: 'file://last.png',
      referenceImageUris: ['file://ref1.png'],
    });
    assert.equal(result.ok, true);
  });
});

describe('renderVideoToolResult', () => {
  const result: VideoResult = {
    model: 'MiniMax-H3',
    durationSec: 10,
    taskId: 'task-abc',
    absolutePath: '/Users/me/storage/mighty-max/media/h3-2026-09-30.mp4',
    sizeBytes: 12_582_912,
    mime: 'video/mp4',
  };

  it('includes the model id', () => {
    assert.match(renderVideoToolResult(result), /MiniMax-H3/);
  });
  it('includes the duration', () => {
    assert.match(renderVideoToolResult(result), /10s/);
  });
  it('includes the absolute path', () => {
    assert.ok(renderVideoToolResult(result).includes(result.absolutePath));
  });
  it('includes the task id', () => {
    assert.match(renderVideoToolResult(result), /task-abc/);
  });
  it('includes a human-readable size', () => {
    assert.match(renderVideoToolResult(result), /MB/);
  });
  it('returns a single line (no embedded newlines)', () => {
    assert.equal(renderVideoToolResult(result).includes('\n'), false);
  });
});

describe('renderVideoNotificationBody', () => {
  it('includes the model id, duration, size, and path', () => {
    const body = renderVideoNotificationBody({
      model: 'MiniMax-H3-Max',
      durationSec: 6,
      taskId: 't1',
      absolutePath: '/x.mp4',
      sizeBytes: 1024,
      mime: 'video/mp4',
    });
    assert.match(body, /MiniMax-H3-Max/);
    assert.match(body, /6s/);
    assert.match(body, /1\.0 KB/);
    assert.match(body, /\/x\.mp4/);
  });
});

describe('renderVideoToolError', () => {
  it('includes both the error code and the message', () => {
    const text = renderVideoToolError('1026', 'video description contains sensitive content');
    assert.match(text, /1026/);
    assert.match(text, /sensitive content/);
  });
});
