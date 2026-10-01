/**
 * GenerateImageToolAdapter — registers `mightyMax_generateImage`
 * with VS Code's LM host.
 *
 * T36 sibling to `generate-video-tool-adapter.ts`, minus the poll
 * loop: image generation is synchronous, so the pipeline is
 * generate → persist, and there is no timeout knob.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { MediaArtifactStore } from '../ports/media-artifact-store.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import {
  MIGHTYMAX_GENERATE_IMAGE_TOOL,
  buildGenerateImageDescriptor,
  renderGenerateImageToolError,
  renderGenerateImageToolResult,
  validateImageToolInput,
} from '../lib/domain/image-tool.js';
import { IMAGE_ASPECT_DIMENSIONS, type ImageResult } from '../lib/domain/image.js';
import { ImageGenerationError } from './image-01-adapter.js';

export interface GenerateImageToolConfig {
  /** Whether the tool is allowed to run from the chat model. */
  getToolEnabled(): boolean;
}

export interface GenerateImageToolAdapterDeps {
  readonly logger: Logger;
  readonly keyProvider: KeyProvider;
  readonly imageGenerator: ImageGenerator;
  readonly mediaStore: MediaArtifactStore;
  readonly config: GenerateImageToolConfig;
}

/**
 * Run the generate → persist pipeline. Returns the saved artifacts
 * or throws an `Error` whose message is suitable for the chat model.
 */
export async function runGenerateImagePipeline(
  rawInput: unknown,
  deps: GenerateImageToolAdapterDeps,
  signal: AbortSignal,
): Promise<ImageResult> {
  const validation = validateImageToolInput(rawInput);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const req = validation.normalized;

  const pick = await deps.keyProvider.pickKey();
  if (pick === undefined) {
    throw new Error(
      'No MiniMax API key configured. Run "Mighty Max: Manage" and set a key before invoking image generation.',
    );
  }

  let images;
  try {
    images = await deps.imageGenerator.generate(req, pick.key, signal);
  } catch (err) {
    throw translateError(err);
  }

  const absolutePaths: string[] = [];
  let totalSizeBytes = 0;
  for (const image of images) {
    const ref = await deps.mediaStore.write(image.bytes, {
      extension: 'png',
      mime: image.mime,
      prefix: 'image01',
    });
    absolutePaths.push(ref.absolutePath);
    totalSizeBytes += ref.sizeBytes;
  }

  return {
    model: 'image-01',
    prompt: req.prompt,
    aspectRatio: req.aspectRatio,
    absolutePaths,
    totalSizeBytes,
    mime: images[0]?.mime ?? 'image/png',
  };
}

function translateError(err: unknown): Error {
  if (err instanceof ImageGenerationError) {
    return new Error(renderGenerateImageToolError(err.kind, err.message));
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function asToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/** Register `mightyMax_generateImage` with VS Code's LM host. */
export function registerGenerateImageTool(deps: GenerateImageToolAdapterDeps): vscode.Disposable {
  const descriptor = buildGenerateImageDescriptor();
  const tool: vscode.LanguageModelTool<Record<string, unknown>> = {
    prepareInvocation: (
      options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
      _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> => {
      if (!deps.config.getToolEnabled()) {
        throw new Error(
          'mightyMax_generateImage is disabled by the mightyMax.allowImageToolInChat setting',
        );
      }
      const input = options.input;
      const model = typeof input['model'] === 'string' ? input['model'] : 'image-01';
      const ratio = typeof input['aspectRatio'] === 'string' ? input['aspectRatio'] : '1:1';
      const count = typeof input['count'] === 'number' ? input['count'] : 1;
      const dims = IMAGE_ASPECT_DIMENSIONS[ratio as keyof typeof IMAGE_ASPECT_DIMENSIONS];
      return {
        confirmationMessages: {
          title: `Generate ${String(count)} ${model} image(s)`,
          message: `Mighty Max will submit a synchronous image generation request to MiniMax (${dims ?? ratio}).`,
        },
        invocationMessage: `Generating ${dims ?? ratio} image…`,
      };
    },
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
      token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> => {
      const ac = new AbortController();
      const onCancel = token.onCancellationRequested(() => ac.abort());
      try {
        const result = await runGenerateImagePipeline(options.input, deps, ac.signal);
        deps.logger.info('mightyMax_generateImage succeeded', {
          count: result.absolutePaths.length,
          aspectRatio: result.aspectRatio,
          totalSizeBytes: result.totalSizeBytes,
        });
        return asToolResult(renderGenerateImageToolResult(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger.warn('mightyMax_generateImage failed', { error: message });
        return asToolResult(`mightyMax_generateImage failed: ${message}`);
      } finally {
        onCancel.dispose();
      }
    },
  };
  return vscode.lm.registerTool(descriptor.name, tool);
}

export { MIGHTYMAX_GENERATE_IMAGE_TOOL };
