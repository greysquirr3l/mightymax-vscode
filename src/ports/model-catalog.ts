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
  /**
   * True when the model is past its deprecation window and is hidden
   * from the chat model picker unless `mightyMax.showDeprecatedModels`
   * is enabled.
   *
   * The entry is RETAINED, not removed: a hidden model still resolves
   * by id, keeps all of its metadata, and keeps serving requests, so
   * an existing chat session pinned to it does not break. MiniMax is
   * winding down the M1 and M2.x families; hiding them steers new
   * users to M3 without revoking access from anyone who depends on it.
   */
  deprecated?: boolean;
}

export interface ModelCapabilities {
  /**
   * Tool-calling support + per-request cap.
   *
   * - `true`  — the model supports tool calling with no declared cap.
   *             VS Code / the Agent Host decide on its own how many
   *             tools to ship per request.
   * - `false` — the model cannot call tools (hidden from agent mode).
   * - `number` — the model supports tool calling AND this is the
   *             maximum number of tools the model can consume in a
   *             single request. VS Code's Agent Host reads this value
   *             to truncate the tool list it hands the provider
   *             (`LanguageModelChatCapabilities.toolCalling` in
   *             `vscode.d.ts` is typed `boolean | number` and
   *             documents the number as "the maximum number of tools
   *             that can be provided in a request"). Declaring a true
   *             ceiling prevents the payload from blowing past the
   *             model's actual limit when the workspace exposes 100+
   *             tools (Copilot + MCP + extension LM tools combined).
   *
   * Per MiniMax's published context windows and the tool-call
   * benchmarks cited in the M3 function-call guide, the curated
   * defaults are M3/M3.1-Flash-Preview → 128, M2.x → 60, M1 → 30.
   * `true` is reserved for the live `/v1/models` fallback path
   * (unknown future models).
   */
  toolCalling: boolean | number;
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
