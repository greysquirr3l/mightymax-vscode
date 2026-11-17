/**
 * Human-readable formatting for quota windows (pure).
 *
 * The quota API reports reset times as epoch/relative milliseconds;
 * these helpers turn them into "in 1h 13m (15:42)" in the user's local
 * time. The UTC offset is injected so tests (and the tooltip) never
 * depend on the host timezone.
 */

import type { TokenPlanUsage, TokenPlanWindow } from './usage-normalization.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `UTC`, `UTC-5`, `UTC+5:30`. */
export function utcOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h)}${m === 0 ? '' : `:${pad(m)}`}`;
}

/** `HH:MM:SS` in the given offset. */
export function formatClockSeconds(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * MINUTE);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** `in 47m`, `in 1h 13m`, `in 5d 10h`; `now` once it has passed. */
export function formatRelative(targetMs: number, nowMs: number): string {
  const delta = targetMs - nowMs;
  if (delta <= 0) return 'now';
  if (delta < MINUTE) return 'in under a minute';
  if (delta < HOUR) return `in ${String(Math.floor(delta / MINUTE))}m`;
  if (delta < 48 * HOUR) {
    const h = Math.floor(delta / HOUR);
    const m = Math.floor((delta % HOUR) / MINUTE);
    return m === 0 ? `in ${String(h)}h` : `in ${String(h)}h ${String(m)}m`;
  }
  const d = Math.floor(delta / DAY);
  const h = Math.floor((delta % DAY) / HOUR);
  return h === 0 ? `in ${String(d)}d` : `in ${String(d)}d ${String(h)}h`;
}

/** `in 1h 13m (15:42)`; beyond a day the clock gains a weekday: `in 5d 10h (Sat 08:00)`. */
export function formatReset(resetsAtIso: string, nowMs: number, offsetMinutes: number): string {
  const at = Date.parse(resetsAtIso);
  if (!Number.isFinite(at)) return resetsAtIso;
  const local = new Date(at + offsetMinutes * MINUTE);
  const clock = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const day = at - nowMs >= DAY ? `${WEEKDAYS[local.getUTCDay()] ?? ''} ` : '';
  return `${formatRelative(at, nowMs)} (${day}${clock})`;
}

/** `0/3 today`, `4/21 this week`, `12/100 in the 5-hour window`. */
export function formatCount(w: TokenPlanWindow): string | undefined {
  if (w.usedCount === undefined || w.totalCount === undefined) return undefined;
  const period =
    w.short === 'day' ? 'today' : w.short === 'wk' ? 'this week' : `in the ${w.label}`;
  return `${String(w.usedCount)}/${String(w.totalCount)} ${period}`;
}

/** Windows that have hit 100%, for the exhausted banner. */
export function exhaustedWindows(usage: TokenPlanUsage): readonly TokenPlanWindow[] {
  return usage.windows.filter((w) => w.percentUsed >= 100);
}
