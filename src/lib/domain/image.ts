/**
 * Domain: image generation types and validation (pure).
 *
 * Sibling to `media.ts` (video). MiniMax's image endpoint is
 * SYNCHRONOUS — `POST /v1/image_generation` returns the images in
 * the response body, unlike video's submit/poll/download — so
 * unlike the video pipeline there is no task handle and no polling
 * loop. The shape is otherwise the same: request in, bytes out,
 * persisted through `MediaArtifactStore`.
 *
 * Grounded in the MiniMax Image Generation OpenAPI spec
 * (`api-reference/image/generation/api/text-to-image.json`).
 * Every default, enum, and range below is transcribed from that
 * schema, not guessed.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

/** Only image model MiniMax currently publishes. */
export type ImageModelId = 'image-01';

/**
 * Aspect ratios the endpoint accepts, with the pixel dimensions the
 * spec documents for each.
 */
export type ImageAspectRatio = '1:1' | '16:9' | '4:3' | '3:2' | '2:3' | '3:4' | '9:16' | '21:9';

/**
 * Pixel dimensions per aspect ratio. Transcribed from the spec's
 * `aspect_ratio` descriptions. Surfaced in the tool result so the
 * chat model can tell the user what they actually got.
 */
export const IMAGE_ASPECT_DIMENSIONS: Readonly<Record<ImageAspectRatio, string>> = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1280x720',
  '4:3': '1152x864',
  '3:2': '1248x832',
  '2:3': '832x1248',
  '3:4': '864x1152',
  '9:16': '720x1280',
  '21:9': '1344x576',
});

export const IMAGE_ASPECT_RATIOS: ReadonlyArray<ImageAspectRatio> = Object.freeze([
  '1:1',
  '16:9',
  '4:3',
  '3:2',
  '2:3',
  '3:4',
  '9:16',
  '21:9',
]);

/** Spec: "Text description of the image, max length 1500 characters." */
export const IMAGE_PROMPT_MAX_CHARS = 1500;

/** Spec: width/height "Range [512, 2048], must be divisible by 8." */
export const IMAGE_DIMENSION_MIN = 512;
export const IMAGE_DIMENSION_MAX = 2048;
export const IMAGE_DIMENSION_MULTIPLE = 8;

/** Spec: "Number of images to generate per request. Range [1, 9]." */
export const IMAGE_COUNT_MIN = 1;
export const IMAGE_COUNT_MAX = 9;

export interface ImageRequest {
  readonly model: ImageModelId;
  readonly prompt: string;
  /** Optional. Defaults to the spec's default, `1:1`. */
  readonly aspectRatio?: ImageAspectRatio;
  /**
   * Explicit pixel dimensions. The spec: "Must be set together with
   * `height` … If both `width/height` and `aspect_ratio` are
   * provided, `aspect_ratio` takes precedence." We therefore reject
   * the ambiguous combination rather than silently dropping one.
   */
  readonly width?: number;
  readonly height?: number;
  /** Optional. Defaults to the spec's default, 1. */
  readonly count?: number;
  /** Optional. Same seed + params → same image. Defaults to random. */
  readonly seed?: number;
  /** Optional. Spec default `false`. */
  readonly promptOptimizer?: boolean;
}

export interface ImageBytes {
  readonly bytes: Uint8Array;
  /** Best-effort MIME. image-01 emits PNG. */
  readonly mime: string;
  /** Upstream URL when the response used `response_format: url`. */
  readonly sourceUrl?: string;
}

export interface ImageResult {
  readonly model: ImageModelId;
  readonly prompt: string;
  readonly aspectRatio: ImageAspectRatio;
  /** Absolute paths of the saved files, in response order. */
  readonly absolutePaths: ReadonlyArray<string>;
  readonly totalSizeBytes: number;
  readonly mime: string;
}

/**
 * A validated request with every spec default filled in, so the
 * adapter sends the same body whether the caller omitted a field or
 * set it to its documented default.
 */
export type NormalizedImageRequest = Readonly<{
  model: ImageModelId;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  count: number;
  promptOptimizer: boolean;
}> & {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
};

export type ImageValidationResult =
  | { readonly ok: true; readonly normalized: NormalizedImageRequest }
  | { readonly ok: false; readonly error: string };

const isAspectRatio = (v: unknown): v is ImageAspectRatio =>
  typeof v === 'string' && (IMAGE_ASPECT_RATIOS as ReadonlyArray<string>).includes(v);

const isMultipleOf8 = (n: number): boolean => n % IMAGE_DIMENSION_MULTIPLE === 0;

/**
 * Validate and normalize a raw image request. Pure — no I/O.
 *
 * Defaults are transcribed from the spec so "unset" and "explicitly
 * default" produce byte-identical requests:
 *   - `aspect_ratio` → `1:1`
 *   - `n`             → `1`
 *   - `prompt_optimizer` → `false`
 */
