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
  if (
    typeof cap.toolCalling !== 'boolean' &&
    (typeof cap.toolCalling !== 'number' ||
      !Number.isFinite(cap.toolCalling) ||
      !Number.isInteger(cap.toolCalling) ||
      cap.toolCalling < 1)
  ) {
    return 'capabilities.toolCalling must be a boolean or a positive integer';
  }
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
 *            The context window is what MiniMax documents (1M for
 *            both M3 and M3.1-Flash); the output budget is the piece
 *            MiniMax does NOT document, so we advertise a
 *            conservative 128K and RESERVE it from the window
 *            (`maxInputTokens + maxOutputTokens` is what VS Code
 *            shows, and what the first-party BYOK providers compute
 *            as `contextWindow - maxOutputTokens`). The M2.x entries
 *            below already follow that shape (196 608 + 8 192 =
 *            204 800); M3/M3.1-Flash now match it (872 000 + 128 000
 *            = 1 000 000) instead of over-reporting a 1.128M window.
 *            `models.dev` currently lists a 524 288 output cap for
 *            these two models, but MiniMax publishes no output cap
 *            at all and that figure is an aggregator's estimate —
 *            advertising it would imply a 1.5M window. The
 *            chat-provider still clamps the actual request's
 *            `max_tokens` to 32K (opencode OUTPUT_TOKEN_MAX); the
 *            catalog value drives UI, not the request body.
 *  - M3.1-Flash — 1 000 000 ctx / 128 000 out, image input, tool
 *            calling, native thinking (Anthropic-style), frontier
 *            coding. GA on the M Plan / MiniMax Code tier; served by
 *            the same `minimax-m3` Anthropic sampler/thinking
 *            branches, so the id intentionally matches the existing
 *            `includes('minimax-m3')` predicates rather than spawning
 *            a new branch.
 *  - M3.1-Flash-Preview — a deprecated alias for M3.1-Flash, kept so
 *            a session pinned to the preview id still resolves. It
 *            sends the GA id on the wire (`wireId`).
 *  - M2.7 — 196 608 ctx, tool calling, OpenAI-style reasoning deltas.
 *  - M2.5 — 196 608 ctx, tool calling, OpenAI-style reasoning deltas.
 *  - M2   — 196 608 ctx, tool calling, OpenAI-style reasoning deltas,
 *            structured outputs.
 *  - M1   — 32 768 ctx, tool calling, no native thinking.
 */
