/**
 * CatalogAdapter — deprecation filtering and lifecycle.
 *
 * Exercises the seam between the pure catalog rules in
 * `lib/domain/catalog.ts` and the picker list VS Code actually sees:
 * `listModels()` filters deprecated entries by default while
 * `getModel()` keeps resolving them, so a chat session already pinned
 * to a wound-down model does not break when it leaves the picker.
 *
 * Runs under `run-vscode-stub-tests.cjs` (the adapter imports
 * `vscode.EventEmitter` and reads the `mightyMax` config store).
 */

import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as vscode from 'vscode';

import { CatalogAdapter } from './catalog.js';
import { BUILT_IN_CATALOG, CURRENT_MODEL_IDS } from '../lib/domain/catalog.js';
import type { Logger } from '../ports/logger.js';

function makeLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Reset the shared stub config store between tests. */
async function clearSetting(): Promise<void> {
  await vscode.workspace
    .getConfiguration('mightyMax')
    .update('showDeprecatedModels', undefined);
}

describe('CatalogAdapter — deprecation filtering', () => {
  it('lists only current models by default', async () => {
    await clearSetting();
    const adapter = new CatalogAdapter(makeLogger());
    try {
      const models = await adapter.listModels();
      deepStrictEqual(
        models.map((m) => m.id),
        [...CURRENT_MODEL_IDS],
      );
    } finally {
      adapter.dispose();
    }
  });

  it('lists every model when showDeprecatedModels is enabled', async () => {
    await clearSetting();
    await vscode.workspace
      .getConfiguration('mightyMax')
      .update('showDeprecatedModels', true);
    const adapter = new CatalogAdapter(makeLogger());
    try {
      const models = await adapter.listModels();
      equal(models.length, BUILT_IN_CATALOG.length);
      ok(
        models.some((m) => m.id === 'MiniMax-M2.7'),
        'M2.7 must reappear when the setting is on',
      );
    } finally {
      adapter.dispose();
      await clearSetting();
    }
  });

  it('still resolves a deprecated model by id even while hidden', async () => {
    await clearSetting();
    const adapter = new CatalogAdapter(makeLogger());
    try {
      // The picker hides it...
      const listed = await adapter.listModels();
      ok(!listed.some((m) => m.id === 'MiniMax-M2.7'), 'must be hidden by default');
      // ...but an open session pinned to it keeps working.
      const resolved = await adapter.getModel('MiniMax-M2.7');
      ok(resolved, 'a hidden model must still resolve by id');
      equal(resolved?.thinkingStyle, 'openai');
      equal(resolved?.capabilities.toolCalling, 60);
      equal(resolved?.deprecated, true);
    } finally {
      adapter.dispose();
    }
  });

  it('carries the deprecated flag through to the resolved model info', async () => {
    await clearSetting();
    const adapter = new CatalogAdapter(makeLogger());
    try {
      equal((await adapter.getModel('MiniMax-M3'))?.deprecated, undefined);
      equal((await adapter.getModel('MiniMax-M1'))?.deprecated, true);
    } finally {
      adapter.dispose();
    }
  });

  it('reads the setting fresh rather than caching the first answer', async () => {
    await clearSetting();
    const adapter = new CatalogAdapter(makeLogger());
    try {
      equal((await adapter.listModels()).length, 2);
      await vscode.workspace
        .getConfiguration('mightyMax')
        .update('showDeprecatedModels', true);
      equal((await adapter.listModels()).length, BUILT_IN_CATALOG.length);
      await vscode.workspace
        .getConfiguration('mightyMax')
        .update('showDeprecatedModels', false);
      equal((await adapter.listModels()).length, 2);
    } finally {
      adapter.dispose();
      await clearSetting();
    }
  });
});