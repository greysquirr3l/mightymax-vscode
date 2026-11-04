/**
 * T35 - MCP tool discovery.
 *
 * Pure domain module. Defines two lightweight tools the chat-provider
 * always includes in the wire so the model can find and call MCP tools
 * without the rolling LRU having to fit every MCP tool schema into the
 * wire on every request: `mcp_search_tools` (BM25 relevance search over
 * every loaded MCP tool) and `mcp_load` (invoke one by exact name).
 */
import type { Logger } from '../../ports/logger.js';
import { schemaPropertyNames, searchTools } from './tool-search.js';

export const MCP_SEARCH_TOOLS_TOOL = 'mcp_search_tools';
export const MCP_LOAD_TOOL = 'mcp_load';

/** Default and maximum number of search hits returned. */
export const MCP_SEARCH_DEFAULT_LIMIT = 8;
export const MCP_SEARCH_MAX_LIMIT = 25;

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
  readonly kind: 'search' | 'tool-result' | 'error';
  readonly resolvedTool?: string;
}

export interface McpLoadOptions {
  readonly tools: ReadonlyArray<LiveMcpToolInfo>;
  readonly logger?: Logger;
}

export interface McpSearchInput {
  readonly query: string;
  readonly limit?: number;
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
      name: MCP_SEARCH_TOOLS_TOOL,
      description:
        'Search the MCP tools currently loaded by VS Code by what you need to do (for example "create a github pull request" or "query a postgres table"). Returns the best-matching tools with their exact names, descriptions and parameters, across all MCP servers; then call mcp_load with a returned name. Use this when you need an MCP tool that is not in your current tool list.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you want to do, or keywords from the tool name or its parameters.',
          },
          limit: {
            type: 'number',
            description:
              'Maximum results (default ' +
              String(MCP_SEARCH_DEFAULT_LIMIT) +
              ', max ' +
              String(MCP_SEARCH_MAX_LIMIT) +
              ').',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      tags: ['mcp-discovery'],
    },
    {
      name: MCP_LOAD_TOOL,
      description:
        'Invoke one MCP tool by exact name and return its result. The named tool does not need to be in your current tool list; calling mcp_load records the tool as recently used so it joins your tool list for subsequent turns in this session. Use this to run an MCP tool found with mcp_search_tools.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Exact tool name from mcp_search_tools, e.g. "mcp_github_list_issues".',
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

/** One search hit as the model reads it: exact name, description, parameter names. */
function renderSearchHit(tool: LiveMcpToolInfo, rank: number): string {
  const params = schemaPropertyNames(tool.inputSchema, 0);
  const required = (tool.inputSchema as { required?: unknown } | undefined)?.required;
  const requiredSet = new Set(Array.isArray(required) ? (required as string[]) : []);
  const paramText =
    params.length === 0
      ? ''
      : ' | params: ' + params.map((p) => (requiredSet.has(p) ? p + '*' : p)).join(', ');
  return (
    String(rank) + '. ' + tool.name + ' -- ' + (tool.description || '(no description)') + paramText
  );
}

export function handleMcpSearchTools(
  input: McpSearchInput,
  opts: McpLoadOptions,
): McpInvokerResponse {
  const query = input.query.trim();
  if (query === '') {
    return {
      kind: 'error',
      text: '`query` parameter is required. Describe what you want to do, e.g. "create a github pull request".',
    };
  }
  if (opts.tools.length === 0) {
    return { kind: 'search', text: 'No MCP tools are currently loaded into VS Code.' };
  }
  const limit = Math.min(
    MCP_SEARCH_MAX_LIMIT,
    Math.max(1, Math.floor(input.limit ?? MCP_SEARCH_DEFAULT_LIMIT)),
  );
  const hits = searchTools(query, opts.tools, limit);
  if (hits.length === 0) {
    return {
      kind: 'search',
      text:
        'No loaded MCP tool matches "' +
        query +
        '" (' +
        String(opts.tools.length) +
        ' tools across ' +
        String(uniqueMcpServers(opts.tools).length) +
        ' server(s)). Try different keywords.',
    };
  }
  return {
    kind: 'search',
    text:
      String(hits.length) +
      ' matching tool(s) (* = required parameter):\n' +
      hits.map((h, i) => renderSearchHit(h.tool, i + 1)).join('\n') +
      '\n\nCall mcp_load with the exact tool name and its input.',
  };
}

export function validateMcpLoad(input: McpLoadInput, opts: McpLoadOptions): McpLoadValidation {
  const trimmed = input.tool.trim();
  if (trimmed === '') {
    return {
      ok: false,
      error: {
        kind: 'error',
        text: '`tool` parameter is required. Call mcp_search_tools to find the exact tool name.',
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
          '. Call mcp_search_tools to find the exact tool name.',
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
