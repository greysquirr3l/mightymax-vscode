import { defineConfig } from '@vscode/test-cli';

/**
 * @vscode/test-cli profiles:
 *  - `unit`: Mocha on the single genuinely-Mocha test file
 *    (`no-vscode.test.js`), run inside a real (but otherwise idle)
 *    VS Code host — see the `files` comment below for why nothing
 *    else is in this list.
 *  - `integration`: full VS Code host with the extension loaded from
 *    `dist/extension.cjs` (esbuild output). Uses stable VS Code for
 *    reliability in CI (insiders download fails intermittently on Windows).
 *  - `agent-harness`: multi-round agent conversation tests in VS Code host.
 *
 * The `node:test`-based unit files don't have a profile here at all:
 * pure ones run via `scripts/run-node-tests.cjs`, `vscode`-importing
 * ones via `scripts/run-vscode-stub-tests.cjs` — see those scripts
 * for why.
 */
export default defineConfig([
  {
    label: 'unit',
    // ONLY `no-vscode.test.js` — the one file in the repo that uses
    // Mocha's own BDD globals. Every other test file uses
    // `import { describe, it } from 'node:test'`, which registers
    // with node:test's own independent, self-scheduled runner — NOT
    // Mocha's suite tree. @vscode/test-cli tears down the extension
    // host as soon as MOCHA's suite finishes, which loses the race
    // against node:test's suites for slower/later-registered files
    // with no error and exit 0. This profile used to glob
    // `out/lib/**`, `out/adapters/**`, and `out/commands/**`, and
    // that race was observed live on 2026-07-18: `transport.test.js`
    // was cut after its first suite, so the stall-watchdog and
    // server-terminated regression suites were silently not running
    // under this label. Those node:test files now run
    // deterministically outside the host instead:
    //  - pure files → `scripts/run-node-tests.cjs` (plain
    //    `node --test`, per-file process isolation);
    //  - `vscode`-importing files (messages*.test.js, the provider
    //    files, tool-filtering) → `scripts/run-vscode-stub-tests.cjs`
    //    with the checked-in `vscode` stub.
    // Both are chained ahead of this profile in `npm run test:unit`.
    files: ['out/lib/no-vscode.test.js'],
    mocha: {
      // BDD: the test files use `describe`/`it`/`beforeEach`/`afterEach`,
      // which only register with mocha under the BDD interface. The TDD
      // interface uses `suite`/`test` and would silently skip these tests
      // (returning 0 failures but executing nothing).
      ui: 'bdd',
      timeout: 15_000,
    },
  },
  {
    label: 'integration',
    files: 'out/test/**/*.test.js',
    version: 'stable',
    launchArgs: ['--disable-extensions', '--disable-updates'],
    mocha: {
      // BDD everywhere in src/test: every file uses Mocha's
      // `describe`/`it` globals (extension.test.ts was converted
      // from tdd `suite`/`test` on 2026-07-19 so this glob could
      // switch). This matters: under the old tdd interface, only
      // extension.test.js registered with Mocha — every other file
      // in the glob imported `describe`/`it` from `node:test` and
      // ran on node:test's independent scheduler, racing the
      // extension-host teardown that fires when Mocha's own suite
      // finishes (silent cut, exit 0). With bdd + Mocha globals in
      // every file, Mocha owns the full suite tree and awaits it.
      ui: 'bdd',
      timeout: 30_000,
    },
  },
  {
    label: 'agent-harness',
    // Agent-loop fidelity tests: multi-round conversations, parallel tool
    // calls, malformed call recovery, cancellation. Runs with the VS Code
    // host to test the full ChatProvider against scripted agent scenarios.
    files: 'out/test/agent-harness.test.js',
    version: 'stable',
    launchArgs: ['--disable-extensions', '--disable-updates'],
    mocha: {
      ui: 'bdd',
      timeout: 30_000,
    },
  },
  {
    label: 'thinking-passback',
    // Thinking pass-back validation: tests the complete thinking + tool-calling
    // flow to ensure thinking blocks with signatures are captured, cached, and
    // replayed correctly across multi-turn conversations.
    files: 'out/test/thinking-passback.test.js',
    version: 'stable',
    launchArgs: ['--disable-extensions', '--disable-updates'],
    mocha: {
      ui: 'bdd',
      timeout: 30_000,
    },
  },
  // There used to be a dedicated `tool-filtering` profile here
  // (`files: 'out/test/tool-filtering.test.js'`, same shape as
  // `agent-harness`/`thinking-passback` above). It's gone on purpose:
  // at the time, that file registered with `node:test` rather than
  // Mocha, so the profile's Mocha suite was EMPTY and the host was
  // torn down before its tests ever ran (silent `0 passing`, exit 0).
  // `tool-filtering.test.js` now runs two places instead: via
  // `scripts/run-vscode-stub-tests.cjs` (see `npm run test:unit`),
  // deterministically, under plain Node with the checked-in `vscode`
  // stub (where its dual-runner shim falls back to node:test); and as
  // part of the `integration` profile's glob above, where the same
  // shim picks up Mocha's BDD globals and registers with Mocha's own
  // suite tree — no teardown race either way.
]);
