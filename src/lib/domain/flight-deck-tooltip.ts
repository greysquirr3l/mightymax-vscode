/**
 * T32 — Flight-deck status-bar renderer.
 *
 * Pure markdown rendering for the status-bar item's tooltip and text.
 * No I/O, no `vscode` import — the adapter in `src/adapters/status-bar.ts`
 * snapshots the live state (active slot, healthy slots, cooldown
 * remaining, slot labels, auto-rotation toggle, last fallback, usage
 * data) and calls these builders.
 *
 * Layout (T32 spec, verbatim):
 *
 *     ▼ Mighty Max · Flight Deck
 *     ─────────────────────────
 *     Slot 1 ● healthy ★ personal
 *     Slot 2 ● healthy   work
 *     Slot 3 ○ cooldown 47s
 *     ─────────────────────────
 *     Auto-rotation: ON
 *     Last fallback: slot 2 · 3m ago
 *     ─────────────────────────
 *     5h window: 42% used `████░░░░░░`
 *     Weekly:    18% used `██░░░░░░░░`
 *     as of 16:24:03 · click for details
 *
 * Red-dot overlay (T32 acceptance): the status-bar item's text gets
 * ` $(error)` appended whenever the active slot is in cooldown, so
 * the user can spot the failure mode at a glance even without
 * hovering. The status-bar code calls `buildFlightDeckText({ ...,
 * activeInCooldown: true })` to render that suffix.
 *
 * Edge cases honored:
 *   - No keys stored at all → "no API key set. Run `Mighty Max: Manage`."
 *   - Slot has no user-set label → "Slot N" default (from `defaultLabelFor`).
 *   - `lastFallback` is undefined → "Last fallback: (none yet)".
 *   - Usage fetch failed (PAY-G key / network) → render the
 *     health/auto-rotation/last-fallback sections but skip the Token
 *     Plan bars and replace them with a short note.
 *   - "ago" math on `lastFallback.atMs` clamps to "just now" for
 *     sub-minute values, "Nm ago" for minutes < 60, and "Nh ago"
 *     beyond that (we don't expect cooldowns longer than ~60s but
 *     the renderer is defensive).
 */
import type { KeySlot } from './key-pool.js';
import type { TokenPlanUsage } from './usage-normalization.js';

export interface FlightDeckTooltipInput {
  /** The user's preferred slot. */
  readonly activeSlot: KeySlot;
  /** All slots that have a stored key (slot order). */
  readonly stored: ReadonlyArray<KeySlot>;
  /** Slots currently NOT in cooldown AND with a stored key. */
  readonly healthySlots: ReadonlySet<KeySlot>;
  /** Per-slot cooldown remaining in ms. Absence or 0 = healthy. */
  readonly cooldownMsRemaining: ReadonlyMap<KeySlot, number>;
  /** Per-slot label (the user can rename them in the flight-deck view). */
  readonly labels: ReadonlyMap<KeySlot, string>;
  /** `mightyMax.enableAutoKeyRotation` (true = ON). */
  readonly autoRotationEnabled: boolean;
  /** Most-recent successful fallback (T32), undefined until first fallback. */
  readonly lastFallback:
    { readonly slot: KeySlot; readonly fellBackFrom: KeySlot; readonly atMs: number } | undefined;
  /** Token plan usage from the UsageClient; undefined on fetch failure. */
  readonly usage: TokenPlanUsage | undefined;
  /** Wall-clock ms for the "as of HH:MM:SS" line + relative time math. */
  readonly nowMs: number;
  /** True when no key is stored at all (noKey takes precedence over usage). */
  readonly noKey: boolean;
  /** True when the usage fetch returned `UsageUnavailableError` (PAYG key etc.). */
  readonly usageUnavailable: boolean;
}

const SEPARATOR = '─────────────────────────';

/** Default for `Icon` — kept in this module so the unit tests don't need vscode. */
export const FLIGHT_DECK_ICON = '$(mightymax-head)';

/** Round-up divider for "ago" math; never shows "0m ago" for sub-minute. */
function relativeAgo(fromMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - fromMs);
  if (delta < 60_000) return 'just now';
  if (delta < 60 * 60_000) {
    const m = Math.floor(delta / 60_000);
    return `${String(m)}m ago`;
  }
  const h = Math.floor(delta / (60 * 60_000));
  return `${String(h)}h ago`;
}

function fmtClock(ms: number): string {
  // Use UTC components so the rendered timestamp is independent of
  // the host's local timezone — important for cross-host CI and for
  // tests that want a deterministic output. Real wall-clock displays
  // should use `toLocaleTimeString()` if the host's tz is wanted.
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 10-cell Unicode block bar. Same convention as the webview tooltip. */
function bar(pct: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * 10);
  return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '`';
}

/** Pad "Slot 1" / "Slot 2" so the dot columns line up. */
function slotPrefix(slot: KeySlot): string {
  return `Slot ${String(slot)}`;
}

