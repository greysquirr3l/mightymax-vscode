/**
 * GenerateVideoToolAdapter — registers `mightyMax_generateVideo`
 * with VS Code's LM host.
 *
 * T36 — the chat model can call this tool during any agent turn.
 * The `invoke` handler drives submit → poll → download via the
 * `VideoGenerator` port, saves the resulting video through the
 * `MediaArtifactStore` port, and returns a single-part
 * `LanguageModelToolResult` describing the saved path (mirrors the
 * T35 `minimax_subagent` single-box pattern).
 *
 * Pattern follows `src/adapters/subagent-tool-adapter.ts` and
 * `src/adapters/mcp-search-adapter.ts`: descriptor is pure
 * (lives in `src/lib/domain/video-tool.ts`); the adapter adds
 * the I/O layer that calls the real services.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { MediaArtifactStore } from '../ports/media-artifact-store.js';
import type { VideoGenerator } from '../ports/video-generator.js';
import {
  MIGHTYMAX_GENERATE_VIDEO_TOOL,
  buildGenerateVideoDescriptor,
  renderGenerateVideoToolError,
  renderGenerateVideoToolResult,
  validateVideoToolInput,
} from '../lib/domain/video-tool.js';
import type { VideoResult } from '../lib/domain/media.js';
import { HailuoVideoError } from './hailuo-video-adapter.js';

/** Read-only config seam for the adapter. */
export interface GenerateVideoToolConfig {
  /** Returns the polling interval in milliseconds (clamped by the caller). */
  getPollIntervalMs(): number;
  /** Returns the total timeout in milliseconds (clamped by the caller). */
  getTimeoutMs(): number;
  /** Returns the default file extension / mime for the saved artifact. */
  getFileExtension(): 'mp4';
  /** Whether the tool is allowed to run from the chat model. */
  getToolEnabled(): boolean;
}

export interface GenerateVideoToolAdapterDeps {
  readonly logger: Logger;
  readonly keyProvider: KeyProvider;
  readonly videoGenerator: VideoGenerator;
  readonly mediaStore: MediaArtifactStore;
  readonly config: GenerateVideoToolConfig;
}

/**
 * Run the submit → poll → download → save pipeline.
 *
 * Returns the saved artifact or throws an `Error` whose message is
 * suitable for the chat model (typed error codes from
 * `HailuoVideoError` are translated to plain strings so the model
 * never sees internal type names).
 */
export async function runGenerateVideoPipeline(
  rawInput: unknown,
  deps: GenerateVideoToolAdapterDeps,
  signal: AbortSignal,
): Promise<VideoResult> {
  const validation = validateVideoToolInput(rawInput);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const request = validation.normalized;

  const pick = await deps.keyProvider.pickKey();
  if (pick === undefined) {
    throw new Error(
      'No MiniMax API key configured. Run "Mighty Max: Manage" and set a key before invoking video generation.',
    );
  }

  // Submit.
  let handle: { taskId: string; model: typeof request.model };
  try {
    handle = await deps.videoGenerator.submitTask(request, pick.key, signal);
  } catch (err) {
    throw translateAdapterError(err);
  }

  // Poll until success or fail.
  const started = Date.now();
  const timeoutMs = deps.config.getTimeoutMs();
  while (true) {
    if (signal.aborted) {
      throw new Error('video generation cancelled by user');
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`video generation timed out after ${timeoutMs}ms (task ${handle.taskId})`);
    }
    let state;
    try {
      state = await deps.videoGenerator.pollStatus(handle.taskId, pick.key, signal);
    } catch (err) {
      throw translateAdapterError(err);
    }
    if (state.kind === 'success') break;
    if (state.kind === 'fail') {
      throw new Error(renderGenerateVideoToolError(state.errorCode, state.errorMessage));
    }
    await sleep(deps.config.getPollIntervalMs(), signal);
  }

  // Download + save.
  let bytes;
  try {
    bytes = await deps.videoGenerator.downloadResult(handle.taskId, pick.key, signal);
  } catch (err) {
    throw translateAdapterError(err);
  }
  const ref = await deps.mediaStore.write(bytes.bytes, {
    extension: deps.config.getFileExtension(),
    mime: bytes.mime,
    prefix: handle.model === 'MiniMax-H3-Max' ? 'h3max' : 'h3',
  });
  return {
    model: handle.model,
    durationSec: request.durationSec,
    taskId: handle.taskId,
    absolutePath: ref.absolutePath,
    sizeBytes: ref.sizeBytes,
    mime: ref.mime,
  };
}

function translateAdapterError(err: unknown): Error {
  if (err instanceof HailuoVideoError) {
    return new Error(renderGenerateVideoToolError(err.kind, err.message));
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Build a `LanguageModelToolResult` from a single rendered text. */
function asToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Register the `mightyMax_generateVideo` tool with VS Code's LM
 * host. The returned disposable unregisters on extension
 * deactivation.
 */
export function registerGenerateVideoTool(deps: GenerateVideoToolAdapterDeps): vscode.Disposable {
  const descriptor = buildGenerateVideoDescriptor();
  const tool: vscode.LanguageModelTool<Record<string, unknown>> = {
    prepareInvocation: (
      options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
      _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> => {
      if (!deps.config.getToolEnabled()) {
        throw new Error(
          'mightyMax_generateVideo is disabled by the mightyMax.allowVideoToolInChat setting',
        );
      }
      const input = options.input;
      const model = typeof input['model'] === 'string' ? input['model'] : 'MiniMax-H3';
      const dur = typeof input['durationSec'] === 'number' ? input['durationSec'] : 6;
      return {
        confirmationMessages: {
          title: `Generate ${dur}s ${model} video`,
          message:
            'Mighty Max will submit a video generation task to MiniMax and poll until completion.',
        },
        invocationMessage: `Generating ${dur}s ${model} video…`,
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
      token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> => {
      const ac = new AbortController();
      const onCancel = token.onCancellationRequested(() => ac.abort());
      try {
        const result = await runGenerateVideoPipeline(options.input, deps, ac.signal);
        deps.logger.info('mightyMax_generateVideo succeeded', {
          model: result.model,
          durationSec: result.durationSec,
          path: result.absolutePath,
          sizeBytes: result.sizeBytes,
        });
        return asToolResult(renderGenerateVideoToolResult(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn('mightyMax_generateVideo failed', { error: message });
        // Re-throwing lets the chat host surface the error to the
        // model with the standard "tool failed" rendering. We still
        // return a single-part result so the chat widget keeps its
        // single-box layout.
        return asToolResult(`mightyMax_generateVideo failed: ${message}`);
      } finally {
        onCancel.dispose();
      }
    },
  };
  return vscode.lm.registerTool(descriptor.name, tool);
}

export { MIGHTYMAX_GENERATE_VIDEO_TOOL };
