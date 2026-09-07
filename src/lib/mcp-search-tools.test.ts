/**
 * T35 - Pure domain tests for MCP server-level tool discovery.
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  buildSearchToolDescriptors,
  findLiveTool,
  handleMcpListServers,
  handleMcpListTools,
  MCP_LIST_SERVERS_TOOL,
  MCP_LIST_TOOLS_TOOL,
  MCP_LOAD_TOOL,
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
  it('ships exactly three descriptors with the canonical names', () => {
    const descriptors = buildSearchToolDescriptors();
    strictEqual(descriptors.length, 3);
    const names = descriptors.map((d) => d.name).sort();
    deepStrictEqual(names, [MCP_LIST_SERVERS_TOOL, MCP_LIST_TOOLS_TOOL, MCP_LOAD_TOOL].sort());
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

  it('mcp_list_servers takes no parameters', () => {
    const d = buildSearchToolDescriptors().find((x) => x.name === MCP_LIST_SERVERS_TOOL)!;
    deepStrictEqual(d.inputSchema.properties, {});
    strictEqual(d.inputSchema.type, 'object');
    ok(d.inputSchema.additionalProperties === false);
  });

  it('mcp_list_tools requires a server parameter', () => {
    const d = buildSearchToolDescriptors().find((x) => x.name === MCP_LIST_TOOLS_TOOL)!;
    const props = d.inputSchema.properties as Record<string, { type: string }>;
    ok('server' in props);
    strictEqual(props.server.type, 'string');
  });

  it('mcp_load requires a tool parameter and accepts arbitrary input', () => {
    const d = buildSearchToolDescriptors().find((x) => x.name === MCP_LOAD_TOOL)!;
    const props = d.inputSchema.properties as Record<string, { type: string }>;
    ok('tool' in props);
    ok('input' in props);
  });
});

describe('handleMcpListServers', () => {
  it('renders a numbered list with tool counts', () => {
    const result = handleMcpListServers({ tools: FIXTURES });
    strictEqual(result.kind, 'servers');
    ok(result.text.includes('3 MCP server(s) loaded'));
    ok(result.text.includes('clickup (2 tools)'));
    ok(result.text.includes('github (3 tools)'));
    ok(result.text.includes('weather (1 tools)'));
  });

  it('explains the next action when MCP is empty', () => {
    const result = handleMcpListServers({
      tools: [{ name: 'run_in_terminal', description: 'x', inputSchema: {} }],
    });
    strictEqual(result.kind, 'servers');
    ok(result.text.includes('No MCP servers are currently loaded'));
  });
});

describe('handleMcpListTools', () => {
  it('renders the matching tools with descriptions', () => {
    const result = handleMcpListTools({ server: 'github' }, { tools: FIXTURES });
    strictEqual(result.kind, 'tools');
    ok(result.text.includes('3 tool(s) on server "github"'));
    ok(result.text.includes('mcp_github_list_issues -- List GitHub issues'));
    ok(result.text.includes('mcp_github_create_issue -- Create a new GitHub issue'));
    ok(result.text.includes('mcp_github_add_comment_to_pending_review -- Multi-word'));
  });

  it('explains the typo when the server is unknown', () => {
    const result = handleMcpListTools({ server: 'typo_server' }, { tools: FIXTURES });
    strictEqual(result.kind, 'error');
    ok(result.text.includes('No tools found for server "typo_server"'));
    ok(result.text.includes('clickup, github, weather'));
  });

  it('rejects an empty server with an actionable error', () => {
    const result = handleMcpListTools({ server: '' }, { tools: FIXTURES });
    strictEqual(result.kind, 'error');
    ok(result.text.includes('`server` parameter is required'));
  });

  it('trims whitespace before lookup', () => {
    const result = handleMcpListTools({ server: '  clickup  ' }, { tools: FIXTURES });
    strictEqual(result.kind, 'tools');
    ok(result.text.includes('mcp_clickup_create_task'));
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
