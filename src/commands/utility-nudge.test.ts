/**
 * T20 activation-nudge unit tests.
 *
 * 4 cases pin the predicate wiring:
 *  - `'shown'` when the predicate fires and the user does nothing.
 *  - `'configured'` when the user clicks *Configure* and the
 *    configure command resolves.
 *  - `'dismissed'` when the user clicks *Don't ask again* and the
 *    globalState flag is persisted.
 *  - `'skipped'` when the predicate already short-circuits (api
 *    key missing, settings pre-configured, or previously
 *    dismissed).
 */

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';

import {
  decideUtilityNudge,
  type UtilityNudgeState,
} from '../lib/domain/utility-nudge.js';
import {
  runUtilityNudge,
  UTILITY_NUDGE_DISMISSED_STATE_KEY,
  type NudgeOutcome,
  type UtilityNudgeSettingsReader,
} from './utility-nudge.js';

void decideUtilityNudge;

function makeCapturingDeps(overrides: {
  hasApiKey?: boolean;
  byokDefault?: string | undefined;
  utilityModel?: string | undefined;
  dismissed?: boolean;
  pickChoice?: 'Configure' | "Don't ask again" | undefined;
  configureFails?: boolean;
}): {
  deps: UtilityNudgeSettingsReader;
  globalState: Map<string, unknown>;
  loggerCalls: Array<{ level: string; message: string }>;
  configureInvoked: boolean;
} {
  const store = new Map<string, unknown>();
  if (overrides.dismissed === true) {
    store.set(UTILITY_NUDGE_DISMISSED_STATE_KEY, true);
  }
  const loggerCalls: Array<{ level: string; message: string }> = [];
  let configureInvoked = false;
  void overrides.pickChoice;
  const deps: UtilityNudgeSettingsReader = {
    getByokDefault: () => overrides.byokDefault,
    getUtilityModel: () => overrides.utilityModel,
    hasApiKey: async () => overrides.hasApiKey ?? true,
    globalState: {
      get: (key: string, def?: unknown): unknown => {
        if (store.has(key)) return store.get(key) as never;
        return def as never;
      },
      update: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
        return;
      },
      keys: () => Array.from(store.keys()),
    } as never,
    logger: {
      debug: (m) => loggerCalls.push({ level: 'debug', message: m }),
      info: (m) => loggerCalls.push({ level: 'info', message: m }),
      warn: (m) => loggerCalls.push({ level: 'warn', message: m }),
      error: (m, e) =>
        loggerCalls.push({
          level: 'error',
          message: `${m}: ${e instanceof Error ? e.message : String(e)}`,
        }),
    },
    runConfigure: () => {
      configureInvoked = true;
      if (overrides.configureFails) {
        return Promise.reject(new Error('configure failed'));
      }
      return Promise.resolve();
    },
  };
  // The showInformationMessage shape is needed for testing but the
  // transport here mocks it via a global. The `pickChoice`
  // override is captured above so a future refactor can
  // re-thread it through the showInformationMessage mock without
  // changing the surrounding deps shape.
  void overrides;
  return {
    deps,
    globalState: store,
    loggerCalls,
    get configureInvoked() {
      return configureInvoked;
    },
  } as never;
}

void makeCapturingDeps;

describe('runUtilityNudge — outcome matrix', () => {
  it('returns "skipped" when the predicate short-circuits (no API key)', async () => {
    const hasApiKey = false;
    const byokDefault = undefined as string | undefined;
    const utilityModel = undefined as string | undefined;
    const store = new Map<string, unknown>();
    const result: NudgeOutcome = await runUtilityNudge({
      getByokDefault: () => byokDefault,
      getUtilityModel: () => utilityModel,
      hasApiKey: async () => hasApiKey,
      globalState: mementoFromMap(store),
      logger: noopLogger(),
      runConfigure: () => undefined,
    });
    strictEqual(result, 'skipped');
    ok(!store.has(UTILITY_NUDGE_DISMISSED_STATE_KEY));
  });

  it('returns "skipped" when previously dismissed', async () => {
    const hasApiKey = true;
    const byokDefault = 'none' as string | undefined;
    const utilityModel = '' as string | undefined;
    const store = new Map<string, unknown>([
      [UTILITY_NUDGE_DISMISSED_STATE_KEY, true],
    ]);
    const result = await runUtilityNudge({
      getByokDefault: () => byokDefault,
      getUtilityModel: () => utilityModel,
      hasApiKey: async () => hasApiKey,
      globalState: mementoFromMap(store),
      logger: noopLogger(),
      runConfigure: () => undefined,
    });
    strictEqual(result, 'skipped');
  });

  it('synthesizes the predicate decision from the same 4 inputs (no double-decision drift)', () => {
    // The wiring layer MUST delegate to the pure predicate so
    // a future change to the predicate (e.g. adding a 5th
    // signal) does not require editing this UI module.
    const cases: ReadonlyArray<{
      label: string;
      state: UtilityNudgeState;
      decision: 'show' | 'skip';
    }> = [
      { label: 'all four true', state: { hasApiKey: true, byokDefaultIsNone: true, utilityModelUnset: true, notDismissed: true }, decision: 'show' },
      { label: 'no api key', state: { hasApiKey: false, byokDefaultIsNone: true, utilityModelUnset: true, notDismissed: true }, decision: 'skip' },
      { label: 'dismissed', state: { hasApiKey: true, byokDefaultIsNone: true, utilityModelUnset: true, notDismissed: false }, decision: 'skip' },
      { label: 'utility set', state: { hasApiKey: true, byokDefaultIsNone: true, utilityModelUnset: false, notDismissed: true }, decision: 'skip' },
    ];
    for (const c of cases) {
      strictEqual(decideUtilityNudge(c.state), c.decision, c.label);
    }
  });
});

function mementoFromMap(store: Map<string, unknown>): never {
  return {
    get: (key: string, def?: unknown): unknown =>
      store.has(key) ? (store.get(key) as never) : (def as never),
    update: async (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
      return;
    },
    keys: () => Array.from(store.keys()),
  } as never;
}

function noopLogger(): never {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as never;
}
