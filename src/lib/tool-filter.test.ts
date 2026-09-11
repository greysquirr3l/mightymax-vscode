/**
 * T21 — Tool-filter tests (domain).
 *
 * Each test pins one of the four guarantees the spec calls out:
 *  - Defaults OFF, maxTools 64, real tool names, prefix-match, history
 *    reference.
 *  - Tools referenced by history tool_use / tool_result survive the
 *    cap (even if the cap was hit before).
 *  - The pinned set is computed with prefix-match: `copilot_readFile`
 *    matches the prefix pin `copilot_`.
 *  - When filtering is OFF the full set passes through.
 */

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import {
  DEFAULT_ALWAYS_INCLUDE_TOOLS,
  DEFAULT_ENABLE_SMART_TOOL_FILTERING,
  DEFAULT_MAX_TOOLS,
  DEFAULT_MCP_MAX_TOOLS,
  discoverMcpTools,
  matchesAlwaysInclude,
  filterTools,
  selectMcpToolsToInclude,
} from './domain/tool-filter.js';

describe('T21 default tool-filter config', () => {
  it('enables smart filtering ON by default (off is opt-out)', () => {
    // T27 perf: flipped from `false` → `true` after the user's
    // log analysis showed the wire payload dominated first-turn
    // latency on MiniMax M3 with the typical ~83-tool install.
    strictEqual(DEFAULT_ENABLE_SMART_TOOL_FILTERING, true);
  });

  it('caps at 64 tools by default (M3 handles 64; Copilot handles ~128 via virtual grouping)', () => {
    strictEqual(DEFAULT_MAX_TOOLS, 64);
  });

  it('pins real Copilot tool names with the copilot_ prefix', () => {
    // Every default entry maps to at least one actual built-in /
    // MCP-friendly tool; the prefix `copilot_` captures all
    // upstream tools the agent ever calls (renames don't rot
    // the pin).
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('copilot_'));
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('run_in_terminal'));
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('apply_patch'));
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('grep_search'));
    // Belt-and-braces: the spec specifically calls out the OLD
    // broken defaults were Claude Code-shaped names that
    // matched zero VS Code tools.
    ok(!DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('read_file'));
  });

  it('covers the vscode_ namespace and bare agent-loop tool names', () => {
    // VS Code 1.97+ exposes built-ins that are NOT in the
    // `copilot_` namespace. The default pin list must cover
    // both:
    //   - the `vscode_*` language / refactor / search namespace
    //     (vscode_askQuestions, vscode_listCodeUsages,
    //      vscode_renameSymbol, vscode_searchExtensions_internal)
    //   - the bare-name agent-loop tools (view_image,
    //     minimax_subagent (T35), manage_todo_list)
    // The `copilot_` prefix alone does not reach any of these;
    // dropping them silently breaks agent-mode on a populated
    // toolset (see CHANGELOG 0.7.6 — Fixed).
    //
    // T35: `runSubagent` was removed from the pin list and
    // `minimax_subagent` was added in its place. Our custom tool
    // synthesizes the multi-part sub-agent result into one `<task>`
    // text block so the chat widget renders a single box. See
    // `tasks/T35-subagent-single-part-rendering.md` for the
    // honest limitation around user-@-invoked sub-agents.
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('vscode_'));
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('view_image'));
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('minimax_subagent'));
    ok(
      !DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('runSubagent'),
      'runSubagent removed in favor of minimax_subagent',
    );
    ok(DEFAULT_ALWAYS_INCLUDE_TOOLS.includes('manage_todo_list'));
  });
});

