/**
 * Stream pump — the runtime loop that consumes a
 * `MiniMaxClient.streamCompletion` async iterable and projects
 * each `MiniMaxStreamEvent` onto the host via
 * `vscode.Progress<vscode.LanguageModelResponsePart>`.
 *
 * Extracted from `src/providers/chat-provider.ts` so the
 * composition root (`ChatProvider`) keeps the request-building and
 * tool-filter logic in one place while this file owns the
 * per-event fan-out. T19 invariants live here: thinking surfaces
 * to progress (never as visible text), usage surfaces as a
 * `LanguageModelDataPart` with the `'usage'` MIME type (matching
 * the convention VS Code's built-in Copilot BYOK providers use;
 * see `extensions/copilot/src/platform/endpoint/common/endpointTypes.ts`
 * `CustomDataPartMimeTypes.Usage`), and the tool-call accumulator
 * flushes on every terminal path (mid-stream error, `finishReason`
 * of any value, or stream-end with no finish marker).
 *
 * Imports `vscode` because the progress reporter and the
 * `LanguageModelDataPart` (T19 thinking surface, T26 usage
 * surface) require it. `MiniMaxClientError` is intentionally NOT
 * caught here — the caller decides how to surface the failure
 * (the chat-provider re-wraps it as a typed chat error for the
 * host).
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { MiniMaxStreamEvent } from '../ports/minimax-client.js';
import { mapStreamDeltaToResponseParts, isMessageMappingError } from '../lib/domain/messages.js';
import {
  accumulatorSeed,
  accumulateToolCallDelta,
  finalizeAccumulator,
  isToolSchemaError,
  type ToolCallAccumulatorState,
} from '../lib/domain/tools.js';
import { toLanguageModelTextPart, toLanguageModelToolCallPart } from '../ports/tool-schema.js';
import type { ThinkingStyle } from '../ports/model-catalog.js';

export interface StreamPumpResult {
  /** Concatenated visible text the model emitted (T19: NO usage or thinking mixed in). */
  text: string;
  /**
   * Thinking block captured for the LRU replay cache. `undefined`
   * if the model emitted no thinking deltas this stream.
   */
  thinking: { thinking: string; signature?: string } | undefined;
  /** Final id list of tool calls flushed to the host. */
  toolCallIds: ReadonlyArray<string>;
  /** Final accumulator state after every flush. Empty for normal streams. */
  accumulatorState: ToolCallAccumulatorState;
}

export interface StreamPumpDeps {
  /** Source stream of `MiniMaxStreamEvent`s. */
  events: AsyncIterable<MiniMaxStreamEvent>;
  /** Host progress reporter. */
  progress: vscode.Progress<vscode.LanguageModelResponsePart>;
  /** Models use this discriminator to decide whether reasoning belongs on the wire. */
  thinkingStyle: ThinkingStyle;
  /** Diagnostic logger. */
  logger: Logger;
  /** Records a tool call usage event (used by smart-tool-filter learning). */
  recordToolUsage: (toolCallName: string) => void;
  /**
   * Optional observer called when a stream event throws (T19:
   * flush-before-throw). Defaults to no-op. The chat-provider
   * passes a no-op; tests pass a recording observer to assert
   * the always-flush behavior.
   */
  onStreamError?: (err: unknown) => void;
}

/**
 * Drain the iterable, mapping each event to host progress parts and
 * accumulating state. Throws on mid-stream transport errors AFTER
 * flushing any partial tool calls (T19). Returns the captured
 * stream state so the caller can cache thinking, log stats, etc.
 *
 * The function is intentionally monolithic for clarity — splitting
 * the inner loop further obscures the order of operations that
 * the T19 spec pins.
 */
