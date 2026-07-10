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

import type * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import { decideUtilityNudge } from '../lib/domain/utility-nudge.js';

export const UTILITY_NUDGE_DISMISSED_STATE_KEY =
  'minimax.utilityNudgeDismissed.v1';

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
  /**
   * Surfaces the prompt. Injectable so tests can drive the
   * user choice without booting the VS Code UI; production
   * callers pass `vscode.window.showInformationMessage.bind(...)`.
   * The first argument is the message; the second is the choice
   * the user picked (or `undefined` if dismissed via close).
   */
  showInformationMessage: (
    message: string,
    options: { configure: string; dismiss: string },
  ) => Promise<'configure' | 'dismiss' | undefined>;
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
  // Mark dismissed once shown — "at most once per VS Code
  // install" is the documented promise (CHANGELOG + PR). After
  // this point the predicate short-circuits on every subsequent
  // activation regardless of which button the user picked or
  // whether they closed the notification without picking one.
  // The failed-configure branch keeps the flag false so the next
  // activation re-prompts (failure is the only reason to retry).
  await deps.globalState.update(UTILITY_NUDGE_DISMISSED_STATE_KEY, true);
  const choice = await deps.showInformationMessage(
    'MiniMax models need a utility model configured for full agent support — fix the “No utility model is configured” Copilot warning?',
    { configure: 'Configure', dismiss: "Don't ask again" },
  );
  if (choice === 'dismiss') {
    deps.logger.info('Utility nudge dismissed by user');
    return 'dismissed';
  }
  if (choice === 'configure') {
    try {
      await deps.runConfigure();
      deps.logger.info('Utility nudge: configure invoked');
      return 'configured';
    } catch (err) {
      deps.logger.error('Utility nudge: configure failed', err);
      // Reset the flag so the next activation re-prompts.
      await deps.globalState.update(UTILITY_NUDGE_DISMISSED_STATE_KEY, false);
    }
  }
  // Closed without picking a button (or configure failed and
  // was reset above). The flag is already set; the predicate
  // will skip on the next activation regardless.
  return 'shown';
}
