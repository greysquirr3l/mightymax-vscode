#!/usr/bin/env node
'use strict';

/**
 * Host-free runner for the `vscode`-importing unit test files.
 *
 * Why this exists: `out/providers/chat-provider.test.js`,
 * `out/providers/stream-pump.test.js`, and `out/test/tool-filtering.test.js`
 * use `import { describe, it } from 'node:test'` like every other test
 * file in this repo, but they (transitively, via the modules under
 * test) `require('vscode')`. Running them through @vscode/test-cli's
 * `unit` profile (or, for tool-filtering, a dedicated single-file
 * profile) puts them in a race they structurally cannot win: those
 * profiles drive Mocha inside a real VS Code extension host, but
 * these files register with `node:test`'s own independent,
 * self-scheduled runner — NOT Mocha's suite tree (only
 * `src/lib/no-vscode.test.ts` uses Mocha's actual `describe`/`it`
 * globals, via the `ui: 'bdd'` interface). Mocha only awaits its own
 * suite before reporting done — for `unit` that's a tiny ~12-assertion
 * suite, for the old dedicated `tool-filtering` profile it was an
 * EMPTY suite (0 tests, near-instant) — and @vscode/test-cli tears
 * down the extension host as soon as Mocha's callback fires.
 * Whichever `node:test` suites haven't finished by that point are
 * silently cut off — no error, no output, exit 0 — which is exactly
 * the bug this runner fixes for the files that need `vscode`.
 *
 * The fix: don't put these files in that race at all. They don't need
 * the real VS Code host — they only touch the small, stable slice of
 * the `vscode` namespace stubbed in `./vscode-stub.cjs` (event
 * emitters, cancellation tokens, the LanguageModel*Part value classes,
 * a couple of enums, and an in-memory `workspace.getConfiguration()`
 * store). Load the stub, then require the compiled test files
 * directly under plain Node: `node:test`'s own top-level
 * `describe`/`it` scheduling then runs to completion uninterrupted
 * (nothing here calls `process.exit` early), and Node sets
 * `process.exitCode` from the pass/fail result automatically — so a
 * failing assertion in any of these files makes this script's exit
 * code non-zero, same as any other `node:test` invocation.
 *
 * Ordering note: `tool-filtering.test.js` is the only file here that
 * writes to the stub's `workspace.getConfiguration('mightyMax')`
 * store (via `config.update(...)`), and that store is a
 * process-lifetime singleton (matching real VS Code settings
 * persistence). It's required LAST so its config writes can never
 * leak into the providers tests above it — don't reorder this list
 * without checking that invariant still holds.
 *
 * Tests that actually need real VS Code host behavior (extension
 * activation, the real chat participant API, workspace state, …)
 * belong in `src/test/**` under the `integration` / `agent-harness` /
 * `thinking-passback` @vscode/test-cli profiles — this runner is only
 * for host-free domain/adapter-glue logic that happens to reference
 * `vscode` types.
 */

require('./vscode-stub.cjs').install();

require('../out/providers/stream-pump.test.js');
require('../out/providers/chat-provider.test.js');
require('../out/test/tool-filtering.test.js');
