/**
 * T20 — Configure utility models command tests.
 *
 * Three pick flows are exercised end-to-end through the
 * injected UI + Config + Logger test doubles. Each test asserts
 * the exact key/value pairs the BYOK agent-mode error requires
 * and verifies:
 *  - no API key, no Authorization header, no user content leaks
 *    into log calls (the AGENTS.md rule abouts logging-only-meta
 *    still applies here)
 *  - update() failure surfaces via showErrorMessage and does not
 *    throw
 *  - dismissed pick is a no-op (no writes, no info message)
 */

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert/strict';

import {
  CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY,
  CHAT_UTILITY_MODEL_KEY,
  CHAT_UTILITY_SMALL_MODEL_KEY,
  CONFIGURE_UTILITY_PICK_ITEMS,
  MINIMAX_UTILITY_MODEL,
  MINIMAX_UTILITY_SMALL_MODEL,
  MINIMAX_VENDOR,
  runConfigureUtilityModelsCommand,
  type ConfigureUtilityConfig,
  type ConfigureUtilityUi,
} from './configure-utility-models.js';

interface RecordedWrite {
  readonly key: string;
  readonly value: unknown;
}

interface RecordedInfo {
  readonly message: string;
}

interface ScriptedDeps {
  pick?: 'recommended' | 'mainAgent' | 'copilot' | undefined;
  throwsOn?: 'chat.utilityModel' | 'chat.utilitySmallModel' | 'chat.byokUtilityModelDefault';
}

interface RecordingLogger {
  infos: Array<{ message: string; context?: Record<string, unknown> }>;
  errors: Array<{ message: string; context?: Record<string, unknown>; error?: unknown }>;
  debugs: Array<{ message: string; context?: Record<string, unknown> }>;
}

function makeLogger(): RecordingLogger {
  return { infos: [], errors: [], debugs: [] };
}
function bindLogger(logger: RecordingLogger): {
  info: (m: string, c?: Record<string, unknown>) => void;
  warn: (m: string, c?: Record<string, unknown>) => void;
  error: (m: string, e?: unknown, c?: Record<string, unknown>) => void;
  debug: (m: string, c?: Record<string, unknown>) => void;
} {
  return {
    info: (m, c) => {
      logger.infos.push(c === undefined ? { message: m } : { message: m, context: c });
    },
    warn: (m, c) => {
      // not exercised in these tests, but the protocol requires it
      void m;
      void c;
    },
    error: (m, e, c) => {
      const base: { message: string; context?: Record<string, unknown>; error?: unknown } = {
        message: m,
      };
      if (c !== undefined) base.context = c;
      if (e !== undefined) base.error = e;
      logger.errors.push(base);
    },
    debug: (m, c) => {
      logger.debugs.push(c === undefined ? { message: m } : { message: m, context: c });
    },
  };
}

function makeUiAndConfig(opts: ScriptedDeps): {
  ui: ConfigureUtilityUi;
  config: ConfigureUtilityConfig & { writes: RecordedWrite[] };
  info: RecordedInfo[];
} {
  const writes: RecordedWrite[] = [];
  const info: RecordedInfo[] = [];
  const ui: ConfigureUtilityUi = {
    showQuickPick: async () => {
      if (opts.pick === undefined) return undefined;
      if (opts.pick === 'recommended') {
        return CONFIGURE_UTILITY_PICK_ITEMS[0];
      }
      if (opts.pick === 'mainAgent') {
        return CONFIGURE_UTILITY_PICK_ITEMS[1];
      }
      return CONFIGURE_UTILITY_PICK_ITEMS[2];
    },
    showInfoMessage: async (m: string) => {
      info.push({ message: m });
      return undefined;
    },
    showErrorMessage: async () => undefined,
  };
  const config: ConfigureUtilityConfig & { writes: RecordedWrite[] } = {
    writes,
    update: async (key, value) => {
      if (opts.throwsOn === key) {
        throw new Error(`update(${key}) failed in test`);
      }
      writes.push({ key, value });
      return undefined;
    },
  };
  return { ui, config, info };
}

