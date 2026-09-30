/**
 * Unit tests for LocalMediaStore.
 *
 * Pure filesystem test using a per-test tmp directory. No vscode.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { LocalMediaStore, resolveMediaOutputDirectory } from './local-media-store.js';

describe('LocalMediaStore', () => {
  let workdir: string;
  let store: LocalMediaStore;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'mightymax-media-'));
    store = new LocalMediaStore({ baseDirectory: workdir });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('defaultDirectory() returns the configured base directory', () => {
    assert.equal(store.defaultDirectory(), workdir);
  });

  it('writes a file and returns absolute path + size + mime', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = await store.write(bytes, { extension: 'mp4', mime: 'video/mp4' });
    assert.equal(ref.mime, 'video/mp4');
    assert.equal(ref.sizeBytes, 5);
    assert.ok(path.isAbsolute(ref.absolutePath));
    assert.equal(path.dirname(ref.absolutePath), workdir);
    const info = await stat(ref.absolutePath);
    assert.equal(info.size, 5);
  });

  it('creates the base directory if it does not exist', async () => {
    const nested = path.join(workdir, 'nested', 'subdir');
    const nestedStore = new LocalMediaStore({ baseDirectory: nested });
    await nestedStore.write(new Uint8Array([0]), { extension: 'mp4' });
    const files = await readdir(nested);
    assert.equal(files.length, 1);
  });

  it('produces a unique filename for every call', async () => {
    const ref1 = await store.write(new Uint8Array([1]), { extension: 'mp4', prefix: 'h3' });
    // Sleep is unnecessary — the random suffix is 6 hex chars from
    // 24 bits, collision probability per call is ~5e-8. We just
    // assert two consecutive writes don't clobber each other.
    const ref2 = await store.write(new Uint8Array([2]), { extension: 'mp4', prefix: 'h3' });
    assert.notEqual(ref1.absolutePath, ref2.absolutePath);
  });

  it('includes the prefix and extension in the filename', async () => {
    const ref = await store.write(new Uint8Array([0]), {
      extension: 'mp4',
      prefix: 'hailuo',
    });
    assert.match(path.basename(ref.absolutePath), /^hailuo-.*\.mp4$/);
  });

  it('defaults the MIME to application/octet-stream', async () => {
    const ref = await store.write(new Uint8Array([0]), { extension: 'mp4' });
    assert.equal(ref.mime, 'application/octet-stream');
  });

  it('rejects non-Uint8Array bytes', async () => {
    await assert.rejects(
      // @ts-expect-error — intentional runtime violation
      store.write('not bytes', { extension: 'mp4' }),
      /Uint8Array/,
    );
  });

  it('rejects an empty extension', async () => {
    await assert.rejects(
      store.write(new Uint8Array([0]), { extension: '' }),
      /extension is required/,
    );
  });
});

describe('resolveMediaOutputDirectory', () => {
  it('honors the configured override when non-empty', () => {
    assert.equal(resolveMediaOutputDirectory('/storage', '/custom/dir'), '/custom/dir');
  });

  it('honors the configured override when it has surrounding whitespace', () => {
    assert.equal(resolveMediaOutputDirectory('/storage', '  /custom/dir  '), '/custom/dir');
  });

  it('falls back to <storage>/media when override is undefined', () => {
    assert.equal(
      resolveMediaOutputDirectory('/storage', undefined),
      path.join('/storage', 'media'),
    );
  });

  it('falls back to <storage>/media when override is empty / whitespace', () => {
    assert.equal(resolveMediaOutputDirectory('/storage', ''), path.join('/storage', 'media'));
    assert.equal(resolveMediaOutputDirectory('/storage', '   '), path.join('/storage', 'media'));
  });
});
