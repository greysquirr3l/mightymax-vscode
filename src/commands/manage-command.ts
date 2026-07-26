import { isKeySlot, type KeyProvider, type KeySlot } from '../ports/key-provider.js';
import type { Logger } from '../ports/logger.js';
import type { SecretStore } from '../ports/secret-store.js';
import { validateApiKey } from '../adapters/api-key-validator.js';
import { runConfigureUtilityModelsCommand } from './configure-utility-models.js';
import { buildStatusHeader } from './quickpick-header.js';
import { runFlightDeckView } from './flight-deck-view.js';
import type { SlotLabelMap } from '../lib/domain/slot-labels.js';

/**
 * T31 — Slot labels persist across restarts in a Memento-backed store.
 * The adapter wraps `vscode.ExtensionContext.globalState`; the test
 * double is an in-memory map exposed by `manage-command.test-helpers.ts`.
 */
export interface SlotLabelsStore {
  getAll(): Promise<SlotLabelMap>;
  set(map: SlotLabelMap): Promise<void>;
}

/**
 * runManageCommand — orchestrates the `mightyMax.manage` QuickPick UI.
 *
 * Offers four actions:
 *   - Set API key: prompts for a key (password-masked), validates it
 *     against the MiniMax /v1/models endpoint, and stores it on
 *     success. Invalid keys are rejected without persisting.
 *   - Set base URL: prompts for a new MiniMax base URL and writes it
 *     to the workspace setting. Empty input is rejected.
 *   - Test connection: re-validates the currently-stored key and shows
 *     a status message.
 *   - Clear API key: deletes the stored key.
 *
 * Cancellation, invalid input, and validation failures are all
 * handled silently (no error toast) except where the user explicitly
 * acted and got an unexpected result.
 *
 * Implementation: T06.
 */

const API_KEY_NAME = 'apiKey';
const BASE_URL_SETTING = 'baseUrl';

export interface ManagePickItem {
  label: string;
  description?: string;
  /**
   * T29 — non-selectable header rows use `kind: 'separator'`. Regular
   * CTA rows omit this so vscode's QuickPick treats them as selectable.
   */
  kind?: 'separator' | 'header';
  /** T29 — header rows must stick at the top; always true for separators. */
  alwaysShown?: boolean;
}

