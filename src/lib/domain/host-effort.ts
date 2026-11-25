/**
 * Host reasoning-effort vocabulary.
 *
 * VS Code drives per-model reasoning effort through a fixed
 * vocabulary that is NOT the same as the MiniMax wire vocabulary.
 * Verified by string xref against the shipped host bundles
 * (`workbench.desktop.main.js`, `platform/agentHost/node/agentHostMain.js`):
 *
 *  - The agent host's canonical effort set is
 *    `none, minimal, low, medium, high, xhigh, max, ultra`
 *    (`Fd`). `CT()` filters a provider-advertised enum against it,
 *    so a value outside this set is silently dropped and the
 *    control disappears from the picker.
 *  - The workbench's BYOK `listModels` handler reads
 *    `configurationSchema?.properties?.reasoningEffort` — and only
 *    that key. Its `.enum` becomes `supportedReasoningEfforts` and
 *    its `.default` becomes `defaultReasoningEffort`.
 *  - The workbench maps a chosen effort back onto a schema property
 *    with `Bir()`, which scans `["reasoningEffort", "thinkingLevel"]`
 *    in that order and takes the first whose `enum` contains the
 *    value. A provider that publishes any other key (`thinkingEffort`)
 *    is never selected, and the host-side effort control silently
 *    does nothing.
 *
 * So the plugin must publish the effort under the key
 * `reasoningEffort`, using values drawn from the canonical host set,
 * and read the user's choice back from `options.modelConfiguration`.
 *
 * The MiniMax wire vocabulary is narrower: `output_config.effort`
 * accepts `low|medium|high|xhigh|max` (and `none` is a hard 400 for
 * M3.1-Flash, which always thinks). Upstream MiniMax clamps
 * `xhigh`/`max` down to `high` before sending (pi-ai
 * `clampReasoning`), and this plugin's own `clampEffort` does the
 * same. Host-only values therefore need an explicit mapping onto a
 * wire effort rather than being passed through.
 */

import type { ThinkingEffort } from './anthropic-transform.js';

/**
 * Effort levels the host understands, in ascending order of depth.
 * Mirrors the agent host's canonical `Fd` set.
 */
export const HOST_EFFORT_VALUES: ReadonlyArray<string> = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

/**
 * The effort levels the plugin advertises in its `reasoningEffort`
 * schema property, in ascending order of depth.
 *
 * Restricted to the host's canonical set (the agent host filters a
 * provider-advertised enum against it and silently drops anything
 * outside it). `none` is excluded because it is a hard 400 for
 * M3.1-Flash, which always thinks; `minimal` is excluded because it
 * collapses onto `low` on the wire, so offering it would advertise a
 * distinction the model cannot honour.
 *
 * `xhigh` and `max` ARE advertised even though the wire value is
 * clamped to `high` (upstream pi-ai `clampReasoning`, and this
 * plugin's own `clampEffort`): the host's global thinking level uses
 * the host vocabulary, and a model that does not advertise these
 * levels cannot be driven by it at all.
 */
export const PUBLISHED_EFFORT_VALUES: ReadonlyArray<string> = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * A host effort that maps onto a MiniMax wire effort.
 */
export type HostEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Map a host-side effort value onto the MiniMax wire effort.
 *
 * Host-only values are folded onto their nearest wire equivalent:
 * `minimal` behaves like `low` and `ultra` like `max`. `none` has no
 * wire equivalent for M3.1-Flash — it returns `undefined` so the
 * caller keeps its existing default rather than sending a request
 * the API rejects with a 400.
 *
 * Returns `undefined` for values outside the host vocabulary, so a
 * stale or hand-edited model configuration cannot smuggle an
 * unexpected effort onto the wire.
 */
export function mapHostEffortToWire(raw: unknown): HostEffort | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'low':
    case 'minimal':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
    case 'ultra':
      return 'max';
    default:
      return undefined;
  }
}

/**
 * The effort level the plugin publishes as the schema `default` for a
 * given `mightyMax.m31ThinkingEffort` setting value.
 *
 * The published default is what the host injects into
 * `options.modelConfiguration` when the user has not picked a level
 * in the model picker (the extension host merges every schema
 * `default` into the stored model configuration). Publishing the
 * SETTING's value there is what keeps the two in sync: the setting
 * stays the baseline, and a level the user picks in the picker wins
 * because the host stores it as a non-default value.
 *
 * `default` (the setting's "let MiniMax choose" sentinel, which
 * omits `output_config` entirely) has no host vocabulary equivalent,
 * so it publishes as `max` — the deepest level the API documents,
 * and the closest match for "the API's own default".
 */
export function publishedDefaultForEffort(effort: ThinkingEffort): HostEffort {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    case 'default':
      return 'max';
    default:
      return 'medium';
  }
}
