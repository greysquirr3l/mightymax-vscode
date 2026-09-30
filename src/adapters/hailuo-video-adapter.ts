/**
 * HailuoVideoAdapter — `VideoGenerator` impl for MiniMax's H3 / H3-Max
 * async video generation endpoint.
 *
 * T36 — three HTTP calls under the hood:
 *
 *   1. **Submit**:  POST   `{baseUrl}/v2/video_generation`
 *      body: `{ model, content: [{ type: 'text', text: prompt }, ...] }`
 *      → `{ task_id }`
 *
 *   2. **Poll**:    GET    `{baseUrl}/v2/query/video_generation/{task_id}`
 *      → `{ task_id, status: 'Preparing' | 'Queueing' | 'Processing' |
 *                       'Success' | 'Fail', file_id?, video_width?,
 *                       video_height?, base_resp: { status_code, status_msg } }`
 *
 *   3. **Resolve**: GET    `{baseUrl}/v1/files/retrieve?file_id={file_id}`
 *      → `{ file: { download_url, bytes, filename, ... }, base_resp }`
 *
 *   4. **Download**: GET    `{file.download_url}`
 *      → raw video bytes
 *
 * The adapter does NOT implement the polling loop — the chat-tool
 * adapter drives `pollStatus` at `mightyMax.videoPollIntervalMs`
 * cadence and decides when to give up via
 * `mightyMax.videoTimeoutMs`. Keeping the cadence in the caller
 * means cancellation (`AbortSignal`) works the same way for every
 * model: abort = throw `AbortError`, the caller's loop catches it
 * and surfaces a "cancelled" message to the model.
 *
 * No `vscode` imports — `fetch` is injected so tests stub it.
 */

import type { Logger } from '../ports/logger.js';
import type { VideoGenerator, VideoTaskHandle } from '../ports/video-generator.js';
import type {
  VideoBytes,
  VideoModelId,
  VideoRequest,
  VideoTaskState,
} from '../lib/domain/media.js';

/** Re-export of `fetch` so tests can stub the global uniformly. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Default base URL — same as the chat API host. */
export const DEFAULT_HAILUO_BASE_URL = 'https://api.minimax.io';

/** Optional injection seam used by tests. Defaults to the global `fetch`. */
export type FetchLikeOrDefault = FetchLike;

export interface HailuoVideoAdapterOptions {
  /** MiniMax API base URL. Defaults to `https://api.minimax.io`. */
  readonly baseUrl?: string;
  /** Fetch impl. Defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Logger for structured info / debug lines. Required. */
  readonly logger: Logger;
}

/** Discriminated error thrown by the adapter for typed upstream failures. */
export class HailuoVideoError extends Error {
  constructor(
    public readonly kind:
      | 'http' // 4xx / 5xx response
      | 'parse' // non-JSON 2xx or unexpected shape
      | 'rate-limit' // 429 or status_code === 1002
      | 'auth' // 401 / 403 or status_code === 1004
      | 'insufficient-balance' // status_code === 1008
      | 'sensitive' // status_code === 1026 / 1027
      | 'network', // fetch rejected
    public readonly status?: number,
    message?: string,
  ) {
    super(message ?? `Hailuo video error: ${kind}`);
    this.name = 'HailuoVideoError';
  }
}

export class HailuoVideoAdapter implements VideoGenerator {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;

