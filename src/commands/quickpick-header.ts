/**
 * T29 — Reusable QuickPick status header.
 *
 * Pure module: given a snapshot of the key-pool state, returns a
 * non-selectable `kind: 'separator'` row that the manage QuickPick
 * (and any future TUI / webview surface) inserts at index 0.
 *
 * No `vscode` imports — the function is a pure projection from
 * `HeaderState` to a `PickItem`. The header sticks at the top of the
 * menu and always reflects the live state (active slot, per-slot
 * health dots, auto-rotation toggle, and — when the active slot is
 * in cooldown — a warning line with cooldown-remaining seconds).
 */

import type { KeySlot } from '../ports/key-provider.js';

/** Snapshot of the key-pool state the header renders. */
export interface HeaderState {
  readonly activeSlot: KeySlot;
  readonly stored: ReadonlyArray<KeySlot>;
  /** ms remaining per slot in cooldown; absence or 0 = healthy. */
  readonly cooldown: ReadonlyMap<KeySlot, number>;
  readonly autoRotateEnabled: boolean;
}

/**
 * The shape returned by `buildStatusHeader`. Mirrors the
 * `vscode.QuickPickItem` shape narrowly enough to be fed straight
 * into `vscode.window.showQuickPick` after a `kind: 'separator'`
 * row is allowed (the vscode API supports it for divider rows).
 *
 * `alwaysShown` is a friendly hint for any future TUI surface — the
 * header must never be hidden by a "filter" step.
 */
export interface PickItem {
  readonly label: string;
  readonly description?: string;
  readonly kind: 'separator' | 'header';
  readonly alwaysShown: boolean;
}

const NO_KEYS_LABEL = 'No MiniMax API keys stored.';
const NO_KEYS_HINT = 'Pick "Add or rotate key" to get started.';
const ACTIVE_KEY_REJECTED_PREFIX = 'Active key (Slot ';

function msToSecondsCeil(ms: number): number {
  // Round up so a 47.5s cooldown surfaces as "48s" rather than "47s"
  // — the value is a countdown and users expect the next whole second.
  return Math.max(0, Math.ceil(ms / 1000));
}

function dotFor(slot: KeySlot, state: HeaderState): string {
  // Dots reflect HEALTH only — the active marker (`★`) lives in the
  // `Active: Slot N ★` prefix so the dot row never duplicates it.
  const cooldown = state.cooldown.get(slot) ?? 0;
  if (cooldown > 0) return '○';
  return '●';
}

function slotLabel(slot: KeySlot): string {
  return `Slot ${String(slot)}`;
}

function buildSlotList(state: HeaderState): string {
  return state.stored.map((s) => dotFor(s, state)).join(' ');
}

function autoRotateText(state: HeaderState): string {
  return `Auto-rotate: ${state.autoRotateEnabled ? 'ON' : 'OFF'}`;
}

/**
 * Render the header. Order of precedence (highest first):
 *   1. No keys stored → onboarding.
 *   2. Active slot in cooldown → warning line + ready-count.
 *   3. Any other slot in cooldown → partial cooldown (active still
 *      drawn as ★, cooling slot as ○, the rest as ●).
 *   4. All healthy → canonical Active line.
 *
 * The returned PickItem is always `kind: 'separator'` so VS Code's
 * QuickPick renders it as a non-selectable divider.
 */
export function buildStatusHeader(state: HeaderState): PickItem {
  if (state.stored.length === 0) {
    return {
      kind: 'separator',
      label: NO_KEYS_LABEL,
      description: NO_KEYS_HINT,
      alwaysShown: true,
    };
  }

  const activeCooldown = state.cooldown.get(state.activeSlot) ?? 0;
  if (activeCooldown > 0) {
    const readySlots = state.stored.filter((s) => (state.cooldown.get(s) ?? 0) === 0);
    const coolingSlots = state.stored.filter((s) => (state.cooldown.get(s) ?? 0) > 0);
    const coolingDetails =
      coolingSlots.length === 0
        ? ''
        : coolingSlots
            .map(
              (s) =>
                `${slotLabel(s)} cooldown ${String(msToSecondsCeil(state.cooldown.get(s) ?? 0))}s`,
            )
            .join(', ');
    const description =
      coolingDetails.length > 0
        ? `Slots ready: ${String(readySlots.length)} of ${String(state.stored.length)} (${coolingDetails})`
        : `Slots ready: ${String(readySlots.length)} of ${String(state.stored.length)}`;
    return {
      kind: 'separator',
      label: `⚠ ${ACTIVE_KEY_REJECTED_PREFIX}${String(state.activeSlot)}) was rejected ${String(msToSecondsCeil(activeCooldown))}s ago`,
      description,
      alwaysShown: true,
    };
  }

  const otherOnCooldown = state.stored.some(
    (s) => s !== state.activeSlot && (state.cooldown.get(s) ?? 0) > 0,
  );

  // Per-slot cooldown seconds are surfaced via the description only
  // when at least one non-active slot is cooling — keeps the label
  // compact while still letting the user see the worst remaining.
  const coolingNonActive = state.stored
    .filter((s) => s !== state.activeSlot && (state.cooldown.get(s) ?? 0) > 0)
    .map((s) => `${slotLabel(s)} cooldown ${String(msToSecondsCeil(state.cooldown.get(s) ?? 0))}s`);

  const label = `Active: ${slotLabel(state.activeSlot)} ★   ${buildSlotList(state)}   ${autoRotateText(state)}`;
  const description =
    otherOnCooldown && coolingNonActive.length > 0 ? coolingNonActive.join(', ') : undefined;

  return {
    kind: 'separator',
    label,
    ...(description !== undefined ? { description } : {}),
    alwaysShown: true,
  };
}
