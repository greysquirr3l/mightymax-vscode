/**
 * `mightyMax.generateImage` — command palette entry for MiniMax
 * image-01 generation.
 *
 * T36 sibling to `generate-video-command.ts`. Same shape, fewer
 * questions: image generation is synchronous and takes no duration
 * or reference inputs, so the flow is pick shape → prompt → run.
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { MediaArtifactStore } from '../ports/media-artifact-store.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import {
  IMAGE_ASPECT_DIMENSIONS,
  IMAGE_ASPECT_RATIOS,
  renderImageNotificationBody,
  type ImageAspectRatio,
} from '../lib/domain/image.js';
import { validateImageToolInput } from '../lib/domain/image-tool.js';
import {
  runGenerateImagePipeline,
  type GenerateImageToolConfig,
} from '../adapters/generate-image-tool-adapter.js';

export interface GenerateImageCommandUi {
  showQuickPick<T extends vscode.QuickPickItem>(
    items: ReadonlyArray<T>,
    options?: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean },
  ): Promise<T | undefined>;
  showInputBox(options: {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  openExternal(uri: vscode.Uri): Promise<void>;
  revealFile(uri: vscode.Uri): Promise<void>;
}

export interface GenerateImageCommandDeps {
  readonly logger: Logger;
  readonly keyProvider: KeyProvider;
  readonly imageGenerator: ImageGenerator;
  readonly mediaStore: MediaArtifactStore;
  readonly ui: GenerateImageCommandUi;
  readonly config: GenerateImageToolConfig;
}

export async function runGenerateImageCommand(deps: GenerateImageCommandDeps): Promise<boolean> {
  // 1) Pick the aspect ratio.
  const ratioItems: vscode.QuickPickItem[] = IMAGE_ASPECT_RATIOS.map((r) => ({
    label: r,
    description: IMAGE_ASPECT_DIMENSIONS[r],
  }));
  const ratioPick = await deps.ui.showQuickPick(ratioItems, {
    title: 'Mighty Max: Generate Image',
    placeHolder: 'Select an aspect ratio',
  });
  if (ratioPick === undefined) return false;
  const aspectRatio = ratioPick.label as ImageAspectRatio;
  if (!IMAGE_ASPECT_RATIOS.includes(aspectRatio)) return false;

  // 2) Prompt for the description.
  const prompt = await deps.ui.showInputBox({
    title: `Mighty Max: image-01 (${aspectRatio})`,
    prompt: 'Describe the image',
    placeHolder: 'A neon-lit crab holding a typewriter on a rain-slicked pier',
  });
  if (prompt === undefined || prompt.trim() === '') return false;

  // 3) Validate.
  const rawInput = { model: 'image-01', prompt, aspectRatio };
  const validation = validateImageToolInput(rawInput);
  if (!validation.ok) {
    await deps.ui.showErrorMessage(`Invalid image request: ${validation.error}`);
    return false;
  }

  // 4) Run.
  deps.logger.info('Mighty Max generate-image command started', { aspectRatio });
  const ac = new AbortController();
  let result;
  try {
    result = await runGenerateImagePipeline(rawInput, deps, ac.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn('Mighty Max generate-image command failed', { error: message });
    await deps.ui.showErrorMessage(`Image generation failed: ${message}`);
    return false;
  }

  // 5) Notify.
  const body = renderImageNotificationBody(result);
  const picked = await deps.ui.showInformationMessage(body, 'Open', 'Reveal', 'Copy path');
  const first = result.absolutePaths[0];
  if (first === undefined) return true;
  const uri = vscode.Uri.file(first);
  if (picked === 'Open') {
    await deps.ui.openExternal(uri);
  } else if (picked === 'Reveal') {
    await deps.ui.revealFile(uri);
  } else if (picked === 'Copy path') {
    await vscode.env.clipboard.writeText(result.absolutePaths.join('\n'));
  }
  return true;
}
