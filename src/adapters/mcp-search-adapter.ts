/**
 * T35 - MCP server-level tool discovery: VS Code wiring.
 *
 * Adapter that registers the three `mcp_*` invoker tools via
 * `vscode.lm.registerTool(...)` and wires each `invoke` handler to
 * the host's MCP tooling. The pure shape and per-call result
 * rendering live in `src/lib/domain/mcp-search-tools.ts`; this
 * module only adds the I/O layer that calls into VS Code.
 *
 * The three tools are intentionally registered as real VS Code
 * tools (not synthesized in the chat-provider) so they appear in
 * `vscode.lm.tools` for every chat provider that runs alongside us
 * - the chat-provider's stream-pump sees them in the model's
 * `tool_use` blocks and the host invokes them via its standard
 * `LanguageModelToolInvocationOptions.invoke(...)` dispatch.
 *
 * Crucially, the `invoke` handler for `mcp_load` calls
 * `(vscode.lm as any).invokeTool(realName, input, token)` to run
 * the underlying MCP tool. This requires the typed
 * `vscode.lm.tools[].name` to match exactly what the host
 * registered, and works because `vscode.lm.invokeTool(...)` does
 * not need a chat-participant `toolInvocationToken` - the host
 * accepts a plain `thenable` invocation outside the chat-participant
 * API. (The `LanguageModelChatProvider` API doesn't expose
 * `invokeTool`; the only path from a provider into another tool
 * is to register a tool of our own and let the host do the
 * dispatch, which is exactly what we do here.)
 */
import * as vscode from 'vscode';

import type { Logger } from '../ports/logger.js';
import {
  buildSearchToolDescriptors,
  findLiveTool,
  handleMcpListServers,
  handleMcpListTools,
  MCP_LIST_SERVERS_TOOL,
  MCP_LIST_TOOLS_TOOL,
  MCP_LOAD_TOOL,
  renderMcpLoadResult,
  validateMcpLoad,
  type LiveMcpToolInfo,
} from '../lib/domain/mcp-search-tools.js';

export interface McpSearchAdapterDeps {
  readonly logger: Logger;
  /**
   * Snapshot of the live MCP tool set. The adapter calls this
   * on every invocation because the user's MCP installation can
   * change between turns (extension add/remove, server start/stop).
   * Production wires this to `vscode.lm.tools` filtered to the
   * `mcp_` namespace; tests pass a stub list.
   */
  readonly getLiveMcpTools: () => ReadonlyArray<LiveMcpToolInfo>;
  /**
   * Recency-tracker bump fired after a successful `mcp_load`
   * invocation. The chat-provider owns the tracker; the adapter
   * is a no-op when this is undefined. The bump keeps the just-
   * loaded tool in the always-included set for the rest of the
   * session.
   */
  readonly onMcpToolInvoked?: (toolName: string) => void;
}

/**
 * Format a `LanguageModelToolResultPart` from a rendered text. The
 * VS Code host renders single-text results as one tool result part;
 * structured results are also supported (we use strings for
 * portability across hosts).
 */
function asToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/**
 * Cast the chat-provider's live-vscode-tools snapshot into the
 * pure-domain shape. The chat-provider already filters to
 * `mcp_`-prefixed names, so this is just a type narrowing.
 */

/**
 * Invoke the underlying MCP tool by name using the host's
 * `vscode.lm.invokeTool(...)` API. The `as any` cast is the same
 * escape hatch every BYOK provider uses: `invokeTool` is public
 * but the `@types/vscode` surface area varies by VS Code version.
 * Returns the rendered text (or a typed error message) so the
 * `mcp_load` invoker can wrap the result and return it to the
 * model.
 */
async function invokeUnderlyingMcpTool(
  toolName: string,
  input: Readonly<Record<string, unknown>> | undefined,
  token: vscode.CancellationToken,
  deps: McpSearchAdapterDeps,
): Promise<{ text: string; ok: boolean }> {
  const liveTool = findLiveTool(deps.getLiveMcpTools(), toolName);
  if (liveTool === undefined) {
    return {
      text:
        'Tool `' +
        toolName +
        '` is not currently loaded. Call mcp_list_servers then mcp_list_tools to find the exact name.',
      ok: false,
    };
  }
  // The typed `vscode.lm.invokeTool` API requires
  // `ChatParticipantToolToken | undefined`. When the call originates
  // from our own tool (outside the chat-participant API), the
  // token is undefined; the host's runtime accepts this.
  try {
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
    const result = await lm.invokeTool(
      toolName,
      { toolInvocationToken: undefined, input: input ?? {} },
      token,
    );
    // Render the result as a string. `LanguageModelToolResult`
    // exposes a `content` array (not iterable directly).
    const chunks: string[] = [];
    for (const part of result.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        chunks.push(part.value);
      } else if (
        typeof part === 'object' &&
        part !== null &&
        'value' in part &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        typeof (part as { value: unknown } & object).value === 'string'
      ) {
        chunks.push((part as { value: string }).value);
      }
    }
    const text = chunks.join('\n');
    if (text === '') {
      return {
        text: 'Tool `' + toolName + '` completed with no text output.',
        ok: true,
      };
    }
    return { text, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: 'Tool `' + toolName + '` failed: ' + message,
      ok: false,
    };
  }
}

