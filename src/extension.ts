import * as vscode from 'vscode';
import { join } from 'node:path';
import { StreamCapture } from './adapters/stream-capture.js';
import { LoggerAdapter, type LogLevel } from './adapters/logger.js';
import { SecretStoreAdapter } from './adapters/secret-store.js';
import { KeyProviderAdapter } from './adapters/key-provider.js';
import { MiniMaxClientAdapter } from './adapters/transport.js';
import { CatalogAdapter } from './adapters/catalog.js';
import { ChatProvider } from './providers/chat-provider.js';
import { StatusBarAdapter } from './adapters/status-bar.js';
import { UsageTransportAdapter } from './adapters/usage-transport.js';
import { runManageCommand, type SlotLabelsStore } from './commands/manage-command.js';
import { runManageMcpToolsCommand } from './commands/manage-mcp-tools.js';
import { runConfigureUtilityModelsCommand } from './commands/configure-utility-models.js';
import { runShowUsageCommand } from './commands/show-usage.js';
import { runShowDiagnosticsCommand } from './commands/show-diagnostics.js';
import { runUtilityNudge } from './commands/utility-nudge.js';
import type { Logger } from './ports/logger.js';
import type { KeyProvider } from './ports/key-provider.js';
import {
  parseLabelsFromGlobalState,
  serializeLabelsToGlobalState,
} from './lib/domain/slot-labels.js';
import { RecentTurnUsageStore } from './lib/domain/recent-turn-usage.js';
import { McpToolRecencyTracker } from './lib/domain/mcp-tool-recency.js';
import {
  registerMcpSearchTools,
  type McpSearchAdapterDeps,
} from './adapters/mcp-search-adapter.js';
import { registerSubAgentTool } from './adapters/subagent-tool-adapter.js';
import { HailuoVideoAdapter } from './adapters/hailuo-video-adapter.js';
import { Image01Adapter } from './adapters/image-01-adapter.js';
import { LocalMediaStore, resolveMediaOutputDirectory } from './adapters/local-media-store.js';
import { registerGenerateVideoTool } from './adapters/generate-video-tool-adapter.js';
import { registerGenerateImageTool } from './adapters/generate-image-tool-adapter.js';
import { runGenerateVideoCommand } from './commands/generate-video-command.js';
import { runGenerateImageCommand } from './commands/generate-image-command.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const SLOT_LABELS_STATE_KEY = 'mightyMax.slotLabels';

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Build the small UI adapter that maps the manage-command's
 * dependency-injected UI surface onto the real `vscode.window`
 * calls. The return type is a structural superset of both
 * `ManageUi` and `ManageMcpUi` so the same factory backs
 * every command without per-callsite casts.
 */
