/**
 * Domain unit tests for per-model video capability rules (T36).
 *
 * Pure-data tests for `media-capability.ts`. Pin the per-model rules
 * so a MiniMax docs update that wants to lift a cap has to update
 * both the table and these assertions together.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  VIDEO_CAPABILITIES,
  evaluateVideoCapability,
  validateVideoRequestForModel,
} from './media-capability.js';

describe('VIDEO_CAPABILITIES table', () => {
  it('ships exactly H3 and H3-Max', () => {
    assert.deepEqual(Object.keys(VIDEO_CAPABILITIES).sort(), ['MiniMax-H3', 'MiniMax-H3-Max']);
  });

  it('H3 does NOT support subject reference', () => {
    assert.equal(VIDEO_CAPABILITIES['MiniMax-H3'].supportsSubjectReference, false);
  });

  it('H3-Max DOES support subject reference', () => {
    assert.equal(VIDEO_CAPABILITIES['MiniMax-H3-Max'].supportsSubjectReference, true);
  });

  it('H3 allows at most 1 reference image', () => {
    assert.equal(VIDEO_CAPABILITIES['MiniMax-H3'].maxReferenceImages, 1);
  });

  it('H3-Max allows up to 4 reference images', () => {
    assert.equal(VIDEO_CAPABILITIES['MiniMax-H3-Max'].maxReferenceImages, 4);
  });

  it('both models support first/last frame conditioning', () => {
    for (const m of ['MiniMax-H3', 'MiniMax-H3-Max'] as const) {
      assert.equal(VIDEO_CAPABILITIES[m].supportsFirstFrame, true, `${m} firstFrame`);
      assert.equal(VIDEO_CAPABILITIES[m].supportsLastFrame, true, `${m} lastFrame`);
    }
  });

  it('both models allow 6s and 10s durations', () => {
    for (const m of ['MiniMax-H3', 'MiniMax-H3-Max'] as const) {
      // Numeric sort — default Array.sort() does string compare, which
      // would reorder [6, 10] into [10, 6] ('10' < '6' lexicographically).
      const sorted = [...VIDEO_CAPABILITIES[m].allowedDurations].sort((a, b) => a - b);
      assert.deepEqual(sorted, [6, 10], `${m} allowedDurations`);
    }
  });
});

describe('evaluateVideoCapability', () => {
  it('returns H3 capability for MiniMax-H3', () => {
    const r = evaluateVideoCapability('MiniMax-H3');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.capability.displayName, VIDEO_CAPABILITIES['MiniMax-H3'].displayName);
  });

  it('returns H3-Max capability for MiniMax-H3-Max', () => {
    const r = evaluateVideoCapability('MiniMax-H3-Max');
    assert.equal(r.ok, true);
    if (r.ok)
      assert.equal(r.capability.displayName, VIDEO_CAPABILITIES['MiniMax-H3-Max'].displayName);
  });

  it('returns an error for unknown model ids', () => {
    const r = evaluateVideoCapability('MiniMax-M3');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown video model/);
  });

  it('returns an error for chat models like M3', () => {
    const r = evaluateVideoCapability('MiniMax-M3.1-Flash-Preview');
    assert.equal(r.ok, false);
  });
});

describe('validateVideoRequestForModel', () => {
  it('accepts a minimal H3 request', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3',
      prompt: 'a turtle',
      durationSec: 6,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.request.model, 'MiniMax-H3');
      assert.equal(r.request.prompt, 'a turtle');
    }
  });

  it('rejects H3 with subject-reference images', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3',
      prompt: 'a turtle',
      durationSec: 6,
      referenceImageUris: ['file://ref.png'],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /subject-reference/);
  });

  it('accepts H3-Max with up to 4 reference images', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3-Max',
      prompt: 'a turtle',
      durationSec: 10,
      referenceImageUris: ['file://r1', 'file://r2', 'file://r3', 'file://r4'],
    });
    assert.equal(r.ok, true);
  });

  it('rejects H3-Max with 5 reference images (cross-model cap)', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3-Max',
      prompt: 'a turtle',
      durationSec: 10,
      referenceImageUris: ['a', 'b', 'c', 'd', 'e'],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at most/);
  });

  it('rejects duration 5 (cross-model rule)', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3',
      prompt: 'a turtle',
      durationSec: 5,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /6 or 10/);
  });

  it('counts first/last frame toward the reference cap (H3 = 1)', () => {
    // H3 allows 1 reference image. firstFrame + lastFrame is 2.
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3',
      prompt: 'a turtle',
      durationSec: 6,
      firstFrameImageUri: 'file://first.png',
      lastFrameImageUri: 'file://last.png',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /at most 1 reference/);
  });

  it('counts first/last frame toward the reference cap (H3-Max = 4)', () => {
    // H3-Max allows 4. firstFrame + lastFrame + 2 reference = 4 → ok.
    const r = validateVideoRequestForModel({
      model: 'MiniMax-H3-Max',
      prompt: 'a turtle',
      durationSec: 6,
      firstFrameImageUri: 'file://first.png',
      lastFrameImageUri: 'file://last.png',
      referenceImageUris: ['file://r1', 'file://r2'],
    });
    assert.equal(r.ok, true);
  });

  it('rejects unknown model ids', () => {
    const r = validateVideoRequestForModel({
      model: 'MiniMax-M3',
      prompt: 'a turtle',
      durationSec: 6,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /MiniMax-H3/);
  });
});
