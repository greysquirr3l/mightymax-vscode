/**
 * Unit tests for the `mightyMax.generateVideo` command flow.
 *
 * Uses a fake UI surface so the suite never pops QuickPicks. The
 * pipeline is exercised through the fake `VideoGenerator` /
 * `MediaArtifactStore` so we never touch the network or the
 * filesystem.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';

import { runGenerateVideoCommand } from './generate-video-command.js';
import type { GenerateVideoCommandDeps, GenerateVideoCommandUi } from './generate-video-command.js';
import type {
  MediaArtifactRef,
  MediaArtifactStore,
  MediaArtifactWriteHint,
} from '../ports/media-artifact-store.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { VideoGenerator } from '../ports/video-generator.js';
import type { Logger } from '../ports/logger.js';
import type {
  VideoBytes,
  VideoModelId,
  VideoRequest,
  VideoTaskState,
} from '../lib/domain/media.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

class FakeUi implements GenerateVideoCommandUi {
  quickPickResponses: Array<vscode.QuickPickItem | undefined> = [];
  inputBoxResponses: Array<string | undefined> = [];
  infoPickQueue: Array<string | undefined> = [];
  infoMessages: Array<{ message: string; picked?: string }> = [];
  errorMessages: Array<{ message: string; picked?: string }> = [];
  openExternalCalls: vscode.Uri[] = [];
  revealCalls: vscode.Uri[] = [];

  setQuickPickSequence(items: Array<vscode.QuickPickItem | undefined>): void {
    this.quickPickResponses = [...items];
  }

  setInputBoxSequence(items: Array<string | undefined>): void {
    this.inputBoxResponses = [...items];
  }

  setInfoPickSequence(items: Array<string | undefined>): void {
    this.infoPickQueue = [...items];
  }

  async showQuickPick<T extends vscode.QuickPickItem>(
    _items: ReadonlyArray<T>,
  ): Promise<T | undefined> {
    return this.quickPickResponses.shift() as T | undefined;
  }

  async showInputBox(): Promise<string | undefined> {
    return this.inputBoxResponses.shift();
  }

  async showInformationMessage(
    message: string,
    ..._actions: string[]
  ): Promise<string | undefined> {
    const picked = this.infoPickQueue.shift();
    this.infoMessages.push({ message, ...(picked !== undefined ? { picked } : {}) });
    return picked;
  }

  async showErrorMessage(message: string): Promise<string | undefined> {
    this.errorMessages.push({ message });
    return undefined;
  }

  async openExternal(uri: vscode.Uri): Promise<void> {
    this.openExternalCalls.push(uri);
  }

  async revealFile(uri: vscode.Uri): Promise<void> {
    this.revealCalls.push(uri);
  }
}

class FakeKeyProvider implements Pick<KeyProvider, 'pickKey'> {
  constructor(private readonly key: string | undefined) {}
  async pickKey(): Promise<{ slot: 1 | 2 | 3; key: string; fellBack: boolean } | undefined> {
    return this.key === undefined ? undefined : { slot: 1, key: this.key, fellBack: false };
  }
}

class FakeVideoGenerator implements VideoGenerator {
  pollCalls = 0;
  async submitTask(request: VideoRequest): Promise<{ taskId: string; model: VideoModelId }> {
    return { taskId: 'task-cmd-1', model: request.model };
  }
  async pollStatus(): Promise<VideoTaskState> {
    this.pollCalls++;
    if (this.pollCalls < 2) return { kind: 'pending', taskId: 'task-cmd-1' };
    return { kind: 'success', taskId: 'task-cmd-1' };
  }
  async downloadResult(): Promise<VideoBytes> {
    return { bytes: new Uint8Array([9, 9, 9, 9, 9]), mime: 'video/mp4' };
  }
}

class FakeMediaStore implements MediaArtifactStore {
  writes = 0;
  defaultDirectory(): string {
    return '/tmp/media';
  }
  async write(bytes: Uint8Array, hint: MediaArtifactWriteHint): Promise<MediaArtifactRef> {
    this.writes++;
    return {
      absolutePath: `/tmp/media/saved-${this.writes}.${hint.extension}`,
      sizeBytes: bytes.byteLength,
      mime: hint.mime ?? 'video/mp4',
    };
  }
}

function makeDeps(overrides: Partial<GenerateVideoCommandDeps> = {}): {
  deps: GenerateVideoCommandDeps;
  ui: FakeUi;
  generator: FakeVideoGenerator;
  store: FakeMediaStore;
} {
  const ui = new FakeUi();
  const generator = new FakeVideoGenerator();
  const store = new FakeMediaStore();
  const deps: GenerateVideoCommandDeps = {
    logger: silentLogger(),
    keyProvider: new FakeKeyProvider('sk-test') as unknown as KeyProvider,
    videoGenerator: generator,
    mediaStore: store,
    ui,
    config: {
      getPollIntervalMs: () => 5,
      getTimeoutMs: () => 60_000,
      getFileExtension: () => 'mp4',
      getToolEnabled: () => true,
    },
    ...overrides,
  };
  return { deps, ui, generator, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// runGenerateVideoCommand
// ─────────────────────────────────────────────────────────────────────────────

describe('runGenerateVideoCommand', () => {
  it('returns false when the user cancels the model picker', async () => {
    const { deps, ui } = makeDeps();
    ui.setQuickPickSequence([undefined]); // user dismissed
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, false);
    assert.equal(ui.errorMessages.length, 0);
  });

  it('returns false when the user cancels the duration picker', async () => {
    const { deps, ui } = makeDeps();
    ui.setQuickPickSequence([{ label: 'Hailuo-03 (H3)', description: 'MiniMax-H3' }, undefined]);
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, false);
  });

  it('returns false when the prompt is empty / cancelled', async () => {
    const { deps, ui } = makeDeps();
    ui.setQuickPickSequence([
      { label: 'Hailuo-03 (H3)', description: 'MiniMax-H3' },
      { label: '6s', description: '6 seconds' },
    ]);
    ui.setInputBoxSequence([undefined]); // user dismissed
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, false);
  });

  it('returns false when the prompt is whitespace', async () => {
    const { deps, ui } = makeDeps();
    ui.setQuickPickSequence([
      { label: 'Hailuo-03 (H3)', description: 'MiniMax-H3' },
      { label: '6s', description: '6 seconds' },
    ]);
    ui.setInputBoxSequence(['   ']);
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, false);
  });

  it('runs the full pipeline and opens the file when the user picks "Open"', async () => {
    const { deps, ui, store } = makeDeps();
    ui.setQuickPickSequence([
      { label: 'Hailuo-03 (H3)', description: 'MiniMax-H3' },
      { label: '6s', description: '6 seconds' },
    ]);
    ui.setInputBoxSequence(['a giant turtle']);
    ui.setInfoPickSequence(['Open']);
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, true);
    assert.equal(store.writes, 1);
    assert.equal(ui.openExternalCalls.length, 1);
    assert.match(ui.openExternalCalls[0]!.fsPath, /saved-1\.mp4$/);
  });

  it('runs the full pipeline and reveals the file when the user picks "Reveal"', async () => {
    const { deps, ui } = makeDeps();
    ui.setQuickPickSequence([
      { label: 'Hailuo-03 Max (H3-Max)', description: 'MiniMax-H3-Max' },
      { label: '10s', description: '10 seconds' },
    ]);
    ui.setInputBoxSequence(['a turtle with a hat']);
    ui.setInfoPickSequence(['Reveal']);
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, true);
    assert.equal(ui.openExternalCalls.length, 0);
    assert.equal(ui.revealCalls.length, 1);
    assert.match(ui.revealCalls[0]!.fsPath, /saved-1\.mp4$/);
  });

  it('returns false and surfaces an error when no API key is stored', async () => {
    const { deps, ui } = makeDeps({
      keyProvider: new FakeKeyProvider(undefined) as unknown as KeyProvider,
    });
    ui.setQuickPickSequence([
      { label: 'Hailuo-03 (H3)', description: 'MiniMax-H3' },
      { label: '6s', description: '6 seconds' },
    ]);
    ui.setInputBoxSequence(['a turtle']);
    const ran = await runGenerateVideoCommand(deps);
    assert.equal(ran, false);
    assert.equal(ui.errorMessages.length, 1);
    assert.match(ui.errorMessages[0]!.message, /API key/);
  });
});
