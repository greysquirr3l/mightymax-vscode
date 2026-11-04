/**
 * FilesApiUploader — uploads inline media to MiniMax's Files API
 * (`POST {baseUrl}/v1/files/upload`, multipart) so a request can carry a
 * `mm_file://<id>` reference instead of megabytes of base64.
 *
 * Fail-open by design: every failure (network, non-2xx, a response with
 * no file id, a timeout) resolves to `undefined` and the caller keeps
 * the inline block. Uploads are cached per key + content for the TTL
 * MiniMax Code uses (12h), so retries and later turns that re-send the
 * same attachment upload it once.
 */

import { createHash } from 'node:crypto';

import type { Logger } from '../ports/logger.js';
import type { UploadableMedia } from '../lib/domain/files-api.js';

const UPLOAD_TIMEOUT_MS = 60_000;
const FILE_ID_TTL_MS = 43_200_000;

export interface FilesApiUploaderOptions {
  readonly baseUrl: () => string;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

function filenameFor(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase() ?? '';
  const extension = subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin';
  return `mighty-max-media.${extension}`;
}

function readFileId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { base_resp: baseResp, file } = body as { base_resp?: unknown; file?: unknown };
  if (typeof baseResp !== 'object' || baseResp === null) return undefined;
  if ((baseResp as { status_code?: unknown }).status_code !== 0) return undefined;
  if (typeof file !== 'object' || file === null) return undefined;
  const id = (file as { file_id?: unknown }).file_id;
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

export class FilesApiUploader {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, { fileId: string; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  constructor(private readonly options: FilesApiUploaderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async upload(
    apiKey: string,
    media: UploadableMedia,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const baseUrl = this.options.baseUrl().replace(/\/+$/, '');
    // Only the media content is hashed (a cache fingerprint, not a
    // secret); the key and endpoint scope the entry as plain string parts.
    const contentHash = createHash('sha256')
      .update(`${media.purpose}\0${media.mediaType}\0${media.data}`)
      .digest('hex');
    const cacheKey = `${baseUrl}\0${apiKey}\0${contentHash}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.fileId;

    let pending = this.inFlight.get(cacheKey);
    if (pending === undefined) {
      pending = this.doUpload(baseUrl, apiKey, media, signal).then((fileId) => {
        if (fileId !== undefined) {
          this.cache.set(cacheKey, { fileId, expiresAt: this.now() + FILE_ID_TTL_MS });
        }
        return fileId;
      });
      this.inFlight.set(cacheKey, pending);
      void pending.finally(() => this.inFlight.delete(cacheKey));
    }
    return pending;
  }

  private async doUpload(
    baseUrl: string,
    apiKey: string,
    media: UploadableMedia,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const form = new FormData();
    form.append('purpose', media.purpose);
    form.append(
      'file',
      new Blob([Buffer.from(media.data, 'base64')], { type: media.mediaType }),
      filenameFor(media.mediaType),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${baseUrl}/v1/files/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        this.options.logger.warn('Files API upload rejected; keeping media inline', {
          status: response.status,
        });
        return undefined;
      }
      const fileId = readFileId(await response.json());
      if (fileId === undefined) {
        this.options.logger.warn('Files API upload returned no file id; keeping media inline');
      }
      return fileId;
    } catch (error) {
      this.options.logger.warn('Files API upload failed; keeping media inline', {
        error: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
