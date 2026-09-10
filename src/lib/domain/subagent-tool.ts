/**
 * subagent-tool — domain shape of our custom `minimax_subagent`
 * tool that wraps VS Code's built-in `runSubagent` and synthesizes
 * its multi-part result into a single `<task>` text block.
 *
 * T35: registering `minimax_subagent` (instead of leaving the model
 * to call VS Code's `runSubagent` directly) is the half of the fix
 * that controls the chat widget's rendering. VS Code renders our
 * tool's `LanguageModelToolResult` (which we make single-part),
 * not `runSubagent`'s (which is multi-part by construction).
 *
 * Pattern matches `src/lib/domain/mcp-search-tools.ts`: pure
 * descriptor and per-call result rendering, consumed by an adapter
 * in `src/adapters/subagent-tool.ts` that adds the VS Code wiring.
 */

import type { SubAgentState } from './subagent-synthesis.js';

/** Custom tool name — chosen to avoid colliding with `runSubagent`. */
export const MINIMAX_SUBAGENT_TOOL = 'minimax_subagent';

/** Maximum length of the synthesized body before truncation. */
export const DEFAULT_SUBAGENT_RESULT_MAX_CHARS = 32_000;

/** Schema accepted by `minimax_subagent`. Mirrors `runSubagent`'s shape. */
export interface MinimaXSubAgentInput {
  /** Plain-text description shown in the chat widget's tool call title. */
  readonly description: string;
  /** Plain-text prompt for the sub-agent. */
  readonly prompt: string;
  /** Optional sub-agent type; mirrors `runSubagent`'s `subagent_type`. */
  readonly subagent_type?: string;
}

/** Schema of the JSON object VS Code hands back from `lm.invokeTool`. */
export interface SubAgentToolDescriptor {
  readonly name: typeof MINIMAX_SUBAGENT_TOOL;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required: ReadonlyArray<string>;
  };
}

export function buildSubAgentDescriptor(): SubAgentToolDescriptor {
  return {
    name: MINIMAX_SUBAGENT_TOOL,
    description:
      "Spawn a sub-agent to handle a focused, well-scoped task. Returns the sub-agent's " +
      'output as a single `<task>` text block (one box in the chat widget). Use this ' +
      "instead of `runSubagent` when you want the parent conversation's chat history " +
      'to stay legible. The sub-agent has its own tool set and context window.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'Short label describing what the sub-agent is doing (shown in the tool call title).',
        },
        prompt: {
          type: 'string',
          description: 'Plain-text prompt sent to the sub-agent.',
        },
        subagent_type: {
          type: 'string',
          description: "Optional sub-agent type override (defaults to the chat host's default).",
        },
      },
      required: ['description', 'prompt'],
    },
  };
}

/** Result of validating a raw `input` object against the descriptor. */
export interface SubAgentInputValidation {
  readonly ok: boolean;
  readonly value?: MinimaXSubAgentInput;
  readonly errorMessage?: string;
}

export function validateSubAgentInput(raw: unknown): SubAgentInputValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errorMessage: 'minimax_subagent: input must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  const description = obj['description'];
  const prompt = obj['prompt'];
  if (typeof description !== 'string' || description.length === 0) {
    return {
      ok: false,
      errorMessage: 'minimax_subagent: `description` must be a non-empty string',
    };
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, errorMessage: 'minimax_subagent: `prompt` must be a non-empty string' };
  }
  const subagentTypeRaw = obj['subagent_type'];
  const subagent_type =
    typeof subagentTypeRaw === 'string' && subagentTypeRaw.length > 0 ? subagentTypeRaw : undefined;
  const value: MinimaXSubAgentInput = {
    description,
    prompt,
    ...(subagent_type !== undefined ? { subagent_type } : {}),
  };
  return { ok: true, value };
}

/** Per-call options for the synthesis step in the invoke handler. */
export interface SubAgentInvokeOptions {
  readonly maxChars?: number;
}

/** Per-call options forwarded to the underlying `runSubagent` invocation. */
export interface UnderlyingRunSubAgentOptions {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
}

/** Caller-supplied delegate that actually invokes the sub-agent. */
export type UnderlyingInvoker = (
  input: UnderlyingRunSubAgentOptions,
  token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => void },
) => Promise<{ parts: ReadonlyArray<unknown>; state: SubAgentState; summary?: string }>;