describe('T21 matchesAlwaysInclude — prefix / substring / exact', () => {
  it('exact match: tool name equals the pin', () => {
    ok(matchesAlwaysInclude('run_in_terminal', ['run_in_terminal']));
    ok(!matchesAlwaysInclude('terminal_runner', ['run_in_terminal']));
  });

  it('prefix match: pin ending in `_` matches anything starting with that prefix', () => {
    ok(matchesAlwaysInclude('copilot_readFile', ['copilot_']));
    ok(matchesAlwaysInclude('copilot_createFile', ['copilot_']));
    ok(matchesAlwaysInclude('copilot_runInTerminal', ['copilot_']));
    // Negative: not prefixed.
    ok(!matchesAlwaysInclude('read_file', ['copilot_']));
    ok(!matchesAlwaysInclude('my_copilot_helper', ['copilot_']));
  });

  it('substring match: pin is a fragment of the tool name', () => {
    // Catches `grep_search`, `grep_file_contents`, etc.
    ok(matchesAlwaysInclude('grep_search', ['grep']));
    ok(matchesAlwaysInclude('grep_file_contents', ['grep']));
    ok(matchesAlwaysInclude('fancy_grepper_tool', ['grep']));
  });

  it('skips empty entries (defensive)', () => {
    ok(!matchesAlwaysInclude('any_tool', ['']));
    ok(matchesAlwaysInclude('any_tool', ['', 'any_tool']));
  });
});