/**
 * Register the three `mcp_*` invoker tools with VS Code's LM
 * host. The returned disposable unregisters all three on
 * extension deactivation; the activation root in `extension.ts`
 * pushes it onto `context.subscriptions`.
 */
export function registerMcpSearchTools(
  context: vscode.ExtensionContext,
  deps: McpSearchAdapterDeps,
): vscode.Disposable {
  const descriptors = buildSearchToolDescriptors();
  const byName = new Map(descriptors.map((d) => [d.name, d]));

  // The `registerTool` typed signature in `@types/vscode` only
  // declares `{ invoke }` on the tool implementation, but the
  // VS Code runtime accepts `description` / `inputSchema` / `tags`
  // on the implementation object as well (Copilot's BYOK
  // providers use the same escape hatch). We use a minimal
  // structural cast so the typed surface stays clean while the
  // runtime gets the metadata it needs to surface the tool
  // to the model with a useful description and schema.
  type ToolMetadata = {
    description: string;
    inputSchema: unknown;
    tags: ReadonlyArray<string> | undefined;
  };
  const make = (descriptor: (typeof descriptors)[number]) => {
    const metadata: ToolMetadata = {
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      tags: descriptor.tags,
    };
    const tool = {
      ...metadata,
      invoke: async (
        options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
        token: vscode.CancellationToken,
      ): Promise<vscode.LanguageModelToolResult> => {
        const input = options.input ?? {};
        if (descriptor.name === MCP_LIST_SERVERS_TOOL) {
          const result = handleMcpListServers({ tools: deps.getLiveMcpTools() });
          deps.logger.debug('mcp_list_servers invoked', { kind: result.kind });
          return asToolResult(result.text);
        }
        if (descriptor.name === MCP_LIST_TOOLS_TOOL) {
          const result = handleMcpListTools(
            { server: typeof input['server'] === 'string' ? input['server'] : '' },
            { tools: deps.getLiveMcpTools() },
          );
          deps.logger.debug('mcp_list_tools invoked', { kind: result.kind });
          return asToolResult(result.text);
        }
        if (descriptor.name === MCP_LOAD_TOOL) {
          const toolName = typeof input['tool'] === 'string' ? input['tool'] : '';
          const callInput = input['input'] as Record<string, unknown> | undefined;
          const validation = validateMcpLoad(
            callInput === undefined ? { tool: toolName } : { tool: toolName, input: callInput },
            { tools: deps.getLiveMcpTools() },
          );
          if (!validation.ok) {
            deps.logger.info('mcp_load rejected', {
              tool: toolName,
              reason: validation.error?.text,
            });
            return asToolResult(validation.error?.text ?? 'mcp_load: invalid input');
          }
          const callId =
            (options as { toolInvocationToken?: unknown }).toolInvocationToken === undefined
              ? 'mcp_load'
              : 'mcp_load_invoked';
          const invocation = await invokeUnderlyingMcpTool(toolName, callInput, token, deps);
          if (invocation.ok && deps.onMcpToolInvoked !== undefined) {
            deps.onMcpToolInvoked(toolName);
          }
          deps.logger.info('mcp_load dispatched', {
            tool: toolName,
            ok: invocation.ok,
          });
          const text = invocation.ok
            ? renderMcpLoadResult(toolName, callId, invocation.text)
            : invocation.text;
          return asToolResult(text);
        }
        // Unreachable: the descriptor name doesn't match any of the
        // three handlers above. The runtime will never call us
        // with an unknown name, but a defensive error keeps the
        // tool untyped-exception-safe.
        return asToolResult('mcp-search adapter: unknown tool name "' + descriptor.name + '".');
      },
    };
    return vscode.lm.registerTool(
      descriptor.name,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      tool as vscode.LanguageModelTool<Record<string, unknown>>,
    );
  };

  const disposables: vscode.Disposable[] = [];
  for (const d of descriptors) {
    const desc = byName.get(d.name);
    if (desc === undefined) continue;
    try {
      disposables.push(make(desc));
      deps.logger.debug('Registered MCP search tool', { name: d.name });
    } catch (err) {
      // Registration is best-effort: on hosts that don't yet
      // support `lm.registerTool` (older Insiders), the tools
      // simply don't appear. Log and continue.
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn('Failed to register MCP search tool', {
        name: d.name,
        error: message,
      });
    }
  }
  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}