export async function pumpProviderStream(deps: StreamPumpDeps): Promise<StreamPumpResult> {
  let accumulatorState = accumulatorSeed();
  let currentThinking: { thinking: string; signature?: string } | undefined;
  let currentText = '';
  const currentToolCallIds: string[] = [];

  try {
    for await (const event of deps.events) {
      // Handle tool-call deltas first (every event may carry one).
      if (event.toolCallDelta !== undefined) {
        const accumulated = accumulateToolCallDelta(accumulatorState, event.toolCallDelta);
        if (isToolSchemaError(accumulated)) {
          deps.logger.warn('Tool call accumulation error', { error: accumulated });
        } else {
          accumulatorState = accumulated.state;
        }
      }

      // Map stream deltas to response parts. T19 invariant:
      // thinking deltas surface via `reportThinkingPart` (NOT as
      // visible text); usage is logged at debug (NOT as visible text).
      const parts = mapStreamDeltaToResponseParts(event, deps.thinkingStyle);

      for (const part of parts) {
        if (isMessageMappingError(part)) {
          deps.logger.warn('Stream mapping error', { kind: part.kind, error: part });
          continue;
        }
        const typed = part;
        if (typed.type === 'text') {
          currentText += typed.value;
          deps.logger.debug('Text delta', { length: typed.value.length });
          deps.progress.report(toLanguageModelTextPart(typed.value));
        } else if (typed.type === 'thinking') {
          if (typed.value.length > 0) {
            reportThinkingPart(deps.progress, typed, deps.logger);
          } else if (typed.signature) {
            // Standalone signature: Anthropic may emit the
            // signature_delta on its own chunk (no `thinking_delta`
            // paired with it). Emit a zero-length
            // `LanguageModelThinkingPart` carrying the signature
            // in `metadata.signature` so the chat widget can
            // attach it to the prior thinking block — the same
            // pattern Copilot's Anthropic BYOK provider uses
            // (`anthropicProvider.ts:762-769`).
            reportThinkingPart(deps.progress, typed, deps.logger);
          } else {
            // Truly empty (no value, no signature) — nothing to do.
            continue;
          }
          if (!currentThinking) {
            const accumulated: { thinking: string; signature?: string } = {
              thinking: typed.value,
            };
            if (typed.signature) accumulated.signature = typed.signature;
            currentThinking = accumulated;
          } else {
            currentThinking.thinking += typed.value;
            if (typed.signature) currentThinking.signature = typed.signature;
          }
        } else if (typed.type === 'usage') {
          deps.logger.debug('Usage received', {
            promptTokens: typed.usage.promptTokens,
            completionTokens: typed.usage.completionTokens,
            cacheReadTokens: typed.usage.cacheReadTokens,
            cacheCreateTokens: typed.usage.cacheCreateTokens,
          });
          // T26 (issue #46): Surface usage as a `LanguageModelDataPart`
          // with the `'usage'` MIME type. This matches the convention
          // VS Code's built-in Copilot BYOK providers use (see
          // `CustomDataPartMimeTypes.Usage` in
          // extensions/copilot/src/platform/endpoint/common/endpointTypes.ts).
          //
          // As of VS Code 1.125, the public `LanguageModelChatProvider`
          // API does not give third-party providers a direct path to
          // the chat-widget's context-usage gauge (that gauge reads
          // `response.usage`, which is populated by the
          // `vscode.chat` participant API's `stream.usage()` only).
          // Emitting this data part still:
          //   1. Future-proofs us if/when VS Code adds a native decode
          //      for provider-stream usage data parts.
          //   2. Makes the usage visible to any other extension
          //      consuming our response stream.
          //   3. Round-trips cleanly with Copilot's BYOK wrappers if
          //      our extension is ever loaded inside a host that
          //      decodes this MIME type (e.g. a custom agent loop).
          //
          // Never throw out of this branch — a malformed JSON
          // payload must not abort the agent turn.
          try {
            const payload = JSON.stringify({
              promptTokens: typed.usage.promptTokens,
              completionTokens: typed.usage.completionTokens,
              cacheReadTokens: typed.usage.cacheReadTokens ?? 0,
              cacheCreateTokens: typed.usage.cacheCreateTokens ?? 0,
            });
            deps.progress.report(
              new vscode.LanguageModelDataPart(new TextEncoder().encode(payload), 'usage'),
            );
          } catch (err) {
            deps.logger.warn('Failed to surface usage data part', {
              error: String(err),
            });
          }
        }
      }

      if (event.finishReason !== undefined) {
        deps.logger.info('Stream finished', {
          finishReason: event.finishReason,
          textLength: currentText.length,
          thinkingLength: currentThinking?.thinking.length ?? 0,
          toolCallCount: currentToolCallIds.length,
        });
      }

      if (event.error !== undefined) {
        deps.logger.error('Stream error event', event.error);
        throw new Error(`MiniMax stream error: ${event.error.message}`);
      }
    }
  } catch (streamErr) {
    // T19: flush the accumulator BEFORE rethrowing so the host
    // sees whatever completed calls were in flight. Idempotent
    // via the empty-state guard.
    flushAccumulator(
      accumulatorState,
      deps.progress,
      currentToolCallIds,
      deps.logger,
      deps.recordToolUsage,
    );
    deps.onStreamError?.(streamErr);
    throw streamErr;
  }

  // T19: also flush when the stream completes WITHOUT an error
  // (covers `finishReason === 'stop' / 'length' / 'content_filter'`
  // after tool-calls were emitted, and the abandonment path
  // where the stream ends with no finish marker).
  if (accumulatorState.perIndex.size > 0) {
    flushAccumulator(
      accumulatorState,
      deps.progress,
      currentToolCallIds,
      deps.logger,
      deps.recordToolUsage,
    );
  }

  return {
    text: currentText,
    thinking: currentThinking,
    toolCallIds: currentToolCallIds,
    accumulatorState,
  };
}

