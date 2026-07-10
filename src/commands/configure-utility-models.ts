/**
 * T20 — Configure utility models for BYOK agent mode.
 *
 * When a MiniMax model is selected as the main agent model, Copilot
 * Chat surfaces the warning
 *   "No utility model is configured for 'copilot-utility-small' while
 *   the selected main agent model is BYOK."
 * unless `chat.byokUtilityModelDefault` / `chat.utilityModel` /
 * `chat.utilitySmallModel` are set. This command offers three
 * one-click resolutions:
 *
 *   "Use MiniMax for utility tasks (recommended)"
 *       Writes `chat.utilityModel = "minimax/MiniMax-M3"` and
 *       `chat.utilitySmallModel = "minimax/MiniMax-M2.5"`.
 *   "Use the main agent model"
 *       Writes `chat.byokUtilityModelDefault = "mainAgent"`.
 *   "Use Copilot's models (uses Copilot quota)"
 *       Writes `chat.byokUtilityModelDefault = "copilot"`.
 *
 * The command writes to user-scoped settings (`ConfigurationTarget.Global`)
 * because the BYOK settings are workspace-independent. The writes
 * are user-consented (one QuickPick click per write), wrapped in
 * try/catch, and failures surface via `showErrorMessage`.
 */

import type { Logger } from '../ports/logger.js';

export interface ConfigureUtilityPickItem {
  label: string;
  description?: string;
  detail?: string;
}

export interface ConfigureUtilityUi {
  showQuickPick(
    items: readonly ConfigureUtilityPickItem[],
    options?: { title?: string },
  ): Promise<ConfigureUtilityPickItem | undefined>;
  showInfoMessage(message: string): Promise<string | undefined>;
  showErrorMessage(message: string): Promise<string | undefined>;
}

/** Snapshot of the settings write capability tests can fake. */
export interface ConfigureUtilityConfig {
  update(key: string, value: unknown): Promise<unknown>;
}

export interface ConfigureUtilityDeps {
  logger: Logger;
  ui: ConfigureUtilityUi;
  /** Reads the current `chat.byokUtilityModelDefault` value (e.g.
   *  `'none' | 'mainAgent' | 'copilot'`). The activation nudge uses
   *  this to decide whether to surface the prompt. */
  getConfig: () => ConfigureUtilityConfig;
}

export const CONFIGURE_UTILITY_PICK_ITEMS: readonly ConfigureUtilityPickItem[] = [
  {
    label: 'Use MiniMax for utility tasks (recommended)',
    detail: 'Writes chat.utilityModel + chat.utilitySmallModel pointing at MiniMax models. No extra quota — usage is billed to your MiniMax account.',
  },
  {
    label: 'Use the main agent model',
    detail: 'Writes chat.byokUtilityModelDefault = "mainAgent". Copilot reuses the MiniMax model for utility tasks.',
  },
  {
    label: 'Use Copilot’s models (uses Copilot quota)',
    detail: 'Writes chat.byokUtilityModelDefault = "copilot". Utility tasks run on Copilot’s hosted models.',
  },
] as const;

const OPTION_LABEL_RECOMMENDED =
  'Use MiniMax for utility tasks (recommended)';
const OPTION_LABEL_MAIN_AGENT = 'Use the main agent model';
const OPTION_LABEL_COPILOT = 'Use Copilot’s models (uses Copilot quota)';

export const CHAT_UTILITY_MODEL_KEY = 'chat.utilityModel';
export const CHAT_UTILITY_SMALL_MODEL_KEY = 'chat.utilitySmallModel';
export const CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY = 'chat.byokUtilityModelDefault';
export const MINIMAX_VENDOR = 'minimax';
export const MINIMAX_UTILITY_MODEL = 'MiniMax-M3';
export const MINIMAX_UTILITY_SMALL_MODEL = 'MiniMax-M2.5';

export async function runConfigureUtilityModelsCommand(
  deps: ConfigureUtilityDeps,
): Promise<void> {
  const choice = await deps.ui.showQuickPick(CONFIGURE_UTILITY_PICK_ITEMS, {
    title: 'Mighty Max — configure utility models',
  });
  if (!choice) {
    deps.logger.debug('Configure utility models: pick dismissed');
    return;
  }

  const cfg = deps.getConfig();
  try {
    if (choice.label === OPTION_LABEL_RECOMMENDED) {
      await cfg.update(
        CHAT_UTILITY_MODEL_KEY,
        `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_MODEL}`,
      );
      await cfg.update(
        CHAT_UTILITY_SMALL_MODEL_KEY,
        `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_SMALL_MODEL}`,
      );
      await deps.ui.showInfoMessage(
        `Utility models set to ${MINIMAX_UTILITY_MODEL} / ${MINIMAX_UTILITY_SMALL_MODEL}.`,
      );
      deps.logger.info('Configure utility models: MiniMax utility models set', {
        utilityModel: `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_MODEL}`,
        utilitySmallModel: `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_SMALL_MODEL}`,
      });
    } else if (choice.label === OPTION_LABEL_MAIN_AGENT) {
      await cfg.update(CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY, 'mainAgent');
      await deps.ui.showInfoMessage(
        'Copilot will reuse the main agent model for utility tasks.',
      );
      deps.logger.info('Configure utility models: byokUtilityModelDefault=mainAgent');
    } else if (choice.label === OPTION_LABEL_COPILOT) {
      await cfg.update(CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY, 'copilot');
      await deps.ui.showInfoMessage(
        'Copilot will use its hosted models for utility tasks (uses Copilot quota).',
      );
      deps.logger.info('Configure utility models: byokUtilityModelDefault=copilot');
    } else {
      deps.logger.warn('Configure utility models: unknown pick', {
        label: choice.label,
      });
    }
  } catch (err) {
    deps.logger.error('Configure utility models: config update failed', err);
    await deps.ui.showErrorMessage(
      `Failed to write the utility-model configuration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
