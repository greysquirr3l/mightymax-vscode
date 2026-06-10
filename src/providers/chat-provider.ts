/**
 * ChatProvider — implements `vscode.LanguageModelChatProvider` and is
 * registered under the `minimax` vendor in `src/extension.ts`.
 *
 * T02 wires the catalog adapter:
 *   - `provideLanguageModelChatInformation` reads the live catalog
 *     and maps each `ModelInfo` to a `vscode.LanguageModelChatInformation`.
 *   - `onDidChangeLanguageModelChatInformation` re-fires when the
 *     catalog reports a live-list change, so the picker refreshes.
 *
 * The streaming response (`provideLanguageModelChatResponse`) and
 * tokenizer (`provideTokenCount`) are filled in by T07.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { MiniMaxClient, MiniMaxCompletionRequest } from '../ports/minimax-client.js';
import { MiniMaxClientError } from '../ports/minimax-client.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { ChatMessage, ChatMessageContentPart } from '../ports/message-mapping.js';
import { toLanguageModelTextPart, toLanguageModelToolCallPart } from '../ports/message-mapping.js';
import { mapRequestToMiniMax, mapStreamDeltaToResponseParts, isMessageMappingError } from '../lib/domain/messages.js';
import { mapToolsToMiniMax, mapToolModeToChoice, accumulatorSeed, accumulateToolCallDelta, finalizeAccumulator, isToolSchemaError } from '../lib/domain/tools.js';
import type { ChatTool, ChatToolMode } from '../ports/tool-schema.js';
import type { ThinkingStyle } from '../ports/model-catalog.js';

export class ChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly secretStore: SecretStore,
    private readonly client: MiniMaxClient,
    private readonly catalog: ModelCatalog,
  ) {
    // Forward catalog change events to the chat-provider change emitter
    // so the VS Code model picker refreshes when a new model lands in
    // the live list (e.g. a brand-new MiniMax model shows up in
    // `/v1/models`).
    this.disposables.push(
      this.catalog.onDidChange(() => {
        this.logger.debug('ChatProvider: catalog change forwarded to picker');
        this.changeEmitter.fire();
      }),
    );
  }

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.changeEmitter.event;

  /**
   * Public hook used by the composition root (extension.ts) to
   * re-fire the change event after the API key or base URL is
   * mutated through the manage command. Mirrors
   * `vscode.EventEmitter.fire` so callers don't need to reach into
   * the private emitter.
   *
   * Implementation: T06.
   */
  fireChange(): void {
    this.changeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) return [];

    // In silent mode, only return models if we have an API key
    if (options.silent) {
      const hasKey = await this.secretStore.hasSecret('apiKey');
      if (!hasKey) {
        this.logger.debug('ChatProvider: silent resolve with no API key - returning []');
        return [];
      }
    }

    try {
      const entries = await this.catalog.listModels();
      if (token.isCancellationRequested) return [];
      const mapped = entries.map(toLanguageModelChatInformation);
      this.logger.debug('ChatProvider: returning catalog', { count: mapped.length, silent: options.silent });
      return mapped;
    } catch (err) {
      this.logger.error('ChatProvider: catalog read failed', err);
      throw err;
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: ReadonlyArray<vscode.LanguageModelChatRequestMessage>,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Check for API key
    const apiKey = await this.secretStore.getSecret('apiKey');
    if (!apiKey) {
      throw new Error('MiniMax API key not configured. Run "Manage Mighty Max (Set API Key)" to configure.');
    }

    // Convert vscode messages to domain format
    const domainMessages = messages.map(vscodeToDomainMessage);

    // Get model info from catalog to determine thinking style
    const modelInfo = await this.catalog.getModel(model.id);
    const thinkingStyle: ThinkingStyle = modelInfo?.thinkingStyle ?? 'openai';
    // VSCode is deprecating the OpenAI method; always use Anthropic dialect
    const dialect = 'anthropic';

    // Map messages to MiniMax wire format (model first, then messages)
    const mappingResult = mapRequestToMiniMax({ id: model.id, thinkingStyle }, domainMessages);

    // Log any mapping warnings
    for (const warning of mappingResult.warnings) {
      if (isMessageMappingError(warning)) {
        this.logger.warn('Message mapping warning', { kind: warning.kind, warning });
      }
    }

    // Map tools to MiniMax format
    const tools = options.tools?.map(vscodeToDomainTool) ?? [];
    const miniMaxTools = tools.length > 0 ? mapToolsToMiniMax(tools) : undefined;

    // Convert vscode.LanguageModelChatToolMode to ChatToolMode
    let toolMode: ChatToolMode | undefined;
    if (options.toolMode === vscode.LanguageModelChatToolMode.Auto) {
      toolMode = 'auto';
    } else if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      toolMode = 'required';
    }

    const toolChoice = toolMode !== undefined ? mapToolModeToChoice(toolMode) : undefined;

    // Build the request (conditionally include tools/toolChoice)
    const request: MiniMaxCompletionRequest = {
      model: model.id,
      messages: mappingResult.messages.filter((m) => m.role !== undefined),
      ...(miniMaxTools !== undefined ? { tools: miniMaxTools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      stream: true,
      dialect,
    };

    this.logger.debug('Starting streaming request', { model: model.id, dialect, messageCount: request.messages.length, toolCount: tools.length });

    try {
      // Set up tool-call accumulator
      let accumulatorState = accumulatorSeed();

      // Convert CancellationToken to AbortSignal
      const abortController = new AbortController();
      const onCancel = token.onCancellationRequested(() => abortController.abort());

      try {
        // Stream the completion
        for await (const event of this.client.streamCompletion(request, apiKey, abortController.signal, this.logger)) {
          if (token.isCancellationRequested) break;

          // Handle tool-call deltas
          if (event.toolCallDelta !== undefined) {
            const accumulated = accumulateToolCallDelta(accumulatorState, event.toolCallDelta);
            if (isToolSchemaError(accumulated)) {
              this.logger.warn('Tool call accumulation error', { error: accumulated });
            } else {
              accumulatorState = accumulated.state;
            }
          }

          // Map stream deltas to response parts (thinkingStyle, not model object)
          const parts = mapStreamDeltaToResponseParts(event, thinkingStyle);

          for (const part of parts) {
            // Skip MessageMappingError entries
            if (isMessageMappingError(part)) {
              this.logger.warn('Stream mapping error', { kind: part.kind, error: part });
              continue;
            }

            if (part.type === 'text') {
              progress.report(toLanguageModelTextPart(part.value));
            } else if (part.type === 'thinking') {
              // Thinking is reported as text until LanguageModelThinkingPart lands in @types/vscode
              // The thinking content is not added to visible text
              this.logger.debug('Thinking content', { length: part.value.length });
            } else if (part.type === 'usage') {
              // Encode usage as a text part with a marker prefix so the host can introspect it
              const usageJson = JSON.stringify(part.usage);
              progress.report(toLanguageModelTextPart(`__minimax_usage__:${usageJson}`));
            }
          }

          // Handle finish reason
          if (event.finishReason === 'tool_calls') {
            // Finalize accumulated tool calls
            const finalized = finalizeAccumulator(accumulatorState);
            for (const toolCallOrError of finalized) {
              if (isToolSchemaError(toolCallOrError)) {
                this.logger.error('Tool call finalization error', toolCallOrError);
              } else {
                progress.report(toLanguageModelToolCallPart(toolCallOrError));
              }
            }
          }

          // Handle stream errors
          if (event.error !== undefined) {
            this.logger.error('Stream error event', event.error);
            throw new Error(`MiniMax stream error: ${event.error.message}`);
          }
        }
      } finally {
        onCancel.dispose();
      }

      this.logger.debug('Streaming request completed', { model: model.id });
    } catch (err) {
      if (err instanceof MiniMaxClientError) {
        this.logger.error('MiniMax client error', err, { kind: err.kind, status: err.status });
        throw new Error(`MiniMax API error (${err.kind}): ${err.message}`);
      }
      throw err;
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // Get the text content
    const content = typeof text === 'string' ? text : extractMessageText(text);

    // Get model info to determine family
    const modelInfo = await this.catalog.getModel(model.id);
    const isAnthropic = modelInfo?.thinkingStyle === 'anthropic';

    // Family-aware heuristic:
    // - Anthropic-style (M3): ~4 chars per token (more conservative)
    // - OpenAI-style (M2.x): ~3.5 chars per token
    // This is a rough estimate; a real tokenizer would be more accurate.
    const charsPerToken = isAnthropic ? 4.0 : 3.5;
    const estimate = Math.ceil(content.length / charsPerToken);

    return Math.max(1, estimate);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.changeEmitter.dispose();
  }
}

// -----------------------------------------------------------------------------
// Mapping: ModelInfo -> vscode.LanguageModelChatInformation
// -----------------------------------------------------------------------------

/**
 * Map a domain `ModelInfo` to the VS Code `LanguageModelChatInformation`
 * shape. Pure function — no I/O, no side effects — so it can be unit
 * tested independently of the chat provider.
 *
 * Per AGENTS.md: `capabilities.toolCalling = true` on every
 * agent-capable model is the gate that keeps the model in the agent
 * model picker. We forward `imageInput` from the domain capability.
 */
export function toLanguageModelChatInformation(
  entry: ModelInfo,
): vscode.LanguageModelChatInformation {
  return {
    id: entry.id,
    name: entry.displayName,
    family: entry.family,
    version: entry.thinkingStyle === 'anthropic' ? '1' : '0',
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    tooltip: buildTooltip(entry),
    detail: entry.detail,
    capabilities: {
      imageInput: entry.capabilities.imageInput,
      toolCalling: entry.capabilities.toolCalling ? true : false,
    },
  };
}

function buildTooltip(entry: ModelInfo): string {
  const lines = [
    `${entry.displayName} (${entry.id})`,
    `Family: ${entry.family}`,
    `Context: ${entry.maxInputTokens.toLocaleString()} input / ${entry.maxOutputTokens.toLocaleString()} output`,
    `Thinking: ${entry.capabilities.thinking ? `yes (${entry.thinkingStyle})` : 'no'}`,
    `Image input: ${entry.capabilities.imageInput ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Helper: VS Code -> Domain conversions
// -----------------------------------------------------------------------------

/**
 * Convert a VS Code chat message to the domain `ChatMessage` format.
 * This is a thin struct-by-struct copy that mirrors the shapes.
 */
function vscodeToDomainMessage(msg: vscode.LanguageModelChatRequestMessage): ChatMessage {
  const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';

  const content: ChatMessageContentPart[] = [];

  // Handle content that can be string or array
  const msgContent = typeof msg.content === 'string' ? [new vscode.LanguageModelTextPart(msg.content)] : msg.content;

  for (const part of msgContent) {
    if (part instanceof vscode.LanguageModelTextPart) {
      content.push({ type: 'text', value: part.value });
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      content.push({
        type: 'tool-call',
        toolCall: {
          callId: part.callId,
          name: part.name,
          input: part.input as { readonly [key: string]: unknown },
        },
      });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      // Convert tool result content to the domain format
      const resultContent = part.content.map((c) => {
        if (c instanceof vscode.LanguageModelTextPart) {
          return c.value;
        }
        // Other content types would be handled here
        return String(c);
      });
      content.push({
        type: 'tool-result',
        toolResult: {
          callId: part.callId,
          content: resultContent,
        },
      });
    }
    // Image parts would be handled here if supported
  }

  return { role, content, name: msg.name };
}

/**
 * Convert a VS Code tool definition to the domain `ChatTool` format.
 */
function vscodeToDomainTool(tool: vscode.LanguageModelChatTool): ChatTool {
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as { readonly [key: string]: unknown } } : {}),
  };
}

/**
 * Extract text content from a chat message for token counting.
 */
function extractMessageText(msg: vscode.LanguageModelChatRequestMessage): string {
  const msgContent = typeof msg.content === 'string' ? [new vscode.LanguageModelTextPart(msg.content)] : msg.content;

  const textParts: string[] = [];
  for (const part of msgContent) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textParts.push(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      textParts.push(JSON.stringify(part.input));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      for (const c of part.content) {
        if (c instanceof vscode.LanguageModelTextPart) {
          textParts.push(c.value);
        }
      }
    }
  }

  return textParts.join('\n');
}