/**
 * Build the per-call text payload for our tool result. Pure — given
 * the underlying sub-agent's emitted parts + final state, return the
 * string we ship as the single content part of our tool's result.
 *
 * The shape `{ parts, state, summary }` is what the adapter
 * receives from `lm.invokeTool('runSubagent', ...)`. The
 * `state === 'error'` case is mapped from a thrown error so the
 * caller doesn't have to do try/catch around the synthesis path.
 */
export function buildSubAgentToolResult(
  parts: ReadonlyArray<unknown>,
  state: SubAgentState,
  options: SubAgentInvokeOptions = {},
  summary?: string,
): string {
  const subAgentParts = partsToSubAgentParts(parts);
  const result = synthesizeForTool(
    subAgentParts,
    state,
    options.maxChars ?? DEFAULT_SUBAGENT_RESULT_MAX_CHARS,
  );
  return summary !== undefined ? `${result}\n\n<!-- summary: ${summary} -->` : result;
}

// Local import — kept inline so the file is self-contained.
import { synthesizeSubAgentOutput, type SubAgentPart } from './subagent-synthesis.js';

function synthesizeForTool(
  parts: ReadonlyArray<SubAgentPart>,
  state: SubAgentState,
  maxChars: number,
): string {
  return synthesizeSubAgentOutput(parts, {
    sessionId: 'minimax_subagent',
    state,
    maxChars,
  }).text;
}

/**
 * Convert VS Code's `LanguageModelResponsePart[]` (the raw shape
 * returned from `lm.invokeTool(...).content`) into our domain
 * `SubAgentPart[]`. Recognizes:
 *  - `{value: string}` (text / thinking by structural shape)
 *  - `{name, callId, input}` (tool call)
 *  - `{callId, content}` (tool result; flattened to text)
 *  - `{mimeType, data: Uint8Array}` (data part — short marker)
 * Unknown shapes are mapped to `{kind: 'text', value: ''}` so the
 * synthesizer's defensive default-kinds branch skips them silently.
 */
function partsToSubAgentParts(parts: ReadonlyArray<unknown>): SubAgentPart[] {
  const out: SubAgentPart[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) {
      out.push({ kind: 'text', value: '' });
      continue;
    }
    const p = part as Record<string, unknown>;

    // Tool-call shape.
    if (typeof p['name'] === 'string' && typeof p['callId'] === 'string' && 'input' in p) {
      out.push({
        kind: 'tool-use',
        name: p['name'],
        callId: p['callId'],
        input: p['input'],
      });
      continue;
    }

    // Tool-result shape (nested content array).
    if (typeof p['callId'] === 'string' && Array.isArray(p['content'])) {
      const inner = (p['content'] as ReadonlyArray<unknown>)
        .map((c) => {
          if (
            typeof c === 'object' &&
            c !== null &&
            'value' in c &&
            typeof (c as Record<string, unknown>)['value'] === 'string'
          ) {
            return (c as { value: string }).value;
          }
          return '';
        })
        .join('\n');
      out.push({ kind: 'tool-result', callId: p['callId'], value: inner });
      continue;
    }

    // Data part.
    if (typeof p['mimeType'] === 'string' && p['data'] instanceof Uint8Array) {
      out.push({
        kind: 'data',
        mimeType: p['mimeType'],
        size: (p['data']).byteLength,
      });
      continue;
    }

    // Text / thinking — VS Code's `LanguageModelThinkingPart` and
    // `LanguageModelTextPart` both expose `.value`. We can't tell
    // them apart at runtime (the thinking constructor is feature-
    // detected), so we conservatively map them all to 'text' — the
    // synthesizer's `thinking` branch is for when the adapter has
    // already done the kind discrimination. This is the only place
    // where the per-kind info is irreversibly lost, and it matches
    // the inbound-collapse behavior in `collapseSubAgentToolResultsInDomain`.
    if (typeof p['value'] === 'string') {
      out.push({ kind: 'text', value: p['value'] });
      continue;
    }

    // Unknown shape — skip.
    out.push({ kind: 'text', value: '' });
  }
  return out;
}
