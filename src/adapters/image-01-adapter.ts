/**
 * Image01Adapter — `ImageGenerator` impl for MiniMax's synchronous
 * image generation endpoint.
 *
 * T36 sibling to `HailuoVideoAdapter`, minus the polling: one POST,
 * one response, bytes out.
 *
 *   POST {baseUrl}/v1/image_generation
 *   body: { model, prompt, aspect_ratio, n, seed?, response_format }
 *     → { data: { image_base64: [...] }, base_resp: { status_code, status_msg } }
 *
 * We ask for `response_format: "base64"` rather than the default
 * `"url"`. The spec warns "⚠️ Note: url expires in 24 hours", and
 * the `MediaArtifactStore` contract wants bytes on disk — so
 * requesting base64 up front avoids a second round-trip entirely
 * and removes the expiry window. `url` is still handled defensively
 * in case the server returns it anyway.
 *
 * No `vscode` imports — `fetch` is injected so tests stub it.
 */

import type { Logger } from '../ports/logger.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import type { ImageBytes, ImageRequest } from '../lib/domain/image.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_IMAGE_BASE_URL = 'https://api.minimax.io';

/** Typed upstream failure, mirroring `HailuoVideoError`'s shape. */
export class ImageGenerationError extends Error {
  constructor(
    public readonly kind:
      'http' | 'parse' | 'rate-limit' | 'auth' | 'insufficient-balance' | 'sensitive' | 'network',
    public readonly status?: number,
    message?: string,
  ) {
    super(message ?? `image generation error: ${kind}`);
    this.name = 'ImageGenerationError';
  }
}

export interface Image01AdapterOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  readonly logger: Logger;
}

export class Image01Adapter implements ImageGenerator {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;

  constructor(options: Image01AdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_IMAGE_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async generate(
    request: ImageRequest,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<ImageBytes[]> {
    const url = `${this.baseUrl}/v1/image_generation`;
    const body = buildGenerateBody(request);
    this.logger.debug('image-01 generate', {
      model: request.model,
      promptLen: request.prompt.length,
      aspectRatio: request.aspectRatio,
      count: request.count,
    });

    const json = await this.postJson(url, body, apiKey, signal);
    const baseResp = (json['base_resp'] ?? {}) as Record<string, unknown>;
    const statusCode = typeof baseResp['status_code'] === 'number' ? baseResp['status_code'] : 0;
    const statusMsg = typeof baseResp['status_msg'] === 'string' ? baseResp['status_msg'] : '';

    switch (statusCode) {
      case 0:
        break;
      case 1002:
        throw new ImageGenerationError('rate-limit', undefined, 'MiniMax rate limit triggered');
      case 1004:
        throw new ImageGenerationError('auth', undefined, 'MiniMax authentication failed');
      case 1008:
        throw new ImageGenerationError(
          'insufficient-balance',
          undefined,
          'MiniMax account has insufficient balance',
        );
      case 1026:
      case 1027:
        throw new ImageGenerationError(
          'sensitive',
          undefined,
          `MiniMax sensitive content guard (code ${statusCode}: ${statusMsg})`,
        );
      default:
        throw new ImageGenerationError(
          'http',
          undefined,
          `upstream status_code ${statusCode}: ${statusMsg}`,
        );
    }

    const data = json['data'];
    if (data === null || typeof data !== 'object') {
      throw new ImageGenerationError('parse', undefined, 'response missing `data`');
    }
    const obj = data as Record<string, unknown>;
    const b64 = obj['image_base64'];
    const urls = obj['image_urls'];

    if (Array.isArray(b64) && b64.length > 0) {
      return b64.map((entry, i) => ({
        bytes: decodeBase64(String(entry), i),
        mime: 'image/png',
      }));
    }
    if (Array.isArray(urls) && urls.length > 0) {
      // Defensive: we request base64, so this path is unexpected. Handle
      // it anyway rather than returning an empty array.
      const out: ImageBytes[] = [];
      for (const entry of urls) {
        const href = String(entry);
        out.push(await this.download(href, apiKey, signal));
      }
      return out;
    }
    throw new ImageGenerationError(
      'parse',
      undefined,
      'response contained neither image_base64 nor image_urls',
    );
  }

  private async postJson(
    url: string,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ImageGenerationError('network', undefined, String(err));
    }

    if (response.status === 401 || response.status === 403) {
      throw new ImageGenerationError(
        'auth',
        response.status,
        `auth failed: HTTP ${response.status}`,
      );
    }
    if (response.status === 429) {
      throw new ImageGenerationError('rate-limit', response.status, 'rate limit triggered');
    }
    if (!response.ok) {
      throw new ImageGenerationError('http', response.status, `HTTP ${response.status}`);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new ImageGenerationError(
        'parse',
        response.status,
        `failed to read body: ${String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ImageGenerationError('parse', response.status, 'response body is not JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImageGenerationError('parse', response.status, 'response body is not an object');
    }
    return parsed as Record<string, unknown>;
  }

  private async download(href: string, apiKey: string, signal: AbortSignal): Promise<ImageBytes> {
    try {
      const response = await this.fetchImpl(href, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) {
        throw new ImageGenerationError(
          'http',
          response.status,
          `download failed: HTTP ${response.status}`,
        );
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mime: response.headers.get('content-type') ?? 'image/png',
        sourceUrl: href,
      };
    } catch (err) {
      if (err instanceof ImageGenerationError) throw err;
      if (isAbort(err)) throw err;
      throw new ImageGenerationError(
        'network',
        undefined,
        `download network error: ${String(err)}`,
      );
    }
  }
}

/**
 * Build the request body. `aspect_ratio` and `width`/`height` are
 * mutually exclusive (the validator rejects the combination), so at
 * most one of the two shapes is emitted.
 */
export function buildGenerateBody(request: ImageRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    // Base64 up front — the spec warns URLs expire in 24h and the
    // artifact store wants bytes.
    response_format: 'base64',
  };
  if (request.width !== undefined && request.height !== undefined) {
    body['width'] = request.width;
    body['height'] = request.height;
  } else {
    body['aspect_ratio'] = request.aspectRatio ?? '1:1';
  }
  if (request.count !== undefined) body['n'] = request.count;
  if (request.seed !== undefined) body['seed'] = request.seed;
  if (request.promptOptimizer !== undefined) body['prompt_optimizer'] = request.promptOptimizer;
  return body;
}

function decodeBase64(value: string, index: number): Uint8Array {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    throw new ImageGenerationError(
      'parse',
      undefined,
      `image_base64[${index}] is not valid base64`,
    );
  }
}

function isAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === 'string' &&
    ((err as { code?: string }).code === 'ABORT_ERR' || (err as { code?: string }).code === '20')
  );
}
