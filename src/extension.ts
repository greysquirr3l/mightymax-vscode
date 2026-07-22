import * as vscode from 'vscode';
import { LoggerAdapter, type LogLevel } from './adapters/logger.js';
import { SecretStoreAdapter } from './adapters/secret-store.js';
import { KeyProviderAdapter } from './adapters/key-provider.js';
import { MiniMaxClientAdapter } from './adapters/transport.js';
import { CatalogAdapter } from './adapters/catalog.js';
import { ChatProvider } from './providers/chat-provider.js';
import { StatusBarAdapter } from './adapters/status-bar.js';
import { UsageTransportAdapter } from './adapters/usage-transport.js';
import { runManageCommand, type ManageUi } from './commands/manage-command.js';
import { runConfigureUtilityModelsCommand } from './commands/configure-utility-models.js';
import { runShowUsageCommand } from './commands/show-usage.js';
import { runUtilityNudge } from './commands/utility-nudge.js';
import type { Logger } from './ports/logger.js';
import type { KeyProvider } from './ports/key-provider.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Build the small `ManageUi` adapter that maps the manage-command's
 * dependency-injected UI surface onto the real `vscode.window` calls.
 */
function createVsCodeUi(): ManageUi {
  return {
    showQuickPick: async (items, options) => {
      const vscodeItems: vscode.QuickPickItem[] = items.map((item) => ({
        label: item.label,
        ...(item.description !== undefined ? { description: item.description } : {}),
      }));
      const choice = await vscode.window.showQuickPick<vscode.QuickPickItem>(
        vscodeItems,
        options?.title !== undefined ? { title: options.title } : {},
      );
      if (!choice) return undefined;
      const matched = items.find((i) => i.label === choice.label);
      return matched;
    },
    showInputBox: (options) =>
      Promise.resolve(
        vscode.window.showInputBox({
          ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
          ...(options?.password !== undefined ? { password: options.password } : {}),
          ...(options?.value !== undefined ? { value: options.value } : {}),
          ...(options?.ignoreFocusOut !== undefined
            ? { ignoreFocusOut: options.ignoreFocusOut }
            : {}),
        }),
      ),
    showInfoMessage: (message) => Promise.resolve(vscode.window.showInformationMessage(message)),
    showErrorMessage: (message) => Promise.resolve(vscode.window.showErrorMessage(message)),
  };
}

