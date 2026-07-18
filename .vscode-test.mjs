import { defineConfig } from '@vscode/test-cli';

/**
 * @vscode/test-cli profiles:
 *  - `unit`: Mocha on compiled domain/adapter/command tests, run inside
 *    a real (but otherwise idle) VS Code host — see the `files` comment
 *    below for why `out/providers/**` is deliberately NOT in this list.
 *  - `integration`: full VS Code host with the extension loaded from
 *    `dist/extension.cjs` (esbuild output). Uses stable VS Code for
 *    reliability in CI (insiders download fails intermittently on Windows).
 *  - `agent-harness`: multi-round agent conversation tests in VS Code host.
 *
 * Some `node:test`-based files that touch `vscode` (chat-provider,
 * stream-pump, tool-filtering) don't have a profile here at all — see
 * `scripts/run-vscode-stub-tests.cjs` for why and where they run
 * instead.
 */
export default defineConfig([
  {
    label: 'unit',
    // Pure-domain tests live under out/lib/; adapter tests (HTTP, secret
    // store, transport) live under out/adapters/; command-glue tests
    // live under out/commands/. The src/lib/no-vscode.test.ts static
    // guard enforces that the domain layer stays framework-free;
    // adapter tests intentionally import HTTP modules.
    //
    // `out/providers/**` (chat-provider.test.js, stream-pump.test.js)
    // is NOT included here on purpose. Every file in this repo uses
    // `import { describe, it } from 'node:test'` rather than Mocha's
    // own globals (only `no-vscode.test.ts` uses the latter), so
    // Mocha's own suite tree here is effectively just those 12
    // static-purity checks — node:test runs everything else via its
    // own independent, self-scheduled runner. @vscode/test-cli tears
    // down the extension host as soon as MOCHA's (tiny) suite
    // finishes, which loses the race against node:test's suites for
    // slower/later-registered files with no error and exit 0. The two
    // provider files run instead via `scripts/run-vscode-stub-tests.cjs`
    // (see `npm run test:unit`), under plain Node with a checked-in
    // `vscode` stub — they don't need the real host.
    files: ['out/lib/**/*.test.js', 'out/adapters/**/*.test.js', 'out/commands/**/*.test.js'],
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
      ui: 'tdd',
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
  // as a SINGLE-file, `ui: 'bdd'` profile whose one file uses
  // `node:test`'s own `describe`/`it` (not Mocha's globals), Mocha's
  // own suite tree for that profile was EMPTY — 0 tests, so its
  // `run()` callback fired almost instantly, and @vscode/test-cli tore
  // down the extension host before `tool-filtering.test.js`'s
  // node:test suite ever got to run (the same race documented on the
  // `unit` profile above, just with the odds turned all the way
  // against it). It silently reported `0 passing`, exit 0, and its
  // three assertions never actually ran under this label.
  // `tool-filtering.test.js` now runs two places instead: via
  // `scripts/run-vscode-stub-tests.cjs` (see `npm run test:unit`),
  // deterministically, under plain Node with the checked-in `vscode`
  // stub; and — unchanged, still working, kept as real-host coverage
  // of the same `vscode.workspace.getConfiguration` round-trip — as
  // part of the `integration` profile's `out/test/**/*.test.js` glob
  // above, where Mocha's own (real, non-empty) suite reliably outlasts
  // it.
]);
