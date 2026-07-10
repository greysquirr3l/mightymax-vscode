/**
 * Domain: per-model wire-dialect routing.
 *
 * The MiniMax API speaks two incompatible protocols:
 *  - Anthropic-compatible (`{baseUrl}/anthropic/v1/messages`)
 *  - OpenAI-compatible    (`{baseUrl}/v1/chat/completions`)
 *
 * The route is determined by the model entry's `thinkingStyle`:
 *  - `'anthropic'` → Anthropic-dialect (native thinking blocks, cache_control)
 *  - `'openai' | 'none'` → OpenAI-dialect (reasoning_content streaming)
 *
 * The chat provider consumes this function (T07/T17) to set
 * `request.dialect`; the transport's `defaultDialectFor` is a
 * last-resort fallback for callers that omit the field.
 *
 * No `vscode` / HTTP imports; pure type arithmetic over the catalog.
 */

import type { ModelInfo } from '../../ports/model-catalog.js';
import type { MiniMaxDialect } from '../../ports/minimax-client.js';

export function dialectForModel(entry: Pick<ModelInfo, 'thinkingStyle'>): MiniMaxDialect {
  return entry.thinkingStyle === 'anthropic' ? 'anthropic' : 'openai';
}
