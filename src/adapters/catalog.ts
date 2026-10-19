/**
 * CatalogAdapter — implements the `ModelCatalog` port for production.
 *
 * Owns:
 *   - The static built-in catalog (sourced from the domain).
 *   - A "live" override list updated by the transport layer (T05)
 *     after fetching from the MiniMax `/v1/models` endpoint.
 *   - A `vscode.Event<void>` fired whenever the live list changes,
 *     so `ChatProvider` can re-emit
 *     `onDidChangeLanguageModelChatInformation` and the picker
 *     refreshes automatically.
 *
 * Domain (`src/lib/domain/catalog.ts`) does the actual merging and
 * validation; this adapter is a thin vscode-aware shell.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import {
  BUILT_IN_CATALOG,
  type CatalogEntry,
  filterDeprecated,
  mergeCatalog,
} from '../lib/domain/catalog.js';

/** Settings key that re-exposes deprecated models in the picker. */
const SHOW_DEPRECATED_KEY = 'showDeprecatedModels';

export class CatalogAdapter implements ModelCatalog {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private liveModels: ReadonlyArray<CatalogEntry> = [];
  private cachedMerged: ReadonlyArray<ModelInfo> | undefined;
  private cachedMergedLiveKey: ReadonlyArray<CatalogEntry> | undefined;
  private cachedShowDeprecated: boolean | undefined;
  private readonly configSub: vscode.Disposable;

  constructor(private readonly logger: Logger) {
    this.logger.debug('CatalogAdapter constructed');

    // Read fresh at the use-site, but do not re-read on every call:
    // subscribe so a settings change drops the cache and refreshes
    // the picker instead of waiting for the next API-key rotation.
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`mightyMax.${SHOW_DEPRECATED_KEY}`)) return;
      const next = this.readShowDeprecated();
      if (this.cachedShowDeprecated === next) return;
      this.cachedShowDeprecated = next;
      this.logger.debug(
        `CatalogAdapter: ${SHOW_DEPRECATED_KEY}=${next} — picker list changed`,
      );
      // `computeMerged` is unfiltered so it stays cached; only the
      // picker's view of it changed.
      this.changeEmitter.fire();
    });
  }

  /**
   * Whether deprecated (wound-down) models stay visible in the picker.
   * Defaults to `false` so the list reflects what MiniMax still
   * supports; flipping it on restores every catalog entry.
   */
  private readShowDeprecated(): boolean {
    return (
      vscode.workspace
        .getConfiguration('mightyMax')
        .get<boolean>(SHOW_DEPRECATED_KEY, false) === true
    );
  }

  public dispose(): void {
    this.configSub.dispose();
    this.changeEmitter.dispose();
  }

  /** Fires when the live list changes. Subscribed by `ChatProvider`. */
  public readonly onDidChange: vscode.Event<void> = this.changeEmitter.event;

  listModels(): Promise<ReadonlyArray<ModelInfo>> {
    // Returned synchronously but typed as a Promise to match the
    // ModelCatalog port and to keep the public surface async-only
    // (live-list updates may be async in the future).
    return Promise.resolve(filterDeprecated(this.computeMerged(), this.readShowDeprecated()));
  }

  getModel(id: string): Promise<ModelInfo | undefined> {
    // Deliberately resolves against the UNFILTERED catalog. A chat
    // session already pinned to a deprecated model must keep working
    // after that model leaves the picker — hiding it is a display
    // decision, not a revocation.
    return Promise.resolve(this.computeMerged().find((entry) => entry.id === id));
  }

  /**
   * Replace the live override list. The transport layer calls this
   * after fetching from `/v1/models`. Passing an equal-length list
   * with identical ids does NOT fire the change event (we only fire
   * when the resulting merged catalog actually differs).
   */
  public setLiveModels(live: ReadonlyArray<ModelInfo>): void {
    const next = Object.freeze([...live]);
    const previousIds = this.liveModels.map((e) => e.id).join(',');
    const nextIds = next.map((e) => e.id).join(',');
    if (previousIds === nextIds && this.liveModels.length === next.length) {
      // No structural change — short-circuit so we don't re-emit.
      return;
    }
    this.liveModels = next;
    this.cachedMerged = undefined;
    this.cachedMergedLiveKey = undefined;
    this.logger.debug(`CatalogAdapter: live list updated (${next.length} entries)`);
    this.changeEmitter.fire();
  }

  private computeMerged(): ReadonlyArray<ModelInfo> {
    if (this.cachedMerged && this.cachedMergedLiveKey === this.liveModels) {
      return this.cachedMerged;
    }
    const merged = mergeCatalog(BUILT_IN_CATALOG, this.liveModels);
    this.cachedMerged = Object.freeze(merged);
    this.cachedMergedLiveKey = this.liveModels;
    return this.cachedMerged;
  }

  /** Test seam: returns the live list as currently set. */
  public _liveForTest(): ReadonlyArray<CatalogEntry> {
    return this.liveModels;
  }
}
