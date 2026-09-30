/**
 * Unit tests for `runGenerateVideoPipeline` (the tool adapter's
 * submit → poll → download → save pipeline).
 *
 * Uses an in-test `VideoGenerator` fake and a `MediaArtifactStore`
 * fake so the suite never touches the network or the filesystem.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runGenerateVideoPipeline } from './generate-video-tool-adapter.js';
import type { GenerateVideoToolAdapterDeps } from './generate-video-tool-adapter.js';
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

function makeSilentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

interface PollStep {
  state: VideoTaskState;
}

class FakeVideoGenerator implements VideoGenerator {
  submitted: VideoRequest[] = [];
  pollCalls = 0;
  downloadCalls = 0;
  private readonly pollSequence: PollStep[];

  constructor(
    pollSequence: PollStep[],
    private readonly downloadBytes: VideoBytes,
  ) {
    this.pollSequence = pollSequence;
  }

  async submitTask(request: VideoRequest): Promise<{ taskId: string; model: VideoModelId }> {
    this.submitted.push(request);
    return { taskId: 'task-test-1', model: request.model };
  }

  async pollStatus(_taskId: string): Promise<VideoTaskState> {
    const step =
      this.pollSequence[this.pollCalls] ?? this.pollSequence[this.pollSequence.length - 1]!;
    this.pollCalls++;
    return step.state;
  }

  async downloadResult(_taskId: string): Promise<VideoBytes> {
    this.downloadCalls++;
    return this.downloadBytes;
  }
}

class FakeMediaStore implements MediaArtifactStore {
  readonly writes: Array<{ bytes: Uint8Array; hint: MediaArtifactWriteHint }> = [];

  defaultDirectory(): string {
    return '/tmp/media';
  }

  async write(bytes: Uint8Array, hint: MediaArtifactWriteHint): Promise<MediaArtifactRef> {
    this.writes.push({ bytes, hint });
    return {
      absolutePath: `/tmp/media/${this.writes.length}.${hint.extension}`,
      sizeBytes: bytes.byteLength,
      mime: hint.mime ?? 'application/octet-stream',
    };
  }
}

class FakeKeyProvider implements Pick<KeyProvider, 'pickKey'> {
  constructor(private readonly key: string | undefined) {}
  async pickKey(): Promise<{ slot: 1 | 2 | 3; key: string; fellBack: boolean } | undefined> {
    if (this.key === undefined) return undefined;
    return { slot: 1, key: this.key, fellBack: false };
  }
}

function makeDeps(
  overrides: Partial<GenerateVideoToolAdapterDeps> = {},
): GenerateVideoToolAdapterDeps {
  const pendingState: VideoTaskState = { kind: 'pending', taskId: 'task-test-1' };
  const successState: VideoTaskState = { kind: 'success', taskId: 'task-test-1' };
  const downloadBytes: VideoBytes = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    mime: 'video/mp4',
  };
  const videoGenerator = new FakeVideoGenerator(
    [{ state: pendingState }, { state: pendingState }, { state: successState }],
    downloadBytes,
  );
  const mediaStore = new FakeMediaStore();
  const keyProvider = new FakeKeyProvider('sk-test');
  return {
    logger: makeSilentLogger(),
    keyProvider: keyProvider as unknown as KeyProvider,
    videoGenerator,
    mediaStore,
    config: {
      getPollIntervalMs: () => 10,
      getTimeoutMs: () => 60_000,
      getFileExtension: () => 'mp4',
      getToolEnabled: () => true,
    },
    ...overrides,
  };
}

const validInput = {
  model: 'MiniMax-H3',
  prompt: 'a giant turtle',
  durationSec: 6,
};

// ─────────────────────────────────────────────────────────────────────────────
// runGenerateVideoPipeline
// ─────────────────────────────────────────────────────────────────────────────

describe('runGenerateVideoPipeline', () => {
  it('submits, polls, downloads, and saves on a happy path', async () => {
    const deps = makeDeps();
    const result = await runGenerateVideoPipeline(validInput, deps, new AbortController().signal);
    assert.equal(result.taskId, 'task-test-1');
    assert.equal(result.model, 'MiniMax-H3');
    assert.equal(result.durationSec, 6);
    assert.equal(result.sizeBytes, 4);
    assert.equal(result.mime, 'video/mp4');
    assert.equal(result.absolutePath, '/tmp/media/1.mp4');
    // 2 pending polls + 1 success poll = 3
    assert.equal((deps.videoGenerator as FakeVideoGenerator).pollCalls, 3);
    assert.equal((deps.videoGenerator as FakeVideoGenerator).downloadCalls, 1);
    assert.equal((deps.mediaStore as FakeMediaStore).writes.length, 1);
  });

  it('rejects invalid input with a typed error', async () => {
    const deps = makeDeps();
    await assert.rejects(
      runGenerateVideoPipeline(
        { ...validInput, durationSec: 5 },
        deps,
        new AbortController().signal,
      ),
      (err: unknown) => err instanceof Error && /6 or 10/.test(err.message),
    );
  });

  it('throws when no API key is configured', async () => {
    const deps = makeDeps({
      keyProvider: new FakeKeyProvider(undefined) as unknown as KeyProvider,
    });
    await assert.rejects(
      runGenerateVideoPipeline(validInput, deps, new AbortController().signal),
      (err: unknown) => err instanceof Error && /API key/.test(err.message),
    );
  });

  it('translates a Fail poll into an error message the model can read', async () => {
    const deps = makeDeps({
      videoGenerator: new FakeVideoGenerator(
        [
          {
            state: {
              kind: 'fail',
              taskId: 'task-test-1',
              errorCode: '1026',
              errorMessage: 'sensitive content',
            },
          },
        ],
        { bytes: new Uint8Array(), mime: 'video/mp4' },
      ),
    });
    await assert.rejects(
      runGenerateVideoPipeline(validInput, deps, new AbortController().signal),
      (err: unknown) => err instanceof Error && /1026/.test(err.message),
    );
  });

  it('throws when the poll exceeds the configured timeout', async () => {
    const pending: VideoTaskState = { kind: 'pending', taskId: 'task-test-1' };
    const manyPending: PollStep[] = [];
    for (let i = 0; i < 100; i++) manyPending.push({ state: pending });
    const deps = makeDeps({
      videoGenerator: new FakeVideoGenerator(manyPending, {
        bytes: new Uint8Array(),
        mime: 'video/mp4',
      }),
      config: {
        getPollIntervalMs: () => 5,
        getTimeoutMs: () => 25, // < total time spent polling
        getFileExtension: () => 'mp4',
        getToolEnabled: () => true,
      },
    });
    await assert.rejects(
      runGenerateVideoPipeline(validInput, deps, new AbortController().signal),
      (err: unknown) => err instanceof Error && /timed out/.test(err.message),
    );
  });

  it('throws when the signal is already aborted', async () => {
    const deps = makeDeps();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      runGenerateVideoPipeline(validInput, deps, ac.signal),
      (err: unknown) => err instanceof Error && /cancelled/.test(err.message),
    );
  });

  it('translates a generator submit error to a friendly message', async () => {
    const deps = makeDeps({
      videoGenerator: {
        submitTask: async () => {
          throw new Error('upstream blew up');
        },
        pollStatus: async () => ({ kind: 'pending' as const, taskId: 'x' }),
        downloadResult: async () => ({ bytes: new Uint8Array(), mime: 'video/mp4' }),
      },
    });
    await assert.rejects(
      runGenerateVideoPipeline(validInput, deps, new AbortController().signal),
      (err: unknown) => err instanceof Error && /upstream blew up/.test(err.message),
    );
  });
});