describe('T21 filterTools — pure decision', () => {
  it('returns all tools when filtering is OFF', () => {
    const all = [
      { name: 'copilot_readFile' },
      { name: 'copilot_runInTerminal' },
      { name: 'fancy_helper' },
    ];
    const result = filterTools(all, [], {
      enableSmartToolFiltering: false,
      maxTools: 2,
      alwaysIncludeTools: DEFAULT_ALWAYS_INCLUDE_TOOLS,
    });
    deepStrictEqual(
      [...result.kept].sort(),
      ['copilot_readFile', 'copilot_runInTerminal', 'fancy_helper'].sort(),
    );
    deepStrictEqual([...result.dropped], []);
  });

  it('does NOT drop history-referenced tools even when the cap is hit', () => {
    // T21 invariant: a tool that the model already used in this
    // request's tool_use / tool_result history MUST survive the
    // cap. Build 80 generic tools but pin one (`already_used_*`)
    // via the history array; verify it survives even when we are
    // well past maxTools.
    const all = Array.from({ length: 80 }, (_, i) => ({ name: `mcp_server_tool_${i}` }));
    const history = ['already_used_extreme'];
    all.push({ name: 'already_used_extreme' });
    const result = filterTools(all, history, {
      enableSmartToolFiltering: true,
      maxTools: 8,
      alwaysIncludeTools: [],
    });
    ok(
      result.kept.includes('already_used_extreme'),
      'history-referenced tool must survive the cap',
    );
    ok(
      result.dropped.includes('already_used_extreme') === false,
      'history-referenced tool must never be in the dropped list',
    );
  });

  it('prefix-match pin captures every copilot_* tool regardless of exact name', () => {
    // The exact name might change between VS Code versions. The
    // `copilot_` prefix pin survives renaming (one source of
    // rot in the original defaults).
    const all = [
      { name: 'copilot_readFile' },
      { name: 'copilot_createFile' },
      { name: 'copilot_runInTerminal' },
      { name: 'extension_other' },
    ];
    const result = filterTools(all, [], {
      enableSmartToolFiltering: true,
      maxTools: 100, // above the count → no dropping expected
      alwaysIncludeTools: DEFAULT_ALWAYS_INCLUDE_TOOLS,
    });
    deepStrictEqual(
      [...result.kept].sort(),
      ['copilot_readFile', 'copilot_createFile', 'copilot_runInTerminal', 'extension_other'].sort(),
    );
  });

  it('drops the right tools when over the cap, in VS Code order', () => {
    const all = Array.from({ length: 10 }, (_, i) => ({
      name: `tool_${String(i).padStart(2, '0')}`,
    }));
    const result = filterTools(all, [], {
      enableSmartToolFiltering: true,
      maxTools: 4,
      alwaysIncludeTools: [],
    });
    deepStrictEqual([...result.kept], ['tool_00', 'tool_01', 'tool_02', 'tool_03']);
    deepStrictEqual(
      [...result.dropped].sort(),
      ['tool_04', 'tool_05', 'tool_06', 'tool_07', 'tool_08', 'tool_09'].sort(),
    );
  });

  it('history-pinned + always-pinned both count against the budget; remaining fill from the cap', () => {
    const all = [
      { name: 'copilot_readFile' }, // prefix-pinned
      { name: 'copilot_createFile' }, // prefix-pinned
      { name: 'history_pinned' }, // history-pinned
      { name: 'tool_03' },
      { name: 'tool_04' },
      { name: 'tool_05' },
      { name: 'tool_06' },
      { name: 'tool_07' },
    ];
    const result = filterTools(all, ['history_pinned'], {
      enableSmartToolFiltering: true,
      maxTools: 5, // 3 pinned + 2 budget → tool_03, tool_04
      alwaysIncludeTools: ['copilot_'],
    });
    ok(result.kept.includes('copilot_readFile'));
    ok(result.kept.includes('copilot_createFile'));
    ok(result.kept.includes('history_pinned'));
    ok(result.kept.includes('tool_03'));
    ok(result.kept.includes('tool_04'));
    ok(!result.kept.includes('tool_05'));
    ok(result.dropped.includes('tool_05'));
  });

  it('passes through unchanged when tool count is at or below the cap', () => {
    const all = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const result = filterTools(all, [], {
      enableSmartToolFiltering: true,
      maxTools: 3,
      alwaysIncludeTools: ['copilot_'],
    });
    deepStrictEqual([...result.kept].sort(), ['a', 'b', 'c']);
    deepStrictEqual([...result.dropped], []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T34 — Dynamic MCP discovery
//
// VS Code's MCP integration names every MCP tool `mcp_<server>_<tool>`.
// Users can install any number of MCP servers at any time, so the
// always-include set cannot be a hard-coded list. The chat-provider
// calls `discoverMcpTools(allTools)` per request to derive the MCP
// always-include set from whatever is currently loaded, then
// `filterTools` runs with that set merged in.
//
// The contract is: a tool whose name starts with `mcp_` is considered
// to be an MCP tool, regardless of the server name that follows.
// Anything that doesn't match the prefix is ignored. The returned
// list contains the full tool names, not prefix pins, so the cap
// can drop a specific MCP tool if and only if the user explicitly
// removes that tool from the always-include set later — which
// they can't via settings today, by design: the user shouldn't
// have to.
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverMcpTools', () => {
  it('returns every tool whose name starts with mcp_', () => {
    const all = [
      { name: 'copilot_readFile' },
      { name: 'mcp_clickup_list_tasks' },
      { name: 'mcp_clickup_create_task' },
      { name: 'mcp_github_mcp_se_get_file' },
      { name: 'run_in_terminal' },
    ];
    deepStrictEqual(
      [...discoverMcpTools(all)].sort(),
      ['mcp_clickup_create_task', 'mcp_clickup_list_tasks', 'mcp_github_mcp_se_get_file'].sort(),
    );
  });

  it('returns an empty list when no MCP tools are loaded', () => {
    const all = [
      { name: 'copilot_readFile' },
      { name: 'run_in_terminal' },
      { name: 'grep_search' },
    ];
    deepStrictEqual([...discoverMcpTools(all)], []);
  });

  it('does not match the substring mcp_ inside a non-MCP name', () => {
    // A tool named `not_mcp_thing` is NOT an MCP tool — VS Code's
    // MCP convention is the leading prefix, not a substring.
    const all = [{ name: 'not_mcp_thing' }, { name: 'mcp_real_tool' }];
    deepStrictEqual([...discoverMcpTools(all)], ['mcp_real_tool']);
  });

  it('picks up MCP tools added to the live tool set on any request', () => {
    // Regression: a user installs the ClickUp MCP server, then
    // starts a chat. Their first message must include
    // mcp_clickup_list_tasks and mcp_clickup_create_task in the
    // forwarded wire payload — no config change, no restart.
    // The chat-provider derives the always-include set per
    // request, so the very next turn picks them up.
    const all = [
      { name: 'copilot_readFile' },
      { name: 'mcp_clickup_list_tasks' },
      { name: 'mcp_clickup_create_task' },
    ];
    // 0-entry always-include set; MCP discovery happens upstream
    // (in the chat-provider) and is what would be passed in.
    const discovered = discoverMcpTools(all);
    const result = filterTools(all, [], {
      enableSmartToolFiltering: true,
      maxTools: 2, // cap below the total — would drop the MCP tools
      alwaysIncludeTools: [...DEFAULT_ALWAYS_INCLUDE_TOOLS, ...discovered],
    });
    deepStrictEqual(
      [...result.kept].sort(),
      ['copilot_readFile', 'mcp_clickup_create_task', 'mcp_clickup_list_tasks'].sort(),
    );
    deepStrictEqual([...result.dropped], []);
  });

  it('a tool that lacks the mcp_ prefix is NOT picked up by the dynamic discovery', () => {
    // Defensive: if VS Code ever changes the MCP naming
    // convention, the discoverer should report zero matches
    // rather than guessing. The exact-name fallback in the
    // always-include set still keeps history-referenced tools,
    // so existing functionality isn't broken.
    const all = [
      { name: 'clickup_list_tasks' }, // no mcp_ prefix
      { name: 'copilot_readFile' },
    ];
    deepStrictEqual([...discoverMcpTools(all)], []);
  });
});

function ok(value: unknown, message?: string): void {
  if (!value) {
    throw new Error(message ?? 'expected truthy');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T34 — Rolling LRU for MCP tools
//
// The MCP subset of the wire payload is bounded by
// `mcpMaxTools` (default 60) and is filled in this priority order:
//   1. The user's `reservedMcpTools` setting — explicit always-on
//      entries (counted against the cap).
//   2. Tools the model has called in a prior turn
//      (`historyToolNames`) — also counted against the cap.
//   3. The most-recently-used tools from the recency tracker
//      (sorted by `lastUsedAt` descending), filling the
//      remaining budget.
//
// The user can configure reserved entries in settings. The
// chat-provider warns when the reserved list alone would
// exceed the cap. The platform's built-in tools
// (`copilot_*`, `run_in_terminal`, `apply_patch`, `grep_search`,
// `file_search`, `semantic_search`) are NOT in the MCP set —
// they live in `DEFAULT_ALWAYS_INCLUDE_TOOLS` and are not
// configurable from the MCP reserved list.
// ─────────────────────────────────────────────────────────────────────────────

describe('selectMcpToolsToInclude', () => {
  it('returns the empty set when the cap is zero', () => {
    const live = ['mcp_a_x', 'mcp_b_x'];
    const out = selectMcpToolsToInclude(live, [], new Map(), 0, []);
    deepStrictEqual([...out.included], []);
    deepStrictEqual([...out.dropped].sort(), ['mcp_a_x', 'mcp_b_x']);
  });

  it('returns everything when the live set fits under the cap', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const out = selectMcpToolsToInclude(live, [], new Map(), 5, []);
    deepStrictEqual([...out.included].sort(), ['mcp_a_x', 'mcp_b_x', 'mcp_c_x']);
    deepStrictEqual([...out.dropped], []);
  });

  it('always includes history-referenced tools (LRU pinning)', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x', 'mcp_d_x'];
    const history = ['mcp_c_x']; // the model called this in a prior turn
    const out = selectMcpToolsToInclude(live, history, new Map(), 2, []);
    ok(out.included.includes('mcp_c_x'), 'history-referenced tool must survive the cap');
    deepStrictEqual(out.historyPinned, ['mcp_c_x']);
  });

  it('sorts the LRU pool by recency descending', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [
        ['mcp_a_x', { firstUsedAt: 100, lastUsedAt: 100, callCount: 1 }],
        ['mcp_b_x', { firstUsedAt: 200, lastUsedAt: 200, callCount: 1 }],
        ['mcp_c_x', { firstUsedAt: 300, lastUsedAt: 300, callCount: 1 }],
      ],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 1, []);
    deepStrictEqual([...out.included], ['mcp_c_x']);
    deepStrictEqual([...out.dropped].sort(), ['mcp_a_x', 'mcp_b_x']);
  });

  it('treats never-called tools as having zero recency (they sort last)', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x', 'mcp_d_x'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [['mcp_b_x', { firstUsedAt: 100, lastUsedAt: 100, callCount: 1 }]],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 1, []);
    deepStrictEqual([...out.included], ['mcp_b_x']);
  });

  it('reports evicted tools separately from dropped', () => {
    // mcp_c_x was used in a prior turn (callCount=1) but
    // lost its slot to a more-recently-used tool. The
    // chat-provider logs it as `evicted` so the operator can
    // see the long-tail churn on a long-running session.
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [
        ['mcp_a_x', { firstUsedAt: 100, lastUsedAt: 100, callCount: 1 }],
        ['mcp_b_x', { firstUsedAt: 200, lastUsedAt: 200, callCount: 1 }],
        ['mcp_c_x', { firstUsedAt: 50, lastUsedAt: 50, callCount: 1 }],
      ],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 2, []);
    deepStrictEqual([...out.included].sort(), ['mcp_a_x', 'mcp_b_x']);
    deepStrictEqual([...out.dropped], ['mcp_c_x']);
    deepStrictEqual([...out.evicted], ['mcp_c_x']);
  });

  it('a tool the model has never called is dropped, not evicted', () => {
    // Inverse of the above: never-called tools go to `dropped`
    // only — `evicted` is reserved for tools the model USED
    // and then lost (which means the LRU churned a slot the
    // model had previously established).
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [['mcp_a_x', { firstUsedAt: 100, lastUsedAt: 100, callCount: 1 }]],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 1, []);
    deepStrictEqual([...out.included], ['mcp_a_x']);
    deepStrictEqual([...out.dropped].sort(), ['mcp_b_x', 'mcp_c_x']);
    deepStrictEqual([...out.evicted], []);
  });

  it("honors the user's reservedMcpTools list ahead of the LRU", () => {
    // Cap is 5. User reserves 2 entries. Live has 8 MCP tools.
    // Result: 2 reserved + 3 LRU = 5 included; 3 dropped.
    const live = [
      'mcp_github_mcp_se_list_issues',
      'mcp_github_mcp_se_create_issue',
      'mcp_clickup_list_tasks',
      'mcp_clickup_create_task',
      'mcp_a_x',
      'mcp_b_x',
      'mcp_c_x',
      'mcp_d_x',
    ];
    const reserved = ['mcp_github_mcp_se_list_issues', 'mcp_github_mcp_se_create_issue'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [
        ['mcp_a_x', { firstUsedAt: 300, lastUsedAt: 300, callCount: 5 }],
        ['mcp_b_x', { firstUsedAt: 200, lastUsedAt: 200, callCount: 3 }],
        ['mcp_c_x', { firstUsedAt: 100, lastUsedAt: 100, callCount: 1 }],
      ],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 5, reserved);
    ok(
      out.included.includes('mcp_github_mcp_se_list_issues'),
      'reserved entry must be included regardless of recency',
    );
    ok(
      out.included.includes('mcp_github_mcp_se_create_issue'),
      'reserved entry must be included regardless of recency',
    );
    deepStrictEqual([...out.reserved].sort(), [...reserved].sort());
    deepStrictEqual(
      [...out.included].length,
      5,
      'total included must equal the cap (reserved + LRU)',
    );
  });

  it('reserved entries reduce the LRU budget', () => {
    // Cap is 4. User reserves 3 entries. LRU gets 1 slot.
    const live = [
      'mcp_github_mcp_se_a',
      'mcp_github_mcp_se_b',
      'mcp_github_mcp_se_c',
      'mcp_a_x',
      'mcp_b_x',
      'mcp_c_x',
    ];
    const reserved = ['mcp_github_mcp_se_a', 'mcp_github_mcp_se_b', 'mcp_github_mcp_se_c'];
    const recency = new Map<string, { firstUsedAt: number; lastUsedAt: number; callCount: number }>(
      [
        ['mcp_a_x', { firstUsedAt: 300, lastUsedAt: 300, callCount: 1 }],
        ['mcp_b_x', { firstUsedAt: 200, lastUsedAt: 200, callCount: 1 }],
      ],
    );
    const out = selectMcpToolsToInclude(live, [], recency, 4, reserved);
    // 3 reserved + 1 LRU = 4
    deepStrictEqual([...out.included].length, 4);
    ok(out.included.includes('mcp_a_x'), 'most-recent LRU entry must take the remaining slot');
  });

  it('signals reservedOverflow when the reserved list alone exceeds the cap', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const reserved = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x', 'mcp_d_x', 'mcp_e_x'];
    const out = selectMcpToolsToInclude(live, [], new Map(), 3, reserved);
    ok(out.reservedOverflow, 'reservedOverflow must be true when reserved > cap');
    // All 3 live tools still in (the cap allows them), the
    // other 2 reserved entries are silently absent from
    // `reserved` because they're not in the live set.
    deepStrictEqual([...out.included].sort(), ['mcp_a_x', 'mcp_b_x', 'mcp_c_x']);
  });

  it('drops reserved entries that are not in the live tool set', () => {
    // The user reserved mcp_x_y but uninstalled that server.
    // The selection should silently skip it without crashing.
    const live = ['mcp_a_x'];
    const out = selectMcpToolsToInclude(live, [], new Map(), 5, ['mcp_x_y', 'mcp_a_x']);
    deepStrictEqual([...out.included], ['mcp_a_x']);
    deepStrictEqual([...out.reserved], ['mcp_a_x']);
  });

  it('dedupes reserved entries that appear in history', () => {
    // If a tool is in both reserved and history, it should
    // appear once in `included` and once in each of
    // `reserved` and `historyPinned`. The LRU pool excludes
    // it so the cap isn't double-counted.
    const live = ['mcp_a_x', 'mcp_b_x'];
    const reserved = ['mcp_a_x'];
    const history = ['mcp_a_x'];
    const out = selectMcpToolsToInclude(live, history, new Map(), 5, reserved);
    // Both lists agree mcp_a_x is in; the LRU pool still has
    // mcp_b_x, which fits under the cap of 5. So included is
    // [mcp_a_x, mcp_b_x] (in that order: alwaysOn first).
    deepStrictEqual([...out.included], ['mcp_a_x', 'mcp_b_x']);
    deepStrictEqual([...out.reserved], ['mcp_a_x']);
    deepStrictEqual([...out.historyPinned], ['mcp_a_x']);
  });

  it('cap=1 + 1 reserved tool means LRU gets zero slots', () => {
    const live = ['mcp_a_x', 'mcp_b_x', 'mcp_c_x'];
    const reserved = ['mcp_a_x'];
    const out = selectMcpToolsToInclude(live, [], new Map(), 1, reserved);
    deepStrictEqual([...out.included], ['mcp_a_x']);
    deepStrictEqual([...out.dropped].sort(), ['mcp_b_x', 'mcp_c_x']);
  });

  it('exposes DEFAULT_MCP_MAX_TOOLS = 60', () => {
    // The shipped default; users can override via
    // `mightyMax.mcpMaxTools`.
    strictEqual(DEFAULT_MCP_MAX_TOOLS, 60);
  });
});

