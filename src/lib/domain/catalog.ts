/**
 * Domain: model catalog.
 *
 * Pure, framework-free. T02 ships the static M-series catalog and the
 * pure function that merges a live list (e.g. from the MiniMax
 * `/v1/models` endpoint) with the static list, filling sane defaults
 * for any model we don't have curated data for.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

import type { ModelCapabilities, ModelInfo, ThinkingStyle } from '../../ports/model-catalog.js';

export type CatalogEntry = ModelInfo;

export interface CatalogValidationError {
  code: 'duplicate-id' | 'invalid-capability' | 'invalid-token-budget' | 'missing-required-field';
  modelId: string;
  message: string;
}

/**
 * Validate a catalog. Returns the list of errors found; an empty list
 * means the catalog is acceptable. Pure function — no I/O, no side effects.
 */
export function validateCatalog(entries: ReadonlyArray<CatalogEntry>): CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!entry.id || typeof entry.id !== 'string') {
      errors.push({
        code: 'missing-required-field',
        modelId: String(entry.id ?? '<empty>'),
        message: 'Model entry is missing the `id` field',
      });
      continue;
    }

    if (seen.has(entry.id)) {
      errors.push({
        code: 'duplicate-id',
        modelId: entry.id,
        message: `Duplicate model id: ${entry.id}`,
      });
    }
    seen.add(entry.id);

    const capability = validateCapabilities(entry.capabilities);
    if (capability) {
      errors.push({ code: 'invalid-capability', modelId: entry.id, message: capability });
    }

    if (entry.maxInputTokens <= 0 || entry.maxOutputTokens <= 0) {
      errors.push({
        code: 'invalid-token-budget',
        modelId: entry.id,
        message: `Token budgets must be positive (got ${entry.maxInputTokens}/${entry.maxOutputTokens})`,
      });
    }
  }

  return errors;
}

function validateCapabilities(cap: ModelCapabilities): string | undefined {
  if (typeof cap.toolCalling !== 'boolean') return 'capabilities.toolCalling must be a boolean';
  if (typeof cap.imageInput !== 'boolean') return 'capabilities.imageInput must be a boolean';
  if (typeof cap.thinking !== 'boolean') return 'capabilities.thinking must be a boolean';
  return undefined;
}

// -----------------------------------------------------------------------------
// Static built-in catalog
// -----------------------------------------------------------------------------

/** Vendor id used in the manifest and on every catalog entry. */
export const MINIMAX_VENDOR = 'minimax';

/** Family id used for picker grouping (all MiniMax models share this). */
export const MINIMAX_FAMILY = 'minimax';

/**
 * Default output budget for entries that don't ship with a known output
 * limit. 8 192 tokens matches what M2.7 / M2.5 / M2 advertise; M3 doubles
 * the input headroom but keeps the same output ceiling.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Format a token budget for the `detail` field shown in the picker.
 *  - 1 048 576 -> "1M"
 *  -   196 608 -> "200K"
 *  -    32 768 -> "32K"
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return String(tokens);
}

/**
 * The static built-in catalog. Numbers are honest defaults based on the
 * MiniMax public documentation as of T02. They can be tightened later
 * without changing call sites because the live-merge layer
 * (`mergeCatalog`) overrides them when the API disagrees.
 *
 *  - M3   — 1 000 000 ctx / 128 000 out, image input, tool calling,
 *            native thinking (Anthropic-style thinking blocks).
 *            Token budgets mirror the canonical `models.dev` entry for
 *            the `minimax` provider so VS Code's context-window widget
 *            and the utility-model budget math stay accurate. The
 *            chat-provider still clamps the actual request's
 *            `max_tokens` to 32K (opencode OUTPUT_TOKEN_MAX); the
 *            catalog value drives UI, not the request body.
 *  - M2.7 — 196 608 ctx, tool calling, OpenAI-style reasoning deltas.
 *  - M2.5 — 196 608 ctx, tool calling, OpenAI-style reasoning deltas.
 *  - M2   — 196 608 ctx, tool calling, OpenAI-style reasoning deltas,
 *            structured outputs.
 *  - M1   — 32 768 ctx, tool calling, no native thinking.
 */
export const BUILT_IN_CATALOG: ReadonlyArray<CatalogEntry> = Object.freeze([
  Object.freeze({
    id: 'MiniMax-M3',
    displayName: 'M3 (MiniMax)',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: Object.freeze({
      toolCalling: true,
      imageInput: true,
      thinking: true,
    }),
    thinkingStyle: 'anthropic' as ThinkingStyle,
    detail: '1M ctx · 128K out · image + tools + thinking',
  }),
  Object.freeze({
    id: 'MiniMax-M2.7',
    displayName: 'M2.7 (MiniMax)',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      toolCalling: true,
      imageInput: true,
      thinking: true,
    }),
    thinkingStyle: 'openai' as ThinkingStyle,
    detail: '200K ctx · 8K out · image + tools + reasoning',
  }),
  Object.freeze({
    id: 'MiniMax-M2.5',
    displayName: 'M2.5 (MiniMax)',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      toolCalling: true,
      imageInput: true,
      thinking: true,
    }),
    thinkingStyle: 'openai' as ThinkingStyle,
    detail: '200K ctx · 8K out · image + tools + reasoning',
  }),
  Object.freeze({
    id: 'MiniMax-M2',
    displayName: 'M2 (MiniMax)',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      toolCalling: true,
      imageInput: true,
      thinking: true,
    }),
    thinkingStyle: 'openai' as ThinkingStyle,
    detail: '200K ctx · 8K out · image + tools + reasoning · structured outputs',
  }),
  Object.freeze({
    id: 'MiniMax-M1',
    displayName: 'M1 (MiniMax)',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: Object.freeze({
      toolCalling: true,
      imageInput: false,
      thinking: false,
    }),
    thinkingStyle: 'none' as ThinkingStyle,
    detail: '32K ctx · 4K out · tools',
  }),
]);

