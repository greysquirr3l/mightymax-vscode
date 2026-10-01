/**
 * Unit tests for `runGenerateImagePipeline` — the tool adapter's
 * generate → persist pipeline. Fake generator + fake store, so no
 * network and no filesystem.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runGenerateImagePipeline } from './generate-image-tool-adapter.js';
import type { GenerateImageToolAdapterDeps } from './generate-image-tool-adapter.js';
import type {
  MediaArtifactRef,
  MediaArtifactStore,
  MediaArtifactWriteHint,
} from '../ports/media-artifact-store.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { ImageGenerator } from '../ports/image-generator.js';
import type { Logger } from '../ports/logger.js';
import type { ImageBytes, ImageRequest } from '../lib/domain/image.js';
import { ImageGenerationError } from './image-01-adapter.js';

function logger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

class FakeGenerator implements ImageGenerator {
  seen: ImageRequest[] = [];
  constructor(private readonly out: ImageBytes[] | Error) {}
  async generate(request: ImageRequest): Promise<ImageBytes[]> {
    this.seen.push(request);
    if (this.out instanceof Error) throw this.out;
    return this.out;
  }
}

class FakeStore implements MediaArtifactStore {
  writes: Array<{ bytes: Uint8Array; hint: MediaArtifactWriteHint }> = [];
  defaultDirectory(): string {
    return '/tmp/media';
  }
  async write(bytes: Uint8Array, hint: MediaArtifactWriteHint): Promise<MediaArtifactRef> {
    this.writes.push({ bytes, hint });
    return {
      absolutePath: `/tmp/media/image01-${this.writes.length}.png`,
      sizeBytes: bytes.byteLength,
      mime: hint.mime ?? 'image/png',
    };
  }
}

class FakeKeys implements Pick<KeyProvider, 'pickKey'> {
  constructor(private readonly key: string | undefined) {}
  async pickKey(): Promise<{ slot: 1 | 2 | 3; key: string; fellBack: boolean } | undefined> {
    return this.key === undefined ? undefined : { slot: 1, key: this.key, fellBack: false };
  }
}

function deps(over: Partial<GenerateImageToolAdapterDeps> = {}): {
  d: GenerateImageToolAdapterDeps;
  gen: FakeGenerator;
  store: FakeStore;
} {
  const gen = new FakeGenerator([{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }]);
  const store = new FakeStore();
  const d: GenerateImageToolAdapterDeps = {
    logger: logger(),
    keyProvider: new FakeKeys('sk-test') as unknown as KeyProvider,
    imageGenerator: gen,
    mediaStore: store,
    config: { getToolEnabled: () => true },
    ...over,
  };
  return { d, gen, store };
}

const valid = { model: 'image-01', prompt: 'a neon crab' };

describe('runGenerateImagePipeline', () => {
  it('generates and persists one image', async () => {
    const { d, store } = deps();
    const r = await runGenerateImagePipeline(valid, d, new AbortController().signal);
    assert.equal(r.absolutePaths.length, 1);
    assert.equal(r.totalSizeBytes, 3);
    assert.equal(r.mime, 'image/png');
    assert.equal(r.aspectRatio, '1:1');
    assert.equal(store.writes[0]?.hint.extension, 'png');
    assert.equal(store.writes[0]?.hint.prefix, 'image01');
  });

  it('persists every image when count > 1', async () => {
    const gen = new FakeGenerator([
      { bytes: new Uint8Array([1]), mime: 'image/png' },
      { bytes: new Uint8Array([2]), mime: 'image/png' },
      { bytes: new Uint8Array([3]), mime: 'image/png' },
    ]);
    const { d, store } = deps({ imageGenerator: gen });
    const r = await runGenerateImagePipeline(
      { ...valid, count: 3 },
      d,
      new AbortController().signal,
    );
    assert.equal(r.absolutePaths.length, 3);
    assert.equal(store.writes.length, 3);
    assert.equal(r.totalSizeBytes, 3);
  });

  it('forwards the normalized request to the generator', async () => {
    const { d, gen } = deps();
    await runGenerateImagePipeline(
      { ...valid, aspectRatio: '16:9' },
      d,
      new AbortController().signal,
    );
    assert.equal(gen.seen[0]?.aspectRatio, '16:9');
  });

  it('rejects invalid input before calling the generator', async () => {
    const { d, gen } = deps();
    await assert.rejects(
      runGenerateImagePipeline({ ...valid, count: 99 }, d, new AbortController().signal),
      /between 1 and 9/,
    );
    assert.equal(gen.seen.length, 0, 'must not hit the network for invalid input');
  });

  it('throws when no API key is stored', async () => {
    const { d } = deps({ keyProvider: new FakeKeys(undefined) as unknown as KeyProvider });
    await assert.rejects(
      runGenerateImagePipeline(valid, d, new AbortController().signal),
      /API key/,
    );
  });

  it('translates a typed generator error into a readable message', async () => {
    const gen = new FakeGenerator(
      new ImageGenerationError('sensitive', undefined, 'guard tripped'),
    );
    const { d } = deps({ imageGenerator: gen });
    await assert.rejects(
      runGenerateImagePipeline(valid, d, new AbortController().signal),
      (e: unknown) =>
        e instanceof Error && /sensitive/.test(e.message) && /guard tripped/.test(e.message),
    );
  });
});