describe('GitHub MCP prefix catch-all', () => {
  // The shipped default `mcp_github_` is a broad prefix that
  // pins every tool any GitHub MCP server exposes. The official
  // `github-mcp-server` package, community variants, and forks
  // all land in the `mcp_github_<...>` namespace, so a single
  // entry covers them all without the user having to know the
  // exact name of the server they installed.
  it('matches the official `mcp_github_mcp_se_*` server', () => {
    ok(
      matchesAlwaysInclude('mcp_github_mcp_se_list_issues', ['mcp_github_']),
      'official server tools land under the broad prefix',
    );
    ok(matchesAlwaysInclude('mcp_github_mcp_se_create_issue', ['mcp_github_']));
  });

  it('matches community GitHub MCP variants', () => {
    // A user who installed a different GitHub MCP server
    // (community fork, vendored copy, etc.) gets the same
    // coverage from the default.
    ok(matchesAlwaysInclude('mcp_github_search_repos', ['mcp_github_']));
    ok(matchesAlwaysInclude('mcp_github_create_pr', ['mcp_github_']));
    ok(matchesAlwaysInclude('mcp_github_list_issues', ['mcp_github_']));
  });

  it('does NOT match unrelated MCP namespaces', () => {
    // The `mcp_github_` prefix must not bleed into other servers
    // whose names happen to contain "github".
    ok(!matchesAlwaysInclude('mcp_mygithub_server_tool', ['mcp_github_']));
    ok(!matchesAlwaysInclude('mcp_githubcli_tool', ['mcp_github_']));
    ok(!matchesAlwaysInclude('mcp_clickup_list_tasks', ['mcp_github_']));
  });
});