/** Helper used by the test suite to assert token-budget formatting. */
export const _internal = { formatTokenCount, DEFAULT_MAX_OUTPUT_TOKENS };

// -----------------------------------------------------------------------------
// Live-merge
// -----------------------------------------------------------------------------

/**
 * Default capability + presentation values used when a live model id is
 * not present in the static catalog. Per the AGENTS.md contract, every
 * agent-capable model advertises `toolCalling = true`; this default
 * honors that rule so newly-released MiniMax models appear automatically
 * in the picker with sane defaults instead of being hidden from agent
 * mode by a missing flag.
 */
export const DEFAULT_LIVE_MODEL_CAPS: Readonly<ModelCapabilities> = Object.freeze({
  toolCalling: true,
  imageInput: true,
  thinking: true,
});

export interface LiveModelDefaults {
  /** Capability fallback for unknown live models. */
  capabilities: ModelCapabilities;
  /** Thinking-style fallback for unknown live models. */
  thinkingStyle: ThinkingStyle;
  /** Output-token budget fallback for unknown live models. */
  maxOutputTokens: number;
  /** Display name fallback (used when the API doesn't provide one). */
  displayNamePrefix: string;
  /** Vendor id stamped on every entry (constant for this extension). */
  vendor: string;
  /** Family id stamped on every entry (constant for this extension). */
  family: string;
}

/** Sane defaults that satisfy AGENTS.md: every agent-capable model
 *  advertises tool calling. */
export const DEFAULT_LIVE_DEFAULTS: Readonly<LiveModelDefaults> = Object.freeze({
  capabilities: DEFAULT_LIVE_MODEL_CAPS,
  thinkingStyle: 'openai',
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  displayNamePrefix: 'M',
  vendor: MINIMAX_VENDOR,
  family: MINIMAX_FAMILY,
});

/**
 * Normalize a model id to the catalog form. Bare ids like `M3` gain the
 * `MiniMax-` prefix; ids already in catalog form are returned unchanged.
 */
export function normalizeModelId(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  return /^minimax-/i.test(raw) ? raw : `MiniMax-${raw}`;
}

/**
 * Merge the static built-in catalog with a live list of models fetched
 * from the MiniMax `/v1/models` endpoint. The rules:
 *
 *  1. Static entries always win on their declared id; the live list is
 *     used only to *add* models that the static list doesn't cover.
 *  2. Live entries that collide with a static id are dropped (we trust
 *     the curated entry's token budgets and thinking style).
 *  3. Live entries missing capabilities or thinking style are filled
 *     with `defaults` so the model is still advertised correctly
 *     (in particular, `toolCalling: true` is applied so the model is
 *     NOT silently hidden from agent mode).
 *  4. The merged list is stable-ordered: static entries first (in their
 *     declared order), then live entries sorted alphabetically by id.
 *
 * Pure function — no I/O, no side effects. The transport layer is
 * responsible for actually fetching the live list and passing it in.
 */
export function mergeCatalog(
  staticList: ReadonlyArray<CatalogEntry>,
  liveList: ReadonlyArray<CatalogEntry>,
  defaults: Readonly<LiveModelDefaults> = DEFAULT_LIVE_DEFAULTS,
): CatalogEntry[] {
  const seen = new Set<string>();
  const merged: CatalogEntry[] = [];

  for (const entry of staticList) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }

  const extras = liveList
    .map((raw) => fillLiveDefaults(raw, defaults))
    .filter((entry): entry is CatalogEntry => {
      if (!entry) return false;
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  merged.push(...extras);
  return merged;
}

/**
 * Normalize a single live entry: stamp the vendor/family, fill missing
 * capabilities + thinking style with `defaults`, and rebuild the
 * `detail` string from the actual token budgets so the picker
 * presentation matches reality. Returns `undefined` when the entry is
 * not usable (missing id, non-positive token budget).
 */
function fillLiveDefaults(
  raw: CatalogEntry,
  defaults: Readonly<LiveModelDefaults>,
): CatalogEntry | undefined {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined;
  if (!id) return undefined;
  if (raw.maxInputTokens <= 0 || raw.maxOutputTokens <= 0) return undefined;

  const displayName =
    raw.displayName && raw.displayName.length > 0
      ? raw.displayName
      : `${defaults.displayNamePrefix} (${id})`;

  // For unknown live models we FORCE the curated defaults rather
  // than merging the API's claim with the defaults. The `??` merge
  // would let a `false` value the API happens to ship for an unknown
  // model silently hide it from agent mode (AGENTS.md: a model
  // WITHOUT `toolCalling` is hidden). Erring on the side of
  // advertising unknown models as agent-capable is the safer default.
  const thinkingStyle: ThinkingStyle = defaults.thinkingStyle;
  const thinking = thinkingStyle !== 'none';
  const capabilities: ModelCapabilities = {
    toolCalling: defaults.capabilities.toolCalling,
    imageInput: defaults.capabilities.imageInput,
    thinking,
  };

  const detail =
    raw.detail && raw.detail.length > 0
      ? raw.detail
      : `${formatTokenCount(raw.maxInputTokens + raw.maxOutputTokens)} ctx · ` +
        `${formatTokenCount(raw.maxOutputTokens)} out`;

  return {
    id,
    displayName,
    vendor: raw.vendor || defaults.vendor,
    family: raw.family || defaults.family,
    maxInputTokens: raw.maxInputTokens,
    maxOutputTokens: raw.maxOutputTokens,
    capabilities,
    thinkingStyle,
    detail,
  };
}