export interface ManageUi {
  showQuickPick(
    items: readonly ManagePickItem[],
    options?: { title?: string },
  ): Promise<ManagePickItem | undefined>;
  showInputBox(options?: {
    prompt?: string;
    password?: boolean;
    value?: string;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInfoMessage(message: string): Promise<string | undefined>;
  showErrorMessage(message: string): Promise<string | undefined>;
}

/** Fetches the current base URL and updates it. The extension wires the
 * real `vscode.workspace.getConfiguration('mightyMax')` here. */
export interface ManageConfig {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<unknown>;
}

export interface ManageDeps {
  logger: Logger;
  secretStore: SecretStore;
  keyProvider: KeyProvider;
  baseUrl: string;
  ui: ManageUi;
  /** Called once after a successful store or delete so the chat
   * provider can re-fire `onDidChangeLanguageModelChatInformation`. */
  fireChange: () => void;
  /** Optional fetch override used by tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Optional config override used by tests for the base-URL flow. */
  getConfig?: () => ManageConfig;
  /** T31 — slot labels persist across restarts via this Memento-backed store. */
  slotLabels?: SlotLabelsStore;
}

const PICK_ITEMS: readonly ManagePickItem[] = [
  {
    label: 'Set API key',
    description:
      'Store a new MiniMax API key on the active slot (validated against the models endpoint)',
  },
  {
    label: 'Manage API keys',
    description: 'View, set, clear, or rotate up to three stored API keys',
  },
  {
    label: 'Set base URL',
    description: 'Change the MiniMax endpoint (default: platform.minimax.io)',
  },
  { label: 'Test connection', description: 'Validate the currently-stored API key' },
  { label: 'Clear API key', description: 'Remove the stored MiniMax API key' },
  {
    label: 'Toggle auto-rotation',
    description:
      'Flip the mightyMax.enableAutoKeyRotation setting (visible label shows current state)',
  },
  {
    label: 'Configure utility models',
    description: 'Fix the BYOK "no utility model configured" error',
  },
] as const;

// T28 — auto-rotation toggle label is state-dependent, so it is
// computed per render rather than stored in the static PICK_ITEMS.
const AUTO_ROTATION_KEY = 'enableAutoKeyRotation';
const LOG_LEVEL_KEY = 'logLevel';
function autoRotationLabel(enabled: boolean): string {
  return `${enabled ? '●' : '○'} Auto-rotate on auth failure: ${enabled ? 'ON' : 'OFF'}`;
}
function readAutoRotationEnabled(deps: ManageDeps): boolean {
  const raw = deps.getConfig?.().get(AUTO_ROTATION_KEY);
  // The package.json default is `true`; treat anything-but-`false` as on.
  return raw !== false;
}

// T30 — three primary CTAs only. The "Set base URL" / "Test connection" /
// "Clear API key" / "Configure utility models" / "Toggle auto-rotation"
// entries are no longer top-level — they all live in the Settings submenu.
const PRIMARY_CTA_ADD = '➕ Add or rotate API key';
const PRIMARY_CTA_ROTATE = '⚠ Rotate to a healthy key';
const MANAGE_KEYS_PREFIX = '🔑 Manage keys';
const SETTINGS_LABEL = '⚙ Settings';

/** Subset of PICK_ITEMS handled inline (the rest delegate out). */
type InlinePick = 'Set API key' | 'Set base URL' | 'Test connection' | 'Clear API key';

function pickByLabel(label: string): ManagePickItem {
  const found = PICK_ITEMS.find((p) => p.label === label);
  if (!found) {
    throw new Error(`runManageCommand: unknown pick label "${label}"`);
  }
  return found;
}

export async function runManageCommand(deps: ManageDeps): Promise<void> {
  deps.logger.debug('Manage command: showing main pick');
  const autoRotationEnabled = readAutoRotationEnabled(deps);
  const storedKeys = await deps.keyProvider.listStoredKeys();
  const activeSlot = await deps.keyProvider.getActiveSlot();
  const healthySlots = await deps.keyProvider.listHealthySlots();
  // "Active in cooldown" only when the active slot has a key on file
  // AND it's not in the healthy set. With no keys stored, the CTA stays
  // in the onboarding "Add or rotate" state rather than warning about
  // a key the user hasn't added yet.
  const activeStored = storedKeys.some((k) => k.slot === activeSlot);
  const activeInCooldown = activeStored && !healthySlots.includes(activeSlot);
  const items = buildManagePickItems(autoRotationEnabled, storedKeys.length, activeInCooldown);
  const choice = await deps.ui.showQuickPick(items, {
    title: 'Mighty Max — manage connection',
  });
  if (!choice) {
    deps.logger.debug('Manage command: main pick dismissed');
    return;
  }

  // T28 — toggle dispatches before the static-label dispatch because
  // its label is state-dependent (`● … ON` vs `○ … OFF`). T30 — the
  // toggle now lives in the Settings submenu, but if a stale label
  // leaks in (e.g. user-driven config edit mid-pick), still handle it.
  if (choice.label === autoRotationLabel(true) || choice.label === autoRotationLabel(false)) {
    await handleToggleAutoRotation(deps, autoRotationEnabled);
    return;
  }

  if (choice.label === PRIMARY_CTA_ADD || choice.label === PRIMARY_CTA_ROTATE) {
    // T30 — primary CTA flows through the same validation+storage as
    // the old "Set API key"; the rotate-warning variant just carries
    // a different label so the user knows they're swapping.
    await handleSetApiKey(deps);
  } else if (choice.label.startsWith(MANAGE_KEYS_PREFIX)) {
    // T31 — Manage-keys CTA opens the per-slot flight-deck view, which
    // dispatches into per-slot action sheets (Set / Test / Clear / Make
    // active / Rename).
    await runFlightDeckForManage(deps);
  } else if (choice.label === SETTINGS_LABEL) {
    await runSettingsMenu(deps);
  }
}

// Build the runtime pick list. The status header (T29) sits at index 0;
// the three flight-deck CTAs follow. The primary CTA's label and the
// Manage-keys count are derived from live state per render.
function buildManagePickItems(
  autoRotationEnabled: boolean,
  keyCount: number,
  activeInCooldown: boolean,
): readonly ManagePickItem[] {
  const primaryLabel = activeInCooldown
    ? `${PRIMARY_CTA_ROTATE} (slot in cooldown)`
    : PRIMARY_CTA_ADD;
  const primaryDescription = activeInCooldown
    ? 'Pick to set a new key — current active is in cooldown'
    : 'Set or rotate the key on the active slot';

  const header = buildStatusHeader({
    activeSlot: 1,
    stored: [1, 2, 3].slice(0, keyCount === 0 ? 0 : Math.max(keyCount, 1)) as readonly KeySlot[],
    cooldown: new Map(),
    autoRotateEnabled: autoRotationEnabled,
  });

  const items: ManagePickItem[] = [
    {
      label: header.label,
      kind: 'separator',
      alwaysShown: true,
      ...(header.description !== undefined ? { description: header.description } : {}),
    },
    {
      label: primaryLabel,
      description: primaryDescription,
    },
    {
      label: `${MANAGE_KEYS_PREFIX} (${String(keyCount)} ${keyCount === 1 ? 'slot' : 'slots'})`,
      description: 'View, set, clear, or rotate stored API keys',
    },
    {
      label: SETTINGS_LABEL,
      description: 'Base URL, log level, auto-rotation, utility models',
    },
  ];
  return items;
}

// T31 — open the per-slot flight-deck view from the "Manage keys"
// CTA. Loads slot labels from the Memento-backed store (or empty when
// no store is wired), runs the view, and persists any label changes
// the user made via the "Rename slot" action.
//
// The `runFlightDeckView` orchestrator takes a snapshot of labels at
// the start of the flow; subsequent renames happen in-memory inside
// the action sheet. For T31 we propagate the final map back via a
// post-write — the in-memory `labels` map carried in the closure IS
// the persisted state at flow exit. (The view itself is pure over
// its inputs, but the action-sheet handlers mutate a working map
// passed by reference via a tiny adapter shim.)
async function runFlightDeckForManage(deps: ManageDeps): Promise<void> {
  const initialLabels = (await deps.slotLabels?.getAll()) ?? new Map<KeySlot, string>();
  // The `Map(Iterable<K,V>)` constructor types its return as `Map<any, any>`
  // under TypeScript's lib (it predates ReadonlyMap-aware constructor
  // signatures). Spread explicitly so we keep `Map<KeySlot, string>`.
  const workingLabels = new Map<KeySlot, string>(
    initialLabels instanceof Map ? initialLabels : [...initialLabels],
  );

  await runFlightDeckView({
    slot: 1, // overwritten per-action by runSlotActionSheet
    keyProvider: deps.keyProvider,
    ui: deps.ui,
    logger: deps.logger,
    labels: workingLabels,
    fireChange: deps.fireChange,
    baseUrl: deps.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Persist any label changes the user made during the flow.
  if (deps.slotLabels !== undefined && !mapsEqual(initialLabels, workingLabels)) {
    await deps.slotLabels.set(workingLabels);
  }
}

function mapsEqual(a: ReadonlyMap<KeySlot, string>, b: ReadonlyMap<KeySlot, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

// T30 — Settings submenu. Five entries: Set base URL, Test all stored
// keys, Configure utility models, Log level (with current value), and
// Auto-rotate on auth failure (toggle).
async function runSettingsMenu(deps: ManageDeps): Promise<void> {
  const autoRotationEnabled = readAutoRotationEnabled(deps);
  const logLevelRaw = deps.getConfig?.().get(LOG_LEVEL_KEY);
  const logLevel = typeof logLevelRaw === 'string' ? logLevelRaw : 'info';

  const settingsItems: ManagePickItem[] = [
    {
      label: 'Set base URL',
      description: 'Change the MiniMax endpoint (default: platform.minimax.io)',
    },
    {
      label: 'Test all stored keys',
      description: 'Validate each stored key against the models endpoint',
    },
    {
      label: 'Configure utility models',
      description: 'Fix the BYOK "no utility model configured" error',
    },
    {
      label: `Log level: ${logLevel}`,
      description: 'Change the chat-provider log level (debug / info / warn / error)',
    },
    {
      label: autoRotationLabel(autoRotationEnabled),
      description: `Currently ${autoRotationEnabled ? 'ON' : 'OFF'} — pick to flip`,
    },
  ];

  const choice = await deps.ui.showQuickPick(settingsItems, {
    title: 'Mighty Max — settings',
  });
  if (!choice) {
    deps.logger.debug('Manage command: settings submenu dismissed');
    return;
  }

  if (choice.label === 'Set base URL') {
    await handleSetBaseUrl(deps);
  } else if (choice.label === 'Test all stored keys') {
    const stored = await deps.keyProvider.listStoredKeys();
    await handleTestAllKeys(deps, stored);
  } else if (choice.label === 'Configure utility models') {
    await handleConfigureUtilityModels(deps);
  } else if (choice.label.startsWith('Log level:')) {
    await handleLogLevel(deps, logLevel);
  } else if (
    choice.label === autoRotationLabel(true) ||
    choice.label === autoRotationLabel(false)
  ) {
    await handleToggleAutoRotation(deps, autoRotationEnabled);
  }
}

async function handleLogLevel(deps: ManageDeps, current: string): Promise<void> {
  const next = await deps.ui.showQuickPick(
    [
      { label: 'debug', description: 'Verbose — every chat-provider call' },
      { label: 'info', description: 'Operational — request start/end, key rotation' },
      { label: 'warn', description: 'Failures and recoverable errors only' },
      { label: 'error', description: 'Hard failures only' },
    ],
    { title: 'Mighty Max — log level' },
  );
  if (!next) return;
  if (next.label === current) {
    await deps.ui.showInfoMessage(`Log level is already ${current}.`);
    return;
  }
  const cfg = deps.getConfig?.();
  if (!cfg) {
    await deps.ui.showErrorMessage('Log level cannot be changed in this environment.');
    return;
  }
  await cfg.update(LOG_LEVEL_KEY, next.label);
  deps.logger.info('Manage command: log level updated', { from: current, to: next.label });
  await deps.ui.showInfoMessage(`Log level is now ${next.label}.`);
}

async function handleToggleAutoRotation(deps: ManageDeps, currentValue: boolean): Promise<void> {
  const nextValue = !currentValue;
  const cfg = deps.getConfig?.();
  if (!cfg) {
    deps.logger.warn('Manage command: no config provider, cannot toggle auto-rotation');
    await deps.ui.showErrorMessage('Auto-rotation cannot be toggled in this environment.');
    return;
  }
  await cfg.update(AUTO_ROTATION_KEY, nextValue);
  deps.logger.info('Manage command: auto-rotation toggled', {
    from: currentValue,
    to: nextValue,
  });
  deps.fireChange();
  await deps.ui.showInfoMessage(
    `Auto-rotation on auth failure is now ${nextValue ? 'ON' : 'OFF'}.`,
  );
}

/** Inline pick labels excluding "Configure utility models" (delegated). */
export type InlinePickLabel = InlinePick;

async function handleSetApiKey(deps: ManageDeps): Promise<void> {
  const key = await deps.ui.showInputBox({
    prompt: 'Enter your MiniMax API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    deps.logger.debug('Manage command: API key input dismissed');
    return;
  }
  const trimmed = key.trim();
  if (trimmed === '') {
    deps.logger.warn('Manage command: API key input was empty');
    await deps.ui.showErrorMessage('API key must not be empty.');
    return;
  }

  deps.logger.info('Manage command: validating new API key');
  const result = await validateApiKey(trimmed, deps.baseUrl, deps.fetchImpl);
  if (!result.ok) {
    deps.logger.warn('Manage command: API key validation failed', { reason: result.reason });
    if (result.reason === 'unauthorized') {
      await deps.ui.showErrorMessage(
        'That API key was rejected by MiniMax. It has not been stored.',
      );
    } else if (result.reason === 'network') {
      await deps.ui.showErrorMessage(
        'Could not reach MiniMax to validate the key. Check your network and try again.',
      );
    } else {
      await deps.ui.showErrorMessage(
        'MiniMax returned an unexpected response. The key has not been stored.',
      );
    }
    return;
  }

  await deps.secretStore.storeSecret(API_KEY_NAME, trimmed);
  deps.logger.info('Manage command: API key stored', { modelCount: result.modelIds.length });
  deps.fireChange();
  await deps.ui.showInfoMessage(
    result.modelIds.length === 0
      ? 'API key saved. The catalog will refresh on the next provider call.'
      : `API key saved. MiniMax reports ${result.modelIds.length} model(s) available.`,
  );
}

async function handleSetBaseUrl(deps: ManageDeps): Promise<void> {
  const currentRaw = deps.getConfig?.().get(BASE_URL_SETTING);
  const current = typeof currentRaw === 'string' ? currentRaw : deps.baseUrl;
  const next = await deps.ui.showInputBox({
    prompt: 'Enter the MiniMax base URL',
    value: current,
    ignoreFocusOut: true,
  });
  if (next === undefined) {
    deps.logger.debug('Manage command: base URL input dismissed');
    return;
  }
  const trimmed = next.trim();
  if (trimmed === '') {
    deps.logger.warn('Manage command: base URL input was empty');
    await deps.ui.showErrorMessage('Base URL must not be empty.');
    return;
  }
  const cfg = deps.getConfig?.();
  if (!cfg) {
    deps.logger.warn('Manage command: no config provider, cannot persist base URL');
    await deps.ui.showErrorMessage('Base URL cannot be persisted in this environment.');
    return;
  }
  await cfg.update(BASE_URL_SETTING, trimmed);
  deps.logger.info('Manage command: base URL updated');
  await deps.ui.showInfoMessage('Base URL saved. The next request will use the new endpoint.');
}

async function handleTestConnection(deps: ManageDeps): Promise<void> {
  const stored = await deps.secretStore.getSecret(API_KEY_NAME);
  if (stored === undefined) {
    deps.logger.info('Manage command: test connection with no stored key');
    await deps.ui.showErrorMessage('No API key is stored. Use "Set API key" first.');
    return;
  }
  deps.logger.info('Manage command: testing connection with stored key');
  const result = await validateApiKey(stored, deps.baseUrl, deps.fetchImpl);
  if (result.ok) {
    deps.logger.info('Manage command: test connection succeeded', {
      modelCount: result.modelIds.length,
    });
    await deps.ui.showInfoMessage(
      result.modelIds.length === 0
        ? 'Connection succeeded. MiniMax returned no models for this key.'
        : `Connection succeeded. ${result.modelIds.length} model(s) available.`,
    );
    return;
  }
  if (result.reason === 'unauthorized') {
    deps.logger.warn('Manage command: test connection unauthorized');
    await deps.ui.showErrorMessage(
      'Connection failed: the stored API key was rejected. Set a new one.',
    );
  } else if (result.reason === 'network') {
    deps.logger.warn('Manage command: test connection network error');
    await deps.ui.showErrorMessage('Connection failed: could not reach MiniMax.');
  } else {
    deps.logger.warn('Manage command: test connection malformed response');
    await deps.ui.showErrorMessage('Connection failed: MiniMax returned an unexpected response.');
  }
}

async function handleClearApiKey(deps: ManageDeps): Promise<void> {
  const had = await deps.secretStore.hasSecret(API_KEY_NAME);
  if (!had) {
    deps.logger.info('Manage command: clear requested with no stored key');
    await deps.ui.showInfoMessage('No API key was stored.');
    return;
  }
  await deps.secretStore.deleteSecret(API_KEY_NAME);
  deps.logger.info('Manage command: API key cleared');
  deps.fireChange();
  await deps.ui.showInfoMessage('API key cleared.');
}

/**
 * T20: routes the "Configure utility models" pick into the dedicated
 * configure-utility-models command. Reuses the same `ManageUi` shim
 * via `as unknown as ConfigureUtilityUi` — both interfaces are
 * structurally identical at the call sites we use here, so the
 * cast is sound and keeps the manage-command module free of new
 * UI fields.
 */
async function handleConfigureUtilityModels(deps: ManageDeps): Promise<void> {
  deps.logger.info('Manage command: routing to configure-utility-models');
  await runConfigureUtilityModelsCommand({
    logger: deps.logger,
    ui: deps.ui,
    getConfig: () => ({
      update: async (key, value) => {
        if (!deps.getConfig) {
          throw new Error('Manage command: getConfig is not wired');
        }
        return deps.getConfig().update(key, value);
      },
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-key rotation (T25)
//
// The "Manage API keys" submenu lets the user inspect up to 3 stored
// keys (the original `apiKey` slot plus `apiKey2` and `apiKey3`), set
// or clear each one independently, change the active slot (the
// preferred pick), and run a connectivity test against each stored
// key in turn. The single-key "Set API key" entry above is preserved
// as a shortcut — it always writes to the active slot.
// ─────────────────────────────────────────────────────────────────────────────

const KEY_SLOT_PICK_LABEL = (slot: KeySlot): string => `Slot ${String(slot)}`;
const ACTIVE_SLOT_PICK_LABEL = 'Active slot';

async function handleManageApiKeys(deps: ManageDeps): Promise<void> {
  deps.logger.debug('Manage command: showing API keys submenu');
  const stored = await deps.keyProvider.listStoredKeys();
  const activeSlot = await deps.keyProvider.getActiveSlot();
  const healthy = await deps.keyProvider.listHealthySlots();

  const storedSet = new Set(stored.map((k) => k.slot));
  const healthySet = new Set(healthy);
  const slotLine = (slot: KeySlot): string => {
    const isStored = storedSet.has(slot);
    const isActive = slot === activeSlot;
    const isHealthy = healthySet.has(slot);
    // T25 — only show the health flag for slots that actually have
    // a key. An empty slot isn't "cooldown", it's just empty; the
    // earlier code rendered "empty · cooldown" which was wrong.
    const flags: string[] = [isStored ? 'stored' : 'empty'];
    if (isStored) flags.push(isHealthy ? 'healthy' : 'cooldown');
    if (isActive) flags.push('★ active');
    return `${KEY_SLOT_PICK_LABEL(slot)} — ${flags.join(' · ')}`;
  };

  const items: ManagePickItem[] = [
    {
      label: 'View API keys',
      description: slotLine(1) + ' / ' + slotLine(2) + ' / ' + slotLine(3),
    },
    { label: 'Set key 1', description: 'Store a new key in slot 1' },
    { label: 'Set key 2', description: 'Store a new key in slot 2' },
    { label: 'Set key 3', description: 'Store a new key in slot 3' },
    { label: 'Clear key 1', description: 'Remove the key stored in slot 1' },
    { label: 'Clear key 2', description: 'Remove the key stored in slot 2' },
    { label: 'Clear key 3', description: 'Remove the key stored in slot 3' },
    {
      label: ACTIVE_SLOT_PICK_LABEL,
      description: `Switch the active slot (currently: ${KEY_SLOT_PICK_LABEL(activeSlot)})`,
    },
    {
      label: 'Test all stored keys',
      description: 'Validate each stored key against the models endpoint',
    },
  ];

  const choice = await deps.ui.showQuickPick(items, {
    title: 'Mighty Max — manage API keys',
  });
  if (!choice) return;

  if (choice.label === 'View API keys') {
    const summary = stored
      .map(
        (k) => `${KEY_SLOT_PICK_LABEL(k.slot)}: stored${k.slot === activeSlot ? ' (active)' : ''}`,
      )
      .join('\n');
    const empty = stored.length === 0 ? 'No API keys are stored.' : '';
    await deps.ui.showInfoMessage(
      `${empty ? empty + '\n' : ''}${summary}\n\nHealthy slots: ${healthy.length} / ${String(stored.length) || '0'}`,
    );
    return;
  }

  if (choice.label === 'Set key 1') return handleSetKeyForSlot(deps, 1);
  if (choice.label === 'Set key 2') return handleSetKeyForSlot(deps, 2);
  if (choice.label === 'Set key 3') return handleSetKeyForSlot(deps, 3);

  if (choice.label === 'Clear key 1') return handleClearKeyForSlot(deps, 1);
  if (choice.label === 'Clear key 2') return handleClearKeyForSlot(deps, 2);
  if (choice.label === 'Clear key 3') return handleClearKeyForSlot(deps, 3);

  if (choice.label === ACTIVE_SLOT_PICK_LABEL)
    return handleSetActiveSlot(deps, activeSlot, storedSet);

  if (choice.label === 'Test all stored keys') return handleTestAllKeys(deps, stored);
}

async function handleSetKeyForSlot(deps: ManageDeps, slot: KeySlot): Promise<void> {
  const key = await deps.ui.showInputBox({
    prompt: `Enter your MiniMax API key for slot ${String(slot)}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  const trimmed = key.trim();
  if (trimmed === '') {
    await deps.ui.showErrorMessage('API key must not be empty.');
    return;
  }
  deps.logger.info(`Manage command: validating new API key for slot ${String(slot)}`);
  const result = await validateApiKey(trimmed, deps.baseUrl, deps.fetchImpl);
  if (!result.ok) {
    if (result.reason === 'unauthorized') {
      await deps.ui.showErrorMessage(
        `That API key was rejected by MiniMax. Slot ${String(slot)} has not been updated.`,
      );
    } else if (result.reason === 'network') {
      await deps.ui.showErrorMessage(
        'Could not reach MiniMax to validate the key. Check your network and try again.',
      );
    } else {
      await deps.ui.showErrorMessage(
        'MiniMax returned an unexpected response. The key has not been stored.',
      );
    }
    return;
  }
  await deps.keyProvider.setKey(slot, trimmed);
  deps.logger.info(`Manage command: API key stored for slot ${String(slot)}`);
  deps.fireChange();
  await deps.ui.showInfoMessage(
    `API key saved for slot ${String(slot)}. MiniMax reports ${result.modelIds.length} model(s) available.`,
  );
}

async function handleClearKeyForSlot(deps: ManageDeps, slot: KeySlot): Promise<void> {
  const stored = await deps.keyProvider.listStoredKeys();
  if (!stored.some((k) => k.slot === slot)) {
    await deps.ui.showInfoMessage(`Slot ${String(slot)} has no stored key.`);
    return;
  }
  await deps.keyProvider.setKey(slot, null);
  deps.logger.info(`Manage command: API key cleared for slot ${String(slot)}`);
  deps.fireChange();
  await deps.ui.showInfoMessage(`API key cleared for slot ${String(slot)}.`);
}

async function handleSetActiveSlot(
  deps: ManageDeps,
  currentActive: KeySlot,
  storedSet: Set<KeySlot>,
): Promise<void> {
  const candidates: KeySlot[] = storedSet.size > 0 ? Array.from(storedSet).sort() : [1, 2, 3];
  const items: ManagePickItem[] = candidates.map((slot) => ({
    label: KEY_SLOT_PICK_LABEL(slot),
    description:
      slot === currentActive ? 'currently active' : storedSet.has(slot) ? 'stored' : 'empty',
  }));
  const choice = await deps.ui.showQuickPick(items, {
    title: 'Mighty Max — choose active slot',
  });
  if (!choice) return;
  // T25 — validate the parsed slot before persisting it. Without
  // this, a malformed label (or a future localization change) could
  // slip `NaN` into `globalState['mightyMax.activeKeySlot']`, which
  // `isKeySlot()` rejects and silently falls back to slot 1 — not
  // what the user picked. Reject anything that isn't 1, 2, or 3.
  const parsed = Number(choice.label.replace(/^Slot /, ''));
  if (!isKeySlot(parsed)) {
    deps.logger.error('Manage command: unexpected active-slot pick label', {
      label: choice.label,
      parsed,
    });
    await deps.ui.showErrorMessage(
      `Could not parse the chosen slot from "${choice.label}". Pick a "Slot N" entry.`,
    );
    return;
  }
  const slot: KeySlot = parsed;
  if (slot === currentActive) {
    await deps.ui.showInfoMessage(`Slot ${String(slot)} is already the active slot.`);
    return;
  }
  await deps.keyProvider.setActiveSlot(slot);
  deps.logger.info(`Manage command: active slot switched to ${String(slot)}`);
  deps.fireChange();
  await deps.ui.showInfoMessage(`Active slot set to ${String(slot)}.`);
}

async function handleTestAllKeys(
  deps: ManageDeps,
  stored: ReadonlyArray<{ slot: KeySlot; key: string }>,
): Promise<void> {
  if (stored.length === 0) {
    await deps.ui.showInfoMessage('No API keys are stored to test.');
    return;
  }
  for (const entry of stored) {
    deps.logger.info(`Manage command: testing slot ${String(entry.slot)}`);
    const result = await validateApiKey(entry.key, deps.baseUrl, deps.fetchImpl);
    if (result.ok) {
      await deps.ui.showInfoMessage(
        `Slot ${String(entry.slot)}: OK — ${result.modelIds.length} model(s) available.`,
      );
    } else if (result.reason === 'unauthorized') {
      await deps.ui.showErrorMessage(
        `Slot ${String(entry.slot)}: rejected (401). Consider replacing this key.`,
      );
    } else if (result.reason === 'network') {
      await deps.ui.showErrorMessage(`Slot ${String(entry.slot)}: network error.`);
    } else {
      await deps.ui.showErrorMessage(`Slot ${String(entry.slot)}: unexpected response.`);
    }
  }
}

// Internal export for tests that want to drive the per-flow helpers
// without re-implementing the pick routing. Not part of the public API.
export const __testing = {
  pickByLabel,
  handleSetApiKey,
  handleSetBaseUrl,
  handleTestConnection,
  handleClearApiKey,
  PICK_ITEMS,
  API_KEY_NAME,
  BASE_URL_SETTING,
  KEY_SLOT_PICK_LABEL,
  ACTIVE_SLOT_PICK_LABEL,
  handleManageApiKeys,
  handleSetKeyForSlot,
  handleClearKeyForSlot,
  handleSetActiveSlot,
  handleTestAllKeys,
};
