import type { Event } from 'vscode';

/**
 * ModelCatalog — port for the static + dynamic list of MiniMax chat models
 * that this extension advertises to VS Code's chat model picker.
 *
 * The full catalog definition (T02) lives in `src/lib/domain/catalog.ts`;
 * this port is the seam between the domain (pure data + rules) and the
 * adapter that turns catalog entries into
 * `vscode.LanguageModelChatInformation[]` for `provideLanguageModelChatInformation`.
 *
 * The `onDidChange` event is consumed by `ChatProvider` to re-emit
 * `onDidChangeLanguageModelChatInformation` so the picker refreshes
 * when the catalog (e.g. the live list fetched from `/v1/models`)
 * changes. Adapters that have no live list can return
 * `new vscode.EventEmitter<void>().event` (it just never fires).
 */

/**
 * How a model surfaces its thinking content in the MiniMax stream.
 *  - `anthropic` — M3 (and forward) on the Anthropic-compatible endpoint emits
 *    first-class `thinking` blocks interleaved with text and tool calls.
 *  - `openai`    — M2.x on the OpenAI-compatible endpoint emits reasoning
 *    as a separate `reasoning_content` delta in the chunk stream.
 *  - `none`      — no native thinking; the model answers directly.
 *
 * The transport layer (T05) reads this field to pick the right wire schema.
 */
export type ThinkingStyle = 'anthropic' | 'openai' | 'none';

export interface ModelInfo {
  /** Stable MiniMax model id used in API requests (e.g. "MiniMax-M3"). */
  id: string;
  /** Human-readable name shown in the picker (e.g. "M3 (MiniMax)"). */
  displayName: string;
  /** Vendor id used in the `languageModelChatProviders` contribution. */
  vendor: string;
  /** Family/grouping for picker UI. The MiniMax hint uses "minimax" so every
   *  entry groups under a single family in the model picker. */
  family: string;
  /** Maximum input token count for the model (= total ctx − max output). */
  maxInputTokens: number;
  /** Maximum output token count for the model. */
  maxOutputTokens: number;
  /** Capability flags; `toolCalling` gates agent-mode eligibility. */
  capabilities: ModelCapabilities;
  /** How the model emits its thinking content, if any. */
  thinkingStyle: ThinkingStyle;
  /** Short, human-readable subtitle shown in the picker ("200K ctx, 8K out"). */
  detail: string;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  imageInput: boolean;
  /** Native thinking blocks (M3 exposes these on the Anthropic-compatible endpoint). */
  thinking: boolean;
  /**
   * Video input via Anthropic-compatible content blocks.
   *
   * Only `MiniMax-M3` and `MiniMax-M3.1-Flash-Preview` accept it —
   * the MiniMax docs state "The M2.7, M2.5, M2.1, and M2 series
   * support text and tool-call content blocks only", so sending a
   * video part to an M2.x model is a guaranteed rejection. The
   * message mapper consults this flag to downgrade the part to an
   * `unsupported-content` warning instead of putting a doomed
   * request on the wire.
   */
  videoInput: boolean;
}

export interface ModelCatalog {
  /** All models the extension supports (static list merged with any live list). */
  listModels(): Promise<ReadonlyArray<ModelInfo>>;
  /** Lookup by id; returns undefined if the model is not in the catalog. */
  getModel(id: string): Promise<ModelInfo | undefined>;
  /** Fires when the catalog contents change. Adapters that never change
   *  (e.g. a read-only test stub) may return an event that never fires. */
  readonly onDidChange: Event<void>;
}
