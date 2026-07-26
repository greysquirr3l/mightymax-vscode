/**
 * T31 — Per-slot flight-deck view.
 *
 * Replaces the 10-item "Manage API keys" submenu with two layers:
 *
 *   1. `buildFlightDeckItems(state)` — one row per stored slot.
 *      Pure projection from `FlightDeckState` to pick items; the
 *      caller feeds the resulting array into `vscode.window.showQuickPick`
 *      and dispatches on the chosen label.
 *
 *   2. `runSlotActionSheet(deps)` — opens the per-slot action sheet
 *      (Set / Test / Clear / Make active / Rename). The "Make
 *      active" action is hidden when the chosen slot is already
 *      the active slot.
 *
 * Slot labels persist across restarts in `globalState` (via the
 * pure helpers in `src/lib/domain/slot-labels.ts`). The wire
 * adapter for that Memento lives in `src/adapters/slot-labels.ts`;
 * this module only consumes a slot-label map.
 */

import type { Logger } from '../ports/logger.js';
import type { KeyProvider, KeySlot, StoredKey } from '../ports/key-provider.js';
import { validateApiKey } from '../adapters/api-key-validator.js';
import { defaultLabelFor, getLabel, setLabel } from '../lib/domain/slot-labels.js';

export interface FlightDeckState {
  readonly activeSlot: KeySlot;
  readonly stored: ReadonlyArray<KeySlot>;
  /** ms remaining per slot in cooldown; absence or 0 = healthy. */
  readonly cooldown: ReadonlyMap<KeySlot, number>;
  readonly labels: Map<KeySlot, string>;
  readonly autoRotateEnabled: boolean;
}

/** Minimal UI seam needed by `runSlotActionSheet`. Mirrors the `ManageUi`
 * shape used by the rest of the manage-command tree so a real
 * `vscode.window` adapter (and a scripted test seam) both work. */
