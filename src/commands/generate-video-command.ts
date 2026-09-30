/**
 * `mightyMax.generateVideo` — command palette entry for the
 * Hailuo-03 / H3 video generation pipeline.
 *
 * T36 — same pipeline as `mightyMax_generateVideo` but with a
 * QuickPick + InputBox flow instead of the chat host invoking
 * the tool. The user picks a model, picks a duration, types a
 * prompt, then we submit / poll / download / save. On success we
 * surface a notification with "Open" / "Reveal" / "Copy path"
 * actions so the user can land directly in their video player or
 * shell.
 *
 * Pattern mirrors `src/commands/show-usage.ts` (returns a
 * Disposable; pure UI / persistence wiring; the actual pipeline
 * lives in `runGenerateVideoPipeline` from the tool adapter).
 */

import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { MediaArtifactStore } from '../ports/media-artifact-store.js';
import type { VideoGenerator } from '../ports/video-generator.js';
import { SUPPORTED_VIDEO_MODELS, validateVideoToolInput } from '../lib/domain/video-tool.js';
import { VIDEO_CAPABILITIES, evaluateVideoCapability } from '../lib/domain/media-capability.js';
import { renderVideoNotificationBody } from '../lib/domain/media.js';
import { runGenerateVideoPipeline } from '../adapters/generate-video-tool-adapter.js';
import type { GenerateVideoToolConfig } from '../adapters/generate-video-tool-adapter.js';

export interface GenerateVideoCommandUi {
  showQuickPick<T extends vscode.QuickPickItem>(
    items: ReadonlyArray<T>,
    options?: {
      title?: string;
      placeHolder?: string;
      canPickMany?: boolean;
      ignoreFocusOut?: boolean;
    },
  ): Promise<T | undefined>;
  showInputBox(options: {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    value?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInformationMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  showErrorMessage(message: string, ...actions: string[]): Promise<string | undefined>;
  openExternal(uri: vscode.Uri): Promise<void>;
  revealFile(uri: vscode.Uri): Promise<void>;
}

export interface GenerateVideoCommandDeps {
  readonly logger: Logger;
  readonly keyProvider: KeyProvider;
  readonly videoGenerator: VideoGenerator;
  readonly mediaStore: MediaArtifactStore;
  readonly ui: GenerateVideoCommandUi;
  readonly config: GenerateVideoToolConfig;
}

/** Run the command end-to-end. Returns `true` when a video was generated. */
export async function runGenerateVideoCommand(deps: GenerateVideoCommandDeps): Promise<boolean> {
  // 1) Pick a model.
  const modelItems: vscode.QuickPickItem[] = SUPPORTED_VIDEO_MODELS.map((id) => {
    const cap = VIDEO_CAPABILITIES[id];
    return {
      label: cap.displayName,
      description: id,
      detail: cap.description,
    };
  });
  const modelPick = await deps.ui.showQuickPick(modelItems, {
    title: 'Mighty Max: Generate Video',
    placeHolder: 'Select a video model',
  });
  if (modelPick === undefined) return false;
  const modelId = modelPick.description;
  if (modelId !== 'MiniMax-H3' && modelId !== 'MiniMax-H3-Max') return false;
  const capability = evaluateVideoCapability(modelId);
  if (!capability.ok) {
    await deps.ui.showErrorMessage(`Unknown video model: ${modelId}`);
    return false;
  }

  // 2) Pick a duration.
  const durationItems: vscode.QuickPickItem[] = capability.capability.allowedDurations.map((d) => ({
    label: `${d}s`,
    description: `${d} seconds`,
  }));
  const durationPick = await deps.ui.showQuickPick(durationItems, {
    title: 'Mighty Max: Generate Video',
    placeHolder: 'Select duration',
  });
  if (durationPick === undefined) return false;
  const durationSec = Number(durationPick.label.replace(/s$/, ''));
  if (durationSec !== 6 && durationSec !== 10) return false;

  // 3) Prompt for the description.
  const prompt = await deps.ui.showInputBox({
    title: `Mighty Max: ${durationSec}s ${modelId}`,
    prompt: 'Describe the video',
    placeHolder: 'A giant turtle swimming through a coral reef at sunrise',
  });
  if (prompt === undefined || prompt.trim() === '') return false;

  // 4) Validate the assembled input.
  const rawInput = { model: modelId, prompt, durationSec };
  const validation = validateVideoToolInput(rawInput);
  if (!validation.ok) {
    await deps.ui.showErrorMessage(`Invalid video request: ${validation.error}`);
    return false;
  }

  // 5) Run the pipeline.
  deps.logger.info('Mighty Max generate-video command started', {
    model: modelId,
    durationSec,
  });
  const ac = new AbortController();
  let result;
  try {
    result = await runGenerateVideoPipeline(rawInput, deps, ac.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn('Mighty Max generate-video command failed', { error: message });
    await deps.ui.showErrorMessage(`Video generation failed: ${message}`);
    return false;
  }

  // 6) Surface the success notification with three actions.
  const body = renderVideoNotificationBody(result);
  const picked = await deps.ui.showInformationMessage(body, 'Open', 'Reveal', 'Copy path');
  const uri = vscode.Uri.file(result.absolutePath);
  if (picked === 'Open') {
    await deps.ui.openExternal(uri);
  } else if (picked === 'Reveal') {
    await deps.ui.revealFile(uri);
  } else if (picked === 'Copy path') {
    await vscode.env.clipboard.writeText(result.absolutePath);
  }
  return true;
}
