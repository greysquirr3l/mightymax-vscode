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

import { createHash } from 'node:crypto';

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { MiniMaxClient, MiniMaxCompletionRequest } from '../ports/minimax-client.js';
import { MiniMaxClientError } from '../ports/minimax-client.js';
import type { ModelCatalog, ModelInfo } from '../ports/model-catalog.js';
import type { SecretStore } from '../ports/secret-store.js';
import type { ChatMessage, ChatMessageContentPart } from '../ports/message-mapping.js';

import { mapRequestToMiniMax, isMessageMappingError } from '../lib/domain/messages.js';
import { dialectForModel } from '../lib/domain/dialect.js';
import {
  filterTools,
  type ToolFilterConfig,
} from '../lib/domain/tool-filter.js';
import { pumpProviderStream } from './stream-pump.js';
import {
  mapToolsToMiniMax,
  mapToolModeToChoice,
} from '../lib/domain/tools.js';
import {
  getMaxTokensForModel,
  getModelSampler,
  getThinkingConfig,
} from '../lib/domain/anthropic-transform.js';
import { LruMap } from '../lib/domain/lru.js';
import type { ChatTool, ChatToolMode } from '../ports/tool-schema.js';
import type { ThinkingStyle } from '../ports/model-catalog.js';

export class ChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private disposables: vscode.Disposable[] = [];
  /**
   * Shadow cache of thinking blocks with signatures, keyed by a
   * stable hash of the assistant message that preceded them. This
   * cache bridges the gap until LanguageModelThinkingPart lands
   * in @types/vscode and VS Code can persist thinking blocks in
   * its own history. The cache is bounded (LRU, 128 entries) so a
   * long-running session cannot grow it without limit. The cache
   * lifetime is the provider's lifetime (cleared on dispose).
   *
   * Key: sha256 of (model id + text content + canonicalized tool
   * call list). Value: {thinking, signature?}.
   */
  private readonly thinkingCache = new LruMap<string, { thinking: string; signature?: string }>(
    128,
  );
  /**
   * Tool usage tracking for smart filtering. Maps tool names to call counts.
   * Used to prioritize frequently-used tools when filtering is enabled.
   */
  private readonly toolUsageStats = new Map<string, number>();

  /**
   * Default system prompt sent on every M3 request. M3 plans more
   * carefully than M2.x when given a system preamble; the
   * sentence is tuned for a coding-agent context (use the
   * available tools, prefer minimal tool calls, summarize
   * changes). The user can override it via the
   * `mightyMax.systemPrompt` configuration setting.
   */
  private static readonly DEFAULT_SYSTEM_PROMPT =
    'You are a helpful coding assistant. Use the available tools to complete the task. ' +
    'Prefer minimal tool calls and return a short summary of any changes you made.';

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
      this.logger.debug('ChatProvider: returning catalog', {
        count: mapped.length,
        silent: options.silent,
      });
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
      throw new Error(
        'MiniMax API key not configured. Run "Manage Mighty Max (Set API Key)" to configure.',
      );
    }

    // Convert vscode messages to domain format
    const domainMessages = messages.map(vscodeToDomainMessage);

    // Inject cached thinking blocks into assistant messages
    const enrichedMessages = this.enrichWithThinking(domainMessages, model.id);

    // Get model info from catalog to determine thinking style + dialect
    const modelInfo = await this.catalog.getModel(model.id);
    const thinkingStyle: ThinkingStyle = modelInfo?.thinkingStyle ?? 'openai';
    const dialect = dialectForModel(modelInfo ?? { thinkingStyle });

    // Map messages to MiniMax wire format (model first, then messages)
    const mappingResult = mapRequestToMiniMax({ id: model.id, thinkingStyle }, enrichedMessages);

    // Log any mapping warnings
    for (const warning of mappingResult.warnings) {
      if (isMessageMappingError(warning)) {
        this.logger.warn('Message mapping warning', { kind: warning.kind, warning });
      }
    }

    // Map tools to MiniMax format with smart filtering
    const allTools = options.tools?.map(vscodeToDomainTool) ?? [];

    // Apply smart filtering if configured (T21). The pure
    // decision lives in `src/lib/domain/tool-filter.ts`; the
    // provider feeds it: (1) the resolved config, (2) the names
    // of tools already referenced by this request's tool_use /
    // tool_result history (so the model's in-flight tool calls
    // cannot be silently dropped by the cap). The response tells
    // us which tools to keep; the dropped list is logged with
    // names only — never schemas — per AGENTS.md redaction rules.
    const filterConfig = readToolFilterConfig();
    const historyToolNames = collectHistoryReferencedToolNames(messages);
    const filterDecision = filterTools(allTools, historyToolNames, filterConfig);
    const keptTools = filterDecision.kept
      .map((name) => allTools.find((t) => t.name === name))
      .filter((t): t is ChatTool => t !== undefined);
    if (filterDecision.dropped.length > 0) {
      this.logger.warn('Smart tool filtering dropped tools', {
        droppedCount: filterDecision.dropped.length,
        droppedNames: filterDecision.dropped,
      });
    }
    const tools = keptTools;
    const miniMaxTools = tools.length > 0 ? mapToolsToMiniMax(tools) : undefined;

    // Convert vscode.LanguageModelChatToolMode to ChatToolMode
    let toolMode: ChatToolMode | undefined;
    if (options.toolMode === vscode.LanguageModelChatToolMode.Auto) {
      toolMode = 'auto';
    } else if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      toolMode = 'required';
    }

    const toolChoice = toolMode !== undefined ? mapToolModeToChoice(toolMode) : undefined;

    // Per-model sampling parameters (opencode `transform.ts:286-334`).
    // The M-series is tuned at temp=1.0, topP=0.95, topK=20-40; sending
    // the upstream default produces noticeably different outputs.
    const sampler = getModelSampler(model.id);
    // Clamp max_tokens to 32K (opencode OUTPUT_TOKEN_MAX) so an
    // agent turn cannot burn the whole context window.
    const maxTokens = getMaxTokensForModel(model.id);
    // M3 native thinking: opt the model in to its reasoning block
    // (Anthropic interface defaults thinking OFF, unlike Chat
    // Completions). Without this, M3 rushes the first tool call.
    const thinkingConfig = getThinkingConfig(model.id, thinkingStyle, maxTokens);
    // User-overridable system prompt.
    const systemPrompt = this.readSystemPromptOverride();

    // Build the request (conditionally include tools/toolChoice/sampling)
    const request: MiniMaxCompletionRequest = {
      model: model.id,
      messages: mappingResult.messages.filter((m) => m.role !== undefined),
      ...(miniMaxTools !== undefined ? { tools: miniMaxTools } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      temperature: sampler.temperature,
      topP: sampler.topP,
      topK: sampler.topK,
      maxTokens,
      stream: true,
      dialect,
      ...(thinkingConfig !== undefined ? { thinking: thinkingConfig.thinking } : {}),
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      ...(mappingResult.cacheMarkers.length > 0
        ? { cacheMarkers: mappingResult.cacheMarkers }
        : {}),
    };

    this.logger.info('Starting streaming request', {
      model: model.id,
      dialect,
      messageCount: request.messages.length,
      toolCount: tools.length,
      toolMode,
      tools: tools.map(t => t.name),
      temperature: sampler.temperature,
      topP: sampler.topP,
      topK: sampler.topK,
      maxTokens,
      thinkingEnabled: thinkingConfig !== undefined,
      cacheMarkers: mappingResult.cacheMarkers.length,
    });

    try {
      // Convert CancellationToken to AbortSignal
      const abortController = new AbortController();
      const onCancel = token.onCancellationRequested(() => abortController.abort());

      let pumpResult: Awaited<ReturnType<typeof pumpProviderStream>>;
      try {
        // T19 stream-pump extraction: every terminal-path flush,
        // thinking-vs-text routing, and usage-not-as-text invariant
        // lives in `src/providers/stream-pump.ts`. The pump is the
        // single place these rules are enforced.
        pumpResult = await pumpProviderStream({
          events: this.client.streamCompletion(
            request,
            apiKey,
            abortController.signal,
            this.logger,
          ),
          progress,
          thinkingStyle,
          logger: this.logger,
          recordToolUsage: (name) => this.recordToolUsage(name),
        });
      } finally {
        onCancel.dispose();
      }

      // Cache the thinking block if we captured one, keyed by message content hash.
      if (pumpResult.thinking && (pumpResult.text || pumpResult.toolCallIds.length > 0)) {
        const cacheKey = this.generateMessageHash(
          pumpResult.text,
          [...pumpResult.toolCallIds],
          model.id,
        );
        this.thinkingCache.set(cacheKey, pumpResult.thinking);
        this.logger.debug('Cached thinking block', {
          cacheKey,
          thinkingLength: pumpResult.thinking.thinking.length,
          hasSignature: !!pumpResult.thinking.signature,
        });
      }

      this.logger.debug('Streaming request completed', { model: model.id });
    } catch (err) {
      if (err instanceof MiniMaxClientError) {
        this.logger.error('MiniMax client error', err, { kind: err.kind, status: err.status });
        // Abandoned requests get a distinct, user-facing message:
        // the model returned a "I'll build X now" / planning turn
        // but the tool loop never executed. Telling the user to
        // retry is more useful than the generic `MiniMax API
        // error (abandoned): ...` envelope.
        if (err.kind === 'abandoned') {
          throw new Error(
            'The model started a response but its tool loop was interrupted ' +
              'before any tool calls could run. Try again — if the issue persists, ' +
              'the model may be hitting a context-window or rate-limit ceiling.',
          );
        }
        // Stalls get the same treatment: the watchdog cut a
        // connection the server left hanging (no response headers,
        // or an open stream that went silent). Silent-before-first-
        // event stalls were already retried by the transport, so by
        // the time one reaches here the server is genuinely
        // unresponsive — telling the user that beats the generic
        // envelope.
        if (err.kind === 'stall') {
          throw new Error(
            'The MiniMax server stopped responding, so the request was cut off ' +
              'instead of hanging. Try again — if this keeps happening, the ' +
              'MiniMax API is likely degraded right now.',
          );
        }
        // Network errors reaching here already spent the transport's
        // retry budget (or delivered partial content, where a retry
        // would duplicate it). The raw undici message ("terminated",
        // "fetch failed") is too cryptic to stand alone.
        if (err.kind === 'network') {
          throw new Error(
            `The connection to MiniMax dropped before the response completed (${err.message}). ` +
              'Safe retries were already attempted. Try again — if this keeps ' +
              'happening, the MiniMax API is likely degraded right now.',
          );
        }
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

    // Family-aware heuristic. M3 uses a BPE tokenizer tuned
    // closer to 3.7 chars/token for code-heavy content; M2.x
    // (OpenAI-style tokenizer) is closer to 3.5. The 4.0/3.5
    // split from before over-estimated M3 by ~10-15% and
    // made the context-window widget drift relative to the
    // model's actual usage. A real tokenizer (gpt-tokenizer
    // for M2.x, a cl100k-style BPE for M3) would be more
    // accurate; the heuristic is the next-best pure-runtime
    // approximation.
    const charsPerToken = isAnthropic ? 3.7 : 3.5;
    const estimate = Math.ceil(content.length / charsPerToken);

    return Math.max(1, estimate);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.changeEmitter.dispose();
    this.thinkingCache.clear();
    this.toolUsageStats.clear();
  }

  /**
   * Read the optional `mightyMax.systemPrompt` setting. When the
   * setting is missing or empty, the default M3 preamble is used.
   * The setting accepts a string; whitespace-only values are
   * treated as "not set" and fall back to the default.
   *
   * Defensive: when `vscode.workspace` is unavailable (e.g. in
   * the host-free test harness), falls back to the default rather
   * than throwing — the chat-provider must be safe to construct
   * and exercise in test environments.
   */
  private readSystemPromptOverride(): string {
    const ws = (vscode as { workspace?: { getConfiguration?: (s: string) => unknown } })
      .workspace;
    if (ws?.getConfiguration === undefined) {
      return ChatProvider.DEFAULT_SYSTEM_PROMPT;
    }
    const config = ws.getConfiguration('mightyMax') as { get?: (k: string) => unknown };
    const raw = config.get?.('systemPrompt');
    if (typeof raw !== 'string') return ChatProvider.DEFAULT_SYSTEM_PROMPT;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return ChatProvider.DEFAULT_SYSTEM_PROMPT;
    return raw;
  }

  /**
   * Generate a stable sha256 hash for an assistant message. The
   * VS Code chat host does not persist assistant text across
   * rounds (only the tool calls survive in the history), so the
   * cache key is keyed on (model id + tool-call id set) only.
   * The text is intentionally NOT part of the key so a round 2
   * lookup with the same tool calls (and empty text) hits the
   * round 1 entry. The previous implementation joined tool-call
   * ids with a comma; the same call set with different id ordering
   * (a `toString()` artifact) would collide. sha256 makes the key
   * stable across id-order permutations and resistant to the
   * `[object Object]` class of collision in the previous key.
   */
  private generateMessageHash(
    _text: string,
    toolCallIds: string[],
    modelId: string,
  ): string {
    const hasher = createHash('sha256');
    hasher.update(modelId);
    hasher.update('\u0000');
    for (const id of toolCallIds) {
      hasher.update(id);
      hasher.update('\u0001');
    }
    return hasher.digest('hex');
  }

  /**
   * Track tool usage for any downstream consumer that wants to
   * learn which tools the model selects most often. T21 keeps
   * the accumulator around even though the active filtering
   * path no longer reads it directly — the next iteration can
   * surface a "frequently-used tools" hint without rebuilding.
   */
  private recordToolUsage(toolName: string): void {
    const current = this.toolUsageStats.get(toolName) ?? 0;
    this.toolUsageStats.set(toolName, current + 1);
  }

  /**
   * Retrieve cached thinking block for an assistant message. Returns
   * undefined if no thinking was cached for this message.
   */
  private getCachedThinking(
    text: string,
    toolCallIds: string[],
    modelId: string,
  ): { thinking: string; signature?: string } | undefined {
    const key = this.generateMessageHash(text, toolCallIds, modelId);
    const value = this.thinkingCache.get(key);
    if (value !== undefined) {
      // Promote to most-recently-used on a hit so a hot
      // thinking block survives long agent loops.
      this.thinkingCache.touch(key);
    }
    return value;
  }

  /**
   * Enrich assistant messages with their cached thinking blocks.
   * This bridges the gap until VS Code can persist thinking blocks
   * in its own history via LanguageModelThinkingPart.
   */
  private enrichWithThinking(
    messages: ReadonlyArray<ChatMessage>,
    modelId: string,
  ): ReadonlyArray<ChatMessage> {
    return messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;

      // Extract text and tool call IDs from this message
      const textParts: string[] = [];
      const toolCallIds: string[] = [];
      for (const part of msg.content) {
        if (part.type === 'text') textParts.push(part.value);
        if (part.type === 'tool-call') toolCallIds.push(part.toolCall.callId);
      }

      // Look up cached thinking
      const cached = this.getCachedThinking(textParts.join('\n'), toolCallIds, modelId);
      if (!cached) return msg;

      // Prepend thinking part to the message content
      const thinkingPart: ChatMessageContentPart = {
        type: 'thinking',
        value: cached.thinking,
      };
      if (cached.signature) {
        (thinkingPart as { type: 'thinking'; value: string; signature?: string }).signature = cached.signature;
      }
      const enriched: ChatMessage = {
        ...msg,
        content: [thinkingPart, ...msg.content],
      };
      return enriched;
    });
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
 * MIME types Copilot Chat uses on `LanguageModelDataPart` to carry
 * provider-directed metadata rather than model-visible content. The
 * agent stamps prompt-cache breakpoints into message content —
 * including inside `LanguageModelToolResultPart` content arrays —
 * as `LanguageModelDataPart(encode("ephemeral"), "cache_control")`.
 * These must never reach the JSON-encode fallback below: stringifying
 * a data part serializes its `Uint8Array` as a `{"0":101,...}` byte
 * map, which lands in the model-visible tool output as
 * `{"mimeType":"cache_control","data":{...}}` garbage (models read
 * it as an injection attempt). The set mirrors the special-mime enum
 * in the built-in Copilot extension (cacheControl / statefulMarker /
 * thinking / contextManagement / phaseData / usage).
 */
const METADATA_DATA_PART_MIMES = new Set([
  'cache_control',
  'stateful_marker',
  'thinking',
  'context_management',
  'phase_data',
  'usage',
]);

/**
 * Recognize a `LanguageModelDataPart` structurally rather than via
 * `instanceof` — hosts and test stubs that predate the class (it
 * landed in `@types/vscode` 1.99+) and cross-realm instances all
 * still match on the `{mimeType: string, data: Uint8Array}` shape,
 * which is the only part of the contract the converter consumes.
 */
function asDataPart(c: unknown): { mimeType: string; data: Uint8Array } | undefined {
  if (
    typeof c === 'object' &&
    c !== null &&
    typeof (c as { mimeType?: unknown }).mimeType === 'string' &&
    (c as { data?: unknown }).data instanceof Uint8Array
  ) {
    return c as { mimeType: string; data: Uint8Array };
  }
  return undefined;
}

/**
 * Convert a VS Code chat message to the domain `ChatMessage` format.
 * This is a thin struct-by-struct copy that mirrors the shapes.
 */
/**
 * Convert a VS Code chat message to the domain `ChatMessage` format.
 * This is a thin struct-by-struct copy that mirrors the shapes.
 *
 * Exported for unit testing — the `tool-result` content
 * normalization (in particular, the JSON-encode fallback for
 * non-text content) is a security-relevant boundary that
 * benefits from direct regression coverage.
 */
export function vscodeToDomainMessage(msg: vscode.LanguageModelChatRequestMessage): ChatMessage {
  const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';

  const content: ChatMessageContentPart[] = [];

  // Handle content that can be string or array
  const msgContent =
    typeof msg.content === 'string' ? [new vscode.LanguageModelTextPart(msg.content)] : msg.content;

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
      // Convert tool result content to the domain format.
      // This helper is a free function (not a class method), so
      // we keep it pure: no `this.logger`, no `console.warn`.
      // The marker string on the JSON.stringify failure path is
      // itself the diagnostic — it appears in the model's
      // context and on the wire payload if a user wants to find
      // unserializable tool results.
      const resultContent: string[] = [];
      for (const c of part.content) {
        if (c instanceof vscode.LanguageModelTextPart) {
          resultContent.push(c.value);
          continue;
        }
        const dataPart = asDataPart(c);
        if (dataPart !== undefined) {
          // Provider-directed metadata (cache breakpoints etc.) is
          // consumed here, never forwarded: mightymax computes its
          // own `cacheMarkers` in the domain mapper, so the host's
          // breakpoint hints are redundant on this wire.
          if (METADATA_DATA_PART_MIMES.has(dataPart.mimeType)) continue;
          // Textual payloads (text/*, application/json, *+json) are
          // real tool output — decode the bytes instead of
          // stringifying the Uint8Array into a byte map.
          const mime = dataPart.mimeType.toLowerCase();
          if (
            mime.startsWith('text/') ||
            mime === 'application/json' ||
            mime.endsWith('+json')
          ) {
            resultContent.push(new TextDecoder().decode(dataPart.data));
            continue;
          }
          // Binary payloads (images etc.) cannot ride the
          // string-only tool-result wire; a short marker keeps the
          // omission visible without dumping bytes into context.
          resultContent.push(
            `[tool result data omitted: ${dataPart.mimeType}, ${dataPart.data.byteLength} bytes]`,
          );
          continue;
        }
        // Other content types would be handled here. We
        // JSON-encode the payload so the model sees a primitive
        // string on the wire. `String(c)` on a structured object
        // produces the literal `[object Object]`, which leaks
        // into the model's context as garbage and is the most
        // common source of the `[object Object]` strings that
        // appear in chat transcripts when a tool returns a
        // non-text payload. Mirrors the defensive
        // `JSON.stringify` in the message mapper boundary at
        // `src/lib/domain/messages.ts:mapRequestToMiniMax`.
        try {
          resultContent.push(JSON.stringify(c));
        } catch {
          // Circular reference or BigInt or similar
          // unserializable value. Fall back to a marker the
          // model can see so the turn doesn't silently lose the
          // tool result. The marker includes the constructor
          // name (e.g. "Object", "Map") so a user inspecting
          // the wire payload can identify the offending type.
          const ctor = (c as { constructor?: { name?: string } })?.constructor?.name ?? typeof c;
          resultContent.push(`[unserializable tool result content: ${ctor}]`);
        }
      }
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
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema as { readonly [key: string]: unknown } }
      : {}),
  };
}

