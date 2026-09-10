/**
 * subagent-synthesis — collapse a multi-part sub-agent tool result
 * into a single text string shaped like opencode's `<task>` block.
 *
 * T35: when the chat widget's tool-result card contains a multi-part
 * content array, each part renders as its own collapsible box (text,
 * thinking, tool-call, etc.). VS Code's built-in `runSubagent`
 * returns an array of N parts (one per text delta + one per thinking
 * delta + one per tool call the sub-agent made), so the user sees a
 * wall of blank rectangles. The fix is to collapse the parts into
 * ONE text blob at the boundary, so the widget renders one box.
 *
 * The synthesizer is a pure function: it accepts a flat list of
 * structural `SubAgentPart` shapes (no `vscode` import) and returns
 * the rendered XML string. The adapter in `src/adapters/subagent-tool.ts`
 * converts VS Code's `LanguageModelResponsePart` value classes into
 * `SubAgentPart`s and ships the rendered text back as a single
 * `LanguageModelTextPart`. The chat-provider's inbound `vscodeToDomainMessage`
 * uses the same synthesizer when it sees a `runSubagent` tool result
 * in the request, so the model sees a clean single-string payload.
 *
 * Pattern matches `src/lib/domain/mcp-search-tools.ts`: pure module,
 * no `vscode` dependency, consumed by both the chat-provider and the
 * custom tool adapter.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State of the sub-agent run that produced the parts. Mirrors
 * opencode's `State` (`running` | `completed` | `error` | `cancelled`).
 * `cancelled` is collapsed into `error` for the synthesized payload
 * because both surface to the parent agent as "did not complete
 * normally".
 */
export type SubAgentState = 'running' | 'completed' | 'error';

/**
 * Structural shape the synthesizer knows how to render. Each variant
 * carries the fields the synthesizer needs and is intentionally
 * shallow so the adapter can construct `SubAgentPart`s by walking
 * VS Code's value classes without dragging the `vscode` types into
 * the domain layer.
 */
export type SubAgentPart =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'thinking'; readonly value: string }
  | {
      readonly kind: 'tool-use';
      readonly name: string;
      readonly callId: string;
      readonly input: unknown;
    }
  | {
      readonly kind: 'tool-result';
      readonly callId: string;
      readonly value: string;
    }
  | { readonly kind: 'data'; readonly mimeType: string; readonly size: number };

export interface SubAgentSynthesisOptions {
  /** VS Code session id of the sub-agent run; emitted as the task id. */
  readonly sessionId: string;
  /** Final state of the sub-agent run. */
  readonly state: SubAgentState;
  /** Optional one-line summary inserted between the task tag and the result tag. */
  readonly summary?: string;
  /** Optional cap on the rendered body length; truncates with a marker. */
  readonly maxChars?: number;
}