describe('runConfigureUtilityModelsCommand — three pick flows', () => {
  it('"recommended" writes chat.utilityModel + chat.utilitySmallModel pointing at MiniMax', async () => {
    const logger = makeLogger();
    const { ui, config, info } = makeUiAndConfig({ pick: 'recommended' });
    const bound = bindLogger(logger);
    await runConfigureUtilityModelsCommand({
      logger: bound,
      ui,
      getConfig: () => config,
    });
    deepStrictEqual(
      config.writes.map((w) => ({ key: w.key, value: w.value })),
      [
        { key: CHAT_UTILITY_MODEL_KEY, value: `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_MODEL}` },
        {
          key: CHAT_UTILITY_SMALL_MODEL_KEY,
          value: `${MINIMAX_VENDOR}/${MINIMAX_UTILITY_SMALL_MODEL}`,
        },
      ],
    );
    strictEqual(info.length >= 1, true, 'expected an info message after success');
    strictEqual(
      logger.infos[0]?.message.includes('MiniMax utility models set'),
      true,
      'expected a success log entry',
    );
    // AGENTS.md redaction guard: never log the API key (there is
    // none here, but the assertion is structural — no calls log
    // anything resembling a Bearer token or user content).
    for (const entry of logger.infos) {
      const blob = JSON.stringify(entry);
      strictEqual(blob.includes('Bearer'), false);
      strictEqual(blob.includes('sk-'), false);
    }
  });

  it('"main agent model" writes chat.byokUtilityModelDefault=mainAgent', async () => {
    const logger = makeLogger();
    const { ui, config, info } = makeUiAndConfig({ pick: 'mainAgent' });
    await runConfigureUtilityModelsCommand({
      logger: bindLogger(logger),
      ui,
      getConfig: () => config,
    });
    deepStrictEqual(config.writes, [
      { key: CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY, value: 'mainAgent' },
    ]);
    strictEqual(info.length, 1);
    ok(info[0]?.message.includes('main agent model'));
  });

  it('"Copilot" writes chat.byokUtilityModelDefault=copilot', async () => {
    const logger = makeLogger();
    const { ui, config, info } = makeUiAndConfig({ pick: 'copilot' });
    await runConfigureUtilityModelsCommand({
      logger: bindLogger(logger),
      ui,
      getConfig: () => config,
    });
    deepStrictEqual(config.writes, [
      { key: CHAT_BYOK_UTILITY_MODEL_DEFAULT_KEY, value: 'copilot' },
    ]);
    strictEqual(info.length, 1);
    ok(info[0]?.message.includes('Copilot'));
  });

  it('dismissed pick is a no-op (no writes, no info message)', async () => {
    const logger = makeLogger();
    const { ui, config, info } = makeUiAndConfig({ pick: undefined });
    await runConfigureUtilityModelsCommand({
      logger: bindLogger(logger),
      ui,
      getConfig: () => config,
    });
    strictEqual(config.writes.length, 0, 'no writes when pick is dismissed');
    strictEqual(info.length, 0, 'no info message when pick is dismissed');
  });

  it('update() failure surfaces via showErrorMessage and does not throw', async () => {
    const logger = makeLogger();
    const errorHolder: { value: string | undefined } = { value: undefined };
    const writes: RecordedWrite[] = [];
    const ui: ConfigureUtilityUi = {
      showQuickPick: async () => CONFIGURE_UTILITY_PICK_ITEMS[0],
      showInfoMessage: async () => undefined,
      showErrorMessage: async (m: string) => {
        errorHolder.value = m;
        return undefined;
      },
    };
    const config: ConfigureUtilityConfig = {
      update: async (key, _value) => {
        if (key === CHAT_UTILITY_MODEL_KEY) {
          throw new Error('write failed in test');
        }
        writes.push({ key, value: null });
        return undefined;
      },
    };
    let threw = false;
    try {
      await runConfigureUtilityModelsCommand({
        logger: bindLogger(logger),
        ui,
        getConfig: () => config,
      });
    } catch {
      threw = true;
    }
    strictEqual(threw, false, 'command must swallow the write failure');
    const errorValue = errorHolder.value;
    if (errorValue === undefined) {
      throw new Error('expected an error message to have been shown');
    }
    ok(errorValue.includes('Failed to write'));
  });
});

function ok(value: unknown, message?: string): void {
  if (!value) {
    throw new Error(message ?? 'expected truthy');
  }
}