/**
 * Extract text content from a chat message for token counting.
 */
function extractMessageText(msg: vscode.LanguageModelChatRequestMessage): string {
  const msgContent =
    typeof msg.content === 'string' ? [new vscode.LanguageModelTextPart(msg.content)] : msg.content;

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

// ─────────────────────────────────────────────────────────────────────────────
// T19 stream-loop helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * T21: read the smart-tool-filtering config from VS Code
 * settings with the new honest defaults.
 */
function readToolFilterConfig(): ToolFilterConfig {
  type ConfigReader = {
    get?: <T>(k: string, d?: T) => T;
  };
  const ws = (vscode as { workspace?: { getConfiguration?: (s: string) => unknown } })
    .workspace;
  if (ws?.getConfiguration === undefined) {
    return {
      enableSmartToolFiltering: true,
      maxTools: 64,
      alwaysIncludeTools: [],
    };
  }
  const config = ws.getConfiguration('mightyMax') as ConfigReader;
  return {
    enableSmartToolFiltering:
      config.get?.<boolean>('enableSmartToolFiltering', true) ?? true,
    maxTools: config.get?.<number>('maxTools', 64) ?? 64,
    alwaysIncludeTools:
      config.get?.<string[]>('alwaysIncludeTools', [
        'copilot_',
        'run_in_terminal',
        'apply_patch',
        'grep_search',
        'file_search',
        'semantic_search',
      ]) ?? [],
  };
}

/**
 * T21: collect the names of tools already referenced by the
 * request's history. `LanguageModelToolCallPart` carries the
 * tool name; `LanguageModelToolResultPart` carries the call id
 * but not the name (the name lives on the prior assistant
 * turn's `tool_call`). We walk the history and union every
 * `tool_call` name; tool results are intentionally skipped
 * here because their name is already in the set via the prior
 * tool-call entry. A tool that is in flight on the current
 * turn cannot be silently dropped by the filter — the model
 * expects to see the result on the next turn.
 */
function collectHistoryReferencedToolNames(
  msgs: ReadonlyArray<vscode.LanguageModelChatRequestMessage>,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const m of msgs) {
    const parts =
      typeof m.content === 'string'
        ? [new vscode.LanguageModelTextPart(m.content)]
        : m.content;
    for (const p of parts) {
      if (p instanceof vscode.LanguageModelToolCallPart) {
        if (p.name.length > 0) names.add(p.name);
      }
    }
  }
  return Array.from(names);
}
