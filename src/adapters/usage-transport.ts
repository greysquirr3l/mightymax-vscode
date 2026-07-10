/**
 * Transport adapter for `GET https://www.minimax.io/v1/token_plan/remains`.
 *
 * Wraps the endpoint, then delegates parsing to the pure normalizer
 * in `src/lib/domain/usage-normalization.ts`. The two responsibilities
 * are deliberately split — this adapter does I/O + error wrapping, the
 * normalizer does schema interpretation. PAYG keys, network failures,
 * and parse failures all surface as `UsageUnavailableError` so the
 * status bar can render a neutral state instead of a scary red one.
 *
 * The endpoint lives on the public `www.minimax.io` host (not the
 * configurable `api.minimax.io`); it requires the user's Subscription
 * Key. A pay-as-you-go key legitimately failing here is NOT a
 * user-facing error — it just means the plan doesn't have a
 * Token Plan bar.
 */

import type { Logger } from '../ports/logger.js';
import {
  UsageUnavailableError,
  type UsageClient,
  type TokenPlanUsage,
} from '../ports/usage-client.js';
import { normalizeTokenPlanRemains } from '../lib/domain/usage-normalization.js';

/** Documented production endpoint. Tests inject a `remainsUrl` to keep
 *  fixture traffic off the public host. */
export const DEFAULT_REMAINS_URL = 'https://www.minimax.io/v1/token_plan/remains';

export interface UsageTransportDeps {
  readonly logger: Logger;
  /** Override the endpoint (tests). Defaults to `DEFAULT_REMAINS_URL`. */
  readonly remainsUrl?: string;
  /** Override `fetch` (tests). Defaults to the global. */
  readonly fetchImpl?: typeof fetch;
  /** Override the clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class UsageTransportAdapter implements UsageClient {
  private readonly logger: Logger;
  private readonly remainsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(deps: UsageTransportDeps) {
    this.logger = deps.logger;
    this.remainsUrl = deps.remainsUrl ?? DEFAULT_REMAINS_URL;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async fetchUsage(apiKey: string): Promise<TokenPlanUsage> {
    const url = this.remainsUrl;
    const doFetch = this.fetchImpl;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw new UsageUnavailableError('network', 'Network error querying token plan remains', {
        retriable: true,
        cause: err,
      });
    }

    if (!res.ok) {
      throw new UsageUnavailableError(
        'unavailable',
        `Token plan remains returned HTTP ${String(res.status)}`,
        { retriable: res.status >= 500 },
      );
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new UsageUnavailableError(
        'parse',
        'Token plan remains returned non-JSON body',
        { cause: err },
      );
    }

    try {
      const usage = normalizeTokenPlanRemains(raw, this.now());
      this.logger.debug(
        `usage fetch ok: ${String(usage.windows.length)} window(s), overall=${String(usage.percentUsed)}`,
      );
      return usage;
    } catch (err) {
      throw new UsageUnavailableError(
        'parse',
        err instanceof Error ? err.message : 'failed to normalize token plan payload',
        { cause: err },
      );
    }
  }
}