export interface SlotUi {
  showQuickPick(
    items: readonly { label: string; description?: string }[],
    options?: { title?: string },
  ): Promise<{ label: string } | undefined>;
  showInputBox(options?: {
    prompt?: string;
    password?: boolean;
    value?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInfoMessage(message: string): Promise<string | undefined>;
  showErrorMessage(message: string): Promise<string | undefined>;
}

export interface SlotActionDeps {
  slot: KeySlot;
  keyProvider: KeyProvider;
  ui: SlotUi;
  logger: Logger;
  /**
   * Mutable working copy of the slot-label map. The Rename handler
   * updates this in place; the caller is responsible for persisting
   * it (typically via the SlotLabelsStore.set adapter) when the
   * flight-deck flow exits.
   */
  labels: Map<KeySlot, string>;
  fireChange: () => void;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface FlightDeckRow {
  label: string;
  description?: string;
}

function healthDot(slot: KeySlot, state: FlightDeckState): string {
  if ((state.cooldown.get(slot) ?? 0) > 0) return '○';
  return slot === state.activeSlot ? '★' : '●';
}

/**
 * Build the per-slot pick list. One row per stored slot, in slot
 * order. Pure — no I/O, no vscode. The caller wraps this into a
 * QuickPick via the `ui.showQuickPick` adapter.
 */
export function buildFlightDeckItems(state: FlightDeckState): FlightDeckRow[] {
  const rows: FlightDeckRow[] = [];
  for (const slot of state.stored) {
    const dot = healthDot(slot, state);
    const label = getLabel(state.labels, slot, defaultLabelFor(slot));
    rows.push({
      label: `${label}  ${dot}${slot === state.activeSlot ? ' active' : ''}`,
      description: 'Open the slot action sheet',
    });
  }
  return rows;
}

const SLOT_SET = 'Set / replace key';
const SLOT_TEST = 'Test this key';
const SLOT_CLEAR = 'Clear this key';
const SLOT_MAKE_ACTIVE = 'Make active';
const SLOT_RENAME = 'Rename slot';

/**
 * Open the action sheet for a single slot. The "Make active" row is
 * omitted when the slot is already the active slot.
 */
export async function runSlotActionSheet(deps: SlotActionDeps): Promise<void> {
  const stored = await deps.keyProvider.listStoredKeys();
  const storedSet = new Set(stored.map((k: StoredKey) => k.slot));
  const isActive =
    storedSet.has(deps.slot) && deps.slot === (await deps.keyProvider.getActiveSlot());

  const items: { label: string; description?: string }[] = [
    {
      label: SLOT_SET,
      description: 'Open the password-masked input and validate against /v1/models',
    },
    { label: SLOT_TEST, description: "Validate this slot's key against the models endpoint" },
    { label: SLOT_CLEAR, description: "Remove this slot's key from SecretStorage" },
    ...(isActive ? [] : [{ label: SLOT_MAKE_ACTIVE, description: 'Promote this slot to active' }]),
    { label: SLOT_RENAME, description: 'Set a custom label (e.g. "personal", "work")' },
  ];

  const choice = await deps.ui.showQuickPick(items, {
    title: `Mighty Max — Slot ${String(deps.slot)}`,
  });
  if (!choice) return;

  if (choice.label === SLOT_SET) {
    await handleSlotSet(deps);
  } else if (choice.label === SLOT_TEST) {
    await handleSlotTest(deps, stored);
  } else if (choice.label === SLOT_CLEAR) {
    await handleSlotClear(deps, storedSet);
  } else if (choice.label === SLOT_MAKE_ACTIVE) {
    await handleSlotMakeActive(deps, storedSet);
  } else if (choice.label === SLOT_RENAME) {
    await handleSlotRename(deps);
  }
}

async function handleSlotSet(deps: SlotActionDeps): Promise<void> {
  const key = await deps.ui.showInputBox({
    prompt: `Enter your MiniMax API key for slot ${String(deps.slot)}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  const trimmed = key.trim();
  if (trimmed === '') {
    await deps.ui.showErrorMessage('API key must not be empty.');
    return;
  }
  deps.logger.info(`Slot ${String(deps.slot)}: validating new API key`);
  const result = await validateApiKey(trimmed, deps.baseUrl, deps.fetchImpl);
  if (!result.ok) {
    if (result.reason === 'unauthorized') {
      await deps.ui.showErrorMessage(
        `That API key was rejected by MiniMax. Slot ${String(deps.slot)} has not been updated.`,
      );
    } else if (result.reason === 'network') {
      await deps.ui.showErrorMessage(
        'Could not reach MiniMax to validate the key. Check your network and try again.',
      );
    } else {
      await deps.ui.showErrorMessage(
        'MiniMax returned an unexpected response. The key has not been stored.',
      );
    }
    return;
  }
  await deps.keyProvider.setKey(deps.slot, trimmed);
  deps.logger.info(`Slot ${String(deps.slot)}: API key stored`);
  deps.fireChange();
  await deps.ui.showInfoMessage(
    `Slot ${String(deps.slot)}: API key saved. MiniMax reports ${result.modelIds.length} model(s) available.`,
  );
}

async function handleSlotTest(
  deps: SlotActionDeps,
  stored: ReadonlyArray<StoredKey>,
): Promise<void> {
  const entry = stored.find((k) => k.slot === deps.slot);
  if (!entry) {
    await deps.ui.showInfoMessage(`Slot ${String(deps.slot)} has no stored key.`);
    return;
  }
  deps.logger.info(`Slot ${String(deps.slot)}: testing key`);
  const result = await validateApiKey(entry.key, deps.baseUrl, deps.fetchImpl);
  if (result.ok) {
    await deps.ui.showInfoMessage(
      `Slot ${String(deps.slot)}: OK — ${result.modelIds.length} model(s) available.`,
    );
  } else if (result.reason === 'unauthorized') {
    await deps.ui.showErrorMessage(
      `Slot ${String(deps.slot)}: MiniMax rejected the key (401/403).`,
    );
  } else if (result.reason === 'network') {
    await deps.ui.showErrorMessage(`Slot ${String(deps.slot)}: could not reach MiniMax.`);
  } else {
    await deps.ui.showErrorMessage(
      `Slot ${String(deps.slot)}: MiniMax returned an unexpected response.`,
    );
  }
}

async function handleSlotClear(deps: SlotActionDeps, storedSet: Set<KeySlot>): Promise<void> {
  if (!storedSet.has(deps.slot)) {
    await deps.ui.showInfoMessage(`Slot ${String(deps.slot)} has no stored key.`);
    return;
  }
  await deps.keyProvider.setKey(deps.slot, null);
  deps.logger.info(`Slot ${String(deps.slot)}: API key cleared`);
  deps.fireChange();
  await deps.ui.showInfoMessage(`Slot ${String(deps.slot)}: API key cleared.`);
}

async function handleSlotMakeActive(deps: SlotActionDeps, storedSet: Set<KeySlot>): Promise<void> {
  if (!storedSet.has(deps.slot)) {
    await deps.ui.showInfoMessage(`Slot ${String(deps.slot)} has no stored key.`);
    return;
  }
  await deps.keyProvider.setActiveSlot(deps.slot);
  deps.logger.info(`Slot ${String(deps.slot)}: promoted to active`);
  deps.fireChange();
  await deps.ui.showInfoMessage(`Slot ${String(deps.slot)} is now the active slot.`);
}

async function handleSlotRename(deps: SlotActionDeps): Promise<void> {
  const currentLabel = getLabel(deps.labels, deps.slot, defaultLabelFor(deps.slot));
  const next = await deps.ui.showInputBox({
    prompt: `Rename slot ${String(deps.slot)}`,
    value: currentLabel,
    ignoreFocusOut: true,
  });
  if (next === undefined) return;
  const trimmed = next.trim();
  // setLabel returns a new map; we mutate the input in place so the
  // caller (which holds the same map reference) sees the update.
  const updated = setLabel(deps.labels, deps.slot, trimmed);
  deps.labels.clear();
  for (const [k, v] of updated) deps.labels.set(k, v);
  deps.logger.info(`Slot ${String(deps.slot)}: label updated`, {
    from: currentLabel,
    to: trimmed,
  });
  await deps.ui.showInfoMessage(
    trimmed === ''
      ? `Slot ${String(deps.slot)} label cleared.`
      : `Slot ${String(deps.slot)} renamed to "${trimmed}".`,
  );
}

/**
 * Run the per-slot flight-deck view: build rows from the live key-pool
 * state, show them, dispatch on the chosen row's label into
 * `runSlotActionSheet`. Used by the main manage command's
 * "Manage keys" CTA.
 */
export async function runFlightDeckView(deps: SlotActionDeps): Promise<void> {
  const stored = await deps.keyProvider.listStoredKeys();
  const storedSlots: ReadonlyArray<KeySlot> = stored.map((s) => s.slot);
  const activeSlot = await deps.keyProvider.getActiveSlot();
  const healthySlots = await deps.keyProvider.listHealthySlots();
  const cooldown = new Map<KeySlot, number>();
  for (const slot of storedSlots) {
    if (!healthySlots.includes(slot)) {
      // Sentinel positive so the healthDot renders ○. The T29 header
      // surfaces real durations elsewhere.
      cooldown.set(slot, 1);
    }
  }

  const state: FlightDeckState = {
    activeSlot,
    stored: storedSlots,
    cooldown,
    labels: deps.labels,
    autoRotateEnabled: true,
  };

  const rows = buildFlightDeckItems(state);
  if (rows.length === 0) {
    await deps.ui.showInfoMessage(
      'No MiniMax API keys are stored. Use "Add or rotate API key" to add one.',
    );
    return;
  }
  const choice = await deps.ui.showQuickPick(rows, {
    title: 'Mighty Max — flight deck',
  });
  if (!choice) return;

  const slotMatch = matchPickedSlot(choice.label, state);
  if (slotMatch === undefined) return;
  await runSlotActionSheet({ ...deps, slot: slotMatch });
}

function matchPickedSlot(pickedLabel: string, state: FlightDeckState): KeySlot | undefined {
  for (const slot of state.stored) {
    const label = getLabel(state.labels, slot, defaultLabelFor(slot));
    if (pickedLabel.startsWith(label)) return slot;
  }
  return undefined;
}
