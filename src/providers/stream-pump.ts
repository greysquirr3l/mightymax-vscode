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
 * to progress (never as visible text), usage logs at `debug`
 * only (never as text), and the tool-call accumulator flushes on
 * every terminal path (mid-stream error, `finishReason` of any
 * value, or stream-end with no finish marker).
 *
 * Imports `vscode` because the progress reporter and the
 * `LanguageModelDataPart` (T19 thinking surface) require it.
 * `MiniMaxClientError` is intentionally NOT caught here — the
 * caller decides how to surface the failure (the chat-provider
 * re-wraps it as a typed chat error for the host).
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
          reportThinkingPart(deps.progress, typed, deps.logger);
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
 * Report a thinking event to the host. Until
 * `LanguageModelThinkingPart` lands in `@types/vscode`, we use
 * `LanguageModelDataPart.json(value, mime)` with a discriminating
 * MIME so the chat UI routes the part to the thinking panel
 * rather than the visible-text lane. The runtime is present on
 * VS Code 1.128+; the type is missing from `@types/vscode 1.104`,
 * so the constructor is resolved via a small cast.
 */
function reportThinkingPart(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: { type: 'thinking'; value: string; signature?: string },
  logger: Logger,
): void {
  type DataCtor = new (data: Uint8Array, mime: string) => unknown;
  const ctor = (vscode as unknown as { LanguageModelDataPart?: DataCtor }).LanguageModelDataPart;
  const payload = part.signature
    ? { thinking: part.value, signature: part.signature }
    : { thinking: part.value };
  if (typeof ctor === 'function') {
    try {
      const json = new TextEncoder().encode(JSON.stringify(payload));
      progress.report(
        new ctor(json, 'application/vnd.minimax.thinking+json') as vscode.LanguageModelResponsePart,
      );
      return;
    } catch (err) {
      logger.warn('LanguageModelDataPart construction failed; falling back to no-op', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // No-op: the cached `currentThinking` still feeds the LRU
  // replay cache so the thinking signature survives into the
  // next request. When LanguageModelThinkingPart lands in
  // @types/vscode, swap this fallback for the typed
  // constructor.
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
