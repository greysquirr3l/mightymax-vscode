import type { Logger } from '../ports/logger.js';
import type { KeyProvider } from '../ports/key-provider.js';
import type { ModelCatalog } from '../ports/model-catalog.js';

export interface DiagnosticsUi {
  showInfoMessage(message: string): Promise<string | undefined>;
}

export interface DiagnosticsConfig {
  get(key: string): unknown;
}

export interface MiniMaxDiagnosticsDeps {
  readonly logger: Logger;
  readonly keyProvider: KeyProvider;
  readonly catalog: ModelCatalog;
  readonly ui: DiagnosticsUi;
  readonly baseUrl: string;
  readonly vscodeVersion: string;
  readonly hasLanguageModelThinkingPart: boolean;
  readonly getConfig: () => DiagnosticsConfig;
}

/**
 * Build a concise, read-only MiniMax integration report. The report never
 * receives or derives API-key material: it only uses slot counts and health.
 */
export async function runShowDiagnosticsCommand(deps: MiniMaxDiagnosticsDeps): Promise<void> {
  const [stored, healthy, activeSlot, models] = await Promise.all([
    deps.keyProvider.listStoredKeys(),
    deps.keyProvider.listHealthySlots(),
    deps.keyProvider.getActiveSlot(),
    deps.catalog.listModels(),
  ]);
  const config = deps.getConfig();
  const thinkingMode = config.get('m3ThinkingMode') === 'disabled' ? 'disabled' : 'adaptive';
  const nativeTokenCounting = config.get('enableNativeTokenCounting') !== false;
  const toolResultBudget = readBoundedNumber(config.get('toolResultMaxChars'), 4096, 512, 65_536);
  const autoRotation = config.get('enableAutoKeyRotation') !== false;
  const activeStored = stored.some((entry) => entry.slot === activeSlot);
  const activeHealthy = healthy.includes(activeSlot);

  const report = [
    'Mighty Max — MiniMax Copilot Chat diagnostics',
    '',
    `Endpoint: ${safeEndpoint(deps.baseUrl)}`,
    `Host: VS Code ${deps.vscodeVersion}; collapsible thinking: ${deps.hasLanguageModelThinkingPart ? 'available' : 'fallback data part'}`,
    `Models: ${String(models.length)} available`,
    `Keys: ${String(stored.length)}/3 stored; ${String(healthy.length)} healthy; active slot ${String(activeSlot)}: ${activeStored ? (activeHealthy ? 'healthy' : 'cooldown') : 'empty'}`,
    `Auto-rotation: ${autoRotation ? 'on' : 'off'}`,
    `M3 thinking: ${thinkingMode}`,
    `Native M3 token counting: ${nativeTokenCounting ? 'on (cached with heuristic fallback)' : 'off (heuristic only)'}`,
    `Tool-result budget: ${String(toolResultBudget)} characters per result`,
    'Usage: streamed prompt, completion, and cache metadata is emitted when MiniMax provides it.',
  ].join('\n');

  deps.logger.info('Mighty Max diagnostics displayed', {
    modelCount: models.length,
    storedKeyCount: stored.length,
    healthyKeyCount: healthy.length,
    activeSlot,
    thinkingMode,
    nativeTokenCounting,
    toolResultBudget,
  });
  await deps.ui.showInfoMessage(report);
}

function safeEndpoint(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '(invalid base URL)';
  }
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export const __testing = { safeEndpoint, readBoundedNumber };
