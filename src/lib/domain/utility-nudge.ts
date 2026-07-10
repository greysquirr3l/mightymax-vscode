/**
 * T20 — Utility-model nudge predicate.
 *
 * Pure domain. Given the observed VS Code configuration state plus a
 * dismissed flag, decide whether to surface the one-time activation
 * nudge that fixes the
 * "No utility model is configured for 'copilot-utility-small'"
 * error Copilot Chat raises when a MiniMax model is selected as the
 * main agent model and `chat.byokUtilityModelDefault` / `chat.utilityModel`
 * are not configured.
 *
 * The decision is the conjunction of:
 *  - `hasApiKey`           — an API key is stored; the user has
 *                            finished onboarding and is using the
 *                            extension.
 *  - `byokDefaultIsNone`   — `chat.byokUtilityModelDefault` is
 *                            `'none'` or unset (i.e., the user has
 *                            NOT opted into Copilot or mainAgent
 *                            fallback).
 *  - `utilityModelUnset`   — `chat.utilityModel` is not set to a
 *                            value that names a MiniMax model.
 *  - `notDismissed`        — the per-user "don't ask again" flag is
 *                            false.
 *
 * The predicate returns `true` ONLY when all four conditions hold.
 * Any other combination returns `false`.
 */

export type UtilityNudgeDecision = 'show' | 'skip';

export interface UtilityNudgeState {
  hasApiKey: boolean;
  byokDefaultIsNone: boolean;
  utilityModelUnset: boolean;
  notDismissed: boolean;
}

export function decideUtilityNudge(state: UtilityNudgeState): UtilityNudgeDecision {
  if (!state.hasApiKey) return 'skip';
  if (!state.byokDefaultIsNone) return 'skip';
  if (!state.utilityModelUnset) return 'skip';
  if (!state.notDismissed) return 'skip';
  return 'show';
}
