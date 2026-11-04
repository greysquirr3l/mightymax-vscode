/**
 * validateApiKey — verifies a MiniMax API key by issuing a single
 * authenticated GET to the models endpoint. The key is sent in the
 * `Authorization: Bearer …` header ONLY and is never written to a
 * log channel, error message, or response body.
 *
 * Implemented as a pure module-level function that takes a `fetch`
 * implementation as an argument so unit tests can stub it without
 * monkey-patching the global. The production call site passes the
 * global `fetch`.
 *
 * Implementation: T06.
 */

/** Outcome of a single key-validation attempt. */
export type ValidationResult =
  | { ok: true; modelIds: string[] }
  | { ok: false; reason: ValidationFailure; status?: number };

export type ValidationFailure = 'unauthorized' | 'network' | 'malformed';

/** Optional injection seam used by tests. Defaults to the global `fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Reject keys that are empty or whitespace-only. */
function assertValidInputs(apiKey: string, baseUrl: string): void {
  if (apiKey.trim() === '') {
    throw new Error('validateApiKey: API key must not be empty');
  }
  if (baseUrl === '') {
    throw new Error('validateApiKey: base URL must not be empty');
  }
}

/** Normalise a base URL — strip a single trailing slash if present. */
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/** Extract a list of model ids from a MiniMax /v1/models response body. */
function extractModelIds(json: unknown): string[] {
  // The MiniMax OpenAI-compatible endpoint returns `{ data: Model[] }`
  // where each model has an `id`. Some endpoints return `{ models: ... }`
  // or a bare array. We tolerate all three and return [] on anything
  // unfamiliar.
  if (json === null || typeof json !== 'object') return [];
  const obj = json as Record<string, unknown>;
  const data = obj['data'];
  if (Array.isArray(data)) {
    const ids: string[] = [];
    for (const item of data) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>)['id'] === 'string'
      ) {
        ids.push((item as Record<string, string>)['id'] ?? '');
      }
    }
    return ids.filter((id) => id.length > 0);
  }
  return [];
}

type ModelIdsObserver = (modelIds: ReadonlyArray<string>) => void;

let modelIdsObserver: ModelIdsObserver | undefined;

/**
 * Register the single listener told about the model ids every
 * successful validation returns. The extension uses it to feed the
 * live catalog; validation call sites stay unaware of the catalog.
 */
export function setModelIdsObserver(observer: ModelIdsObserver | undefined): void {
  modelIdsObserver = observer;
}

export async function validateApiKey(
  apiKey: string,
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  assertValidInputs(apiKey, baseUrl);
  const url = `${normaliseBaseUrl(baseUrl)}/v1/models`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method: 'GET', headers };
  if (signal !== undefined) {
    init.signal = signal;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    // Network-level failure: DNS, refused connection, TLS, etc. The
    // global fetch rejects with TypeError on these. We DO NOT include
    // the error message in the result because it could echo the URL
    // (which sometimes contains the key in misconfigured setups).
    return { ok: false, reason: 'network' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', status: response.status };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, reason: 'malformed', status: response.status };
  }

  // The body is parsed defensively. A non-JSON 2xx is treated as
  // malformed rather than throwing — callers always see a result.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, reason: 'malformed', status: response.status };
  }
  const modelIds = extractModelIds(json);
  modelIdsObserver?.(modelIds);
  return { ok: true, modelIds };
}
