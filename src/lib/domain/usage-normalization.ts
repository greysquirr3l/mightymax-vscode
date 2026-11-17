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
  /** Derived from the window's real length: '5-hour window', 'Daily window', 'Weekly window'. */
  readonly label: string;
  /** Compact form for the status bar: '5h', 'day', 'wk'. */
  readonly short?: string;
  /** 0–100, integer, consumed-quota percentage. */
  readonly percentUsed: number;
  /** Wall-clock time the window resets, or undefined when missing. */
  readonly resetsAt?: string;
  /** Window length in ms, when the payload carried start/end times. */
  readonly durationMs?: number;
  /** Counted quota (e.g. video generations); absent for percent-only pools. */
  readonly usedCount?: number;
  readonly totalCount?: number;
}

/** A non-general quota pool (video, image, speech...) with its own windows. */
export interface TokenPlanPool {
  readonly name: string;
  readonly label: string;
  readonly windows: readonly TokenPlanWindow[];
}

export interface TokenPlanUsage {
  /** Whichever window is most-consumed drives the bar tint. Undefined
   *  only when the payload had no usable entry (adapter must throw). */
  readonly percentUsed?: number;
  /** Earliest resetting time across windows. Undefined when absent. */
  readonly resetsAt?: string;
  readonly windows: readonly TokenPlanWindow[];
  /** Other quota pools the plan reports besides `general`. */
  readonly pools?: readonly TokenPlanPool[];
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
  readonly start_time?: number;
  readonly end_time?: number;
  readonly weekly_start_time?: number;
  readonly weekly_end_time?: number;
  readonly current_interval_total_count?: number;
  readonly current_interval_usage_count?: number;
  readonly current_weekly_total_count?: number;
  readonly current_weekly_usage_count?: number;
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
  return remains.filter(isRecord);
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

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Name a window by its real length; fall back to the plan's usual shape. */
export function describeWindow(
  durationMs: number | undefined,
  fallback: 'interval' | 'weekly',
): { readonly label: string; readonly short: string } {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return fallback === 'weekly'
      ? { label: 'Weekly window', short: 'wk' }
      : { label: '5-hour window', short: '5h' };
  }
  if (Math.abs(durationMs - 5 * HOUR_MS) <= 5 * 60_000) return { label: '5-hour window', short: '5h' };
  if (Math.abs(durationMs - DAY_MS) <= 10 * 60_000) return { label: 'Daily window', short: 'day' };
  if (Math.abs(durationMs - 7 * DAY_MS) <= HOUR_MS) return { label: 'Weekly window', short: 'wk' };
  if (durationMs < 2 * DAY_MS) {
    const h = Math.round(durationMs / HOUR_MS);
    return { label: `${String(h)}-hour window`, short: `${String(h)}h` };
  }
  const d = Math.round(durationMs / DAY_MS);
  return { label: `${String(d)}-day window`, short: `${String(d)}d` };
}

function finite(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function buildWindow(
  fallback: 'interval' | 'weekly',
  status: number | undefined,
  remainingPercent: number | undefined,
  remainsMs: number | undefined,
  startMs: number | undefined,
  endMs: number | undefined,
  usedCount: number | undefined,
  totalCount: number | undefined,
  nowMs: number,
): TokenPlanWindow | undefined {
  if (status === STATUS_NOT_IN_PLAN) return undefined;
  if (!finite(remainingPercent)) return undefined;
  const durationMs = finite(startMs) && finite(endMs) && endMs > startMs ? endMs - startMs : undefined;
  const { label, short } = describeWindow(durationMs, fallback);
  return {
    label,
    short,
    percentUsed: clamp(100 - remainingPercent),
    ...(finite(remainsMs)
      ? { resetsAt: new Date(nowMs + Math.max(0, remainsMs)).toISOString() }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(finite(totalCount) && totalCount > 0 && finite(usedCount)
      ? { usedCount, totalCount }
      : {}),
  };
}

function windowsFor(entry: TokenPlanRemainsEntry, nowMs: number): TokenPlanWindow[] {
  const out: TokenPlanWindow[] = [];
  const interval = buildWindow(
    'interval',
    entry.current_interval_status,
    entry.current_interval_remaining_percent,
    entry.remains_time,
    entry.start_time,
    entry.end_time,
    entry.current_interval_usage_count,
    entry.current_interval_total_count,
    nowMs,
  );
  if (interval !== undefined) out.push(interval);
  const weekly = buildWindow(
    'weekly',
    entry.current_weekly_status,
    entry.current_weekly_remaining_percent,
    entry.weekly_remains_time,
    entry.weekly_start_time,
    entry.weekly_end_time,
    entry.current_weekly_usage_count,
    entry.current_weekly_total_count,
    nowMs,
  );
  if (weekly !== undefined) out.push(weekly);
  return out;
}

const POOL_LABELS: Readonly<Record<string, string>> = {
  video: 'Video',
  image: 'Image',
  speech: 'Speech',
  music: 'Music',
};

function poolLabel(name: string): string {
  return POOL_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** The most-consumed window: the one that will bind first. */
export function bindingWindow(usage: TokenPlanUsage): TokenPlanWindow | undefined {
  let best: TokenPlanWindow | undefined;
  for (const w of usage.windows) {
    if (best === undefined || w.percentUsed > best.percentUsed) best = w;
  }
  return best;
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

  const windows = windowsFor(entry, nowMs);
  if (windows.length === 0) {
    throw new Error('Token plan entry reported no active windows');
  }

  const pools: TokenPlanPool[] = [];
  for (const other of entries) {
    // Per-model text entries (`MiniMax-M3`...) mirror the plan-wide
    // `general` quota; only the separately-metered pools are surfaced.
    if (
      other === entry ||
      typeof other.model_name !== 'string' ||
      other.model_name === 'general' ||
      other.model_name.toLowerCase().startsWith('minimax-')
    ) {
      continue;
    }
    const poolWindows = windowsFor(other, nowMs);
    if (poolWindows.length > 0) {
      pools.push({ name: other.model_name, label: poolLabel(other.model_name), windows: poolWindows });
    }
  }

  const percentUsed = Math.max(...windows.map((w) => w.percentUsed));
  const resetsAt = windows.find((w) => w.resetsAt !== undefined)?.resetsAt;

  return {
    percentUsed,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    windows,
    ...(pools.length > 0 ? { pools } : {}),
    raw: payload,
    fetchedAt: new Date(nowMs),
  };
}