export interface SynthesizeResult {
  readonly text: string;
  readonly truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML helpers (kept local to avoid dragging in a real XML library for
// one inline-body use case)
// ─────────────────────────────────────────────────────────────────────────────

/** Escape `<`, `>`, `&` (and `"` for attribute safety). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a JSON.stringify result with a fallback for circular / BigInt. */
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? 'null';
  } catch {
    const ctor =
      (input as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof input;
    return `[unserializable tool input: ${ctor}]`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderPartBody(part: SubAgentPart): string {
  switch (part.kind) {
    case 'text':
      // Defensive: tolerate a `value` that's missing or not a string
      // (e.g., a future part kind that re-uses the `text` discriminator
      // without the legacy field). Coerce to empty rather than throw.
      return escapeXml(typeof part.value === 'string' ? part.value : '');
    case 'thinking':
      // Parent agent does not re-reason about sub-agent thinking —
      // omit verbatim. The reasoning was context for the sub-agent,
      // not output the parent agent should re-process. Returns an
      // empty string so `renderBody`'s `chunks.join('\n')` cleanly
      // skips the line. (`'\n'.split` would leave a stray blank line
      // that breaks the test for empty bodies.)
      return '';
    case 'tool-use': {
      const args = safeStringify(part.input);
      return [
        `<tool_use name="${escapeXml(part.name)}" id="${escapeXml(part.callId)}">`,
        escapeXml(args),
        `</tool_use>`,
      ].join('\n');
    }
    case 'tool-result':
      return [
        `<tool_result id="${escapeXml(part.callId)}">`,
        escapeXml(typeof part.value === 'string' ? part.value : ''),
        `</tool_result>`,
      ].join('\n');
    case 'data':
      return `[data omitted: ${escapeXml(part.mimeType)}, ${String(part.size)} bytes]`;
    default: {
      // Defensive: a future part kind lands as `{ kind: 'unknown', ... }`
      // — skip without throwing so the synthesizer stays total.
      const unknown = part as { kind?: unknown };
      const kindLabel = typeof unknown.kind === 'string' ? unknown.kind : 'unknown';
      return `[unrecognized sub-agent part kind: ${escapeXml(kindLabel)}]`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the body of the `<task_result>` (or `<task_error>`) tag.
 * Each rendered line is a single chunk. Body length is capped at
 * `opts.maxChars` (default unlimited) with a `[...truncated N chars
 * dropped]` marker when the cap is exceeded.
 */
function renderBody(
  parts: ReadonlyArray<SubAgentPart>,
  maxChars?: number,
): { body: string; truncated: boolean } {
  const chunks: string[] = [];
  for (const part of parts) {
    const chunk = renderPartBody(part);
    if (chunk.length > 0) chunks.push(chunk);
  }
  let body = chunks.join('\n');
  let truncated = false;
  if (maxChars !== undefined && body.length > maxChars) {
    const originalLength = body.length;
    body = body.slice(0, maxChars);
    // Include the ORIGINAL length (not the dropped count) so a
    // diagnostic consumer can compute the truncation ratio without
    // re-running the slice.
    body += `\n[...truncated; original length ${originalLength} chars]`;
    truncated = true;
  }
  return { body, truncated };
}

/**
 * Collapse a multi-part sub-agent tool result into the opencode-shaped
 * `<task id state>...<task_result>...</task_result></task>` (or
 * `<task_error>` for error state) XML block. The returned string is
 * what we ship to the model and what we emit as the result of our
 * custom `minimax_subagent` tool, so the chat widget renders exactly
 * one box.
 */
export function synthesizeSubAgentOutput(
  parts: ReadonlyArray<SubAgentPart>,
  opts: SubAgentSynthesisOptions,
): SynthesizeResult {
  const state = opts.state;
  const resultTag = state === 'error' ? 'task_error' : 'task_result';
  const { body, truncated } = renderBody(parts, opts.maxChars);
  const lines: string[] = [];
  lines.push(`<task id="${escapeXml(opts.sessionId)}" state="${escapeXml(state)}">`);
  if (opts.summary !== undefined && opts.summary.length > 0) {
    lines.push(`<summary>${escapeXml(opts.summary)}</summary>`);
  }
  lines.push(`<${resultTag}>`);
  if (body.length > 0) lines.push(body);
  lines.push(`</${resultTag}>`);
  lines.push('</task>');
  return { text: lines.join('\n'), truncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound collapse (post-mapping)
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ChatMessageContentPart } from '../../ports/message-mapping.js';
import type { ChatToolResultPart } from '../../ports/tool-schema.js';

/** Names of tools whose results should be collapsed into one `<task>` block. */
export const SUB_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'runSubagent',
  'minimax_subagent',
]);

/**
 * Walk `messages` and build a map of `callId → toolName` from the
 * assistant turns' `LanguageModelToolCallPart`s. Pure — operates on
 * already-converted domain messages, so the call sites don't need
 * access to the raw `vscode.LanguageModelChatRequestMessage` array.
 *
 * The chat-provider builds this once per request and feeds it to
 * `collapseSubAgentToolResultsInDomain` so the post-mapping step
 * doesn't have to re-walk the raw request shape.
 */
export function buildCallIdToToolNameMap(
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type === 'tool-call') {
        if (part.toolCall.callId.length > 0) {
          map.set(part.toolCall.callId, part.toolCall.name);
        }
      }
    }
  }
  return map;
}

/**
 * Replace the `content` array of any sub-agent tool-result part with
 * a single-element array containing the synthesized `<task>` XML
 * block. The chat-provider calls this after `vscodeToDomainMessage`
 * (so the model's input is one clean string instead of N strings,
 * some of which may have leaked JSON-stringified thinking parts).
 *
 * The mapping at this boundary has already lost the per-kind
 * structural info (text vs thinking vs tool-call) — VS Code hands
 * the chat-provider each tool result as an array of
 * `LanguageModelResponsePart`s, and the existing conversion in
 * `vscodeToDomainMessage` flattens them to strings. We treat every
 * surviving string as a `text` chunk for synthesis. That's still a
 * net win: the model's context is one cleanly XML-escaped string
 * instead of N strings (some of them JSON garbage from
 * `LanguageModelThinkingPart` falling to the `JSON.stringify`
 * fallback).
 *
 * For the per-kind synthesis (text vs thinking vs tool-use), see
 * the custom `minimax_subagent` tool adapter, which runs against the
 * pre-flattened VS Code parts and produces the structured
 * SubAgentParts the synthesizer knows how to render.
 */
export function collapseSubAgentToolResultsInDomain(
  messages: ReadonlyArray<ChatMessage>,
  callIdToToolName: ReadonlyMap<string, string>,
  options: {
    readonly maxChars?: number;
  } = {},
): ReadonlyArray<ChatMessage> {
  return messages.map((msg) => {
    let mutated = false;
    const newContent: ChatMessageContentPart[] = msg.content.map((part) => {
      if (part.type !== 'tool-result') return part;
      const toolName = callIdToToolName.get(part.toolResult.callId);
      if (toolName === undefined || !SUB_AGENT_TOOL_NAMES.has(toolName)) return part;
      mutated = true;
      return {
        type: 'tool-result',
        toolResult: synthesizeToolResultPart(part.toolResult, options.maxChars),
      } satisfies ChatMessageContentPart;
    });
    if (!mutated) return msg;
    return { ...msg, content: newContent };
  });
}

function synthesizeToolResultPart(part: ChatToolResultPart, maxChars?: number): ChatToolResultPart {
  const textParts: SubAgentPart[] = [];
  for (const c of part.content) {
    if (typeof c === 'string' && c.length > 0) {
      textParts.push({ kind: 'text', value: c });
    }
  }
  const result = synthesizeSubAgentOutput(textParts, {
    sessionId: part.callId,
    state: 'completed',
    ...(maxChars !== undefined ? { maxChars } : {}),
  });
  return {
    callId: part.callId,
    content: [result.text],
  };
}