export const BUILT_IN_CATALOG: ReadonlyArray<CatalogEntry> = Object.freeze([
  Object.freeze({
    id: 'MiniMax-M3',
    displayName: 'M3',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 872_000,
    maxOutputTokens: 128_000,
    capabilities: Object.freeze({
      // Frontier agentic model. The Agent Host's tool picker advertises
      // this number directly (Insiders 1.142+). Verified against live
      // requests carrying 100+ MCP + extension tools with no model-side
      // rejection in T21 testing; cap stays at 128 to leave headroom.
      toolCalling: 128,
      imageInput: true,
      thinking: true,
      videoInput: true,
    }),
    thinkingStyle: 'anthropic',
    detail: '1M ctx · 128K out · image + video + tools (≤128) + thinking',
  }),
  Object.freeze({
    id: 'MiniMax-M3.1-Flash',
    displayName: 'M3.1 Flash',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 872_000,
    maxOutputTokens: 128_000,
    capabilities: Object.freeze({
      // Same frontier tier as M3; tunable `effort` parameter does not
      // change the tool slot count.
      toolCalling: 128,
      imageInput: true,
      thinking: true,
      videoInput: true,
    }),
    thinkingStyle: 'anthropic',
    detail: '1M ctx · 128K out · image + video + tools (≤128) + thinking',
  }),
  Object.freeze({
    // The GA id above replaced the preview id. The preview id is kept
    // as a deprecated alias so a chat session pinned to it keeps
    // resolving; `wireId` sends the current GA id on the wire so the
    // request still names a model MiniMax serves.
    id: 'MiniMax-M3.1-Flash-Preview',
    displayName: 'M3.1 Flash Preview',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 872_000,
    maxOutputTokens: 128_000,
    capabilities: Object.freeze({
      toolCalling: 128,
      imageInput: true,
      thinking: true,
      videoInput: true,
    }),
    wireId: 'MiniMax-M3.1-Flash',
    deprecated: true,
    thinkingStyle: 'anthropic',
    detail: '1M ctx · 128K out · image + video + tools (≤128) + thinking (alias for M3.1 Flash)',
  }),
  Object.freeze({
    id: 'MiniMax-M2.7',
    displayName: 'M2.7',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      // M2.7 + the rest of the M2 family sit at the historical
      // `mcpMaxTools` (default 60) ceiling that T21 perf testing
      // validated. Conservative — bump only after confirming with
      // a real wire request carrying >60 tools.
      toolCalling: 60,
      imageInput: true,
      thinking: true,
      videoInput: false,
    }),

    // MiniMax is winding down the M2.x family (M1 already went).
    // Hidden from the picker by default; still reachable via
    // `mightyMax.showDeprecatedModels` and by id.
    deprecated: true,
    thinkingStyle: 'openai',
    detail: '200K ctx · 8K out · image + tools (≤60) + reasoning',
  }),
  Object.freeze({
    id: 'MiniMax-M2.5',
    displayName: 'M2.5',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      toolCalling: 60,
      imageInput: true,
      thinking: true,
      videoInput: false,
    }),

    // MiniMax is winding down the M2.x family (M1 already went).
    // Hidden from the picker by default; still reachable via
    // `mightyMax.showDeprecatedModels` and by id.
    deprecated: true,
    thinkingStyle: 'openai',
    detail: '200K ctx · 8K out · image + tools (≤60) + reasoning',
  }),
  Object.freeze({
    id: 'MiniMax-M2',
    displayName: 'M2',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 196_608,
    maxOutputTokens: 8_192,
    capabilities: Object.freeze({
      toolCalling: 60,
      imageInput: true,
      thinking: true,
      videoInput: false,
    }),

    // MiniMax is winding down the M2.x family (M1 already went).
    // Hidden from the picker by default; still reachable via
    // `mightyMax.showDeprecatedModels` and by id.
    deprecated: true,
    thinkingStyle: 'openai',
    detail: '200K ctx · 8K out · image + tools (≤60) + reasoning · structured outputs',
  }),
  Object.freeze({
    id: 'MiniMax-M1',
    displayName: 'M1',
    vendor: MINIMAX_VENDOR,
    family: MINIMAX_FAMILY,
    maxInputTokens: 32_768,
    maxOutputTokens: 4_096,
    capabilities: Object.freeze({
      // Smallest / oldest model — 30 tool slots matches its 32K
      // context. Anything larger than ~30 tools blows past the
      // available schema-budget once the system prompt and tool
      // descriptions are added.
      toolCalling: 30,
      imageInput: false,
      thinking: false,
      videoInput: false,
    }),

    // MiniMax is winding down the M2.x family (M1 already went).
    // Hidden from the picker by default; still reachable via
    // `mightyMax.showDeprecatedModels` and by id.
    deprecated: true,
    thinkingStyle: 'none',
    detail: '32K ctx · 4K out · tools (≤30)',
  }),
]);

/** Helper used by the test suite to assert token-budget formatting. */
export const _internal = { formatTokenCount, DEFAULT_MAX_OUTPUT_TOKENS };

// -----------------------------------------------------------------------------
// Deprecation filtering
// -----------------------------------------------------------------------------

/**
 * The models MiniMax still considers current. Everything else in
 * `BUILT_IN_CATALOG` is retained but carries `deprecated: true`.
 */
export const CURRENT_MODEL_IDS: ReadonlyArray<string> = Object.freeze([
  'MiniMax-M3',
  'MiniMax-M3.1-Flash',
]);

