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
  matchesAlwaysInclude,
  filterTools,
} from './domain/tool-filter.js';

describe('T21 default tool-filter config', () => {
  it('enables smart filtering OFF by default (opt-in)', () => {
    strictEqual(DEFAULT_ENABLE_SMART_TOOL_FILTERING, false);
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
      [
        'copilot_readFile',
        'copilot_createFile',
        'copilot_runInTerminal',
        'extension_other',
      ].sort(),
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
    const result = filterTools(
      all,
      ['history_pinned'],
      {
        enableSmartToolFiltering: true,
        maxTools: 5, // 3 pinned + 2 budget → tool_03, tool_04
        alwaysIncludeTools: ['copilot_'],
      },
    );
    ok(result.kept.includes('copilot_readFile'));
    ok(result.kept.includes('copilot_createFile'));
    ok(result.kept.includes('history_pinned'));
    ok(result.kept.includes('tool_03'));
    ok(result.kept.includes('tool_04'));
    ok(!result.kept.includes('tool_05'));
    ok(result.dropped.includes('tool_05'));
  });

  it('passes through unchanged when tool count is at or below the cap', () => {
    const all = [
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ];
    const result = filterTools(all, [], {
      enableSmartToolFiltering: true,
      maxTools: 3,
      alwaysIncludeTools: ['copilot_'],
    });
    deepStrictEqual([...result.kept].sort(), ['a', 'b', 'c']);
    deepStrictEqual([...result.dropped], []);
  });
});

function ok(value: unknown, message?: string): void {
  if (!value) {
    throw new Error(message ?? 'expected truthy');
  }
}
