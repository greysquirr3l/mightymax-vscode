/**
 * StatusBarAdapter — VS Code status-bar item for the MiniMax Token Plan.
 *
 * Single right-aligned item, Copilot-style: the Mighty Max aviator
 * glyph (contributed via `contributes.icons`, not a PNG — VS Code's
 * status bar does not accept image files), an optional percent,
 * warning tint past 80%, error tint at 100%, a markdown tooltip with
 * the T32 flight-deck dashboard, and a click-through to the
 * `mightyMax.showUsage` webview.
 *
 * The status bar reads the API key via the `KeyProvider` so the
 * Token Plan fetch uses the same key the chat-provider will pick.
 * When no key is stored the icon stays neutral with a
 * "run 'Mighty Max: Manage' first" hint — the same is done for
 * `UsageUnavailableError` (PAYG keys have no Token Plan bar; that's
 * a normal state).
 *
 * T32 — the tooltip is now the "flight deck": 5 sections (slot
 * status, auto-rotation toggle, last fallback, Token Plan bars,
 * refresh time). The item text gets a ` $(error)` codicon suffix
 * when the user's active slot is currently in cooldown so the
 * failure mode is visible at a glance without hovering.
 */

import * as vscode from 'vscode';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { KeyProvider, KeySlot } from '../ports/key-provider.js';
import {
  UsageUnavailableError,
  type TokenPlanUsage,
  type UsageClient,
} from '../ports/usage-client.js';
import {
  buildFlightDeckText,
  buildFlightDeckTooltip,
  FLIGHT_DECK_ICON,
  isActiveInCooldown,
  type FlightDeckTooltipInput,
} from '../lib/domain/flight-deck-tooltip.js';
import { cooldownRemainingMs, type KeySlot as KeySlotType } from '../lib/domain/key-pool.js';
import { getLabel, parseLabelsFromGlobalState } from '../lib/domain/slot-labels.js';

const REFRESH_MS = 5 * 60 * 1000; // match the console's coarse granularity
const ICON = FLIGHT_DECK_ICON;

