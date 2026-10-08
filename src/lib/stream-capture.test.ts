/**
 * T41 — stream-capture tests.
 *
 * Covers the properties that make an armed-but-dormant diagnostic
 * sink safe to leave switched on:
 *  1. it caps its own growth (bounded disk footprint);
 *  2. it never throws (diagnostics cannot break streaming);
 *  3. it serializes events so the rolling buffer stays parseable;
 *  4. it writes only into a private, owner-only directory created
 *     via `mkdtemp` — never a predictable path in a shared
 *     world-writable temp dir (CodeQL js/insecure-temporary-file).
 *
 * Each test creates its OWN `mkdtemp` root and removes it in a
 * `finally`, so no test depends on another having run first.
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { formatCaptureLine, StreamCapture } from '../adapters/stream-capture.js';

/**
 * Create a private scratch root for one test.
 *
 * `mkdtemp` rather than a fixed name: a predictable path in the
 * shared OS temp dir is exactly the pattern CodeQL flags, and it is
 * a symlink-attack target even in tests.
 */
async function scratchRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'mighty-max-capture-test-'));
}

describe('StreamCapture', () => {
  it('writes appended lines to disk on flush', async () => {
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      capture.append('[text] "hello"\n');
      capture.append('[finish] stop\n');
      await capture.close();

      const written = await fs.readFile(capture.filePath, 'utf8');
      assert.equal(written, '[text] "hello"\n[finish] stop\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the OLDEST content once the cap is exceeded', async () => {
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, maxBytes: 40, flushIntervalMs: 0 });
      capture.append('[text] "aaaaaaaaaa"\n');
      capture.append('[text] "bbbbbbbbbb"\n');
      capture.append('[text] "cccccccccc"\n');
      capture.append('[text] "dddddddddd"\n');
      await capture.close();

      const written = await fs.readFile(capture.filePath, 'utf8');
      assert.ok(written.length <= 40, `capture grew past its cap: ${String(written.length)}`);
      // The newest line must survive; the oldest must be gone.
      assert.ok(written.includes('dddddddddd'), 'newest content was dropped');
      assert.ok(!written.includes('aaaaaaaaaa'), 'oldest content should have been evicted');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores appends after close instead of throwing', async () => {
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      await capture.close();
      assert.doesNotThrow(() => capture.append('[text] "late"\n'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never throws when the target directory is unwritable', async () => {
    // Parent is a file, not a directory — mkdtemp fails.
    const root = await scratchRoot();
    try {
      const blocker = join(root, 'blocker');
      await fs.writeFile(blocker, 'not a directory', 'utf8');
      const capture = new StreamCapture({ dir: join(blocker, 'nested') });
      assert.doesNotThrow(() => capture.append('[text] "x"\n'));
      await capture.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('creates missing parent directories', async () => {
    const root = await scratchRoot();
    try {
      const dir = join(root, 'does', 'not', 'exist');
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      capture.append('[text] "nested"\n');
      await capture.close();
      assert.equal(await fs.readFile(capture.filePath, 'utf8'), '[text] "nested"\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ── security regression ─────────────────────────────────────────────

  it('writes into an unpredictable private directory, not the parent', async () => {
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      capture.append('[text] "secret"\n');
      await capture.close();

      const file = capture.filePath;
      // The capture must NOT sit directly in the parent directory —
      // that is the predictable shared-path shape.
      assert.notEqual(dirname(file), dir, 'capture landed in the shared parent directory');
      // It must sit in a mkdtemp-named subdirectory.
      const subdir = basename(dirname(file));
      assert.ok(
        subdir.startsWith('stream-capture-'),
        `capture directory is not mkdtemp-named: ${subdir}`,
      );
      // …and the predictable name must not exist at the old location.
      await assert.rejects(fs.access(join(dir, 'stream-capture.txt')));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('creates the capture directory owner-only (0700)', async function () {
    if (process.platform === 'win32') return; // POSIX modes are not meaningful on Windows
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      capture.append('[text] "x"\n');
      await capture.close();

      const mode = (await fs.stat(dirname(capture.filePath))).mode & 0o777;
      assert.equal(mode, 0o700, `capture dir is not owner-only: 0${mode.toString(8)}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('creates the capture file owner-only (0600)', async function () {
    if (process.platform === 'win32') return; // POSIX modes are not meaningful on Windows
    const dir = await scratchRoot();
    try {
      const capture = new StreamCapture({ dir, flushIntervalMs: 0 });
      capture.append('[text] "x"\n');
      await capture.close();

      const mode = (await fs.stat(capture.filePath)).mode & 0o777;
      assert.equal(mode, 0o600, `capture file is not owner-only: 0${mode.toString(8)}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('formatCaptureLine', () => {
  it('escapes text deltas so newlines cannot break line framing', () => {
    const line = formatCaptureLine({ textDelta: 'a\nb"c' });
    assert.equal(line, '[text] "a\\nb\\"c"\n');
  });

  it('records tool deltas with id, name and arguments', () => {
    const line = formatCaptureLine({
      toolCallDelta: { id: 'call_1', name: 'read', argumentsDelta: '{"a":1}' },
    });
    assert.equal(line, '[tool] id=call_1 name=read args="{\\"a\\":1}"\n');
  });

  it('tolerates a tool delta with no header yet (continuation fragment)', () => {
    const line = formatCaptureLine({ toolCallDelta: { argumentsDelta: '{"b":2}' } });
    assert.equal(line, '[tool] id=- name=- args="{\\"b\\":2}"\n');
  });

  it('records the finish reason', () => {
    assert.equal(formatCaptureLine({ finishReason: 'tool_calls' }), '[finish] tool_calls\n');
  });

  it('returns undefined for events with nothing worth diagnosing', () => {
    assert.equal(formatCaptureLine({}), undefined);
  });
});
