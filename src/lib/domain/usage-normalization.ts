/**
 * Token Plan usage — pure domain normalization.
 *
 * MiniMax does not document the wire schema of
 * `GET https://www.minimax.io/v1/token_plan/remains`. The shape
 * exercised here was verified against a working consumer
 * (`oc-usage-limits-plugin`, the opencode TUI's usage display).
 *
 * Invariants the normalizer preserves:
 * - `model_remains[]` carries one record per model; `model_name === "general"`
 *   is the canonical plan-wide quota.
 * - Percentages are REPORTED AS REMAINING. Used = 100 - remaining.
 * - `*_status === 3` means the model is not enrolled in that window;
 *   the API still returns `100` for the phantom bucket, so those
 *   windows MUST be filtered out — otherwise the status bar would
 *   briefly flash a free reading on a plan that is otherwise full.
 * - `remains_time` / `weekly_remains_time` are RELATIVE milliseconds
 *   until the window resets, not epoch timestamps. The rendered
 *   `resetsAt` is `now + remainsTime` localized.
 *
 * The module is import-free from `vscode` and from any I/O boundary;
 * adapters do the fetch, this module does the parse.
 */

export interface TokenPlanWindow {
  readonly label: '5-hour window' | 'Weekly window';
  /** 0–100, integer, consumed-quota percentage. */
  readonly percentUsed: number;
  /** Wall-clock time the window resets, or undefined when missing. */
  readonly resetsAt?: string;
}

export interface TokenPlanUsage {
  /** Whichever window is most-consumed drives the bar tint. Undefined
   *  only when the payload had no usable entry (adapter must throw). */
  readonly percentUsed?: number;
  /** Earliest resetting time across windows. Undefined when absent. */
  readonly resetsAt?: string;
  readonly windows: readonly TokenPlanWindow[];
  readonly raw: unknown;
  readonly fetchedAt: Date;
}

export interface TokenPlanRemainsEntry {
  readonly model_name?: string;
  readonly current_interval_status?: number;
  readonly current_interval_remaining_percent?: number;
  /** Relative milliseconds until the 5-hour window resets. */
  readonly remains_time?: number;
  readonly current_weekly_status?: number;
  readonly current_weekly_remaining_percent?: number;
  /** Relative milliseconds until the weekly window resets. */
  readonly weekly_remains_time?: number;
}

export interface TokenPlanRemainsPayload {
  readonly base_resp?: unknown;
  readonly model_remains?: ReadonlyArray<unknown>;
}

export const STATUS_NOT_IN_PLAN = 3;
export const STATUS_ACTIVE = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Validate the envelope and return per-model entries.
 *
 * `base_resp.status_code === 0` (with `status_msg === "success"`) is the
 * documented success envelope. MiniMax occasionally returns a payload
 * where `status_code` is null/undefined but `status_msg` is `"success"`;
 * accept that too.
 *
 * @throws UsageParseError on any unexpected shape. The transport
 *   adapter treats "MiniMax changed the schema" the same as "no data".
 */
export function parseModelRemains(payload: unknown): readonly TokenPlanRemainsEntry[] {
  if (!isRecord(payload)) throw new Error('Token plan payload is not an object');
  const baseResp = payload['base_resp'];
  const statusCode = isRecord(baseResp) ? baseResp['status_code'] : undefined;
  const statusMsg = isRecord(baseResp) ? baseResp['status_msg'] : undefined;
  const okCode = statusCode === 0 || statusCode === null || statusCode === undefined;
  if (!okCode || statusMsg !== 'success') {
    throw new Error(
      `Token plan envelope not successful (status_code=${String(statusCode)}, status_msg=${String(statusMsg)})`,
    );
  }
  const remains = payload['model_remains'];
  if (!Array.isArray(remains)) throw new Error('Token plan payload has no model_remains array');
  return remains.filter(isRecord) as readonly TokenPlanRemainsEntry[];
}

/**
 * The plan covers every model but reports one record per model; the
 * "general" record is the canonical plan-wide quota. Fall back to the
 * first active entry with a numeric remaining percent.
 */
export function selectEntry(
  entries: readonly TokenPlanRemainsEntry[],
): TokenPlanRemainsEntry | undefined {
  const general = entries.find((e) => e.model_name === 'general');
  if (general !== undefined) return general;
  return entries.find(
    (e) =>
      e.current_interval_status === STATUS_ACTIVE &&
      typeof e.current_interval_remaining_percent === 'number',
  );
}

function buildWindow(
  label: TokenPlanWindow['label'],
  status: number | undefined,
  remainingPercent: number | undefined,
  remainsMs: number | undefined,
  nowMs: number,
): TokenPlanWindow | undefined {
  if (status === STATUS_NOT_IN_PLAN) return undefined;
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) return undefined;
  const percentUsed = clamp(100 - remainingPercent);
  const resetsAt =
    typeof remainsMs === 'number' && Number.isFinite(remainsMs)
      ? new Date(nowMs + Math.max(0, remainsMs)).toISOString()
      : undefined;
  return resetsAt !== undefined
    ? { label, percentUsed, resetsAt }
    : { label, percentUsed };
}

/**
 * Full payload → normalized TokenPlanUsage.
 *
 * @throws Error when no per-model entry is usable or when no window
 *   is active. The transport adapter maps this to UsageUnavailableError.
 */
export function normalizeTokenPlanRemains(
  payload: unknown,
  nowMs: number,
): TokenPlanUsage {
  const entries = parseModelRemains(payload);
  const entry = selectEntry(entries);
  if (entry === undefined) {
    throw new Error('No usable model_remains entry (no "general", none active)');
  }

  const windows: TokenPlanWindow[] = [];
  const fiveHour = buildWindow(
    '5-hour window',
    entry.current_interval_status,
    entry.current_interval_remaining_percent,
    entry.remains_time,
    nowMs,
  );
  if (fiveHour !== undefined) windows.push(fiveHour);
  const weekly = buildWindow(
    'Weekly window',
    entry.current_weekly_status,
    entry.current_weekly_remaining_percent,
    entry.weekly_remains_time,
    nowMs,
  );
  if (weekly !== undefined) windows.push(weekly);

  if (windows.length === 0) {
    throw new Error('Token plan entry reported no active windows');
  }

  const percentUsed = Math.max(...windows.map((w) => w.percentUsed));
  const resetsAt = windows.find((w) => w.resetsAt !== undefined)?.resetsAt;

  return resetsAt !== undefined
    ? { percentUsed, resetsAt, windows, raw: payload, fetchedAt: new Date(nowMs) }
    : { percentUsed, windows, raw: payload, fetchedAt: new Date(nowMs) };
}
