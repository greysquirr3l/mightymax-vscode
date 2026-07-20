/**
 * Domain: tool schema mapping.
 *
 * Pure, framework-free. T03 implements the VS Code ↔ MiniMax tool
 * schema conversion. The domain layer (this file) operates on
 * framework-neutral types declared in `src/ports/tool-schema.ts`; the
 * chat-provider (T07) is responsible for converting between
 * `vscode.LanguageModelChatTool` and the `ChatTool` alias at the
 * boundary.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` guard enforces that statically.
 *
 * What lives here:
 *  - `mapToolsToMiniMax`            — VS Code tools → MiniMax `tools`.
 *  - `mapToolModeToChoice`          — VS Code tool mode → wire `tool_choice`.
 *  - `accumulateToolCallDelta`      — stream of tool-call deltas →
 *                                       completed `ChatToolCallPart`s.
 *  - `finalizeAccumulator`          — close the accumulator, run the
 *                                       bounded JSON repair, surface
 *                                       typed errors.
 *  - `repairTruncatedJson`          — bounded repair for argument
 *                                       streams the model truncated.
 *  - `mapToolResultToMiniMax`       — VS Code tool-result →
 *                                       MiniMax tool wire message.
 *  - `serializeToolResultContent`   — JSON-encode the tool-result
 *                                       content list.
 *
 * Errors are returned as `ToolSchemaError` envelopes from the port;
 * the transport (T05) and chat-provider (T07) translate those into
 * chat errors VS Code can surface to the user without crashing the
 * host.
 */

import type {
  ChatTool,
  ChatToolCallPart,
  ChatToolMode,
  ChatToolResultPart,
  ToolCallAccumulatorState,
  ToolSchemaError,
} from '../../ports/tool-schema.js';
import type {
  MiniMaxStreamEvent,
  MiniMaxToolDefinition,
  MiniMaxWireMessage,
} from '../../ports/minimax-client.js';

// Re-export the port types so the test file (and any future
// consumer) can import everything the domain exports from one
// place. The domain is the canonical owner of these types as far
// as the rest of the codebase is concerned — the port is a thin
// boundary that mirrors them.
export type {
  ChatTool,
  ChatToolCallPart,
  ChatToolMode,
  ChatToolResultPart,
  ToolCallAccumulatorState,
  ToolSchemaError,
} from '../../ports/tool-schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: VS Code tools -> MiniMax tool definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a list of normalized VS Code tools to the MiniMax `tools`
 * array. Uniform regardless of origin (built-in apply-edit, built-in
 * run-in-terminal, extension Language Model Tools, MCP server tools
 * all share the same shape). Order is preserved — the model uses
 * tool name to dispatch, so reordering would silently break the
 * name-based routing.
 *
 * `inputSchema` is kept VERBATIM here. The MiniMax wire format only
 * differs from the VS Code tool shape at the serialization boundary:
 *  - The Anthropic-compatible endpoint expects schemas lowered to the
 *    subset its tool validator accepts (`sanitizeAnthropicSchema`
 *    inside the transport drops `const`, `additionalProperties: false`,
 *    and rewrites boolean sub-schemas). VS Code tools (especially from
 *    MCP servers and third-party extensions) routinely ship those
 *    shapes, which Anthropic rejects with 400.
 *  - The OpenAI-compatible endpoint accepts the VS Code-style schema
 *    shape unchanged.
 * Lowering at the wire boundary (not at the domain boundary) keeps
 * `mapToolsToMiniMax` dialect-neutral; the same `MiniMaxToolDefinition`
 * can be serialized to either wire.
 *
 * When the upstream tool did not provide an `inputSchema`, we emit an
 * empty object — MiniMax requires the key to be present, but accepts
 * `{}` as "no parameters".
 */
