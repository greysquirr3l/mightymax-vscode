/**
 * T20 activation-nudge UI wiring.
 *
 * After activation, if an API key is stored AND
 * `chat.byokUtilityModelDefault` is `'none'` or unset AND
 * `chat.utilityModel` is unset AND the user has not previously
 * dismissed the prompt, surface a one-time information message
 * with two buttons:
 *   "Configure" → invoke `mightyMax.configureUtilityModels`.
 *   "Don't ask again" → persist a flag in `globalState` so the
 *     message never reappears for this VS Code installation.
 *
 * The pure predicate lives in `src/lib/domain/utility-nudge.ts`.
 * This module owns the UI surface only.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import { decideUtilityNudge } from '../lib/domain/utility-nudge.js';

export const UTILITY_NUDGE_DISMISSED_STATE_KEY =
  'minimax.utilityNudgeDismissed.v1';
export const UTILITY_NUDGE_PROMPT_KEY =
  'minimax.utilityNudgeShownCount.v1';

export interface UtilityNudgeSettingsReader {
  /**
   * Returns the current value of `chat.byokUtilityModelDefault`
   * (one of `'none'`, `'mainAgent'`, `'copilot'`, or undefined
   * if the user has never opened the setting).
   */
  getByokDefault(): string | undefined;
  /** Returns the current `chat.utilityModel` value, if any. */
  getUtilityModel(): string | undefined;
  /**
   * Returns true when a MiniMax API key is currently stored.
   * The adapter uses `SecretStore.hasSecret` for this.
   */
  hasApiKey(): Promise<boolean>;
  /** Persists / reads the dismissal flag. */
  globalState: vscode.Memento;
  /** Logger at info / debug for nudge-fired / nudge-skipped. */
  logger: Logger;
  /** Resolves the configure-utility-models command. */
  runConfigure: () => Promise<void> | void;
}

/**
 * Run the activation nudge. Returns one of:
 *   - `'shown'`     — the predicate passed and the prompt was shown.
 *   - `'configured'` — the user clicked *Configure* and the
 *                        configure command ran.
 *   - `'dismissed'`  — the user clicked *Don't ask again* and the
 *                        flag was persisted.
 *   - `'skipped'`    — the predicate was already false (api key
 *                        missing, settings pre-configured, or the
 *                        flag was previously set).
 */
export type NudgeOutcome = 'shown' | 'configured' | 'dismissed' | 'skipped';

export async function runUtilityNudge(
  deps: UtilityNudgeSettingsReader,
): Promise<NudgeOutcome> {
  const dismissed = deps.globalState.get<boolean>(
    UTILITY_NUDGE_DISMISSED_STATE_KEY,
    false,
  );
  const hasApiKey = await deps.hasApiKey();
  const byokDefault = deps.getByokDefault();
  const utilityModel = deps.getUtilityModel();
  const state = {
    hasApiKey,
    byokDefaultIsNone: byokDefault === undefined || byokDefault === 'none',
    utilityModelUnset: utilityModel === undefined || utilityModel.length === 0,
    notDismissed: !dismissed,
  };
  const decision = decideUtilityNudge(state);
  if (decision === 'skip') {
    deps.logger.debug('Utility-nudge predicate: skip', {
      hasApiKey,
      byokDefault,
      utilityModel,
      dismissed,
    });
    return 'skipped';
  }

  deps.logger.info(
    'Mighty Max: inviting the user to configure utility models for BYOK agent mode',
  );
  const shownCount =
    deps.globalState.get<number>(UTILITY_NUDGE_PROMPT_KEY, 0) + 1;
  await deps.globalState.update(UTILITY_NUDGE_PROMPT_KEY, shownCount);
  const choice = await vscode.window.showInformationMessage(
    'MiniMax models need a utility model configured for full agent support — fix the “No utility model is configured” Copilot warning?',
    'Configure',
    "Don't ask again",
  );
  if (choice === "Don't ask again") {
    await deps.globalState.update(UTILITY_NUDGE_DISMISSED_STATE_KEY, true);
    deps.logger.info('Utility nudge dismissed by user');
    return 'dismissed';
  }
  if (choice === 'Configure') {
    try {
      await deps.runConfigure();
      deps.logger.info('Utility nudge: configure invoked');
      return 'configured';
    } catch (err) {
      deps.logger.error('Utility nudge: configure failed', err);
      // The flag isn't set, so the next activation re-prompts.
    }
  }
  // Dismissed implicitly (closed the notification).
  return 'shown';
}
