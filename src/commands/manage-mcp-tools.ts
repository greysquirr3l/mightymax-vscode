/**
 * T34 — `Mighty Max: Manage MCP reserved tools` (QuickPick UI).
 *
 * Lets the user curate the `mightyMax.reservedMcpTools` setting
 * without hand-editing `settings.json`. The UI shows:
 *
 *   - A read-only section listing the platform's always-included
 *     agent tools (`copilot_*`, `run_in_terminal`, `apply_patch`,
 *     `grep_search`, `file_search`, `semantic_search`). These
 *     are uneditable — they live in `DEFAULT_ALWAYS_INCLUDE_TOOLS`
 *     and are always in the wire regardless of MCP cap.
 *
 *   - The current reserved list, one row per entry. Each row
 *     shows whether the entry currently matches any loaded MCP
 *     tool (the `vscode.lm.tools` snapshot) — useful for
 *     spotting typos and uninstalled servers.
 *
 *   - A warning row if the reserved count alone exceeds
 *     `mightyMax.mcpMaxTools` (default 60). The LRU gets zero
 *     slots in that case, so the warning is worth surfacing
 *     in the UI rather than just in the chat-provider's log.
 *
 *   - An "Add tool or prefix..." row that prompts for input and
 *     validates the entry before committing it.
 *
 *   - A "Done" / back row to close the UI.
 *
 * The reserved list lives in the `mightyMax.reservedMcpTools`
 * workspace setting (already declared in `package.json`). This
 * command is the curated UI on top of that setting; the wire
 * path is in `src/providers/chat-provider.ts` (see
 * `selectMcpToolsToInclude` in `src/lib/domain/tool-filter.ts`).
 *
 * Note on `vscode` imports: the picker item type lives here as
 * a local interface (not `vscode.QuickPickItem`) and the
 * separator kind is a string literal (not the
 * `vscode.QuickPickItemKind` enum). That keeps the module free
 * of runtime `vscode` references so the unit tests can run in
 * the `node:test` profile (which has no `vscode` shim) without
 * dragging in the stub runner. The production wiring in
 * `extension.ts` adapts the items to `vscode.QuickPickItem`
 * when it dispatches the picker.
 */
import type { Logger } from '../ports/logger.js';
import { DEFAULT_ALWAYS_INCLUDE_TOOLS } from '../lib/domain/tool-filter.js';

/** Names of platform tools the user can't remove. Displayed as read-only. */
const PLATFORM_TOOL_HINTS: ReadonlyArray<string> = [...DEFAULT_ALWAYS_INCLUDE_TOOLS];

/**
 * Local string-literal marker for non-selectable header rows.
 * Mirrors `manage-command.ts` (which uses `kind: 'separator'`
 * on its `ManagePickItem`). Avoids a runtime dep on
 * `vscode.QuickPickItemKind` so the test can run in `node:test`.
 */
const HEADER_KIND = 'separator' as const;

const ADD_LABEL = '➕ Add tool or prefix…';
const DONE_LABEL = '✓ Done';

export interface ManageMcpPickItem {
  readonly label: string;
  readonly description?: string;
  readonly kind?: typeof HEADER_KIND;
}

export interface ManageMcpUi {
  showQuickPick(
    items: readonly ManageMcpPickItem[],
    options?: { title?: string; ignoreFocusOut?: boolean },
  ): Promise<ManageMcpPickItem | undefined>;
  showInputBox(options?: {
    prompt?: string;
    placeHolder?: string;
    password?: boolean;
    ignoreFocusOut?: boolean;
  }): Promise<string | undefined>;
  showInfoMessage(message: string): Promise<string | undefined>;
  showWarningMessage(message: string): Promise<string | undefined>;
}

export interface ManageMcpDeps {
  readonly logger: Logger;
  readonly ui: ManageMcpUi;
  /**
   * Returns the current reserved list. Production passes a
   * closure over the `mightyMax.reservedMcpTools` setting; the
   * `node:test` runner passes a stub. Required (no default
   * that reads `vscode`) so the module has no runtime
   * `vscode` reference.
   */
  readonly getReserved: () => ReadonlyArray<string>;
  /**
   * Writes the new reserved list back to the
   * `mightyMax.reservedMcpTools` setting. Production uses
   * `vscode.workspace.getConfiguration('mightyMax').update(...)`.
   */
  readonly setReserved: (next: ReadonlyArray<string>) => Promise<void>;
  /**
   * Returns the current `mcpMaxTools` cap. Required; production
   * reads the setting, the test supplies a literal.
   */
  readonly getMcpMaxTools: () => number;
  /**
   * Returns the live VS Code tool set. Production calls
   * `vscode.lm.tools`; tests pass a stub.
   */
  readonly listLiveTools: () => ReadonlyArray<{ readonly name: string }>;
}

function liveMcpToolNames(tools: ReadonlyArray<{ readonly name: string }>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const tool of tools) {
    if (tool.name.startsWith('mcp_')) out.add(tool.name);
  }
  return out;
}

function isValidMcpName(name: string): boolean {
  // Accept exact MCP tool names ("mcp_github_mcp_se_list_issues")
  // and prefix pins ending in "_" ("mcp_github_mcp_se_"). Reject
  // anything that doesn't start with `mcp_` — the chat-provider
  // silently drops non-MCP entries from the reserved set, so we
  // want to catch typos at the UI layer instead.
  return name.startsWith('mcp_') && name.length > 4 && !name.includes(' ');
}

