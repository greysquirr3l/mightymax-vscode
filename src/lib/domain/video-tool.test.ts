/**
 * Domain unit tests for the `mightyMax_generateVideo` tool
 * descriptor and validation (T36).
 *
 * Pure-data tests — no vscode, no HTTP. The descriptor is what
 * ends up in `package.json` `languageModelTools` and in the
 * runtime `vscode.lm.registerTool(...)` call, so these assertions
 * also pin the manifest contract.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MIGHTYMAX_GENERATE_VIDEO_TOOL,
  SUPPORTED_VIDEO_MODELS,
  buildGenerateVideoDescriptor,
  renderGenerateVideoToolError,
  renderGenerateVideoToolResult,
  validateVideoToolInput,
} from './video-tool.js';
import type { VideoResult } from './media.js';

describe('buildGenerateVideoDescriptor', () => {
  it('uses the canonical tool name', () => {
    const d = buildGenerateVideoDescriptor();
    assert.equal(d.name, MIGHTYMAX_GENERATE_VIDEO_TOOL);
    assert.equal(d.toolReferenceName, MIGHTYMAX_GENERATE_VIDEO_TOOL);
  });

  it('includes the minimax + media + video tags', () => {
    const d = buildGenerateVideoDescriptor();
    assert.ok(d.tags.includes('minimax'));
    assert.ok(d.tags.includes('media'));
    assert.ok(d.tags.includes('video'));
  });

  it('input schema requires model + prompt + durationSec', () => {
    const d = buildGenerateVideoDescriptor();
    assert.deepEqual([...d.inputSchema.required].sort(), ['durationSec', 'model', 'prompt']);
  });

  it('input schema is a closed object (no additionalProperties)', () => {
    // The manifest schema for `languageModelTools[].inputSchema`
    // rejects `additionalProperties`, and `sanitizeAnthropicSchema`
    // strips `additionalProperties: false` before the wire anyway —
    // so carrying it was dead weight on both ends. Unrecognised
    // keys are dropped by `validateVideoToolInput` regardless,
    // which is the behaviour that actually protects the request.
    const d = buildGenerateVideoDescriptor();
    assert.equal(
      Object.hasOwn(d.inputSchema, 'additionalProperties'),
      false,
      'additionalProperties must not be emitted',
    );
  });

  it('input schema constrains durationSec to 6 or 10', () => {
    const d = buildGenerateVideoDescriptor();
    const dur = d.inputSchema.properties['durationSec'] as { enum?: ReadonlyArray<number> };
    assert.deepEqual(
      [...(dur.enum ?? [])].sort((a, b) => a - b),
      [6, 10],
    );
  });

  it('input schema constrains model to H3 / H3-Max', () => {
    const d = buildGenerateVideoDescriptor();
    const model = d.inputSchema.properties['model'] as { enum?: ReadonlyArray<string> };
    assert.deepEqual([...(model.enum ?? [])].sort(), ['MiniMax-H3', 'MiniMax-H3-Max']);
  });
});

describe('SUPPORTED_VIDEO_MODELS', () => {
  it('lists H3 and H3-Max in deterministic order', () => {
    assert.deepEqual([...SUPPORTED_VIDEO_MODELS].sort(), ['MiniMax-H3', 'MiniMax-H3-Max']);
  });
});

describe('validateVideoToolInput', () => {
  const valid = {
    model: 'MiniMax-H3',
    prompt: 'a giant turtle swimming through a coral reef',
    durationSec: 6,
  };

  it('accepts a minimal valid input', () => {
    const r = validateVideoToolInput(valid);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.normalized.prompt, valid.prompt);
  });

  it('rejects non-object inputs', () => {
    assert.equal(validateVideoToolInput('nope').ok, false);
    assert.equal(validateVideoToolInput(42).ok, false);
  });

  it('rejects firstFrameImageUri longer than the URI cap', async () => {
    const { VIDEO_REFERENCE_URI_MAX_CHARS } = await import('./video-tool.js');
    const huge = 'x'.repeat(VIDEO_REFERENCE_URI_MAX_CHARS + 1);
    const r = validateVideoToolInput({ ...valid, firstFrameImageUri: huge });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /firstFrameImageUri/);
  });

  it('rejects H3 with subject-reference images (per-model rule)', () => {
    const r = validateVideoToolInput({
      ...valid,
      referenceImageUris: ['file://ref.png'],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /subject-reference/);
  });

  it('accepts H3-Max with a full reference image list', () => {
    const r = validateVideoToolInput({
      model: 'MiniMax-H3-Max',
      prompt: 'a turtle',
      durationSec: 10,
      referenceImageUris: ['file://r1', 'file://r2', 'file://r3', 'file://r4'],
    });
    assert.equal(r.ok, true);
  });
});

describe('renderGenerateVideoToolResult', () => {
  const result: VideoResult = {
    model: 'MiniMax-H3-Max',
    durationSec: 10,
    taskId: 'task-xyz',
    absolutePath: '/tmp/media/h3max-2026-09-30-abcd.mp4',
    sizeBytes: 5_242_880,
    mime: 'video/mp4',
  };

  it('returns a single-line string with model + path + size', () => {
    const text = renderGenerateVideoToolResult(result);
    assert.equal(text.includes('\n'), false);
    assert.match(text, /MiniMax-H3-Max/);
    assert.ok(text.includes(result.absolutePath));
    assert.match(text, /5\.0 MB/);
  });
});

describe('renderGenerateVideoToolError', () => {
  it('includes both code and message', () => {
    const text = renderGenerateVideoToolError('1026', 'sensitive content');
    assert.match(text, /1026/);
    assert.match(text, /sensitive content/);
  });
});