export interface StatusBarDeps {
  readonly logger: Logger;
  readonly secretStore: SecretStore;
  readonly keyProvider: KeyProvider;
  readonly usageClient: UsageClient;
  /**
   * T32 — the auto-rotation setting the flight deck reads on every
   * refresh. Injected for tests; defaults to reading
   * `mightyMax.enableAutoKeyRotation` from the host configuration.
   * The default is `true` when the setting is missing (see
   * `src/providers/chat-provider.ts` `isAutoRotationEnabled` for the
   * shared rationale).
   */
  readonly isAutoRotationEnabled?: () => boolean;
  /**
   * T32 — per-slot labels persisted by the flight-deck view's Rename
   * action. Raw globalState value; the renderer parses it via the
   * pure `parseLabelsFromGlobalState` helper.
   */
  readonly slotLabelsRaw?: unknown;
  /** T32 — clock seam for tests; defaults to `Date.now()`. */
  readonly now?: () => number;
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
  private readonly isAutoRotationEnabled: () => boolean;
  private readonly slotLabelsRaw: unknown;
  private readonly now: () => number;
  private readonly item: vscode.StatusBarItem;
  private readonly setIntervalImpl: (
    handler: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastUsage: TokenPlanUsage | undefined;
  private lastUsageUnavailable = false;

  constructor(deps: StatusBarDeps) {
    this.logger = deps.logger;
    this.keyProvider = deps.keyProvider;
    this.usageClient = deps.usageClient;
    this.isAutoRotationEnabled =
      deps.isAutoRotationEnabled ?? (() => StatusBarAdapter.readAutoRotationDefault());
    this.slotLabelsRaw = deps.slotLabelsRaw;
    this.now = deps.now ?? Date.now;
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
   * Default `enableAutoKeyRotation` reader for production: pulls
   * `mightyMax.enableAutoKeyRotation` from the host config the same
   * way the chat-provider does. Returns `true` when the host has no
   * config layer (test harness, schema drift, etc.).
   */
  private static readAutoRotationDefault(): boolean {
    const ws = (vscode as { workspace?: { getConfiguration?: (s: string) => unknown } }).workspace;
    if (ws?.getConfiguration === undefined) return true;
    const config = ws.getConfiguration('mightyMax') as { get?: (k: string) => unknown };
    const raw = config.get?.('enableAutoKeyRotation');
    return raw !== false;
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
    // usage reflects the same key the next request will send.
    const pick = await this.keyProvider.pickKey();
    if (pick === undefined) {
      this.lastUsage = undefined;
      this.lastUsageUnavailable = false;
      await this.renderNoKey();
      return undefined;
    }
    try {
      const usage = await this.usageClient.fetchUsage(pick.key);
      this.lastUsage = usage;
      this.lastUsageUnavailable = false;
      await this.renderFlightDeck({ usage, currentSlot: pick.slot });
      return usage;
    } catch (err) {
      this.lastUsage = undefined;
      if (err instanceof UsageUnavailableError) {
        // PAYG key, schema drift, or network blip — show neutral icon, no noise.
        this.logger.debug(`usage unavailable (kind=${err.kind}): ${err.message}`);
        this.lastUsageUnavailable = true;
      } else {
        this.logger.warn(`usage refresh failed: ${String(err)}`);
        this.lastUsageUnavailable = false;
      }
      await this.renderFlightDeck({ usage: undefined, currentSlot: pick.slot });
      return undefined;
    }
  }

  /** Last successfully fetched usage payload, for the webview panel. */
  getLastUsage(): TokenPlanUsage | undefined {
    return this.lastUsage;
  }

  /**
   * T32 — single rendering entry point. Snapshots the live state
   * (active slot, healthy slots, cooldown remaining, slot labels,
   * auto-rotation toggle, last fallback, usage data) and feeds it
   * into the pure `buildFlightDeckTooltip` + `buildFlightDeckText`
   * renderers. Side-effects:
   *
   *   - `item.text` includes a `$(error)` suffix when the active
   *     slot is in cooldown.
   *   - `item.backgroundColor` tints warning at 80% / error at 100%.
   *   - `item.tooltip` becomes the markdown dashboard.
   */
  private async renderFlightDeck(opts: {
    readonly usage: TokenPlanUsage | undefined;
    readonly currentSlot: KeySlot;
  }): Promise<void> {
    const activeSlot = await this.keyProvider.getActiveSlot();
    const storedEntries = await this.keyProvider.listStoredKeys();
    const stored = storedEntries.map((e) => e.slot);
    const healthySlots = new Set<KeySlot>(await this.keyProvider.listHealthySlots());

    // Per-slot cooldown remaining. Sourced from the (in-memory)
    // cooldown state the KeyProvider adapter owns; `__testOnlyCooldown`
    // is the seam (deliberately not a production method name).
    const cooldownMsRemaining = new Map<KeySlot, number>();
    const cooldown = this.keyProvider.__testOnlyCooldown;
    const nowMs = this.now();
    for (const slot of [1, 2, 3] as KeySlotType[]) {
      const remaining = cooldown !== undefined ? cooldownRemainingMs(slot, cooldown, nowMs) : 0;
      if (remaining > 0) cooldownMsRemaining.set(slot, remaining);
    }

    // Slot labels — fall back to the empty default if globalState is
    // empty / malformed (the helper tolerates both).
    const labelsMap = parseLabelsFromGlobalState(this.slotLabelsRaw);
    const labels = new Map<KeySlot, string>();
    for (const slot of [1, 2, 3] as KeySlotType[]) {
      const userLabel = getLabel(labelsMap, slot, '');
      if (userLabel !== '') labels.set(slot, userLabel);
    }

    const input: FlightDeckTooltipInput = {
      activeSlot,
      stored,
      healthySlots,
      cooldownMsRemaining,
      labels,
      autoRotationEnabled: this.isAutoRotationEnabled(),
      lastFallback: this.keyProvider.lastFallback,
      usage: opts.usage,
      nowMs,
      noKey: false,
      usageUnavailable: this.lastUsageUnavailable,
    };

    // T32 — text suffix for the active-in-cooldown case. Always
    // computed from the same snapshot so a tooltip hover and a
    // click are consistent.
    this.item.text = buildFlightDeckText({
      icon: ICON,
      percentUsed: opts.usage?.percentUsed,
      activeInCooldown: isActiveInCooldown(input),
    });

    // Background tint mirrors the prior contract: warning at 80%,
    // error at 100%. The flight-deck markdown itself carries the
    // full health narrative; the tint is purely a visual alarm.
    const pct = opts.usage?.percentUsed;
    this.item.backgroundColor =
      pct !== undefined && pct >= 100
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : pct !== undefined && pct >= 80
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(buildFlightDeckTooltip(input));
    this.item.tooltip = md;
  }

  private async renderNoKey(): Promise<void> {
    const activeSlot = await this.keyProvider.getActiveSlot();
    const input: FlightDeckTooltipInput = {
      activeSlot,
      stored: [],
      healthySlots: new Set(),
      cooldownMsRemaining: new Map(),
      labels: new Map(),
      autoRotationEnabled: this.isAutoRotationEnabled(),
      lastFallback: this.keyProvider.lastFallback,
      usage: undefined,
      nowMs: this.now(),
      noKey: true,
      usageUnavailable: false,
    };
    this.item.text = buildFlightDeckText({
      icon: ICON,
      percentUsed: undefined,
      activeInCooldown: isActiveInCooldown(input),
    });
    this.item.backgroundColor = undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(buildFlightDeckTooltip(input));
    this.item.tooltip = md;
  }

  dispose(): void {
    if (this.timer !== undefined) {
      this.clearIntervalImpl(this.timer);
      this.timer = undefined;
    }
    this.item.dispose();
  }
}