/**
 * Decide which catalog entries the chat model picker should show.
 *
 * Deprecation hides an entry from the picker; it never deletes it.
 * `getModel` still resolves deprecated ids, so a request that names one
 * still works.
 *
 * It does, however, remove the model from VS Code's model list — the
 * host builds that list from the models the extension advertises — so
 * a chat session pinned to a hidden model is reset to the default
 * model rather than continuing on the old one. Flipping this filter
 * off puts the model back.
 *
 * Pure: no I/O, no vscode. The caller reads the setting and passes it
 * in.
 */
export function filterDeprecated(
  entries: ReadonlyArray<CatalogEntry>,
  showDeprecated: boolean,
): ReadonlyArray<CatalogEntry> {
  if (showDeprecated) return entries;
  return entries.filter((entry) => entry.deprecated !== true);
}

/** True when `id` names a model MiniMax has wound down. */
export function isDeprecatedModel(
  entries: ReadonlyArray<CatalogEntry>,
  id: string,
): boolean {
  return entries.some((entry) => entry.id === id && entry.deprecated === true);
}

/**
 * The model id to put on the wire for a catalog entry.
 *
 * Most entries are their own wire id. An entry that stands in for
 * another model — the `MiniMax-M3.1-Flash-Preview` alias for the GA
 * `MiniMax-M3.1-Flash` — carries a `wireId`, so a session pinned to
 * the old id keeps sending a model MiniMax currently serves.
 *
 * Pure: no I/O, no vscode.
 */
export function wireModelId(entry: CatalogEntry | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.wireId ?? entry.id;
}

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
  // Conservative for unknown future models: video input is only
  // documented for the M3 family, so an unrecognised live model does
  // NOT get the flag. The cost of a false positive is a hard 400 on a
  // request that carries a video part; the cost of a false negative is
  // one `unsupported-content` warning. Asymmetric — default to false.
  videoInput: false,
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
 *     with `defaults` so the model is still advertised correctly.
 *     `toolCalling: true` is applied when the live entry is missing
 *     the field entirely so the model is NOT silently hidden from
 *     agent mode (AGENTS.md invariant). An explicit `false` from the
 *     live API is still overridden to the default `true` for the
 *     same reason; `true` and a positive integer are passed through
 *     so the per-request tool cap reported by the live API reaches
 *     VS Code's Agent Host.
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
  //
  // Tool-calling gets a carve-out: as of the Agent Host API change in
  // VS Code Insiders 1.142 the `toolCalling` field is `boolean | number`,
  // where a number is the model's per-request tool cap. If the live API
  // reports a number (or `true`) for an unknown model we trust it — only
  // an explicit `false` triggers the agent-mode-visibility override,
  // because that is the one value that breaks AGENTS.md's invariant.
  const liveToolCalling = raw.capabilities?.toolCalling;
  let toolCalling: boolean | number;
  if (liveToolCalling === false) {
    toolCalling = defaults.capabilities.toolCalling;
  } else if (
    typeof liveToolCalling === 'number' &&
    Number.isInteger(liveToolCalling) &&
    liveToolCalling > 0
  ) {
    toolCalling = liveToolCalling;
  } else if (typeof liveToolCalling === 'boolean') {
    toolCalling = liveToolCalling;
  } else {
    toolCalling = defaults.capabilities.toolCalling;
  }

  const thinkingStyle: ThinkingStyle = defaults.thinkingStyle;
  const thinking = thinkingStyle !== 'none';
  const capabilities: ModelCapabilities = {
    toolCalling,
    imageInput: defaults.capabilities.imageInput,
    thinking,
    videoInput: defaults.capabilities.videoInput,
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
    // Preserved so an entry that stands in for another model keeps
    // sending that model, whatever path it came in by.
    ...(raw.wireId !== undefined ? { wireId: raw.wireId } : {}),
  };
}
