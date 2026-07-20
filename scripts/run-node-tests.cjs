#!/usr/bin/env node
'use strict';

/**
 * Deterministic runner for the pure `node:test` unit files.
 *
 * Why this exists: the @vscode/test-cli `unit` profile used to glob
 * `out/lib/**`, `out/adapters/**`, and `out/commands/**` — but every
 * file in this repo except `no-vscode.test.ts` registers with
 * `node:test`'s own independent runner, NOT Mocha's suite tree.
 * @vscode/test-cli tears down the extension host as soon as Mocha's
 * own (12-assertion purity) suite reports done, and whichever
 * node:test suites hadn't finished by then were silently cut off —
 * no error, no output, exit 0. Observed 2026-07-18: a full
 * `npm run test:unit` run cut `transport.test.js` after its first
 * suite, so the stall-watchdog and server-terminated regression
 * suites were not actually running under that label.
 *
 * The fix mirrors `run-vscode-stub-tests.cjs`: don't put these files
 * in that race at all. They are pure Node code (no `vscode` import
 * anywhere in their require graph), so they run under plain
 * `node --test`, which executes each file in its own child process —
 * full isolation, no shared-singleton ordering concerns, non-zero
 * exit on any failure.
 *
 * File selection is glob-minus-exclusions so newly added test files
 * are picked up automatically. Excluded:
 *  - `out/lib/no-vscode.test.js` — the one genuine Mocha file; it
 *    stays under the @vscode/test-cli `unit` profile (its
 *    `describe`/`it` come from Mocha's BDD globals and are undefined
 *    under `node --test`).
 *  - `out/lib/messages.test.js`, `out/lib/messages-id-fidelity.test.js`
 *    — transitively `require('vscode')` (via
 *    `ports/message-mapping.js`); they run in
 *    `run-vscode-stub-tests.cjs` with the checked-in stub instead.
 * If a future test file starts importing `vscode`, its child process
 * fails loudly with "Cannot find module 'vscode'" — move it to the
 * stub runner's list.
 */

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const EXCLUDED = new Set([
  'out/lib/no-vscode.test.js',
  'out/lib/messages.test.js',
  'out/lib/messages-id-fidelity.test.js',
]);

// Recursive *.test.js collector. CI pins Node 20, which predates
// `fs.globSync` (added in 22) — hence the hand-rolled walk.
function collectTestFiles(relDir) {
  const abs = path.join(root, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(rel));
    } else if (entry.name.endsWith('.test.js')) {
      found.push(rel);
    }
  }
  return found;
}

const files = ['out/lib', 'out/adapters', 'out/commands']
  .flatMap(collectTestFiles)
  .filter((f) => !EXCLUDED.has(f))
  .sort();

if (files.length === 0) {
  console.error('run-node-tests: no compiled test files found — run `npm run compile` first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
