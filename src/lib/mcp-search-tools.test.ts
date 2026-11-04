/**
 * T35 - Pure domain tests for MCP tool discovery (search + load).
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  buildSearchToolDescriptors,
  findLiveTool,
  handleMcpSearchTools,
  MCP_LOAD_TOOL,
  MCP_SEARCH_TOOLS_TOOL,
  parseMcpName,
  renderMcpLoadResult,
  toolsForServer,
  uniqueMcpServers,
  validateMcpLoad,
  type LiveMcpToolInfo,
} from './domain/mcp-search-tools.js';

const FIXTURES: ReadonlyArray<LiveMcpToolInfo> = [
  {
    name: 'mcp_github_list_issues',
    description: 'List GitHub issues.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp_github_create_issue',
    description: 'Create a new GitHub issue.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp_github_add_comment_to_pending_review',
    description: 'Multi-word tool name with underscores.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp_clickup_create_task',
    description: 'Create a ClickUp task.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp_clickup_list_tasks',
    description: 'List ClickUp tasks.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp_weather_get_current',
    description: 'Get current weather.',
    inputSchema: { type: 'object' },
  },
  {
    name: 'run_in_terminal',
    description: 'Built-in terminal tool (not MCP).',
    inputSchema: { type: 'object' },
  },
];

describe('parseMcpName', () => {
  it('splits at the first underscore (server is a single token)', () => {
    deepStrictEqual(parseMcpName('mcp_github_list_issues'), {
      server: 'github',
      tool: 'list_issues',
    });
  });

  it('handles multi-word tool names with internal underscores', () => {
    deepStrictEqual(parseMcpName('mcp_github_add_comment_to_pending_review'), {
      server: 'github',
      tool: 'add_comment_to_pending_review',
    });
  });

  it('handles server-only names (mcp_X with no tool separator)', () => {
    deepStrictEqual(parseMcpName('mcp_something'), { server: 'something', tool: '' });
  });

  it('rejects non-mcp names', () => {
    ok(parseMcpName('run_in_terminal') === undefined);
    ok(parseMcpName('not_mcp_anything') === undefined);
    ok(parseMcpName('mcp_') === undefined);
  });

  it('rejects names with non-snake-case server segments', () => {
    // mcp_my-server_list has a hyphen in the server portion,
    // which is not a valid snake_case identifier.
    ok(parseMcpName('mcp_my-server_list') === undefined);
  });
});

describe('uniqueMcpServers', () => {
  it('returns the deduped, sorted server list', () => {
    const servers = uniqueMcpServers(FIXTURES);
    deepStrictEqual([...servers].sort(), [...servers]);
    deepStrictEqual(servers, ['clickup', 'github', 'weather']);
  });

  it('returns an empty list when no MCP tools are loaded', () => {
    deepStrictEqual(
      uniqueMcpServers([{ name: 'run_in_terminal', description: '', inputSchema: {} }]),
      [],
    );
  });
});

describe('toolsForServer', () => {
  it('returns the matching tools sorted by name', () => {
    const tools = toolsForServer(FIXTURES, 'github');
    deepStrictEqual(
      tools.map((t) => t.name),
      [
        'mcp_github_add_comment_to_pending_review',
        'mcp_github_create_issue',
        'mcp_github_list_issues',
      ],
    );
  });

  it('returns an empty list for an unknown server', () => {
    deepStrictEqual(toolsForServer(FIXTURES, 'does_not_exist'), []);
  });

  it('returns an empty list for the empty server', () => {
    deepStrictEqual(toolsForServer(FIXTURES, ''), []);
  });
});

describe('findLiveTool', () => {
  it('finds a tool by exact name', () => {
    const tool = findLiveTool(FIXTURES, 'mcp_github_list_issues');
    ok(tool !== undefined);
    strictEqual(tool.name, 'mcp_github_list_issues');
  });

  it('returns undefined for missing tools', () => {
    ok(findLiveTool(FIXTURES, 'mcp_nope_list') === undefined);
  });
});

describe('buildSearchToolDescriptors', () => {
  it('ships exactly two descriptors with the canonical names', () => {
    const descriptors = buildSearchToolDescriptors();
    strictEqual(descriptors.length, 2);
    const names = descriptors.map((d) => d.name).sort();
    deepStrictEqual(names, [MCP_SEARCH_TOOLS_TOOL, MCP_LOAD_TOOL].sort());
  });

  it('every descriptor mentions MCP in its description', () => {
    const descriptors = buildSearchToolDescriptors();
    for (const d of descriptors) {
      ok(d.description.toLowerCase().includes('mcp'), d.name + ' description should mention MCP');
    }
  });

  it('every descriptor has a non-empty object inputSchema', () => {
    const descriptors = buildSearchToolDescriptors();
    for (const d of descriptors) {
      ok(typeof d.inputSchema === 'object' && d.inputSchema !== null);
      ok('type' in d.inputSchema);
    }
  });

  it('mcp_search_tools requires a query and takes an optional limit', () => {
    const d = buildSearchToolDescriptors().find((x) => x.name === MCP_SEARCH_TOOLS_TOOL)!;
    const props = d.inputSchema.properties as Record<string, { type: string }>;
    strictEqual(props.query?.type, 'string');
    strictEqual(props.limit?.type, 'number');
    deepStrictEqual(d.inputSchema.required, ['query']);
  });

  it('mcp_load requires a tool parameter and accepts arbitrary input', () => {
    const d = buildSearchToolDescriptors().find((x) => x.name === MCP_LOAD_TOOL)!;
    const props = d.inputSchema.properties as Record<string, { type: string }>;
    ok('tool' in props);
    ok('input' in props);
  });
});

const SEARCHABLE: ReadonlyArray<LiveMcpToolInfo> = [
  ...FIXTURES,
  {
    name: 'mcp_github_create_pull_request',
    description: 'Open a pull request from a branch.',
    inputSchema: {
      type: 'object',
      properties: { head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' } },
      required: ['head', 'title'],
    },
  },
];

describe('handleMcpSearchTools', () => {
  it('ranks the best match first and renders name, description and params', () => {
    const result = handleMcpSearchTools({ query: 'create a pull request' }, { tools: SEARCHABLE });
    strictEqual(result.kind, 'search');
    const first = result.text.split('\n')[1] ?? '';
    ok(first.startsWith('1. mcp_github_create_pull_request -- Open a pull request'), first);
    ok(first.includes('params: head*, base, title*'), first);
  });

  it('matches on a parameter name, not just the tool name', () => {
    const result = handleMcpSearchTools({ query: 'base branch' }, { tools: SEARCHABLE });
    ok(result.text.includes('mcp_github_create_pull_request'));
  });

  it('finds tools across servers by keyword', () => {
    const result = handleMcpSearchTools({ query: 'create' }, { tools: SEARCHABLE });
    ok(result.text.includes('mcp_clickup_create_task'));
    ok(result.text.includes('mcp_github_create_issue'));
    ok(!result.text.includes('run_in_terminal'));
  });

  it('honours the limit', () => {
    const result = handleMcpSearchTools({ query: 'create', limit: 1 }, { tools: SEARCHABLE });
    ok(result.text.startsWith('1 matching tool(s)'));
  });

  it('says so when nothing matches', () => {
    const result = handleMcpSearchTools({ query: 'zzzzqx' }, { tools: SEARCHABLE });
    strictEqual(result.kind, 'search');
    ok(result.text.includes('No loaded MCP tool matches'));
  });

  it('rejects an empty query with an actionable error', () => {
    const result = handleMcpSearchTools({ query: '  ' }, { tools: SEARCHABLE });
    strictEqual(result.kind, 'error');
    ok(result.text.includes('`query` parameter is required'));
  });

  it('explains the next action when no MCP tools are loaded', () => {
    const result = handleMcpSearchTools({ query: 'anything' }, { tools: [] });
    ok(result.text.includes('No MCP tools are currently loaded'));
  });
});

describe('validateMcpLoad', () => {
  it('accepts a valid tool name and returns the live record', () => {
    const result = validateMcpLoad({ tool: 'mcp_github_list_issues' }, { tools: FIXTURES });
    strictEqual(result.ok, true);
    strictEqual(result.resolvedTool, 'mcp_github_list_issues');
    ok(result.liveTool !== undefined);
  });

  it('accepts multi-word tool names', () => {
    const result = validateMcpLoad(
      { tool: 'mcp_github_add_comment_to_pending_review' },
      { tools: FIXTURES },
    );
    strictEqual(result.ok, true);
    strictEqual(result.resolvedTool, 'mcp_github_add_comment_to_pending_review');
  });

  it('rejects an empty tool name', () => {
    const result = validateMcpLoad({ tool: '' }, { tools: FIXTURES });
    strictEqual(result.ok, false);
    ok(result.error);
    ok(result.error && result.error.text.includes('`tool` parameter is required'));
  });

  it('rejects a non-mcp tool name', () => {
    const result = validateMcpLoad({ tool: 'run_in_terminal' }, { tools: FIXTURES });
    strictEqual(result.ok, false);
    ok(result.error!.text.includes('not an MCP tool name'));
  });

  it('rejects an MCP tool name that is not currently loaded', () => {
    const result = validateMcpLoad({ tool: 'mcp_uninstalled_server_tool' }, { tools: FIXTURES });
    strictEqual(result.ok, false);
    ok(result.error!.text.includes('not currently loaded'));
    ok(result.error!.text.includes('Available servers: clickup, github, weather'));
    ok(result.error!.text.includes('mcp_search_tools'));
  });

  it('accepts an empty input object', () => {
    const result = validateMcpLoad(
      { tool: 'mcp_clickup_list_tasks', input: {} },
      { tools: FIXTURES },
    );
    strictEqual(result.ok, true);
  });
});

describe('renderMcpLoadResult', () => {
  it('renders a structured success envelope', () => {
    const text = renderMcpLoadResult(
      'mcp_github_list_issues',
      'call_xyz',
      '[{"id":1,"title":"hello"}]',
    );
    ok(text.includes('mcp_github_list_issues'));
    ok(text.includes('call_xyz'));
    ok(text.includes('[{"id":1,"title":"hello"}]'));
  });
});
