/**
 * Domain: media generator types and validation (pure).
 *
 * T36 — the H3 / Hailuo-03 video generator pipeline is the first
 * non-chat media endpoint we wire up. The chat model invokes a
 * `LanguageModelTool` whose input / output live in this module; the
 * adapter handles all I/O against MiniMax's `/v2/video_generation`
 * endpoint. Keeping the types and validation here means the tool
 * descriptor and command UI can share one source of truth without
 * pulling `vscode` or `fetch` into the domain layer.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

/** MiniMax video generation model ids we ship in this task. */
export type VideoModelId = 'MiniMax-H3' | 'MiniMax-H3-Max';

/** Allowed output durations for any Hailuo-03 video. */
export type VideoDurationSec = 6 | 10;

/**
 * A user- or model-supplied video generation request. `prompt` is
 * the only required field. Reference inputs are URIs the caller has
 * already validated as readable (the adapter does not resolve them).
 */
export interface VideoRequest {
  readonly model: VideoModelId;
  readonly prompt: string;
  readonly durationSec: VideoDurationSec;
  /** Optional URI of the first-frame image (image-to-video conditioning). */
  readonly firstFrameImageUri?: string;
  /** Optional URI of the last-frame image (start-end-to-video). */
  readonly lastFrameImageUri?: string;
  /** Optional list of subject-reference URIs (H3-Max only). */
  readonly referenceImageUris?: ReadonlyArray<string>;
}

/** Single-shot state of an async video generation task. */
export type VideoTaskState =
  /** Task queued or actively generating; caller should poll again. */
  | { readonly kind: 'pending'; readonly taskId: string; readonly progress?: number }
  /** Task succeeded; caller should download. */
  | { readonly kind: 'success'; readonly taskId: string; readonly downloadUrl?: string }
  /** Task failed terminally; retry will not help without changing inputs. */
  | {
      readonly kind: 'fail';
      readonly taskId: string;
      readonly errorCode: string;
      readonly errorMessage: string;
    };

/** Video bytes downloaded from the upstream endpoint. */
export interface VideoBytes {
  readonly bytes: Uint8Array;
  /** Best-effort MIME type, default `video/mp4`. */
  readonly mime: string;
  /** Upstream URL when known (for debug / "open in browser" affordances). */
  readonly sourceUrl?: string;
}

/**
 * A successful generation's local artifact reference. Produced by
 * `MediaArtifactStore.write(...)` after the adapter downloads
 * `VideoBytes` from MiniMax.
 */
export interface VideoResult {
  readonly model: VideoModelId;
  readonly durationSec: VideoDurationSec;
  readonly taskId: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly mime: string;
}

/** Limits enforced by `validateVideoRequest` (not model-specific). */
export const VIDEO_PROMPT_MAX_CHARS = 2000;
export const VIDEO_REFERENCE_MAX_IMAGES = 4;

export type VideoValidationResult =
  | { readonly ok: true; readonly normalizedPrompt: string }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a `VideoRequest` against the cross-model rules. Per-model
 * rules (e.g. "H3 does not support subject references") live in
 * `media-capability.ts`; this function only enforces the rules every
 * video model shares.
 */
export function validateVideoRequest(req: unknown): VideoValidationResult {
  if (req === null || typeof req !== 'object') {
    return { ok: false, error: 'video request must be an object' };
  }
  const r = req as Record<string, unknown>;

  if (r['model'] !== 'MiniMax-H3' && r['model'] !== 'MiniMax-H3-Max') {
    return { ok: false, error: 'model must be "MiniMax-H3" or "MiniMax-H3-Max"' };
  }
  if (r['durationSec'] !== 6 && r['durationSec'] !== 10) {
    return { ok: false, error: 'durationSec must be 6 or 10' };
  }
  if (typeof r['prompt'] !== 'string') {
    return { ok: false, error: 'prompt must be a string' };
  }
  const normalizedPrompt = r['prompt'].trim();
  if (normalizedPrompt.length === 0) {
    return { ok: false, error: 'prompt must not be empty' };
  }
  if (normalizedPrompt.length > VIDEO_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      error: `prompt exceeds ${VIDEO_PROMPT_MAX_CHARS} characters (got ${normalizedPrompt.length})`,
    };
  }

  for (const field of ['firstFrameImageUri', 'lastFrameImageUri'] as const) {
    const value = r[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return { ok: false, error: `${field} must be a non-empty string when present` };
    }
  }

  const refs = r['referenceImageUris'];
  if (refs !== undefined) {
    if (!Array.isArray(refs)) {
      return { ok: false, error: 'referenceImageUris must be an array when present' };
    }
    if (refs.length > VIDEO_REFERENCE_MAX_IMAGES) {
      return {
        ok: false,
        error: `at most ${VIDEO_REFERENCE_MAX_IMAGES} reference images are supported (got ${refs.length})`,
      };
    }
    for (let i = 0; i < refs.length; i++) {
      const item: unknown = refs[i];
      if (typeof item !== 'string' || item.length === 0) {
        return {
          ok: false,
          error: `referenceImageUris[${i}] must be a non-empty string`,
        };
      }
    }
  }

  return { ok: true, normalizedPrompt };
}

/**
 * Render the tool-result text the chat model sees after a successful
 * video generation. Single string, no embedded newlines, so the chat
 * widget renders exactly one text part (mirrors the T35 single-box
 * pattern from `minimax_subagent`).
 */
export function renderVideoToolResult(result: VideoResult): string {
  return (
    `Generated ${result.durationSec}s ${result.model} video at ${result.absolutePath} ` +
    `(${formatSize(result.sizeBytes)}, task ${result.taskId}). ` +
    `Tell the user the path; they can open it from the chat widget.`
  );
}

/** Render the body copy for the success notification. Markdown-friendly. */
export function renderVideoNotificationBody(result: VideoResult): string {
  return (
    `Saved **${result.model}** video (${result.durationSec}s, ` +
    `${formatSize(result.sizeBytes)}) to:\n${result.absolutePath}`
  );
}

/** Render the error copy returned to the model when generation fails. */
export function renderVideoToolError(errorCode: string, errorMessage: string): string {
  return `Video generation failed (${errorCode}): ${errorMessage}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
