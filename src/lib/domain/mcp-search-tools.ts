/**
 * T35 - MCP server-level tool discovery.
 *
 * Pure domain module. Defines three lightweight invoker tools the
 * chat-provider always includes in the wire so the model can find
 * and call MCP tools without the rolling LRU having to fit every
 * MCP tool schema into the wire on every request.
 */
import type { Logger } from '../../ports/logger.js';

export const MCP_LIST_SERVERS_TOOL = 'mcp_list_servers';
export const MCP_LIST_TOOLS_TOOL = 'mcp_list_tools';
export const MCP_LOAD_TOOL = 'mcp_load';

export interface LiveMcpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object | undefined;
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly tags?: ReadonlyArray<string>;
}

export interface McpInvokerResponse {
  readonly text: string;
  readonly kind: 'servers' | 'tools' | 'tool-result' | 'error';
  readonly resolvedTool?: string;
}

export interface McpLoadOptions {
  readonly tools: ReadonlyArray<LiveMcpToolInfo>;
  readonly logger?: Logger;
}

export interface McpListToolsInput {
  readonly server: string;
}

export interface McpLoadInput {
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface McpLoadValidation {
  readonly ok: boolean;
  readonly error?: McpInvokerResponse;
  readonly liveTool?: LiveMcpToolInfo;
  readonly resolvedTool?: string;
}

/**
 * Parse mcp_<server>_<tool> to { server, tool }. The server is a
 * single snake_case token; the tool is the remainder and may
 * itself contain underscores.
 */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp_') || name.length <= 4) return undefined;
  const rest = name.slice(4);
  const firstUnderscoreIdx = rest.indexOf('_');
  if (firstUnderscoreIdx === -1) {
    return { server: rest, tool: '' };
  }
  const server = rest.slice(0, firstUnderscoreIdx);
  const tool = rest.slice(firstUnderscoreIdx + 1);
  if (server.length === 0 || !/^[A-Za-z0-9_]+$/.test(server)) return undefined;
  return { server, tool };
}

export function uniqueMcpServers(tools: ReadonlyArray<LiveMcpToolInfo>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const tool of tools) {
    const parsed = parseMcpName(tool.name);
    if (parsed === undefined || parsed.server === '') continue;
    seen.add(parsed.server);
  }
  return [...seen].sort();
}

export function toolsForServer(
  tools: ReadonlyArray<LiveMcpToolInfo>,
  server: string,
): ReadonlyArray<LiveMcpToolInfo> {
  if (server === '') return [];
  const prefix = 'mcp_' + server + '_';
  const matched: LiveMcpToolInfo[] = [];
  for (const tool of tools) {
    if (tool.name.startsWith(prefix)) matched.push(tool);
  }
  matched.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return matched;
}

export function findLiveTool(
  tools: ReadonlyArray<LiveMcpToolInfo>,
  name: string,
): LiveMcpToolInfo | undefined {
  for (const tool of tools) {
    if (tool.name === name) return tool;
  }
  return undefined;
}

export function buildSearchToolDescriptors(): ReadonlyArray<ToolDescriptor> {
  return [
    {
      name: MCP_LIST_SERVERS_TOOL,
      description:
        'List the MCP servers currently loaded by VS Code. Returns the server names; call mcp_list_tools with a server name to see what tools that server exposes. Use this when you need to use an MCP tool that is not in your current tool list.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      tags: ['mcp-discovery'],
    },
    {
      name: MCP_LIST_TOOLS_TOOL,
      description:
        'List the tools exposed by one MCP server. Pass the server name from mcp_list_servers to see the tools it exposes. Returned format: <name> -- <description> per tool.',
      inputSchema: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Server name from mcp_list_servers (e.g. "github", "clickup").',
          },
        },
        required: ['server'],
        additionalProperties: false,
      },
      tags: ['mcp-discovery'],
    },
    {
      name: MCP_LOAD_TOOL,
      description:
        'Invoke one MCP tool by exact name and return its result. The named tool does not need to be in your current tool list; calling mcp_load records the tool as recently used so it joins your tool list for subsequent turns in this session. Use this when you need to run an MCP tool that is not currently in your tool list (typically because the rolling cap dropped it).',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Exact tool name from mcp_list_tools, e.g. "mcp_github_list_issues".',
          },
          input: {
            type: 'object',
            description:
              "Input to pass to the underlying tool (must match the tool's inputSchema; pass {} if the tool takes no arguments).",
            additionalProperties: true,
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      tags: ['mcp-discovery'],
    },
  ];
}

export function handleMcpListServers(opts: McpLoadOptions): McpInvokerResponse {
  const servers = uniqueMcpServers(opts.tools);
  if (servers.length === 0) {
    return { kind: 'servers', text: 'No MCP servers are currently loaded into VS Code.' };
  }
  const lines = servers.map(
    (s, i) =>
      String(i + 1) + '. ' + s + ' (' + String(toolsForServer(opts.tools, s).length) + ' tools)',
  );
  return {
    kind: 'servers',
    text:
      String(servers.length) +
      ' MCP server(s) loaded:\n' +
      lines.join('\n') +
      '\n\nCall mcp_list_tools with a server name to see its tools.',
  };
}

export function handleMcpListTools(
  input: McpListToolsInput,
  opts: McpLoadOptions,
): McpInvokerResponse {
  const trimmed = input.server.trim();
  if (trimmed === '') {
    return {
      kind: 'error',
      text: '`server` parameter is required. Call mcp_list_servers for the list of loaded servers.',
    };
  }
  const tools = toolsForServer(opts.tools, trimmed);
  if (tools.length === 0) {
    const known = uniqueMcpServers(opts.tools).join(', ');
    return {
      kind: 'error',
      text:
        'No tools found for server "' +
        trimmed +
        '". Currently loaded servers: ' +
        (known || '(none)') +
        '.',
    };
  }
  const lines = tools.map((t) => '- ' + t.name + ' -- ' + (t.description || '(no description)'));
  return {
    kind: 'tools',
    text: String(tools.length) + ' tool(s) on server "' + trimmed + '":\n' + lines.join('\n'),
  };
}

export function validateMcpLoad(input: McpLoadInput, opts: McpLoadOptions): McpLoadValidation {
  const trimmed = input.tool.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        kind: 'error',
        text: '`tool` parameter is required. Call mcp_list_servers then mcp_list_tools to find the exact tool name.',
      },
    };
  }
  if (!trimmed.startsWith('mcp_')) {
    return {
      ok: false,
      error: {
        kind: 'error',
        text:
          '"' +
          trimmed +
          '" is not an MCP tool name (must start with "mcp_"). Only MCP tools are invokable through this helper.',
      },
    };
  }
  const liveTool = findLiveTool(opts.tools, trimmed);
  if (liveTool === undefined) {
    const known = uniqueMcpServers(opts.tools);
    return {
      ok: false,
      error: {
        kind: 'error',
        text:
          'Tool "' +
          trimmed +
          '" is not currently loaded. Available servers: ' +
          (known.join(', ') || '(none)') +
          '. Call mcp_list_tools with a server name for the full list.',
      },
    };
  }
  return { ok: true, liveTool, resolvedTool: trimmed };
}

export function renderMcpLoadResult(
  resolvedTool: string,
  callId: string,
  outputText: string,
): string {
  return 'Tool `' + resolvedTool + '` (call ' + callId + ') completed.\n\nResult:\n' + outputText;
}
