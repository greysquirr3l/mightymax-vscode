/**
 * Port: ImageGenerator — adapter-agnostic surface for MiniMax's
 * synchronous image generation endpoint (`POST /v1/image_generation`).
 *
 * Deliberately ONE method, unlike `VideoGenerator`'s three. The image
 * endpoint returns the images in the response body — there is no
 * task_id and no polling — so there is nothing to split. The three-method
 * video shape exists because video is async, not because async-ness is
 * the right default for a media port.
 *
 * The adapter is responsible for the 24-hour URL expiry the spec
 * warns about ("url expires in 24 hours"): it must download the bytes
 * before returning, never hand a caller an expiring URL. That is why
 * this port returns `ImageBytes` and not a URL string.
 *
 * No `vscode` imports.
 */

import type { ImageBytes, ImageRequest } from '../lib/domain/image.js';

export interface ImageGenerator {
  /**
   * Generate images synchronously and return the decoded bytes, in
   * response order. Throws a typed error on upstream failure.
   */
  generate(request: ImageRequest, apiKey: string, signal: AbortSignal): Promise<ImageBytes[]>;
}
