/**
 * Port for querying MiniMax Token Plan quota.
 *
 * The remains endpoint (`GET /v1/token_plan/remains`, Bearer
 * Subscription Key) is the documented way to read the console usage
 * bar programmatically. MiniMax publishes the endpoint but not a
 * stable response schema — the adapter maps whatever fields it
 * recognizes into a typed `TokenPlanUsage` and always carries the
 * raw payload so the webview can degrade gracefully.
 *
 * Module is pure (no `vscode`, no `fetch`); adapters own all I/O and
 * the runtime secret retrieval. The status bar / webview consume the
 * port interface only — see `src/adapters/status-bar.ts`,
 * `src/commands/show-usage.ts`.
 */

import type { TokenPlanUsage } from '../lib/domain/usage-normalization.js';

export type { TokenPlanUsage, TokenPlanWindow } from '../lib/domain/usage-normalization.js';

export interface UsageClient {
  /**
   * Fetch current Token Plan remains. Throws UsageUnavailableError
   * when:
   *   - the key is a pay-as-you-go key (endpoint 404s / errors),
   *   - the network is unreachable,
   *   - the response is not valid JSON, or
   *   - the schema is unrecognized (MiniMax shipped a breaking change).
   *
   * The status bar renders `UsageUnavailableError` as a neutral
   * icon, never as an alarming red one — a PAYG key is a normal
   * state, not a failure.
   */
  fetchUsage(apiKey: string): Promise<TokenPlanUsage>;
}

/** Canonical secret-storage name for the API key. Shared with the
 *  manage command so the status bar and manage flow read the same
 *  name out of `SecretStorage`. */
export const API_KEY_NAME = 'apiKey';

export type UsageErrorKind = 'unavailable' | 'parse' | 'network';

/**
 * Thrown when the Token Plan endpoint cannot return actionable data.
 * Carries a discriminated `kind` so callers can branch without
 * `instanceof` (mirrors `MiniMaxClientError`).
 */
export class UsageUnavailableError extends Error {
  public readonly kind: UsageErrorKind;
  public readonly retriable: boolean;

  constructor(
    kind: UsageErrorKind,
    message: string,
    options: { retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'UsageUnavailableError';
    this.kind = kind;
    this.retriable = options.retriable ?? false;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
