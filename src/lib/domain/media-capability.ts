/**
 * Domain: per-model video generation capability rules (pure).
 *
 * T36 — different H3 / H3-Max variants support different reference
 * shapes and durations. This module is the single source of truth so
 * the tool descriptor, command UI, and adapter all reference the same
 * allowed-duration lists and reference-image caps.
 *
 * The rules below mirror MiniMax's published docs for the Hailuo-03
 * video endpoint as of 2026-09-30. When MiniMax publishes a new
 * variant, add an entry here and the rest of the pipeline picks it up.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

import type { VideoDurationSec, VideoModelId, VideoRequest } from './media.js';
import { validateVideoRequest } from './media.js';

export interface VideoCapability {
  /** Durations the model can emit. */
  readonly allowedDurations: ReadonlyArray<VideoDurationSec>;
  /** Maximum number of reference / conditioning images the model accepts. */
  readonly maxReferenceImages: number;
  /** Whether the model supports a `firstFrameImageUri` (i2v conditioning). */
  readonly supportsFirstFrame: boolean;
  /** Whether the model supports a `lastFrameImageUri` (start-end-to-video). */
  readonly supportsLastFrame: boolean;
  /**
   * Whether the model supports a list of `referenceImageUris` for
   * subject-reference video generation. Only H3-Max ships this.
   */
  readonly supportsSubjectReference: boolean;
  /** Picker display name (matches the MiniMax docs). */
  readonly displayName: string;
  /** Short description for the picker / command UI. */
  readonly description: string;
}

/**
 * Authoritative capability table. Keep entries alphabetised by model
 * id so the diff for adding a new variant is obvious.
 */
export const VIDEO_CAPABILITIES: Readonly<Record<VideoModelId, VideoCapability>> = Object.freeze({
  'MiniMax-H3': Object.freeze<VideoCapability>({
    allowedDurations: Object.freeze<VideoDurationSec[]>([6, 10]),
    maxReferenceImages: 1,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsSubjectReference: false,
    displayName: 'Hailuo-03 (H3)',
    description: 'MiniMax H3 / Hailuo-03 — fast, image-to-video capable.',
  }),
  'MiniMax-H3-Max': Object.freeze<VideoCapability>({
    allowedDurations: Object.freeze<VideoDurationSec[]>([6, 10]),
    maxReferenceImages: 4,
    supportsFirstFrame: true,
    supportsLastFrame: true,
    supportsSubjectReference: true,
    displayName: 'Hailuo-03 Max (H3-Max)',
    description:
      'MiniMax H3-Max / Hailuo-03 Max — subject-reference video, up to 4 reference images.',
  }),
});

/** Result of capability lookup; `undefined` means "unknown model". */
export type VideoCapabilityLookup =
  | { readonly ok: true; readonly capability: VideoCapability }
  | { readonly ok: false; readonly error: string };

/**
 * Look up the capability record for a model id. Returns an error
 * string (rather than `undefined`) so the caller can surface a
 * user-facing message without re-formatting.
 */
export function evaluateVideoCapability(modelId: string): VideoCapabilityLookup {
  if (modelId !== 'MiniMax-H3' && modelId !== 'MiniMax-H3-Max') {
    return {
      ok: false,
      error: `Unknown video model "${modelId}". Supported: MiniMax-H3, MiniMax-H3-Max.`,
    };
  }
  return { ok: true, capability: VIDEO_CAPABILITIES[modelId] };
}

/**
 * Combined validation: cross-model rules from `validateVideoRequest`
 * plus the per-model rules below. Pure — no I/O.
 */
export type VideoRequestValidationResult =
  | { readonly ok: true; readonly request: VideoRequest }
  | { readonly ok: false; readonly error: string };

export function validateVideoRequestForModel(raw: unknown): VideoRequestValidationResult {
  // First enforce the cross-model rules so we can trust the shape.
  const cross = validateVideoRequestShim(raw);
  if (!cross.ok) return cross;
  const req = cross.request;

  const cap = VIDEO_CAPABILITIES[req.model];
  if (!cap.allowedDurations.includes(req.durationSec)) {
    return {
      ok: false,
      error: `${req.model} does not support duration ${req.durationSec}s (allowed: ${cap.allowedDurations.join(', ')})`,
    };
  }
  const refCount =
    (req.firstFrameImageUri !== undefined ? 1 : 0) +
    (req.lastFrameImageUri !== undefined ? 1 : 0) +
    (req.referenceImageUris?.length ?? 0);
  if (refCount > cap.maxReferenceImages) {
    return {
      ok: false,
      error: `${req.model} accepts at most ${cap.maxReferenceImages} reference image(s) (got ${refCount})`,
    };
  }
  if (req.referenceImageUris !== undefined && !cap.supportsSubjectReference) {
    return {
      ok: false,
      error: `${req.model} does not support subject-reference video (use ${'MiniMax-H3-Max'} instead)`,
    };
  }
  return { ok: true, request: req };
}

/**
 * Internal shim that delegates to `validateVideoRequest` from
 * `./media.js` but rebuilds a fully-typed `VideoRequest` instead of
 * returning the loose `normalizedPrompt` payload. Kept inline so the
 * validation lives in one place.
 */
function validateVideoRequestShim(raw: unknown): VideoRequestValidationResult {
  const result = validateVideoRequest(raw);
  if (!result.ok) return { ok: false, error: result.error };
  const r = raw as Record<string, unknown>;
  const req: VideoRequest = {
    model: r['model'] as VideoModelId,
    prompt: result.normalizedPrompt,
    durationSec: r['durationSec'] as VideoDurationSec,
    ...(r['firstFrameImageUri'] !== undefined
      ? { firstFrameImageUri: r['firstFrameImageUri'] as string }
      : {}),
    ...(r['lastFrameImageUri'] !== undefined
      ? { lastFrameImageUri: r['lastFrameImageUri'] as string }
      : {}),
    ...(r['referenceImageUris'] !== undefined
      ? { referenceImageUris: r['referenceImageUris'] as ReadonlyArray<string> }
      : {}),
  };
  return { ok: true, request: req };
}
