/**
 * T35 - Pure domain tests for MCP tool discovery (search + load).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  buildSearchToolDescriptors,
  findLiveTool,
  handleMcpSearchTools,
  isMcpServerTool,
  MCP_SEARCH_LIMIT_DESCRIPTION,
  oneLine,
  MCP_LOAD_TOOL,
  MCP_SEARCH_TOOLS_TOOL,
  renderMcpLoadResult,
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
    ok(result.error!.text.includes('mcp_search_tools'));
    ok(!result.error!.text.includes('Available servers'));
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

// ─── #109: our own discovery tools are not MCP server tools ────────────────

describe('discovery tools are excluded from the live MCP set (#109)', () => {
  const own: ReadonlyArray<LiveMcpToolInfo> = [
    { name: 'mcp_search_tools', description: 'Search the MCP tools', inputSchema: {} },
    { name: 'mcp_load', description: 'Invoke one MCP tool by exact name', inputSchema: {} },
  ];

  it('isMcpServerTool rejects the two discovery tools and non-mcp names', () => {
    strictEqual(isMcpServerTool('mcp_github_list_issues'), true);
    strictEqual(isMcpServerTool('mcp_search_tools'), false);
    strictEqual(isMcpServerTool('mcp_load'), false);
    strictEqual(isMcpServerTool('run_in_terminal'), false);
  });

  it('search never returns them, even if the inventory contains them', () => {
    const result = handleMcpSearchTools(
      { query: 'search the loaded tools for a tool I need' },
      { tools: [...own, ...FIXTURES] },
    );
    ok(!result.text.includes('mcp_search_tools --'));
    ok(!result.text.includes('mcp_load --'));
  });

  it('mcp_load refuses to load itself or the search tool', () => {
    for (const name of ['mcp_load', 'mcp_search_tools']) {
      const r = validateMcpLoad({ tool: name }, { tools: [...own, ...FIXTURES] });
      strictEqual(r.ok, false, name);
      ok(r.error!.text.includes('discovery tool'));
    }
  });
});

// ─── #110: hyphenated and underscored server ids ───────────────────────────

describe('server ids with hyphens and underscores (#110)', () => {
  const tools: ReadonlyArray<LiveMcpToolInfo> = [
    { name: 'mcp_sequential-th_sequentialthinking', description: 'Step by step reasoning', inputSchema: {} },
    { name: 'mcp_github_enterprise_list_issues', description: 'List enterprise issues', inputSchema: {} },
  ];

  it('finds a tool on a hyphenated server (it used to vanish from inventory)', () => {
    const r = handleMcpSearchTools({ query: 'step by step reasoning' }, { tools });
    ok(r.text.includes('mcp_sequential-th_sequentialthinking'));
  });

  it('never claims a server count, which the tool names cannot determine', () => {
    const r = handleMcpSearchTools({ query: 'zzzzqx' }, { tools });
    ok(r.text.includes('among 2 loaded MCP tools'));
    ok(!r.text.includes('server'));
  });

  it('loads a hyphenated-server tool by exact name', () => {
    strictEqual(validateMcpLoad({ tool: 'mcp_sequential-th_sequentialthinking' }, { tools }).ok, true);
  });
});

// ─── #111: multi-line descriptions cannot forge result entries ─────────────

describe('descriptions are rendered on one bounded line (#111)', () => {
  const numbered = [
    'Resolves a library name.',
    '',
    'Selection Process:',
    '1. Analyze the query',
    '2. Return the most relevant match',
  ].join('\n');

  it('oneLine collapses whitespace and newlines', () => {
    strictEqual(oneLine('a\n\n  b\t c'), 'a b c');
    strictEqual(oneLine('   '), '(no description)');
  });

  it('oneLine truncates long descriptions with an ellipsis', () => {
    const out = oneLine('word '.repeat(200));
    ok(out.length <= 200);
    ok(out.endsWith('…'));
  });

  it('a numbered list inside a description adds no extra numbered result lines', () => {
    const tools: ReadonlyArray<LiveMcpToolInfo> = [
      { name: 'mcp_ctx_resolve', description: numbered, inputSchema: {} },
      { name: 'mcp_ctx_other', description: 'Resolve things', inputSchema: {} },
    ];
    const r = handleMcpSearchTools({ query: 'resolve' }, { tools });
    const numberedLines = r.text.split('\n').filter((l) => /^\d+\. /.test(l));
    strictEqual(numberedLines.length, 2);
    ok(numberedLines.every((l) => l.includes(' -- ')));
  });
});

// ─── H2: runtime schema and package.json manifest agree ────────────────────

describe('mcp_search_tools manifest matches the runtime descriptor', () => {
  it('has the same properties, types, required list and limit text', () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { contributes: { languageModelTools: Array<{ name: string; inputSchema: Record<string, unknown> }> } };
    const entry = manifest.contributes.languageModelTools.find((t) => t.name === MCP_SEARCH_TOOLS_TOOL);
    ok(entry, 'package.json must declare mcp_search_tools');
    const runtime = buildSearchToolDescriptors().find((d) => d.name === MCP_SEARCH_TOOLS_TOOL)!;
    const m = entry.inputSchema;
    deepStrictEqual(m['required'], runtime.inputSchema['required']);
    strictEqual(m['additionalProperties'], runtime.inputSchema['additionalProperties']);
    const mp = m['properties'] as Record<string, { type: string; description: string }>;
    const rp = runtime.inputSchema.properties as Record<string, { type: string; description: string }>;
    deepStrictEqual(Object.keys(mp).sort(), Object.keys(rp).sort());
    for (const key of Object.keys(rp)) strictEqual(mp[key]?.type, rp[key]?.type, key);
    strictEqual(mp['limit']?.description, MCP_SEARCH_LIMIT_DESCRIPTION);
  });
});
