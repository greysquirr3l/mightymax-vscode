import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'greysquirr3l.mighty-max';
const MINIMAX_VENDOR = 'minimax';
const EXPECTED_MODEL_IDS = [
  'MiniMax-M1',
  'MiniMax-M2',
  'MiniMax-M2.5',
  'MiniMax-M2.7',
  'MiniMax-M3',
];

suite('Extension smoke', () => {
  test('activates without throwing', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not registered`);

    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, 'extension failed to activate');
  });

  test('exposes the management command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('mightyMax.manage'), 'mightyMax.manage command is not registered');
  });

  test('exposes the configured settings', () => {
    const config = vscode.workspace.getConfiguration('mightyMax');
    assert.ok(config.has('baseUrl'), 'mightyMax.baseUrl setting is missing');
    assert.ok(config.has('logLevel'), 'mightyMax.logLevel setting is missing');
  });
});

suite('Manifest contract', () => {
  test('package.json declares languageModelChatProviders under vendor "minimax"', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension not found');
    const contributes = extension.packageJSON.contributes as Record<string, unknown>;
    const providers = contributes.languageModelChatProviders as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(providers) && providers.length > 0, 'no languageModelChatProviders');
    assert.equal(providers[0]?.vendor, 'minimax');
    // 0.3.1 replaced the deprecated `managementCommand` property with
    // the new `configuration.properties` schema (VS Code 1.109+). Pin
    // both the removal and the replacement's apiKey secret setting.
    assert.equal(providers[0]?.managementCommand, undefined);
    const configuration = providers[0]?.configuration as Record<string, unknown> | undefined;
    assert.ok(configuration, 'provider configuration block is missing');
    const properties = configuration.properties as Record<string, Record<string, unknown>>;
    assert.ok(properties?.apiKey, 'configuration.properties.apiKey is missing');
    assert.equal(properties.apiKey.type, 'string');
    assert.equal(properties.apiKey.secret, true);
  });

  test('package.json sets engines.vscode >= 1.104.0', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension not found');
    const engines = extension.packageJSON.engines as Record<string, string>;
    const versionRange = engines.vscode;
    assert.ok(versionRange, 'engines.vscode is missing');
    // Strip leading ^ or ~ and require the major version to be 1.104 or later.
    const match = /(\d+)\.(\d+)/.exec(versionRange);
    assert.ok(match, `engines.vscode is not a valid range: ${versionRange}`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    assert.ok(
      major > 1 || (major === 1 && minor >= 104),
      `engines.vscode must be >= 1.104.0, got ${versionRange}`,
    );
  });

  test('package.json declares capabilities.untrustedWorkspaces (limited)', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension not found');
    const capabilities = extension.packageJSON.capabilities as Record<string, unknown>;
    const untrusted = capabilities.untrustedWorkspaces as { supported?: string } | undefined;
    assert.ok(untrusted, 'capabilities.untrustedWorkspaces is missing');
    assert.equal(untrusted.supported, 'limited');
  });
});

suite('Language model catalog (T02)', () => {
  test('VS Code can select the minimax vendor', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MINIMAX_VENDOR });
    assert.ok(Array.isArray(models), 'selectChatModels must return an array');
    // Security design: empty list when no API key configured (silent mode)
    // This is expected behavior in CI and first-run scenarios
  });

  test('every expected M-series model id is present (when API key configured)', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MINIMAX_VENDOR });
    if (models.length === 0) {
      // No API key configured - security by design, skip model-specific assertions
      return;
    }
    const ids = new Set(models.map((m) => m.id));
    for (const id of EXPECTED_MODEL_IDS) {
      assert.ok(ids.has(id), `expected model id ${id} missing from the catalog`);
    }
  });

  test('every catalog entry has the minimax family and a non-empty display name', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MINIMAX_VENDOR });
    if (models.length === 0) {
      // No API key configured - security by design
      return;
    }
    for (const m of models) {
      assert.equal(m.family, MINIMAX_VENDOR, `${m.id} family must be "minimax"`);
      assert.ok(typeof m.name === 'string' && m.name.length > 0, `${m.id} needs a display name`);
      assert.ok(typeof m.vendor === 'string' && m.vendor.length > 0, `${m.id} needs a vendor`);
    }
  });

  test('every entry has a positive maxInputTokens budget', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MINIMAX_VENDOR });
    if (models.length === 0) {
      // No API key configured - security by design
      return;
    }
    for (const m of models) {
      assert.ok(m.maxInputTokens > 0, `${m.id} maxInputTokens must be > 0`);
    }
  });

  test('M3 has the largest input budget (1M+ ctx) and is a distinct id from M2.x', async () => {
    const models = await vscode.lm.selectChatModels({ vendor: MINIMAX_VENDOR });
    if (models.length === 0) {
      // No API key configured - security by design
      return;
    }
    const m3 = models.find((m) => m.id === 'MiniMax-M3');
    const m2 = models.find((m) => m.id === 'MiniMax-M2');
    assert.ok(m3 && m2, 'both M3 and M2 must be present');
    assert.ok(
      m3.maxInputTokens > m2.maxInputTokens,
      `M3 (${m3.maxInputTokens}) must have a larger input budget than M2 (${m2.maxInputTokens})`,
    );
  });
});

suite('API key lifecycle (T06)', () => {
  test('mightyMax.manage command is registered and discoverable', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('mightyMax.manage'), 'mightyMax.manage must be registered');
  });

  test.skip('mightyMax.manage runs without throwing (UI is user-driven)', async () => {
    // SKIP: In the test host, vscode.window.showQuickPick does NOT return
    // immediately when there's no input source - it hangs waiting for user
    // interaction, causing this test to timeout in CI. The command is
    // thoroughly tested via unit tests in manage-command.test.ts, and the
    // command registration is verified by the "exposes the management
    // command" test above. UI interaction testing is not reliable in the
    // VS Code test host without mocking the UI layer.
    await assert.doesNotReject(async () => {
      // vscode.commands.executeCommand returns Thenable; await it.
      await vscode.commands.executeCommand('mightyMax.manage');
    }, 'mightyMax.manage should not throw when invoked');
  });
});
