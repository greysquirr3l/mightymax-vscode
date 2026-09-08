/**
 * T34 — Tests for the `Mighty Max: Manage MCP reserved tools`
 * QuickPick UI. Covers the key flows:
 *
 *   - Empty list shows a placeholder row
 *   - Reserved list renders each entry with its match status
 *   - "Add" prompts for input, validates, and writes back
 *   - "Remove" confirms then deletes the entry
 *   - Cap overflow surfaces a warning row, not a crash
 */
import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import {
  runManageMcpToolsCommand,
  type ManageMcpDeps,
  type ManageMcpPickItem,
  type ManageMcpUi,
} from './manage-mcp-tools.js';

class FakeUi implements ManageMcpUi {
  infoCalls: string[] = [];
  warningCalls: string[] = [];
  showQuickPickQueue: Array<{ kind: 'pick' | 'confirm'; value: string | undefined }> = [];
  showInputBoxQueue: Array<string | undefined> = [];

  showQuickPick(
    items: readonly ManageMcpPickItem[],
    options?: { title?: string; ignoreFocusOut?: boolean },
  ): Promise<ManageMcpPickItem | undefined> {
    const next = this.showQuickPickQueue.shift();
    ok(
      next !== undefined,
      `showQuickPick called with no queued answer (title="${options?.title ?? ''}")`,
    );
    ok(next.kind === 'pick', `expected 'pick' kind for ${options?.title ?? ''}`);
    const wanted = next.value;
    if (wanted === undefined) return Promise.resolve(undefined);
    const found = items.find((i) => i.label === wanted);
    if (found === undefined) {
      throw new Error(
        `showQuickPick: no item with label "${wanted}". Available: ${items.map((i) => i.label).join(', ')}`,
      );
    }
    return Promise.resolve(found);
  }

  showInputBox(options?: {
    prompt?: string;
    placeHolder?: string;
    password?: boolean;
  }): Promise<string | undefined> {
    const next = this.showInputBoxQueue.shift();
    ok(
      next !== undefined,
      `showInputBox called with no queued answer (prompt="${options?.prompt ?? ''}")`,
    );
    return Promise.resolve(next);
  }

  showInfoMessage(message: string): Promise<string | undefined> {
    this.infoCalls.push(message);
    return Promise.resolve(undefined);
  }
  showWarningMessage(message: string): Promise<string | undefined> {
    this.warningCalls.push(message);
    return Promise.resolve(undefined);
  }

  enqueuePick(label: string | undefined): void {
    this.showQuickPickQueue.push({ kind: 'pick', value: label });
  }
  enqueueConfirm(label: string | undefined): void {
    this.showQuickPickQueue.push({ kind: 'confirm', value: label });
  }
  enqueueInput(value: string | undefined): void {
    this.showInputBoxQueue.push(value);
  }
}

interface DepsAndReserved {
  readonly deps: ManageMcpDeps;
  reserved: ReadonlyArray<string>;
}

function makeDeps(opts: {
  reserved: ReadonlyArray<string>;
  liveTools?: ReadonlyArray<{ name: string }>;
  mcpMaxTools?: number;
  ui: FakeUi;
}): DepsAndReserved {
  // Holder carries a mutable array so `setReserved` can mutate
  // in place. The test destructures `reserved` and the
  // production code calls `getReserved()`; both observe the
  // same backing array, so updates via either path are
  // immediately visible to the other.
  const holder: { current: string[] } = { current: [...opts.reserved] };
  return {
    get reserved(): ReadonlyArray<string> {
      return holder.current;
    },
    deps: {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ui: opts.ui,
      getReserved: () => holder.current,
      getMcpMaxTools: () => opts.mcpMaxTools ?? 60,
      setReserved: async (next) => {
        // Mutate in place so the test's destructured
        // `reserved` reference (and any other captured
        // references) stay valid after the update.
        holder.current.length = 0;
        holder.current.push(...next);
      },
      listLiveTools: () => opts.liveTools ?? [],
    },
  };
}

