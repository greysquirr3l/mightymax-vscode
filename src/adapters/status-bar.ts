/**
 * StatusBarAdapter — VS Code status-bar item for the MiniMax Token Plan.
 *
 * Single right-aligned item, Copilot-style: the Mighty Max aviator
 * glyph (contributed via `contributes.icons`, not a PNG — VS Code's
 * status bar does not accept image files), an optional percent,
 * warning tint past 80%, error tint at 100%, a markdown tooltip with
 * per-window progress bars, and a click-through to the
 * `mightyMax.showUsage` webview.
 *
 * The status bar reads the API key via the `KeyProvider` so the
 * Token Plan fetch uses the same key the chat-provider will pick.
 * (T25 multi-key: a future enhancement could show per-slot usage
 * but that's a paid-tier / billing-API question — out of scope for
 * this PR.) When no key is stored the icon stays neutral with a
 * "run 'Mighty Max: Manage' first" hint — the same is done for
 * `UsageUnavailableError` (PAYG keys have no Token Plan bar; that's
 * a normal state).
 */

import * as vscode from 'vscode';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { KeyProvider } from '../ports/key-provider.js';
import {
  UsageUnavailableError,
  type TokenPlanUsage,
  type UsageClient,
} from '../ports/usage-client.js';

const REFRESH_MS = 5 * 60 * 1000; // match the console's coarse granularity
const ICON = '$(mightymax-head)';

const MANAGE_COMMAND_TITLE = 'Mighty Max: Manage';

export interface StatusBarDeps {
  readonly logger: Logger;
  readonly secretStore: SecretStore;
  readonly keyProvider: KeyProvider;
  readonly usageClient: UsageClient;
  /** Injected for tests. Defaults to `vscode.window.createStatusBarItem`. */
  readonly createItem?: typeof vscode.window.createStatusBarItem;
  /** Injected for tests. Defaults to `setInterval` / `clearInterval`. */
  readonly setIntervalImpl?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

export class StatusBarAdapter implements vscode.Disposable {
  private readonly logger: Logger;
  // secretStore is no longer used directly — the chat-pipeline
  // consults the keyProvider for the active key. Kept in the deps
  // for backwards compatibility with the existing extension.ts
  // wiring.
  private readonly keyProvider: KeyProvider;
  private readonly usageClient: UsageClient;
  private readonly item: vscode.StatusBarItem;
  private readonly setIntervalImpl: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastUsage: TokenPlanUsage | undefined;

  constructor(deps: StatusBarDeps) {
    this.logger = deps.logger;
    this.keyProvider = deps.keyProvider;
    this.usageClient = deps.usageClient;
    const createItem = deps.createItem ?? vscode.window.createStatusBarItem;
    this.setIntervalImpl = deps.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
    // Priority 100 on the Right group lands it near Copilot/Prettier.
    this.item = createItem('mightyMax.usage', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Mighty Max';
    this.item.command = 'mightyMax.showUsage';
    this.item.text = ICON;
    this.item.tooltip = 'Mighty Max — MiniMax usage';
    this.item.show();
  }

  /**
   * Kick off polling. Call once from `activate()`. Safe to call again
   * after dispose to re-arm the timer (used by the secrets-change
   * listener when the user stores a fresh key).
   */
  start(): void {
    void this.refresh();
    this.timer = this.setIntervalImpl(() => {
      void this.refresh();
    }, REFRESH_MS);
  }

  /** Exposed so the webview's "Refresh" button and the secrets-change
   *  listener can force an out-of-band refresh. */
  async refresh(): Promise<TokenPlanUsage | undefined> {
    // Use the same pick() the chat-provider would, so Token Plan
    // usage reflects the same key the next request will send. If
    // every stored key is in cooldown we still surface the icon
    // (we just can't fetch usage) and tell the user why.
    const pick = await this.keyProvider.pickKey();
    if (pick === undefined) {
      this.renderNoKey();
      return undefined;
    }
    try {
      const usage = await this.usageClient.fetchUsage(pick.key);
      this.lastUsage = usage;
      this.render(usage, pick.slot);
      return usage;
    } catch (err) {
      if (err instanceof UsageUnavailableError) {
        // PAYG key, schema drift, or network blip — show neutral icon, no noise.
        this.logger.debug(`usage unavailable (kind=${err.kind}): ${err.message}`);
      } else {
        this.logger.warn(`usage refresh failed: ${String(err)}`);
      }
      this.renderUnavailable();
      return undefined;
    }
  }

  /** Last successfully fetched usage payload, for the webview panel. */
  getLastUsage(): TokenPlanUsage | undefined {
    return this.lastUsage;
  }

  private render(usage: TokenPlanUsage, currentSlot: number): void {
    const pct = usage.percentUsed;
    this.item.text = pct === undefined ? ICON : `${ICON} ${String(pct)}%`;
    this.item.backgroundColor =
      pct !== undefined && pct >= 100
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct !== undefined && pct >= 80
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**Mighty Max — MiniMax Token Plan**\n\n`);
    md.appendMarkdown(`_Showing usage for slot ${String(currentSlot)}._\n\n`);
    if (usage.windows.length === 0) {
      md.appendMarkdown('_No quota windows reported._\n\n');
    } else {
      for (const w of usage.windows) {
        md.appendMarkdown(`${w.label}: **${String(w.percentUsed)}%** used ${bar(w.percentUsed)}`);
        if (w.resetsAt !== undefined) md.appendMarkdown(`  \n_resets ${w.resetsAt}_`);
        md.appendMarkdown('\n\n');
      }
    }
    md.appendMarkdown(
      `—\n\n$(sync) as of ${usage.fetchedAt.toLocaleTimeString()} · click for details`,
    );
    this.item.tooltip = md;
  }

  private renderNoKey(): void {
    this.item.text = ICON;
    this.item.backgroundColor = undefined;
    this.item.tooltip = `Mighty Max — no API key set. Run "${MANAGE_COMMAND_TITLE}".`;
  }

  private renderUnavailable(): void {
    this.item.text = ICON;
    this.item.backgroundColor = undefined;
    this.item.tooltip =
      'Mighty Max — usage unavailable (pay-as-you-go keys have no Token Plan bar). Click for details.';
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearIntervalImpl(this.timer);
      this.timer = undefined;
    }
    this.item.dispose();
  }
}

/** Unicode block bar, 10 cells — renders fine in markdown tooltips. */
function bar(pct: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * 10);
  return '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '`';
}