  constructor(options: HailuoVideoAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_HAILUO_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async submitTask(
    request: VideoRequest,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<VideoTaskHandle> {
    const body = buildSubmitBody(request);
    const url = `${this.baseUrl}/v2/video_generation`;
    this.logger.debug('Hailuo submit', { model: request.model, promptLen: request.prompt.length });
    const json = await postJson(this.fetchImpl, this.logger, url, body, apiKey, signal);
    const taskId = extractString(json, 'task_id');
    if (taskId === undefined) {
      throw new HailuoVideoError('parse', undefined, 'submit response missing task_id');
    }
    return { taskId, model: request.model };
  }

  async pollStatus(taskId: string, apiKey: string, signal: AbortSignal): Promise<VideoTaskState> {
    const url = `${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`;
    const json = await getJson(this.fetchImpl, this.logger, url, apiKey, signal);
    const baseResp = (json['base_resp'] ?? {}) as Record<string, unknown>;
    const statusCode =
      typeof baseResp['status_code'] === 'number' ? baseResp['status_code'] : 0;
    const statusMsg =
      typeof baseResp['status_msg'] === 'string' ? baseResp['status_msg'] : '';

    if (statusCode === 1002) {
      throw new HailuoVideoError('rate-limit', undefined, 'MiniMax rate limit triggered');
    }
    if (statusCode === 1004) {
      throw new HailuoVideoError('auth', undefined, 'MiniMax authentication failed');
    }
    if (statusCode === 1008) {
      throw new HailuoVideoError(
        'insufficient-balance',
        undefined,
        'MiniMax account has insufficient balance',
      );
    }
    if (statusCode === 1026 || statusCode === 1027) {
      throw new HailuoVideoError(
        'sensitive',
        undefined,
        `MiniMax sensitive content guard (code ${statusCode}: ${statusMsg})`,
      );
    }

    const status = extractString(json, 'status');
    switch (status) {
      case 'Preparing':
      case 'Queueing':
      case 'Processing':
        return { kind: 'pending', taskId };
      case 'Success': {
        // Poll responses carry `file_id` and (per OpenAPI) the
        // success payload can include `content.url` / `content.video_url`.
        const downloadUrl =
          extractNestedString(json, ['content', 'url']) ??
          extractNestedString(json, ['content', 'video_url']);
        return { kind: 'success', taskId, ...(downloadUrl !== undefined ? { downloadUrl } : {}) };
      }
      case 'Fail': {
        const code = String(statusCode);
        const message = statusMsg !== '' ? statusMsg : 'MiniMax task failed';
        return { kind: 'fail', taskId, errorCode: code, errorMessage: message };
      }
      default:
        throw new HailuoVideoError(
          'parse',
          undefined,
          `unexpected poll status "${status ?? '<missing>'}"`,
        );
    }
  }

  async downloadResult(taskId: string, apiKey: string, signal: AbortSignal): Promise<VideoBytes> {
    // Resolve file_id via the file-management endpoint. Some poll
    // responses include a direct download URL; we honour that when
    // present (saves a round-trip) but fall back to file_id lookup.
    const fileId = await this.resolveFileId(taskId, apiKey, signal);
    const fileMeta = await this.retrieveFile(fileId, apiKey, signal);
    const downloadUrl = extractNestedString(fileMeta, ['file', 'download_url']);
    if (downloadUrl === undefined) {
      throw new HailuoVideoError('parse', undefined, 'file metadata did not include download_url');
    }
    const response = await this.fetchWithAuth(downloadUrl, apiKey, signal);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      mime: response.headers.get('content-type') ?? 'video/mp4',
      sourceUrl: downloadUrl,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private async resolveFileId(
    taskId: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    // The poll endpoint can include file_id directly. We try the
    // poll response first to avoid the extra round-trip.
    const pollUrl = `${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`;
    const pollJson = await getJson(this.fetchImpl, this.logger, pollUrl, apiKey, signal);
    const fileIdRaw = pollJson['file_id'];
    if (typeof fileIdRaw === 'string' || typeof fileIdRaw === 'number') {
      return String(fileIdRaw);
    }
    throw new HailuoVideoError(
      'parse',
      undefined,
      'poll response missing file_id; cannot resolve download URL',
    );
  }

  private async retrieveFile(
    fileId: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`;
    return getJson(this.fetchImpl, this.logger, url, apiKey, signal);
  }

  private async fetchWithAuth(url: string, apiKey: string, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!response.ok) {
        throw new HailuoVideoError(
          'http',
          response.status,
          `download failed: HTTP ${response.status}`,
        );
      }
      return response;
    } catch (err) {
      if (err instanceof HailuoVideoError) throw err;
      if (isAbort(err)) throw err;
      throw new HailuoVideoError('network', undefined, `download network error: ${String(err)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Free helpers — exported so the adapter test can reuse the same parsing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the submit body. Mirrors MiniMax's published text-to-video /
 * image-to-video / subject-reference shapes.
 */
export function buildSubmitBody(request: VideoRequest): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }];
  if (request.firstFrameImageUri !== undefined) {
    content.push({ type: 'image_url', image_url: request.firstFrameImageUri });
  }
  if (request.lastFrameImageUri !== undefined) {
    content.push({ type: 'image_url', image_url: request.lastFrameImageUri });
  }
  if (request.referenceImageUris !== undefined) {
    for (const uri of request.referenceImageUris) {
      content.push({ type: 'image_url', image_url: uri });
    }
  }
  return {
    model: request.model,
    content,
  };
}

async function postJson(
  fetchImpl: FetchLike,
  logger: Logger,
  url: string,
  body: unknown,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return requestJson(fetchImpl, logger, 'POST', url, body, apiKey, signal);
}

async function getJson(
  fetchImpl: FetchLike,
  logger: Logger,
  url: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return requestJson(fetchImpl, logger, 'GET', url, undefined, apiKey, signal);
}

async function requestJson(
  fetchImpl: FetchLike,
  logger: Logger,
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      signal,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    response = await fetchImpl(url, init);
  } catch (err) {
    if (isAbort(err)) throw err;
    logger.warn('Hailuo HTTP failure', { url, error: String(err) });
    throw new HailuoVideoError('network', undefined, String(err));
  }

  if (response.status === 401 || response.status === 403) {
    throw new HailuoVideoError('auth', response.status, `auth failed: HTTP ${response.status}`);
  }
  if (response.status === 429) {
    throw new HailuoVideoError('rate-limit', response.status, 'rate limit triggered');
  }
  if (!response.ok) {
    throw new HailuoVideoError('http', response.status, `HTTP ${response.status}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new HailuoVideoError('parse', response.status, `failed to read body: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HailuoVideoError('parse', response.status, 'response body is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HailuoVideoError('parse', response.status, 'response body is not an object');
  }
  return parsed as Record<string, unknown>;
}

function extractString(json: Record<string, unknown>, key: string): string | undefined {
  const v = json[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function extractNestedString(
  json: Record<string, unknown>,
  path: ReadonlyArray<string>,
): string | undefined {
  let cursor: unknown = json;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function isAbort(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === 'string' &&
    ((err as { code?: string }).code === 'ABORT_ERR' || (err as { code?: string }).code === '20')
  );
}

/**
 * Re-export so the adapter's model-id mapping is visible in tests
 * without re-importing the domain module.
 */
export type { VideoModelId };
