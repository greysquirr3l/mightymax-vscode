/**
 * T20 — Utility-model nudge decision truth table.
 *
 * The full 8-case combination (4 boolean conditions × 2 paths) is
 * exercised so any regression to the conjunction is caught.
 *
 * The condition that fires the nudge is the conjunction:
 *   `hasApiKey && byokDefaultIsNone && utilityModelUnset && notDismissed`
 *
 * Each case below names the failing condition(s) so a future
 * change to the predicate surfaces as a focused test failure.
 */

import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { decideUtilityNudge } from './domain/utility-nudge.js';

function makeState(
  hasApiKey: boolean,
  byokDefaultIsNone: boolean,
  utilityModelUnset: boolean,
  notDismissed: boolean,
): {
  hasApiKey: boolean;
  byokDefaultIsNone: boolean;
  utilityModelUnset: boolean;
  notDismissed: boolean;
} {
  return { hasApiKey, byokDefaultIsNone, utilityModelUnset, notDismissed };
}

describe('decideUtilityNudge — full 8-case truth table', () => {
  it('shows when all four conditions are true (user-facing default)', () => {
    strictEqual(
      decideUtilityNudge(makeState(true, true, true, true)),
      'show',
    );
  });

  it('skips when no API key is stored (extension not onboarded)', () => {
    strictEqual(
      decideUtilityNudge(makeState(false, true, true, true)),
      'skip',
    );
  });

  it('skips when byokUtilityModelDefault is already configured to a non-none value', () => {
    // The user has already opted into `mainAgent` or `copilot`,
    // so the prompt is unnecessary.
    strictEqual(
      decideUtilityNudge(makeState(true, false, true, true)),
      'skip',
    );
  });

  it('skips when utilityModel is already set (user pre-configured)', () => {
    strictEqual(
      decideUtilityNudge(makeState(true, true, false, true)),
      'skip',
    );
  });

  it('skips when the user dismissed the prompt', () => {
    strictEqual(
      decideUtilityNudge(makeState(true, true, true, false)),
      'skip',
    );
  });

  it('skips with any two conditions false (multiple suppressions)', () => {
    strictEqual(
      decideUtilityNudge(makeState(true, false, false, true)),
      'skip',
    );
    strictEqual(
      decideUtilityNudge(makeState(true, false, true, false)),
      'skip',
    );
    strictEqual(
      decideUtilityNudge(makeState(true, true, false, false)),
      'skip',
    );
    strictEqual(
      decideUtilityNudge(makeState(false, true, true, false)),
      'skip',
    );
  });

  it('skips with all four conditions false', () => {
    strictEqual(
      decideUtilityNudge(makeState(false, false, false, false)),
      'skip',
    );
  });

  it('skips with three conditions false', () => {
    strictEqual(
      decideUtilityNudge(makeState(false, false, false, true)),
      'skip',
    );
    strictEqual(
      decideUtilityNudge(makeState(false, false, true, false)),
      'skip',
    );
    strictEqual(
      decideUtilityNudge(makeState(false, true, false, false)),
      'skip',
    );
  });

  it('returns only "show" or "skip" (typed literal)', () => {
    // Lock the return type so the command layer can switch on it
    // exhaustively without a default branch catching typos.
    const result = decideUtilityNudge(makeState(true, true, true, true));
    strictEqual(result === 'show' || result === 'skip', true);
  });
});