function dotFor(slot: KeySlot, input: FlightDeckTooltipInput): string {
  const remaining = input.cooldownMsRemaining.get(slot) ?? 0;
  if (remaining > 0) return '○';
  return input.healthySlots.has(slot) ? '●' : '✕';
}

function slotLine(slot: KeySlot, input: FlightDeckTooltipInput): string {
  const remaining = input.cooldownMsRemaining.get(slot) ?? 0;
  // Only show the label when the user has renamed the slot. The
  // default `"Slot N"` would duplicate the line prefix and waste
  // columns in the tooltip — `★` alone is enough to mark the
  // active slot.
  const userLabel = input.labels.get(slot);
  const labelSuffix = userLabel !== undefined && userLabel !== '' ? ` ${userLabel}` : '';
  const activeMark = slot === input.activeSlot ? ' ★' : '  ';
  if (remaining > 0) {
    const secs = Math.ceil(remaining / 1000);
    return `${slotPrefix(slot)} ○ cooldown ${String(secs)}s${activeMark}${labelSuffix}`;
  }
  const dot = dotFor(slot, input);
  if (!input.healthySlots.has(slot) && input.stored.includes(slot)) {
    return `${slotPrefix(slot)} ${dot} unknown${activeMark}${labelSuffix}`;
  }
  return `${slotPrefix(slot)} ${dot} healthy${activeMark}${labelSuffix}`;
}

function usageLine(windowLabel: string, pct: number): string {
  // Map the canonical labels to the compact form the T32 spec
  // uses in the tooltip so the line width stays tight. Anything
  // else falls through verbatim.
  const compact =
    windowLabel === '5-hour window'
      ? '5h window'
      : windowLabel === 'Weekly window'
        ? 'Weekly'
        : windowLabel;
  const padded = `${compact}:`.padEnd(11, ' ');
  return `${padded}${String(pct)}% used ${bar(pct)}`;
}

function usageSection(input: FlightDeckTooltipInput): readonly string[] {
  if (input.usageUnavailable) {
    return ['_usage unavailable (pay-as-you-go keys have no Token Plan bar)_'];
  }
  if (input.usage === undefined) {
    return ['_usage unavailable — click for details_'];
  }
  const lines: string[] = [];
  for (const w of input.usage.windows) {
    lines.push(usageLine(w.label, w.percentUsed));
  }
  if (lines.length === 0) {
    lines.push('_No quota windows reported._');
  }
  return lines;
}

/**
 * Render the markdown for the status-bar tooltip. Pure. The caller
 * is responsible for wrapping the returned string in a
 * `vscode.MarkdownString` (the `MarkdownString.appendMarkdown(text)`
 * call is the only adapter-side step).
 */
export function buildFlightDeckTooltip(input: FlightDeckTooltipInput): string {
  if (input.noKey) {
    return 'Mighty Max — no API key set. Run `Mighty Max: Manage`.';
  }
  const lines: string[] = [];
  lines.push('▼ Mighty Max · Flight Deck');
  lines.push(SEPARATOR);
  for (const slot of [1, 2, 3] as const) {
    lines.push(slotLine(slot, input));
  }
  lines.push(SEPARATOR);
  lines.push(`Auto-rotation: ${input.autoRotationEnabled ? 'ON' : 'OFF'}`);
  if (input.lastFallback !== undefined) {
    lines.push(
      `Last fallback: slot ${String(input.lastFallback.fellBackFrom)} ` +
        `· ${relativeAgo(input.lastFallback.atMs, input.nowMs)}`,
    );
  } else {
    lines.push('Last fallback: (none yet)');
  }
  lines.push(SEPARATOR);
  for (const line of usageSection(input)) {
    lines.push(line);
  }
  lines.push(`as of ${fmtClock(input.nowMs)} · click for details`);
  // A plain '\n' is a markdown *soft* break — VS Code's renderer
  // collapses it to a space, so the whole tooltip reflows into one
  // paragraph. Two trailing spaces force a CommonMark hard break.
  return lines.join('  \n');
}

export interface FlightDeckTextInput {
  /** Icon prefix (kept injectable so tests can use a plain ASCII marker). */
  readonly icon: string;
  /** Headline percentage; undefined → just the icon, no percent. */
  readonly percentUsed: number | undefined;
  /** True when the user's active slot is currently in cooldown. */
  readonly activeInCooldown: boolean;
}

/**
 * Render the status-bar item text. Appends ` $(error)` when the active
 * slot is in cooldown so the user spots it at a glance without hovering.
 * Pure.
 */
export function buildFlightDeckText(input: FlightDeckTextInput): string {
  const base =
    input.percentUsed === undefined ? input.icon : `${input.icon} ${String(input.percentUsed)}%`;
  return input.activeInCooldown ? `${base} $(error)` : base;
}

/**
 * Pure helper: true when the active slot has a non-zero cooldown
 * remaining. The status bar uses this to decide whether to append
 * the `$(error)` suffix.
 */
export function isActiveInCooldown(input: FlightDeckTooltipInput): boolean {
  return (input.cooldownMsRemaining.get(input.activeSlot) ?? 0) > 0;
}