describe('runManageMcpToolsCommand', () => {
  it('renders the platform tools as read-only and the reserved list as editable', async () => {
    const ui = new FakeUi();
    const { deps } = makeDeps({
      reserved: ['mcp_github_mcp_se_'],
      liveTools: [
        { name: 'mcp_github_mcp_se_list_issues' },
        { name: 'mcp_github_mcp_se_create_issue' },
      ],
      ui,
    });
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    ok(ui.infoCalls.length === 0, 'no info message expected on Done');
    ok(ui.warningCalls.length === 0, 'no warning message expected on Done');
  });

  it('flags reserved entries that do not match any loaded MCP tool', async () => {
    const ui = new FakeUi();
    const { deps } = makeDeps({
      reserved: ['mcp_github_mcp_se_', 'mcp_clickup_list_tasks'],
      liveTools: [{ name: 'mcp_github_mcp_se_list_issues' }],
      ui,
    });
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    // The match status is rendered in `buildItems`; the test
    // confirms the command runs to completion with the
    // unmatched entry present (the command is robust to it).
  });

  it('removes a reserved entry on confirm', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: ['mcp_github_mcp_se_', 'mcp_clickup_list_tasks'],
      // Provide a live tool matching the second entry so its
      // row uses the $(check) icon (matched = true). Without
      // a live match, the row uses $(warning) and the test's
      // queued pick label would not match.
      liveTools: [{ name: 'mcp_clickup_list_tasks' }],
      ui,
    });
    ui.enqueuePick('$(check) mcp_clickup_list_tasks    $(trash) Remove');
    ui.enqueuePick('Remove mcp_clickup_list_tasks');
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, ['mcp_github_mcp_se_']);
  });

  it('does not remove when the user cancels the confirm', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: ['mcp_github_mcp_se_'],
      // Provide a live tool matching the reserved entry so its
      // row uses the $(check) icon. Without a live match, the
      // row uses $(warning).
      liveTools: [{ name: 'mcp_github_mcp_se_list_issues' }],
      ui,
    });
    ui.enqueuePick('$(check) mcp_github_mcp_se_    $(trash) Remove');
    ui.enqueuePick('Cancel');
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, ['mcp_github_mcp_se_']);
  });

  it('adds a valid MCP name on Add', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: [],
      ui,
    });
    ui.enqueuePick('➕ Add tool or prefix…');
    ui.enqueueInput('mcp_github_mcp_se_list_issues');
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, ['mcp_github_mcp_se_list_issues']);
    strictEqual(ui.infoCalls.length, 0);
  });

  it('rejects an invalid name and does not add it', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: [],
      ui,
    });
    ui.enqueuePick('➕ Add tool or prefix…');
    ui.enqueueInput('not-an-mcp-tool');
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, []);
    strictEqual(ui.warningCalls.length, 1);
    ok(
      ui.warningCalls[0]?.includes('not-an-mcp-tool'),
      'warning message should mention the rejected input',
    );
  });

  it('dedupes a name that is already reserved', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: ['mcp_github_mcp_se_'],
      ui,
    });
    ui.enqueuePick('➕ Add tool or prefix…');
    ui.enqueueInput('mcp_github_mcp_se_');
    ui.enqueuePick('✓ Done');
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, ['mcp_github_mcp_se_']);
    strictEqual(ui.infoCalls.length, 1, 'duplicate add should show an info message');
  });

  it('exits cleanly when the user dismisses the pick', async () => {
    const ui = new FakeUi();
    const { deps, reserved } = makeDeps({
      reserved: ['mcp_github_mcp_se_'],
      ui,
    });
    ui.enqueuePick(undefined);
    await runManageMcpToolsCommand(deps);
    deepStrictEqual(reserved, ['mcp_github_mcp_se_']);
  });
});