interface VsCodeUi {
  showQuickPick<T extends { label: string; description?: string }>(
    items: readonly T[],
    options?: { title?: string; ignoreFocusOut?: boolean },
  ): Promise<T | undefined>;
  showInputBox(options?: {
    prompt?: string;
    placeHolder?: string;
    password?: boolean;
    value?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInfoMessage(message: string): Promise<string | undefined>;
  showWarningMessage(message: string): Promise<string | undefined>;
  showErrorMessage(message: string): Promise<string | undefined>;
}

/**
 * Shared UI surface for the media-generation commands
 * (`mightyMax.generateVideo` / `mightyMax.generateImage`).
 *
 * Both need a QuickPick, an InputBox, a message with action
 * buttons, and Open / Reveal affordances for the saved artifact.
 * Extracted so the two command registrations stay a handful of
 * lines each instead of two ~50-line inline UI blocks that drift.
 */
function createMediaUi() {
  return {
    showQuickPick: async <T extends vscode.QuickPickItem>(
      items: ReadonlyArray<T>,
      options?: {
        title?: string;
        placeHolder?: string;
        canPickMany?: boolean;
        ignoreFocusOut?: boolean;
      },
    ): Promise<T | undefined> =>
      vscode.window.showQuickPick<T>(items, {
        ...(options?.title !== undefined ? { title: options.title } : {}),
        ...(options?.placeHolder !== undefined ? { placeHolder: options.placeHolder } : {}),
        ...(options?.canPickMany !== undefined ? { canPickMany: options.canPickMany } : {}),
        ...(options?.ignoreFocusOut !== undefined
          ? { ignoreFocusOut: options.ignoreFocusOut }
          : {}),
      }),
    showInputBox: async (options: {
      title?: string;
      prompt?: string;
      placeHolder?: string;
      ignoreFocusOut?: boolean;
    }): Promise<string | undefined> =>
      vscode.window.showInputBox({
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
        ...(options.placeHolder !== undefined ? { placeHolder: options.placeHolder } : {}),
        ...(options.ignoreFocusOut !== undefined ? { ignoreFocusOut: options.ignoreFocusOut } : {}),
      }),
    showInformationMessage: async (message: string, ...actions: string[]) =>
      vscode.window.showInformationMessage(message, ...actions),
    showErrorMessage: async (message: string, ...actions: string[]) =>
      vscode.window.showErrorMessage(message, ...actions),
    openExternal: async (uri: vscode.Uri) => {
      await vscode.env.openExternal(uri);
    },
    revealFile: async (uri: vscode.Uri) => {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    },
  };
}

function createVsCodeUi(): VsCodeUi {
  return {
    showQuickPick: async <T extends { label: string; description?: string }>(
      items: readonly T[],
      options?: { title?: string; ignoreFocusOut?: boolean },
    ): Promise<T | undefined> => {
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
          ...(options?.placeHolder !== undefined ? { placeHolder: options.placeHolder } : {}),
          ...(options?.password !== undefined ? { password: options.password } : {}),
          ...(options?.value !== undefined ? { value: options.value } : {}),
          ...(options?.ignoreFocusOut !== undefined
            ? { ignoreFocusOut: options.ignoreFocusOut }
            : {}),
        }),
      ),
    showInfoMessage: (message) => Promise.resolve(vscode.window.showInformationMessage(message)),
    showWarningMessage: (message) => Promise.resolve(vscode.window.showWarningMessage(message)),
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
  // Labels identify a stored key without ever exposing its secret. They
  // live in globalState rather than SecretStorage and are deliberately
  // read fresh so changes persist and surface without an extension-host
  // restart.
  const slotLabels: SlotLabelsStore = {
    getAll: () =>
      Promise.resolve(
        parseLabelsFromGlobalState(context.globalState.get<unknown>(SLOT_LABELS_STATE_KEY)),
      ),
    set: async (labels) => {
      await context.globalState.update(SLOT_LABELS_STATE_KEY, serializeLabelsToGlobalState(labels));
    },
  };
  // T41 — opt-in response-stream capture. Armed explicitly and
  // dormant by default: the suspected defect is intermittent and
  // cannot be reproduced on demand, so the sink has to be sitting
  // there before the bad stream arrives. Records response events
  // only, to its own file in global storage — never the log
  // channel, so the redaction rule is untouched.
  const captureEnabled =
    vscode.workspace.getConfiguration('mightyMax').get<boolean>('captureStream') ?? false;
  const streamCapture = captureEnabled
    ? new StreamCapture({
        path: join(
          context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? '/tmp',
          'stream-capture.txt',
        ),
      })
    : undefined;
  context.subscriptions.push(
    new vscode.Disposable(() => {
      void streamCapture?.close();
    }),
  );

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
    streamCapture,
  });
  const catalog = new CatalogAdapter(logger);
  const recentTurnUsage = new RecentTurnUsageStore();
  const mcpRecency = new McpToolRecencyTracker();
  const chatProvider = new ChatProvider(
    logger,
    keyProvider,
    client,
    catalog,
    undefined,
    recentTurnUsage,
    mcpRecency,
  );

  // T35 — register the three MCP server-level discovery tools
  // (`mcp_list_servers`, `mcp_list_tools`, `mcp_load`) with VS Code's
  // LM host. They're the only path the model has to find an MCP tool
  // that the rolling LRU has dropped from the wire, and `mcp_load`
  // resolves and invokes the underlying tool by name. The live tool
  // snapshot is read on every invocation; the recency bump on a
  // successful `mcp_load` keeps the just-loaded tool in the always-
  // included set for the rest of the session.
  const mcpSearchDeps: McpSearchAdapterDeps = {
    logger,
    getLiveMcpTools: () =>
      vscode.lm.tools
        .filter((t) => t.name.startsWith('mcp_'))
        .map((t) => ({
          name: t.name,
          description: t.description,
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          inputSchema: t.inputSchema as object | undefined,
        })),
    onMcpToolInvoked: (name) => mcpRecency.record(name),
  };
  context.subscriptions.push(registerMcpSearchTools(context, mcpSearchDeps));

  // T35 — register our custom `minimax_subagent` tool. It wraps
  // VS Code's built-in `runSubagent` and synthesizes the multi-part
  // sub-agent result into a single `<task>` text block, so the chat
  // widget renders exactly one box instead of N collapsible parts
  // (the "blank rectangles" symptom from T35).
  context.subscriptions.push(registerSubAgentTool({ logger }));

  // T36 — Hailuo-03 (H3 / H3-Max) video generation pipeline. Wires
  // the `mightyMax_generateVideo` LM tool + `mightyMax.generateVideo`
  // command to the same `KeyProvider` and `Logger` the chat provider
  // uses. The pipeline runs submit → poll → download → save, and
  // surfaces the saved file via a notification with Open / Reveal /
  // Copy-path actions. Gated by `mightyMax.allowVideoToolInChat` for
  // the LM-tool surface; the command is always available.
  const mediaBaseDir = resolveMediaOutputDirectory(
    context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath ?? '/tmp',
    vscode.workspace.getConfiguration('mightyMax').get<string>('mediaOutputDir'),
  );
  const mediaStore = new LocalMediaStore({ baseDirectory: mediaBaseDir });
  const videoGenerator = new HailuoVideoAdapter({
    baseUrl: baseUrl(),
    logger,
  });

  // T36 — image-01 generation. Synchronous (one POST, bytes back),
  // so the pipeline is generate → persist with no polling. Shares
  // `mediaStore` with the video pipeline: same output directory,
  // same filename discipline, same Open / Reveal / Copy-path
  // notification surface. Gated by `mightyMax.allowImageToolInChat`
  // for the LM-tool surface; the command is always available.
  const imageGenerator = new Image01Adapter({ baseUrl: baseUrl(), logger });
  context.subscriptions.push(
    registerGenerateImageTool({
      logger,
      keyProvider,
      imageGenerator,
      mediaStore,
      config: {
        getToolEnabled: () =>
          vscode.workspace.getConfiguration('mightyMax').get<boolean>('allowImageToolInChat') !==
          false,
      },
    }),
  );
  context.subscriptions.push(
    registerGenerateVideoTool({
      logger,
      keyProvider,
      videoGenerator,
      mediaStore,
      config: {
        getPollIntervalMs: () => {
          const raw = vscode.workspace
            .getConfiguration('mightyMax')
            .get<number>('videoPollIntervalMs');
          if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
          return Math.min(60_000, Math.max(1_000, Math.floor(raw)));
        },
        getTimeoutMs: () => {
          const raw = vscode.workspace.getConfiguration('mightyMax').get<number>('videoTimeoutMs');
          if (typeof raw !== 'number' || !Number.isFinite(raw)) return 600_000;
          return Math.min(1_800_000, Math.max(30_000, Math.floor(raw)));
        },
        getFileExtension: (): 'mp4' => 'mp4',
        getToolEnabled: () =>
          vscode.workspace.getConfiguration('mightyMax').get<boolean>('allowVideoToolInChat') !==
          false,
      },
    }),
  );

  // T27 — Token Plan usage indicator. The status bar item polls
  // every 5 minutes; the same secret-change listener that refreshes
  // the chat picker also kicks an out-of-band refresh so switching
  // the API key updates the indicator without waiting for the next
  // tick. A PAYG key or network failure surfaces as a neutral icon,
  // never a red one, matching the "click for details" affordance.
  const usageClient = new UsageTransportAdapter({ logger });
  const statusBar = new StatusBarAdapter({
    logger,
    keyProvider,
    secretStore,
    usageClient,
    getSlotLabelsRaw: () => context.globalState.get<unknown>(SLOT_LABELS_STATE_KEY),
    recentTurnUsage,
  });
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
      // T34 — bridge the Settings submenu's "Manage MCP reserved
      // tools" entry to the dedicated command. The handle is
      // defined inline so the manage flow doesn't have to know
      // how to read the live `vscode.lm.tools` snapshot.
      const manageMcpTools = () =>
        runManageMcpToolsCommand({
          logger,
          ui,
          getReserved: () => {
            const raw = configProvider().get<unknown>('reservedMcpTools');
            if (!Array.isArray(raw)) return [];
            return raw.filter((s): s is string => typeof s === 'string');
          },
          setReserved: async (next) => {
            await configProvider().update(
              'reservedMcpTools',
              [...next],
              vscode.ConfigurationTarget.Global,
            );
          },
          getMcpMaxTools: () => {
            const raw = configProvider().get<unknown>('mcpMaxTools');
            return typeof raw === 'number' && Number.isFinite(raw) ? raw : 60;
          },
          listLiveTools: () => vscode.lm.tools.map((t) => ({ name: t.name })),
        });
      return runManageCommand({
        logger,
        secretStore,
        keyProvider,
        baseUrl: baseUrl(),
        ui,
        fireChange: () => {
          chatProvider.fireChange();
          void statusBar.refresh();
        },
        slotLabels,
        manageMcpTools,
        getConfig: () => ({
          get: (key) => configProvider().get(key),
          update: (key, value) => Promise.resolve(configProvider().update(key, value)),
        }),
      });
    }),
    vscode.commands.registerCommand('mightyMax.manageMcpTools', () => {
      logger.info('Mighty Max manage-MCP-tools command invoked');
      const ui = createVsCodeUi();
      const configProvider = () => vscode.workspace.getConfiguration('mightyMax');
      return runManageMcpToolsCommand({
        logger,
        ui,
        getReserved: () => {
          const raw = configProvider().get<unknown>('reservedMcpTools');
          if (!Array.isArray(raw)) return [];
          return raw.filter((s): s is string => typeof s === 'string');
        },
        setReserved: async (next) => {
          await configProvider().update(
            'reservedMcpTools',
            [...next],
            vscode.ConfigurationTarget.Global,
          );
        },
        getMcpMaxTools: () => {
          const raw = configProvider().get<unknown>('mcpMaxTools');
          return typeof raw === 'number' && Number.isFinite(raw) ? raw : 60;
        },
        listLiveTools: () => vscode.lm.tools.map((t) => ({ name: t.name })),
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
    vscode.commands.registerCommand('mightyMax.generateVideo', () => {
      logger.info('Mighty Max generate-video command invoked');
      return runGenerateVideoCommand({
        logger,
        keyProvider,
        videoGenerator,
        mediaStore,
        ui: createMediaUi(),
        config: {
          getPollIntervalMs: () => {
            const raw = vscode.workspace
              .getConfiguration('mightyMax')
              .get<number>('videoPollIntervalMs');
            if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
            return Math.min(60_000, Math.max(1_000, Math.floor(raw)));
          },
          getTimeoutMs: () => {
            const raw = vscode.workspace
              .getConfiguration('mightyMax')
              .get<number>('videoTimeoutMs');
            if (typeof raw !== 'number' || !Number.isFinite(raw)) return 600_000;
            return Math.min(1_800_000, Math.max(30_000, Math.floor(raw)));
          },
          getFileExtension: (): 'mp4' => 'mp4',
          getToolEnabled: () => true,
        },
      });
    }),
    vscode.commands.registerCommand('mightyMax.generateImage', () => {
      logger.info('Mighty Max generate-image command invoked');
      return runGenerateImageCommand({
        logger,
        keyProvider,
        imageGenerator,
        mediaStore,
        ui: createMediaUi(),
        config: { getToolEnabled: () => true },
      });
    }),
    vscode.commands.registerCommand('mightyMax.showDiagnostics', () => {
      logger.info('Mighty Max diagnostics command invoked');
      return runShowDiagnosticsCommand({
        logger,
        keyProvider,
        catalog,
        ui: createVsCodeUi(),
        baseUrl: baseUrl(),
        vscodeVersion: vscode.version,
        hasLanguageModelThinkingPart:
          typeof (
            vscode as unknown as {
              LanguageModelThinkingPart?: unknown;
            }
          ).LanguageModelThinkingPart === 'function',
        getConfig: () => ({
          get: (key) => vscode.workspace.getConfiguration('mightyMax').get(key),
        }),
      });
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
  // T41's capture sink is registered as a subscription above, so its
  // final flush happens on deactivate without an explicit hook here.
}

// Surface the Logger port as a public export so T02–T07 can re-use it
// without importing the adapter directly.
export type { Logger };