export function mapToolsToMiniMax(tools: ReadonlyArray<ChatTool>): MiniMaxToolDefinition[] {
  return tools.map((tool) => {
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw new ToolSchemaMappingError({
        kind: 'invalid-tool-definition',
        toolName: tool.name ?? '<empty>',
        reason: 'tool name must be a non-empty string',
      });
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? {},
      },
    } satisfies MiniMaxToolDefinition;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: VS Code tool mode -> MiniMax tool_choice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a domain `ChatToolMode` to the MiniMax `tool_choice` field. The
 * function is total over the `ChatToolMode` union — passing a
 * string-cast value outside the union returns `undefined` so the
 * transport can decide to omit the field (forward-compat: VS Code
 * may add new modes in future API versions).
 */
export function mapToolModeToChoice(
  mode: ChatToolMode | (string & {}),
): 'auto' | 'required' | undefined {
  if (mode === 'auto') return 'auto';
  if (mode === 'required') return 'required';
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound: VS Code tool-result -> MiniMax wire tool message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a tool-result `content` list into a single string the
 * MiniMax wire spec accepts. Strings are joined with `\n`; non-string
 * items are JSON-encoded (numbers, booleans, objects, arrays,
 * `null`). The result is a single string; the model receives it as
 * the `content` of a `role: 'tool'` message.
 */
export function serializeToolResultContent(content: ReadonlyArray<unknown>): string {
  return content
    .map((piece) => {
      if (typeof piece === 'string') return piece;
      const serialized = JSON.stringify(piece);
      return serialized ?? 'null';
    })
    .join('\n');
}

/**
 * Result type for `mapToolResultToMiniMax`. On success it is a
 * `MiniMaxWireMessage` (the `role: 'tool'` form). On failure it is a
 * `ToolSchemaError` envelope the transport must surface as a chat
 * error.
 */
export type ToolResultMapping = MiniMaxWireMessage | ToolSchemaError;

/**
 * Map a VS Code tool-result part into a MiniMax tool wire message.
 * Returns a `ToolSchemaError` envelope (not a throw) when the input
 * is structurally invalid — the transport (T05) is expected to log
 * the error and skip the offending result rather than abort the
 * agent turn.
 */
export function mapToolResultToMiniMax(part: ChatToolResultPart): ToolResultMapping {
  if (typeof part !== 'object' || part === null) {
    return { kind: 'tool-result-content-not-list', callId: '<unknown>' };
  }
  if (typeof part.callId !== 'string' || part.callId.length === 0) {
    return { kind: 'tool-result-missing-call-id' };
  }
  if (!Array.isArray(part.content)) {
    return { kind: 'tool-result-content-not-list', callId: part.callId };
  }
  return {
    role: 'tool',
    content: serializeToolResultContent(part.content),
    toolCallId: part.callId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming tool-call accumulator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initial state for a tool-call accumulator. The transport (T05)
 * holds one state per chat request, feeds deltas in, and pulls
 * completed parts out via `finalizeAccumulator` when the stream
 * ends.
 */
export function accumulatorSeed(): ToolCallAccumulatorState {
  return {
    perIndex: new Map<number, AccumulatingCall>(),
    active: true,
  };
}

/** Internal: per-index in-flight tool call. */
interface AccumulatingCall {
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
}

/**
 * Internal helper — used by the tests via `finalizeAccumulator` to
 * read the raw arguments for a given index. Not exported.
 */
function rawArgumentsFor(state: ToolCallAccumulatorState, index: number): string | undefined {
  return state.perIndex.get(index)?.arguments;
}

/**
 * Result of feeding one stream event into the accumulator. The
 * `state` is always the new state to feed into the next call; the
 * `parts` are any tool calls that became complete as a direct
 * consequence of this event (today this is always empty — parts
 * finalize on `finalizeAccumulator` — but the type is shaped for
 * future Anthropic-style content blocks that may emit in-flight).
 */
export interface AccumulatorStep {
  readonly state: ToolCallAccumulatorState;
  readonly parts: ReadonlyArray<ChatToolCallPart | ToolSchemaError>;
}

/**
 * Feed a single tool-call delta into the accumulator. The function
 * clones the underlying map and returns a new state object so callers
 * can treat the accumulator as immutable. Given the same `state` and
 * `event`, it always returns the same `parts` and a `state` with the
 * same effective contents.
 *
 * Per the OpenAI-compatible wire spec, tool-call deltas carry:
 *  - `index`              — the call's position in the `tool_calls` array.
 *  - `id`                 — the call id (set once, on the first delta).
 *  - `name`               — the function name (set once, on the first delta).
 *  - `argumentsDelta`     — a fragment of the JSON arguments string.
 *
 * A protocol violation (re-using a call id with a different index)
 * is reported by emitting a typed `duplicate-call-id` envelope in
 * `parts` and leaving the state untouched so the in-flight call is
 * not lost. The transport is expected to surface the error to the
 * user as a chat error but keep the turn going.
 */
export function accumulateToolCallDelta(
  state: ToolCallAccumulatorState,
  delta: Extract<NonNullable<MiniMaxStreamEvent['toolCallDelta']>, object>,
): AccumulatorStep {
  const { index, id, name, argumentsDelta } = delta;

  // Protocol violation: the same call id is being assigned to a
  // *different* index than the one we already have on file. This
  // cannot happen in a well-behaved stream; if it does, the
  // transport must not silently overwrite the in-flight call.
  if (id !== undefined) {
    for (const [existingIndex, existing] of state.perIndex) {
      if (existing.callId === id && existingIndex !== index) {
        return {
          state,
          parts: [
            {
              kind: 'duplicate-call-id',
              callId: id,
              index,
            },
          ],
        };
      }
    }
  }

  // Protocol violation: the same index is being re-keyed with a
  // *different* call id. The transport must drop the new event.
  if (state.perIndex.has(index)) {
    const existing = state.perIndex.get(index);
    if (existing && id !== undefined && id !== existing.callId) {
      return {
        state,
        parts: [
          {
            kind: 'duplicate-call-id',
            callId: id,
            index,
          },
        ],
      };
    }
  }

  // Build the next state. We use a mutable copy of the Map so the
  // function remains referentially transparent.
  const next = new Map(state.perIndex);
  const current: AccumulatingCall = next.get(index) ?? {
    callId: id ?? '',
    name: name ?? '',
    arguments: '',
    started: false,
  };
  const updated: AccumulatingCall = {
    callId: id !== undefined ? id : current.callId,
    name: name !== undefined ? name : current.name,
    arguments: current.arguments + (argumentsDelta ?? ''),
    started: current.started || name !== undefined || (argumentsDelta?.length ?? 0) > 0,
  };
  next.set(index, updated);
  return { state: { perIndex: next, active: state.active }, parts: [] };
}

/**
 * Drain the accumulator. For every in-flight call, attempt to parse
 * its accumulated arguments; on success emit a `ChatToolCallPart`,
 * on failure emit a `ToolSchemaError` envelope with `repairAttempted:
 * true` (the bounded repair was tried first). The order of emitted
 * parts matches the order of the `perIndex` Map (numeric index,
 * ascending).
 */
export function finalizeAccumulator(
  state: ToolCallAccumulatorState,
): ReadonlyArray<ChatToolCallPart | ToolSchemaError> {
  const out: Array<ChatToolCallPart | ToolSchemaError> = [];
  const indices = Array.from(state.perIndex.keys()).sort((a, b) => a - b);
  for (const index of indices) {
    const call = state.perIndex.get(index);
    if (!call) continue;
    if (call.callId.length === 0 || call.name.length === 0) {
      out.push({
        kind: 'argument-parse-failed',
        callId: call.callId,
        index,
        rawArguments: call.arguments,
        repairAttempted: false,
      });
      continue;
    }
    const repaired = repairTruncatedJson(call.arguments);
    try {
      const input = JSON.parse(repaired) as { readonly [key: string]: unknown };
      out.push({ callId: call.callId, name: call.name, input });
    } catch {
      out.push({
        kind: 'argument-parse-failed',
        callId: call.callId,
        index,
        rawArguments: call.arguments,
        repairAttempted: true,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded JSON repair
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bounded JSON repair for truncated argument streams. The repair
 * algorithm is intentionally simple — it does not try to recover
 * arbitrary syntactic errors, only the common cases where the model
 * was cut off mid-structure or mid-value.
 *
 * Steps (in order):
 *  1. If the input parses as-is, return it unchanged.
 *  2. Walk the input once to build a stack of open `{` / `[` (in
 *     nesting order) and detect partial-entry truncation
 *     (trailing `,`, trailing `:`, or partial key with no colon).
 *  3. If a partial entry was detected, strip it back to the last
 *     `,` (or the last open structural token) and re-walk the
 *     truncated string.
 *  4. Close any unclosed string with a final `"`.
 *  5. Close any still-open `{` / `[` in nesting-reverse order
 *     (innermost first) so the resulting JSON is well-formed.
 *  6. Try parsing again; if it succeeds, return the repaired
 *     string.
 *  7. If the result still does not parse, return the ORIGINAL
 *     string — `finalizeAccumulator` will catch the failure and
 *     surface a typed `argument-parse-failed` error.
 *
 * "Bounded" means: at most one repair pass; no recursive nesting
 * attempt; no insertion of `null` or `0` placeholders. The function
 * will never invent content the model did not emit; the partial
 * entry is dropped, not padded.
 */
export function repairTruncatedJson(input: string): string {
  // Fast path: already valid.
  try {
    JSON.parse(input);
    return input;
  } catch {
    // fall through to repair
  }

  // Walk the input once to capture the bracket stack, in-string
  // state, the last `,` position, the last significant
  // non-whitespace character, and whether a `:` has appeared
  // since the last `,` or open structural token (used to tell
  // a truncated KEY from a truncated VALUE).
  interface Walk {
    stack: Array<'{' | '['>;
    inString: boolean;
    lastComma: number;
    lastSig: { ch: string; pos: number } | null;
    colonAfterLastSep: boolean;
  }
  const walk = (s: string): Walk => {
    const stack: Array<'{' | '['> = [];
    let inString = false;
    let lastComma = -1;
    let lastSig: { ch: string; pos: number } | null = null;
    let colonAfterLastSep = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === undefined) continue;
      if (inString) {
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '"') {
          inString = false;
          lastSig = { ch: '"', pos: i };
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        lastSig = { ch: '"', pos: i };
        continue;
      }
      if (c === '{' || c === '[') {
        stack.push(c);
        lastSig = { ch: c, pos: i };
        colonAfterLastSep = false;
        continue;
      }
      if (c === '}' || c === ']') {
        stack.pop();
        lastSig = { ch: c, pos: i };
        continue;
      }
      if (c === ',') {
        lastComma = i;
        lastSig = { ch: ',', pos: i };
        colonAfterLastSep = false;
        continue;
      }
      if (c === ':') {
        lastSig = { ch: ':', pos: i };
        colonAfterLastSep = true;
        continue;
      }
      if (!/\s/.test(c)) {
        lastSig = { ch: c, pos: i };
      }
    }
    return { stack, inString, lastComma, lastSig, colonAfterLastSep };
  };

  let repaired = input;
  let state = walk(repaired);

  // Partial entry detection.
  //
  // The model got cut off in one of three ways:
  //   - trailing `,`                       — start of a new entry
  //                                          that was never written.
  //   - trailing `:`                       — key was written, value
  //                                          was not.
  //   - trailing `"` with NO colon since   — partial key (the
  //     the last `,` / open                     string was opened
  //                                          but never closed and
  //                                          there is no `:`).
  //
  // A trailing `"` WITH a colon since the last separator is a
  // truncated VALUE (the value's string was opened but not
  // closed); the right repair is to close the string and the
  // brace, NOT to drop the entry.
  const lastCh = state.lastSig?.ch;
  const partialKey = state.inString && lastCh === '"' && !state.colonAfterLastSep;
  const partial = lastCh === ',' || lastCh === ':' || partialKey;

  if (partial) {
    if (state.lastComma !== -1 && (lastCh === ',' || lastCh === ':')) {
      // Truncate AT the last `,` (the comma is dropped, along with
      // everything after it). This preserves the previous complete
      // entry.
      repaired = repaired.slice(0, state.lastComma);
    } else {
      // No `,` to truncate at — find the most recent unmatched
      // open structural token and keep up to and including it.
      // Walk back through `repaired` looking for the last `{` or
      // `[`; everything after it is partial.
      let cut = -1;
      for (let i = repaired.length - 1; i >= 0; i--) {
        const c = repaired[i];
        if (c === '{' || c === '[') {
          cut = i + 1;
          break;
        }
      }
      if (cut !== -1) {
        repaired = repaired.slice(0, cut);
      } else {
        // Nothing structural to keep; nothing to repair.
        return input;
      }
    }
    // Re-walk the truncated string to refresh the stack.
    state = walk(repaired);
  }

  // Close any unclosed string.
  if (state.inString) {
    repaired += '"';
    state = walk(repaired);
  }

  // Close remaining opens in LIFO order (innermost first) so the
  // resulting JSON is well-formed.
  while (state.stack.length > 0) {
    const top = state.stack.pop();
    repaired += top === '{' ? '}' : ']';
  }

  // Final attempt.
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return input; // surface the failure to the caller
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (not exported; kept here for the test file to
// exercise via the public API only — the tests do NOT import these).
// ─────────────────────────────────────────────────────────────────────────────

// Wrap a `ToolSchemaError` into a thrown `Error` for the rare cases
// where the mapping MUST fail loudly (e.g. an invalid tool
// definition that would silently pass through to the API). This is
// the ONLY path in the file that throws — all the streaming-time
// failures return envelopes.
class ToolSchemaMappingError extends Error {
  readonly detail: ToolSchemaError;
  constructor(detail: ToolSchemaError) {
    super(`ToolSchemaMappingError: ${detail.kind}`);
    this.detail = detail;
  }
}

/**
 * Type guard for `ToolSchemaError`. The `kind` discriminator is
 * present on every variant of the union, so a single guard
 * narrows the type. Use this at consumer boundaries (T05, T07,
 * tests) instead of `'role' in x` — the `in` operator's type
 * constraint requires the key to exist in the union, but
 * `ToolSchemaError` has no field in common with the wire message
 * type, so the `in` narrowing would fail to compile.
 */
export function isToolSchemaError(x: unknown): x is ToolSchemaError {
  return (
    typeof x === 'object' &&
    x !== null &&
    'kind' in x &&
    typeof (x).kind === 'string'
  );
}

// Suppress the unused-export warning for `rawArgumentsFor`; it is
// reserved for a future debugging surface (T05 will log raw
// argument strings when surfacing an error envelope).
void rawArgumentsFor;
