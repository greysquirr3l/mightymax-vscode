/**
 * T31 — Per-slot flight-deck view.
 *
 * Pure helpers for reading/writing slot labels. No I/O; the actual
 * persistence happens in the SlotLabelsStore adapter. This module exists
 * so the view's label logic can be unit-tested without touching
 * vscode.Memento.
 *
 * Labels are keyed by `KeySlot` (1 / 2 / 3) and stored as plain strings.
 * Empty strings are treated as "no label" (deleted on set).
 */

import type { KeySlot } from '../../ports/key-provider.js';

/** Map of slot → user-chosen label. Empty slots are simply absent from the map. */
export type SlotLabelMap = ReadonlyMap<KeySlot, string>;

/** The default state when no labels have been persisted yet. */
export function buildDefaultLabels(): SlotLabelMap {
  return new Map();
}

/** Resolve a label for display, falling back to a generated default. */
export function getLabel(map: SlotLabelMap, slot: KeySlot, fallback: string): string {
  const stored = map.get(slot);
  return stored === undefined || stored === '' ? fallback : stored;
}

/**
 * Set (or clear) a label. Returns a NEW map — never mutates the input.
 * Empty-string labels are removed so the map stays tight.
 */
export function setLabel(map: SlotLabelMap, slot: KeySlot, label: string): SlotLabelMap {
  const next = new Map(map);
  if (label === '') {
    next.delete(slot);
  } else {
    next.set(slot, label);
  }
  return next;
}

/**
 * Parse a raw value (as deserialized from `globalState`) into a
 * SlotLabelMap. Tolerates malformed input — unknown shapes collapse to
 * the empty map so a corrupt persistence layer never crashes the view.
 */
export function parseLabelsFromGlobalState(raw: unknown): SlotLabelMap {
  if (typeof raw !== 'object' || raw === null) return new Map();
  const map = new Map<KeySlot, string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const slot = Number(k);
    if (slot >= 1 && slot <= 3 && Number.isInteger(slot) && typeof v === 'string') {
      map.set(slot as KeySlot, v);
    }
  }
  return map;
}

/**
 * Serialize a SlotLabelMap for persistence. Single-key shape
 * (`globalState['mightyMax.slotLabels']`) keeps storage tight; the
 * adapter does the actual Memento write.
 */
export function serializeLabelsToGlobalState(map: SlotLabelMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, label] of map) {
    if (label === '') continue;
    out[String(slot)] = label;
  }
  return out;
}

/** Generate the canonical fallback label for a slot. */
export function defaultLabelFor(slot: KeySlot): string {
  return `Slot ${String(slot)}`;
}
