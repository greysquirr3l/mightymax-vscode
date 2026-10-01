/**
 * Domain: `mightyMax_generateVideo` tool descriptor.
 *
 * T36 — the tool the chat provider advertises so any M-series model
 * can produce video via the H3 / H3-Max endpoints. The descriptor
 * is pure (no `vscode` import) so the same shape can drive both
 * the manifest `languageModelTools` entry and the registration call.
 *
 * The adapter in `src/adapters/generate-video-tool-adapter.ts`
 * consumes the descriptor; the manifest in `package.json` mirrors
 * the schema verbatim so VS Code's host can show the tool to other
 * providers (the same shape every BYOK provider uses).
 */

import {
  VIDEO_PROMPT_MAX_CHARS,
  VIDEO_REFERENCE_MAX_IMAGES,
  renderVideoToolError,
  renderVideoToolResult,
  type VideoDurationSec,
  type VideoModelId,
  type VideoResult,
} from './media.js';
import {
  VIDEO_CAPABILITIES,
  evaluateVideoCapability,
  validateVideoRequestForModel,
} from './media-capability.js';

/** Tool name surfaced to the chat model and other BYOK providers. */
export const MIGHTYMAX_GENERATE_VIDEO_TOOL = 'mightyMax_generateVideo';

/** Maximum length of a single reference-image URI; defensive against absurd inputs. */
export const VIDEO_REFERENCE_URI_MAX_CHARS = 2048;

/** JSON Schema for the tool's `input` object. */
export interface VideoToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: ReadonlyArray<string>;
}

export interface VideoToolDescriptor {
  readonly name: typeof MIGHTYMAX_GENERATE_VIDEO_TOOL;
  readonly displayName: string;
  readonly toolReferenceName: string;
  readonly userDescription: string;
  readonly modelDescription: string;
  readonly tags: ReadonlyArray<string>;
  readonly inputSchema: VideoToolInputSchema;
}

/**
 * Build the tool descriptor. Kept as a function so the caller can
 * re-build it per VS Code host version (currently static).
 */
export function buildGenerateVideoDescriptor(): VideoToolDescriptor {
  return {
    name: MIGHTYMAX_GENERATE_VIDEO_TOOL,
    displayName: 'Mighty Max: Generate Video',
    toolReferenceName: MIGHTYMAX_GENERATE_VIDEO_TOOL,
    userDescription:
      'Generate a short video using MiniMax H3 / H3-Max (Hailuo-03). ' +
      'Saves to disk and returns the path.',
    modelDescription:
      "Generate a short (6s or 10s) video using MiniMax's H3 or H3-Max video " +
      'generation endpoint. Use the `firstFrameImageUri` / `lastFrameImageUri` ' +
      'inputs for image-to-video or start-end-to-video. Use `referenceImageUris` ' +
      '(H3-Max only, up to 4) for subject-reference video. The tool returns the ' +
      'absolute path of the saved video on disk; describe the result to the user.',
    tags: ['minimax', 'media', 'video'],
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: ['MiniMax-H3', 'MiniMax-H3-Max'],
          description:
            'Which MiniMax video model to invoke. H3-Max supports subject-reference video (up to 4 reference images).',
        },
        prompt: {
          type: 'string',
          maxLength: VIDEO_PROMPT_MAX_CHARS,
          description:
            'Plain-text description of the desired video. Required. Max ' +
            `${VIDEO_PROMPT_MAX_CHARS} characters.`,
        },
        durationSec: {
          type: 'number',
          enum: [6, 10],
          description: 'Output duration in seconds. 6 or 10.',
        },
        firstFrameImageUri: {
          type: 'string',
          description:
            'Optional URI of the first-frame conditioning image (image-to-video). ' +
            `Max ${VIDEO_REFERENCE_URI_MAX_CHARS} characters.`,
        },
        lastFrameImageUri: {
          type: 'string',
          description:
            'Optional URI of the last-frame conditioning image (start-end-to-video). ' +
            `Max ${VIDEO_REFERENCE_URI_MAX_CHARS} characters.`,
        },
        referenceImageUris: {
          type: 'array',
          items: { type: 'string', maxLength: VIDEO_REFERENCE_URI_MAX_CHARS },
          maxItems: VIDEO_REFERENCE_MAX_IMAGES,
          description:
            'Optional list of subject-reference image URIs (H3-Max only). ' +
            `At most ${VIDEO_REFERENCE_MAX_IMAGES} entries.`,
        },
      },
      required: ['model', 'prompt', 'durationSec'],
    },
  };
}

/**
 * Validation result for a tool invocation input. Mirrors
 * `validateVideoRequestForModel` but is parameterised by the raw
 * `unknown` the chat host hands the tool.
 */
export type VideoToolValidationResult =
  | { readonly ok: true; readonly normalized: NormalizedVideoToolInput }
  | { readonly ok: false; readonly error: string };

export interface NormalizedVideoToolInput {
  readonly model: VideoModelId;
  readonly prompt: string;
  readonly durationSec: VideoDurationSec;
  readonly firstFrameImageUri?: string;
  readonly lastFrameImageUri?: string;
  readonly referenceImageUris?: ReadonlyArray<string>;
}

/**
 * Validate the raw input the chat host (or the command adapter)
 * hands to the tool. Same rules as `validateVideoRequestForModel`
 * but with extra defensive checks on the optional URI strings
 * (length cap to defang absurd payloads).
 */
export function validateVideoToolInput(raw: unknown): VideoToolValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'video tool input must be an object' };
  }
  const r = raw as Record<string, unknown>;
  for (const field of ['firstFrameImageUri', 'lastFrameImageUri'] as const) {
    const v = r[field];
    if (v !== undefined && (typeof v !== 'string' || v.length > VIDEO_REFERENCE_URI_MAX_CHARS)) {
      return {
        ok: false,
        error: `${field} must be a string of at most ${VIDEO_REFERENCE_URI_MAX_CHARS} characters`,
      };
    }
  }
  // Defer to the canonical cross-model + per-model validator.
  const cap = evaluateVideoCapability(r['model'] as string);
  if (!cap.ok) return { ok: false, error: cap.error };
  void cap.capability; // capability table is the single source of truth

  const validation = validateVideoRequestForModel(raw);
  if (!validation.ok) return { ok: false, error: validation.error };
  return { ok: true, normalized: validation.request };
}

/**
 * Render the success tool-result text the chat host hands back to
 * the model. Single string, no newlines (mirrors the T35
 * `minimax_subagent` single-box pattern).
 */
export function renderGenerateVideoToolResult(result: VideoResult): string {
  return renderVideoToolResult(result);
}

/** Render the error text the chat host hands back to the model. */
export function renderGenerateVideoToolError(errorCode: string, errorMessage: string): string {
  return renderVideoToolError(errorCode, errorMessage);
}

/** All model ids the tool knows how to invoke (used by the command UI). */
export const SUPPORTED_VIDEO_MODELS: ReadonlyArray<VideoModelId> = Object.freeze(
  Object.keys(VIDEO_CAPABILITIES) as VideoModelId[],
);
