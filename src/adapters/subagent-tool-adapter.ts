/**
 * subagent-tool-adapter — VS Code wiring for the `minimax_subagent`
 * tool.
 *
 * T35: the LM-provider chat widget renders a tool's
 * `LanguageModelToolResult.content` array verbatim — one box per
 * item. VS Code's built-in `runSubagent` returns a multi-part
 * result (text + thinking + tool-calls), so it renders as a wall of
 * blank boxes. We register a custom `minimax_subagent` tool that:
 *
 *   1. Validates the input (description, prompt, optional type).
 *   2. Internally invokes `vscode.lm.invokeTool('runSubagent', ...)`
 *      to delegate the actual sub-agent execution to VS Code.
 *   3. Walks the multi-part result and synthesizes it into a single
 *      `<task>` text block via the domain synthesizer.
 *   4. Returns a `LanguageModelToolResult` containing exactly one
 *      `LanguageModelTextPart` so the widget renders exactly one
 *      box.
 *
 * The model never sees the multi-part content; it sees a clean
 * single-string payload.
 *
 * Pattern matches `src/adapters/mcp-search-adapter.ts`: descriptor
 * in domain, registration + invoke handler in adapter. Pure parts
 * (`buildSubAgentToolResult`, `validateSubAgentInput`) live in
 * `src/lib/domain/subagent-tool.ts` and have their own test file.
 */
import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import {
  buildSubAgentToolResult,
  MINIMAX_SUBAGENT_TOOL,
  validateSubAgentInput,
} from '../lib/domain/subagent-tool.js';
import type { SubAgentState } from '../lib/domain/subagent-synthesis.js';

export interface SubAgentToolAdapterDeps {
  readonly logger: Logger;
}

/**
 * Build a `LanguageModelToolResult` from a single rendered text.
 * Single-text results render as exactly one part in the chat widget.
 */
function asToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Invoke the underlying `runSubagent` tool. The `vscode.lm.invokeTool`
 * API requires either a `ChatParticipantToolToken` or `undefined` —
 * we pass `undefined` because our invocation originates from a
 * registered tool's `invoke` handler, not a chat participant.
 *
 * Returns the emitted parts plus the final state. A thrown error
 * maps to `state: "error"`.
 */
async function invokeUnderlyingRunSubAgent(
  description: string,
  prompt: string,
  subagentType: string | undefined,
  token: vscode.CancellationToken,
  deps: SubAgentToolAdapterDeps,
): Promise<{
  parts: ReadonlyArray<unknown>;
  state: SubAgentState;
  summary?: string;
  error?: string;
}> {
  const lm = vscode.lm as unknown as {
    invokeTool(
      name: string,
      options: {
        toolInvocationToken: undefined;
        input: unknown;
      },
      token: vscode.CancellationToken,
    ): Thenable<vscode.LanguageModelToolResult>;
  };
  try {
    const input: Record<string, unknown> = { description, prompt };
    if (subagentType !== undefined) input['subagent_type'] = subagentType;
    const result = await lm.invokeTool(
      'runSubagent',
      { toolInvocationToken: undefined, input },
      token,
    );
    const parts: unknown[] = [];
    // `LanguageModelToolResult` exposes a `content` array. Per
    // VS Code 1.125, the iteration shape is `for (const part of result.content)`
    // and each part is a `LanguageModelResponsePart` union. We treat
    // the array as `unknown[]` here so the domain layer can stay
    // `vscode`-free.
    for (const part of (result as { content: ReadonlyArray<unknown> }).content) {
      parts.push(part);
    }
    return { parts, state: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn('Underlying runSubagent invocation failed', { error: message });
    return { parts: [], state: 'error', error: message };
  }
}

/**
 * Register the `minimax_subagent` tool with VS Code's LM host.
 * The returned disposable unregisters on extension deactivation;
 * `extension.ts` calls this at activation and pushes the disposable
 * onto the extension context's subscriptions.
 */
export function registerSubAgentTool(deps: SubAgentToolAdapterDeps): vscode.Disposable {
  const tool: vscode.LanguageModelTool<Record<string, unknown>> = {
    invoke: async (
      options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
      token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> => {
      const validation = validateSubAgentInput(options.input);
      if (!validation.ok || validation.value === undefined) {
        deps.logger.info('minimax_subagent rejected', { reason: validation.errorMessage });
        return asToolResult(validation.errorMessage ?? 'minimax_subagent: invalid input');
      }
      const { description, prompt } = validation.value;
      const subagentType = validation.value.subagent_type;

      const underlying = await invokeUnderlyingRunSubAgent(
        description,
        prompt,
        subagentType,
        token,
        deps,
      );
      const text = buildSubAgentToolResult(
        underlying.parts,
        underlying.state,
        {},
        underlying.summary ?? underlying.error,
      );
      deps.logger.info('minimax_subagent dispatched', {
        description,
        ok: underlying.state === 'completed',
        partCount: underlying.parts.length,
      });
      return asToolResult(text);
    },
  };
  return vscode.lm.registerTool(MINIMAX_SUBAGENT_TOOL, tool);
}
