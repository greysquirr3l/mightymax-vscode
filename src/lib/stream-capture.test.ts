/**
 * T41 — stream-capture tests.
 *
 * Covers the three properties that make an armed-but-dormant
 * diagnostic sink safe to leave switched on:
 *  1. it caps its own growth (bounded disk footprint);
 *  2. it never throws (diagnostics cannot break streaming);
 *  3. it serializes events so the rolling buffer stays parseable.
 */

import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { formatCaptureLine, StreamCapture } from '../adapters/stream-capture.js';

function scratchPath(name: string): string {
  return join(tmpdir(), `mighty-max-capture-test-${String(process.pid)}-${name}.txt`);
}

describe('StreamCapture', () => {
  it('writes appended lines to disk on flush', async () => {
    const path = scratchPath('basic');
    await fs.rm(path, { force: true });
    const capture = new StreamCapture({ path, flushIntervalMs: 0 });
    capture.append('[text] "hello"\n');
    capture.append('[finish] stop\n');
    await capture.close();

    const written = await fs.readFile(path, 'utf8');
    assert.equal(written, '[text] "hello"\n[finish] stop\n');
    await fs.rm(path, { force: true });
  });

  it('drops the OLDEST content once the cap is exceeded', async () => {
    const path = scratchPath('cap');
    await fs.rm(path, { force: true });
    const capture = new StreamCapture({ path, maxBytes: 40, flushIntervalMs: 0 });
    capture.append('[text] "aaaaaaaaaa"\n');
    capture.append('[text] "bbbbbbbbbb"\n');
    capture.append('[text] "cccccccccc"\n');
    capture.append('[text] "dddddddddd"\n');
    await capture.close();

    const written = await fs.readFile(path, 'utf8');
    assert.ok(written.length <= 40, `capture grew past its cap: ${String(written.length)}`);
    // The newest line must survive; the oldest must be gone.
    assert.ok(written.includes('dddddddddd'), 'newest content was dropped');
    assert.ok(!written.includes('aaaaaaaaaa'), 'oldest content should have been evicted');
    await fs.rm(path, { force: true });
  });

  it('ignores appends after close instead of throwing', async () => {
    const path = scratchPath('closed');
    const capture = new StreamCapture({ path, flushIntervalMs: 0 });
    await capture.close();
    assert.doesNotThrow(() => capture.append('[text] "late"\n'));
    await fs.rm(path, { force: true });
  });

  it('never throws when the target path is unwritable', async () => {
    // A path whose parent is a file, not a directory — mkdir fails.
    const blocker = scratchPath('blocker');
    await fs.writeFile(blocker, 'not a directory', 'utf8');
    const capture = new StreamCapture({ path: join(blocker, 'nested', 'cap.txt') });
    assert.doesNotThrow(() => capture.append('[text] "x"\n'));
    await capture.close();
    await fs.rm(blocker, { force: true });
  });

  it('creates missing parent directories', async () => {
    const dir = join(tmpdir(), `mighty-max-capture-test-${String(process.pid)}-nested`);
    await fs.rm(dir, { recursive: true, force: true });
    const path = join(dir, 'deep', 'cap.txt');
    const capture = new StreamCapture({ path, flushIntervalMs: 0 });
    capture.append('[text] "nested"\n');
    await capture.close();
    assert.equal(await fs.readFile(path, 'utf8'), '[text] "nested"\n');
    await fs.rm(dir, { recursive: true, force: true });
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