interface BuildItemsArgs {
  readonly reserved: ReadonlyArray<string>;
  readonly liveMcpNames: ReadonlySet<string>;
  readonly mcpMaxTools: number;
}

function buildItems(args: BuildItemsArgs): ManageMcpPickItem[] {
  const items: ManageMcpPickItem[] = [];
  const { reserved, liveMcpNames, mcpMaxTools } = args;

  // Read-only header explaining the always-on platform tools.
  items.push({ kind: HEADER_KIND, label: 'Platform tools (always on, not editable)' });
  for (const name of PLATFORM_TOOL_HINTS) {
    items.push({
      label: `$(lock) ${name}`,
      description: 'Built-in VS Code agent tool — always in the wire',
    });
  }

  // Editable reserved list.
  items.push({ kind: HEADER_KIND, label: 'Reserved MCP tools (your list)' });
  if (reserved.length === 0) {
    items.push({
      label: '$(info) No tools reserved',
      description: 'The rolling LRU handles MCP selection on recency alone',
    });
  } else {
    for (const entry of reserved) {
      const isPrefix = entry.endsWith('_');
      const matched = isPrefix
        ? Array.from(liveMcpNames).some((n) => n.startsWith(entry))
        : liveMcpNames.has(entry);
      const icon = matched ? '$(check)' : '$(warning)';
      const status = matched
        ? isPrefix
          ? `Matches ${String(Array.from(liveMcpNames).filter((n) => n.startsWith(entry)).length)} loaded tools`
          : 'Loaded'
        : 'No loaded MCP tool matches this entry';
      items.push({
        label: `${icon} ${entry}    $(trash) Remove`,
        description: status,
      });
    }
  }

  // Cap warning.
  if (reserved.length > mcpMaxTools) {
    items.push({
      kind: HEADER_KIND,
      label: `⚠ Reserved (${String(reserved.length)}) exceeds mcpMaxTools (${String(mcpMaxTools)}) — LRU gets no slots`,
    });
  } else {
    items.push({
      kind: HEADER_KIND,
      label: `Cap: ${String(mcpMaxTools - reserved.length)} LRU slots remaining (${String(reserved.length)} reserved + ${String(mcpMaxTools)} total)`,
    });
  }

  // Actions.
  items.push({
    label: ADD_LABEL,
    description: 'Add an exact MCP tool name or a `mcp_<server>_` prefix',
  });
  items.push({ label: DONE_LABEL, description: 'Close this menu' });
  return items;
}

export async function runManageMcpToolsCommand(deps: ManageMcpDeps): Promise<void> {
  deps.logger.debug('Manage MCP tools command: showing pick');
  const liveTools = deps.listLiveTools();
  const liveMcpNames = liveMcpToolNames(liveTools);
  const mcpMaxTools = deps.getMcpMaxTools();

  // Loop: the user can add/remove and see the refreshed list
  // in place. Each pass renders the latest state.
  for (;;) {
    const reserved = deps.getReserved();
    const items = buildItems({ reserved, liveMcpNames, mcpMaxTools });
    const choice = await deps.ui.showQuickPick(items, {
      title: 'Mighty Max — MCP reserved tools',
    });
    if (choice === undefined || choice.label === DONE_LABEL) {
      deps.logger.debug('Manage MCP tools command: dismissed');
      return;
    }

    // The reserved-list rows are labeled
    //   `<icon> <entry>    $(trash) Remove`
    // We split on whitespace to recover the entry, then offer
    // a confirmation QuickPick before committing the delete.
    if (choice.label.includes('$(trash) Remove')) {
      const entry = choice.label
        .replace(/^\$\([a-z-]+\)\s+/, '')
        .replace(/\s+\$\(trash\) Remove$/, '')
        .trim();
      const ok = await deps.ui.showQuickPick([{ label: `Remove ${entry}` }, { label: 'Cancel' }], {
        title: `Remove "${entry}" from reserved list?`,
      });
      if (ok?.label === `Remove ${entry}`) {
        const next = reserved.filter((e) => e !== entry);
        await deps.setReserved(next);
        deps.logger.info('Manage MCP tools: removed entry', { entry });
      }
      continue;
    }

    if (choice.label === ADD_LABEL) {
      const input = await deps.ui.showInputBox({
        prompt:
          'Paste a tool name like `mcp_github_mcp_se_list_issues` or a prefix like `mcp_github_mcp_se_`',
        placeHolder: 'mcp_<server>_<tool>  or  mcp_<server>_',
      });
      if (input === undefined || input.trim().length === 0) continue;
      const trimmed = input.trim();
      if (!isValidMcpName(trimmed)) {
        await deps.ui.showWarningMessage(
          `"${trimmed}" is not a valid MCP tool name. It should start with "mcp_" and contain no spaces.`,
        );
        continue;
      }
      if (reserved.includes(trimmed)) {
        await deps.ui.showInfoMessage(`"${trimmed}" is already in the reserved list.`);
        continue;
      }
      const next = [...reserved, trimmed];
      await deps.setReserved(next);
      deps.logger.info('Manage MCP tools: added entry', { entry: trimmed });
      continue;
    }

    // Header / informational rows have kind=separator and the
    // QuickPick treats them as non-selectable, so this branch
    // shouldn't fire — but if a future change makes them
    // selectable, just re-render.
    continue;
  }
}