/**
 * Composition root. Wires the four adapters (logger, secret store, transport,
 * catalog) and the chat provider, then registers them with VS Code. Every
 * disposable is pushed to `context.subscriptions` so deactivate is automatic.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Mighty Max', { log: true });
  context.subscriptions.push(channel);

  const config = vscode.workspace.getConfiguration('mightyMax');
  const logLevelRaw = config.get<unknown>('logLevel');
  const initialLevel: LogLevel = isLogLevel(logLevelRaw) ? logLevelRaw : 'info';
  const DEFAULT_BASE_URL = 'https://api.minimax.io';
  // The baseUrl is read on every request via this callback so config
  // changes are honored without restarting the extension host.
  const baseUrl = (): string =>
    vscode.workspace.getConfiguration('mightyMax').get<string>('baseUrl') ?? DEFAULT_BASE_URL;

  const logger = new LoggerAdapter(channel, initialLevel);
  const secretStore = new SecretStoreAdapter(context.secrets);
  // T25 — multi-key rotation. The provider wraps the secret store
  // and adds a globalState-backed active-slot preference plus an
  // in-memory cooldown. Existing single-key users stay in slot 1
  // (the legacy `mightyMax.apiKey` secret); slots 2 and 3 are new.
  const keyProvider: KeyProvider = new KeyProviderAdapter({
    secretStore,
    globalState: context.globalState,
  });
  // Watchdog timeouts are callbacks (like baseUrl) so settings
  // changes apply on the next request without an extension-host
  // restart. Out-of-range values are clamped to the transport's
  // built-in defaults at read time.
  const client = new MiniMaxClientAdapter({
    baseUrl,
    firstByteTimeoutMs: () =>
      vscode.workspace.getConfiguration('mightyMax').get<number>('firstByteTimeoutMs') ?? 45_000,
    idleTimeoutMs: () =>
      vscode.workspace.getConfiguration('mightyMax').get<number>('idleTimeoutMs') ?? 60_000,
  });
  const catalog = new CatalogAdapter(logger);
  const chatProvider = new ChatProvider(logger, keyProvider, client, catalog);

  // T27 — Token Plan usage indicator. The status bar item polls
  // every 5 minutes; the same secret-change listener that refreshes
  // the chat picker also kicks an out-of-band refresh so switching
  // the API key updates the indicator without waiting for the next
  // tick. A PAYG key or network failure surfaces as a neutral icon,
  // never a red one, matching the "click for details" affordance.
  const usageClient = new UsageTransportAdapter({ logger });
  const statusBar = new StatusBarAdapter({ logger, keyProvider, secretStore, usageClient });
  context.subscriptions.push(statusBar);

  // T06 — when the user clears (or another extension overwrites) the
  // stored API key, the picker should refresh so the model family
  // disappears. `onDidChange` fires after every store/delete; we don't
  // get the key value (and don't want it) — just the event.
  const secretsListener = context.secrets.onDidChange((event) => {
    // `event.key` may be undefined (mass change) or the namespaced key.
    // We only care about our own key, but checking requires a substring
    // match on the namespace prefix.
    if (event.key !== undefined && !event.key.startsWith('mightyMax.')) {
      return;
    }
    logger.info('Mighty Max: secret storage change detected — refreshing chat information');
    chatProvider.fireChange();
    void statusBar.refresh();
  });
  context.subscriptions.push(secretsListener);
  statusBar.start();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('minimax', chatProvider),
    vscode.commands.registerCommand('mightyMax.manage', () => {
      logger.info('Mighty Max management command invoked');
      const ui = createVsCodeUi();
      const configProvider = () => vscode.workspace.getConfiguration('mightyMax');
      return runManageCommand({
        logger,
        secretStore,
        keyProvider,
        baseUrl: baseUrl(),
        ui,
        fireChange: () => chatProvider.fireChange(),
        getConfig: () => ({
          get: (key) => configProvider().get(key),
          update: (key, value) => Promise.resolve(configProvider().update(key, value)),
        }),
      });
    }),
    vscode.commands.registerCommand('mightyMax.configureUtilityModels', () => {
      logger.info('Mighty Max configure-utility-models command invoked');
      const ui = createVsCodeUi();
      return runConfigureUtilityModelsCommand({
        logger,
        ui,
        getConfig: () => ({
          update: (key, value) =>
            Promise.resolve(
              vscode.workspace
                .getConfiguration()
                .update(key, value, vscode.ConfigurationTarget.Global),
            ),
        }),
      });
    }),
    vscode.commands.registerCommand('mightyMax.showUsage', () => {
      logger.info('Mighty Max show-usage command invoked');
      return runShowUsageCommand(context, statusBar);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mightyMax.logLevel')) {
        const next = vscode.workspace.getConfiguration('mightyMax').get<unknown>('logLevel');
        if (isLogLevel(next)) {
          logger.setLevel(next);
          logger.info('Log level updated', { level: next });
        }
      }
      // baseUrl re-reads happen via the callback above; no action needed
      // here other than noting that the next request will pick up the
      // new value automatically.
    }),
  );

  // Expose a logger for downstream code without re-importing the adapter.
  context.subscriptions.push(
    vscode.Disposable.from({ dispose: () => logger.info('Mighty Max extension deactivated') }),
  );

  // T27 capability detection: log the runtime's host-side
  // affordances so support can diagnose the "thinking is
  // verbose" symptom (issue #46) without having to repro it.
  // `LanguageModelThinkingPart` (proposed API in
  // `vscode.proposed.languageModelThinkingPart.d.ts`) lands in
  // VS Code 1.128+; the stream-pump falls back to a JSON data
  // part on hosts where it's missing so users on 1.125–1.127
  // still see the thinking content (just inline rather than
  // collapsible).
  const hasThinkingPartCtor =
    typeof (
      vscode as unknown as {
        LanguageModelThinkingPart?: unknown;
      }
    ).LanguageModelThinkingPart === 'function';
  logger.info('Mighty Max host capabilities', {
    vendor: 'minimax',
    baseUrl: baseUrl(),
    vscodeVersion: vscode.version,
    hasLanguageModelThinkingPart: hasThinkingPartCtor,
    thinkingSurface: hasThinkingPartCtor ? 'thinking-part' : 'data-part-fallback',
  });

  // T20 activation nudge — fires at most once after activation
  // when an API key is stored and the BYOK utility settings are
  // not yet configured. The predicate is pure (domain); this
  // block only carries the UI / persistence wiring. The nudge
  // never blocks activation: we let it resolve in the
  // background and never await it from the activation path.
  void runUtilityNudge({
    getByokDefault: () => {
      const v = vscode.workspace.getConfiguration().get<string>('chat.byokUtilityModelDefault');
      return typeof v === 'string' ? v : undefined;
    },
    getUtilityModel: () => {
      const v = vscode.workspace.getConfiguration().get<string>('chat.utilityModel');
      return typeof v === 'string' ? v : undefined;
    },
    hasApiKey: async () => keyProvider.hasAnyKey(),
    globalState: context.globalState,
    logger,
    showInformationMessage: async (message, options) => {
      // Map VS Code's localized label back to our discriminated
      // union. The vscode API returns the localized button label
      // (or undefined for dismiss-by-close); we reconstruct the
      // discriminated union so the utility-nudge module never has
      // to know about VS Code's button-label API.
      const picked = await vscode.window.showInformationMessage(
        message,
        options.configure,
        options.dismiss,
      );
      if (picked === options.dismiss) return 'dismiss';
      if (picked === options.configure) return 'configure';
      return undefined;
    },
    runConfigure: () => {
      const ui = createVsCodeUi();
      return runConfigureUtilityModelsCommand({
        logger,
        ui,
        getConfig: () => ({
          update: (key, value) =>
            Promise.resolve(
              vscode.workspace
                .getConfiguration()
                .update(key, value, vscode.ConfigurationTarget.Global),
            ),
        }),
      });
    },
  });
}

export function deactivate(): void {
  // Disposables pushed to context.subscriptions are released automatically;
  // this function exists for vsce packaging and explicit shutdown hooks.
}

// Surface the Logger port as a public export so T02–T07 can re-use it
// without importing the adapter directly.
export type { Logger };