export function validateImageRequest(raw: unknown): ImageValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'image request must be an object' };
  }
  const r = raw as Record<string, unknown>;

  if (r['model'] !== 'image-01') {
    return { ok: false, error: 'model must be "image-01"' };
  }

  if (typeof r['prompt'] !== 'string') {
    return { ok: false, error: 'prompt must be a string' };
  }
  const prompt = r['prompt'].trim();
  if (prompt.length === 0) {
    return { ok: false, error: 'prompt must not be empty' };
  }
  if (prompt.length > IMAGE_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      error: `prompt exceeds ${IMAGE_PROMPT_MAX_CHARS} characters (got ${prompt.length})`,
    };
  }

  let aspectRatio: ImageAspectRatio = '1:1';
  const aspectExplicit = r['aspectRatio'] !== undefined;
  if (aspectExplicit) {
    if (!isAspectRatio(r['aspectRatio'])) {
      return {
        ok: false,
        error: `aspectRatio must be one of ${IMAGE_ASPECT_RATIOS.join(', ')}`,
      };
    }
    aspectRatio = r['aspectRatio'];
  }

  // width/height must be supplied together, in range, and divisible
  // by 8. And they are mutually exclusive with aspectRatio — the
  // spec says aspect_ratio "takes precedence", which would silently
  // discard the caller's dimensions, so we reject instead.
  const hasW = r['width'] !== undefined;
  const hasH = r['height'] !== undefined;
  if (hasW !== hasH) {
    return { ok: false, error: 'width and height must be set together' };
  }
  if (hasW && aspectExplicit) {
    // The spec says "If both width/height and aspect_ratio are
    // provided, aspect_ratio takes precedence" — which would
    // silently discard the caller's explicit pixel dimensions.
    // Reject instead of picking a winner, so the caller never
    // gets a shape they didn't ask for.
    return {
      ok: false,
      error: 'width/height cannot be combined with aspectRatio; pick one',
    };
  }
  let width: number | undefined;
  let height: number | undefined;
  if (hasW && hasH) {
    const w = r['width'];
    const h = r['height'];
    if (typeof w !== 'number' || !Number.isInteger(w)) {
      return { ok: false, error: 'width must be an integer' };
    }
    if (typeof h !== 'number' || !Number.isInteger(h)) {
      return { ok: false, error: 'height must be an integer' };
    }
    for (const [name, v] of [
      ['width', w],
      ['height', h],
    ] as const) {
      if (v < IMAGE_DIMENSION_MIN || v > IMAGE_DIMENSION_MAX) {
        return {
          ok: false,
          error: `${name} must be between ${IMAGE_DIMENSION_MIN} and ${IMAGE_DIMENSION_MAX} (got ${v})`,
        };
      }
      if (!isMultipleOf8(v)) {
        return {
          ok: false,
          error: `${name} must be divisible by ${IMAGE_DIMENSION_MULTIPLE} (got ${v})`,
        };
      }
    }
    width = w;
    height = h;
  }

  let count = 1;
  if (r['count'] !== undefined) {
    const n = r['count'];
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return { ok: false, error: 'count must be an integer' };
    }
    if (n < IMAGE_COUNT_MIN || n > IMAGE_COUNT_MAX) {
      return {
        ok: false,
        error: `count must be between ${IMAGE_COUNT_MIN} and ${IMAGE_COUNT_MAX} (got ${n})`,
      };
    }
    count = n;
  }

  let seed: number | undefined;
  if (r['seed'] !== undefined) {
    const s = r['seed'];
    if (typeof s !== 'number' || !Number.isInteger(s)) {
      return { ok: false, error: 'seed must be an integer' };
    }
    seed = s;
  }

  let promptOptimizer = false;
  if (r['promptOptimizer'] !== undefined) {
    if (typeof r['promptOptimizer'] !== 'boolean') {
      return { ok: false, error: 'promptOptimizer must be a boolean' };
    }
    promptOptimizer = r['promptOptimizer'];
  }

  return {
    ok: true,
    normalized: {
      model: 'image-01',
      prompt,
      aspectRatio,
      count,
      promptOptimizer,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}

/**
 * Single-line tool-result text. No embedded newlines so the chat
 * widget renders one text part (mirrors the T35 single-box pattern).
 */
export function renderImageToolResult(result: ImageResult): string {
  const dims = IMAGE_ASPECT_DIMENSIONS[result.aspectRatio];
  const paths = result.absolutePaths.join(', ');
  const plural = result.absolutePaths.length === 1 ? 'image' : 'images';
  return (
    `Generated ${String(result.absolutePaths.length)} ${plural} with ${result.model} ` +
    `(${dims}, ${formatSize(result.totalSizeBytes)}) at: ${paths}. ` +
    `Tell the user the path(s); they can open them from the chat widget.`
  );
}

/** Markdown body for the command's success notification. */
export function renderImageNotificationBody(result: ImageResult): string {
  const dims = IMAGE_ASPECT_DIMENSIONS[result.aspectRatio];
  const n = result.absolutePaths.length;
  const plural = n === 1 ? 'image' : 'images';
  return (
    `Saved **${n}** ${result.model} ${plural} (${dims}, ${formatSize(result.totalSizeBytes)}):\n` +
    result.absolutePaths.join('\n')
  );
}

export function renderImageToolError(errorCode: string, errorMessage: string): string {
  return `Image generation failed (${errorCode}): ${errorMessage}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