/**
 * Report a thinking event to the host. The preferred surface
 * is `LanguageModelThinkingPart` — VS Code's chat widget routes
 * it to a collapsible "click to show" section (see
 * `ChatThinkingContentPart extends ChatCollapsibleContentPart`
 * in upstream's
 * `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatThinkingContentPart.ts`),
 * matching the affordance users see with Claude and ChatGPT.
 *
 * The runtime constructor is present on VS Code 1.128+ but the
 * type is not yet stable in `@types/vscode 1.125.0` — it lives
 * in `vscode.proposed.languageModelThinkingPart.d.ts` upstream.
 * We resolve the constructor via a small cast (the same pattern
 * we use for `LanguageModelDataPart`); once the proposed API
 * stabilizes, the cast drops and the call site becomes typed.
 *
 * Fallback for VS Code < 1.128: the proposed API isn't on the
 * runtime, so we emit a `LanguageModelDataPart` with the
 * previous `application/vnd.minimax.thinking+json` MIME. This
 * is the same surface the extension used before T27 — the
 * chat widget renders it as raw inline text (a 3-version
 * upgrade window of "verbose but visible" rather than the
 * pre-T27 "JSON-wrapped verbose" — the chat widget recognizes
 * a string-only payload with no nested object and renders the
 * `value` field directly).
 *
 * The Anthropic signature rides on `.metadata.signature` (when
 * we have the thinking-part surface) or as a sibling field on
 * the JSON payload (when we fall back to the data part), the
 * same pattern Copilot's Anthropic BYOK provider uses
 * (`extensions/copilot/src/extension/byok/vscode-node/anthropicProvider.ts`
 * lines 762-769) so a downstream consumer that wants to capture
 * the full thinking+signature pair for replay can do so via the
 * same field.
 */
function reportThinkingPart(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: { type: 'thinking'; value: string; signature?: string },
  logger: Logger,
): void {
  type ThinkingCtor = new (
    value: string | string[],
    id?: string,
    metadata?: { readonly [key: string]: unknown },
  ) => unknown;
  type DataCtor = new (data: Uint8Array, mime: string) => unknown;

  const thinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: ThinkingCtor })
    .LanguageModelThinkingPart;
  const dataCtor = (vscode as unknown as { LanguageModelDataPart?: DataCtor })
    .LanguageModelDataPart;

  if (typeof thinkingCtor === 'function') {
    try {
      const metadata: { signature?: string } =
        part.signature !== undefined ? { signature: part.signature } : {};
      progress.report(
        new thinkingCtor(part.value, undefined, metadata) as vscode.LanguageModelResponsePart,
      );
      return;
    } catch (err) {
      logger.warn('LanguageModelThinkingPart construction failed; falling back to data part', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // VS Code < 1.128 fallback: emit a data part with the same
  // MIME we used pre-T27. The thinking text is in the JSON
  // payload as `thinking`; the signature rides on
  // `signature` (when present). The chat widget renders this
  // as raw inline text — verbose but visible, which is
  // strictly better than silently dropping the reasoning.
  if (typeof dataCtor === 'function') {
    try {
      const payload: { thinking: string; signature?: string } = {
        thinking: part.value,
      };
      if (part.signature !== undefined) payload.signature = part.signature;
      const json = new TextEncoder().encode(JSON.stringify(payload));
      progress.report(
        new dataCtor(
          json,
          'application/vnd.minimax.thinking+json',
        ) as vscode.LanguageModelResponsePart,
      );
    } catch (err) {
      logger.warn('LanguageModelDataPart construction failed; thinking dropped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // If both constructors are missing, the cached `currentThinking`
  // at the pump scope still feeds the LRU replay cache so the
  // thinking signature survives into the next request — at the
  // cost of the visible-text affordance. This branch is
  // unreachable on any VS Code that supports the
  // LanguageModelChatProvider API.
}

/**
 * Flush the tool-call accumulator on every terminal path. Runs
 * once per pump (idempotent thanks to the empty-state guard at
 * the top). Emits every surviving call to `progress.report` and
 * appends its id to `currentToolCallIds` so downstream code
 * (context-window widget, tool-usage stats) can correlate.
 */
function flushAccumulator(
  accumulatorState: ToolCallAccumulatorState,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  currentToolCallIds: string[],
  logger: Logger,
  recordUsage: (toolCallName: string) => void,
): void {
  const finalized = finalizeAccumulator(accumulatorState);
  if (finalized.length === 0) return;
  logger.info('Finalizing tool calls', { count: finalized.length });
  for (const toolCallOrError of finalized) {
    if (isToolSchemaError(toolCallOrError)) {
      logger.error('Tool call finalization error', toolCallOrError);
      continue;
    }
    logger.info('Emitting tool call', {
      callId: toolCallOrError.callId,
      name: toolCallOrError.name,
    });
    currentToolCallIds.push(toolCallOrError.callId);
    progress.report(toLanguageModelToolCallPart(toolCallOrError));
    recordUsage(toolCallOrError.name);
  }
}
