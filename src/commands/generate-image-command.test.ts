/**
 * Unit tests for the `mightyMax.generateImage` command flow.
 * Fake UI + fake generator + fake store — no popups, no network,
 * no filesystem.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';

import { runGenerateImageCommand } from './generate-image-command.js';
import type { GenerateImageCommandDeps, GenerateImageCommandUi } from './generate-image-command.js';
import type {
  MediaArtifactRef,
  MediaArtifactStore,
  MediaArtifactWriteHint,
} from '../ports/media-artifact-store.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import type { Logger } from '../ports/logger.js';
import type { ImageBytes, ImageRequest } from '../lib/domain/image.js';

function logger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

class FakeUi implements GenerateImageCommandUi {
  picks: Array<vscode.QuickPickItem | undefined> = [];
  inputs: Array<string | undefined> = [];
  infoQueue: Array<string | undefined> = [];
  infos: string[] = [];
  errors: string[] = [];
  opened: vscode.Uri[] = [];
  revealed: vscode.Uri[] = [];

  async showQuickPick<T extends vscode.QuickPickItem>(): Promise<T | undefined> {
    return this.picks.shift() as T | undefined;
  }
  async showInputBox(): Promise<string | undefined> {
    return this.inputs.shift();
  }
  async showInformationMessage(message: string): Promise<string | undefined> {
    this.infos.push(message);
    return this.infoQueue.shift();
  }
  async showErrorMessage(message: string): Promise<string | undefined> {
    this.errors.push(message);
    return undefined;
  }
  async openExternal(uri: vscode.Uri): Promise<void> {
    this.opened.push(uri);
  }
  async revealFile(uri: vscode.Uri): Promise<void> {
    this.revealed.push(uri);
  }
}

class FakeGen implements ImageGenerator {
  async generate(_r: ImageRequest): Promise<ImageBytes[]> {
    return [{ bytes: new Uint8Array([1, 2]), mime: 'image/png' }];
  }
}

class FakeStore implements MediaArtifactStore {
  n = 0;
  defaultDirectory(): string {
    return '/tmp/media';
  }
  async write(_b: Uint8Array, h: MediaArtifactWriteHint): Promise<MediaArtifactRef> {
    this.n++;
    return {
      absolutePath: `/tmp/media/image01-${this.n}.${h.extension}`,
      sizeBytes: 2,
      mime: h.mime ?? 'image/png',
    };
  }
}

class FakeKeys implements Pick<KeyProvider, 'pickKey'> {
  constructor(private readonly key: string | undefined) {}
  async pickKey(): Promise<{ slot: 1 | 2 | 3; key: string; fellBack: boolean } | undefined> {
    return this.key === undefined ? undefined : { slot: 1, key: this.key, fellBack: false };
  }
}

function make(over: Partial<GenerateImageCommandDeps> = {}): {
  d: GenerateImageCommandDeps;
  ui: FakeUi;
} {
  const ui = new FakeUi();
  const d: GenerateImageCommandDeps = {
    logger: logger(),
    keyProvider: new FakeKeys('sk-test') as unknown as KeyProvider,
    imageGenerator: new FakeGen(),
    mediaStore: new FakeStore(),
    ui,
    config: { getToolEnabled: () => true },
    ...over,
  };
  return { d, ui };
}

describe('runGenerateImageCommand', () => {
  it('returns false when the aspect-ratio picker is dismissed', async () => {
    const { d, ui } = make();
    ui.picks = [undefined];
    assert.equal(await runGenerateImageCommand(d), false);
  });

  it('returns false when the prompt is dismissed', async () => {
    const { d, ui } = make();
    ui.picks = [{ label: '16:9', description: '1280x720' }];
    ui.inputs = [undefined];
    assert.equal(await runGenerateImageCommand(d), false);
  });

  it('returns false when the prompt is whitespace', async () => {
    const { d, ui } = make();
    ui.picks = [{ label: '1:1', description: '1024x1024' }];
    ui.inputs = ['  '];
    assert.equal(await runGenerateImageCommand(d), false);
  });

  it('runs the pipeline and opens the artifact on "Open"', async () => {
    const { d, ui } = make();
    ui.picks = [{ label: '16:9', description: '1280x720' }];
    ui.inputs = ['a neon crab'];
    ui.infoQueue = ['Open'];
    assert.equal(await runGenerateImageCommand(d), true);
    assert.equal(ui.errors.length, 0);
    assert.equal(ui.opened.length, 1);
    assert.match(ui.opened[0]?.fsPath ?? '', /image01-1\.png$/);
  });

  it('reveals on "Reveal"', async () => {
    const { d, ui } = make();
    ui.picks = [{ label: '9:16', description: '720x1280' }];
    ui.inputs = ['a lighthouse'];
    ui.infoQueue = ['Reveal'];
    assert.equal(await runGenerateImageCommand(d), true);
    assert.equal(ui.opened.length, 0);
    assert.equal(ui.revealed.length, 1);
  });

  it('surfaces an error when no API key is stored', async () => {
    const { d, ui } = make({ keyProvider: new FakeKeys(undefined) as unknown as KeyProvider });
    ui.picks = [{ label: '1:1', description: '1024x1024' }];
    ui.inputs = ['a crab'];
    assert.equal(await runGenerateImageCommand(d), false);
    assert.equal(ui.errors.length, 1);
    assert.match(ui.errors[0] ?? '', /API key/);
  });
});
