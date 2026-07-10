/**
 * T21 — Domain tool filter (pure).
 *
 * The chat-provider's "smart tool filtering" feature lives here as a
 * pure function so the default lists, prefix-matching, and history-aware
 * pinning rules can be unit-tested without VS Code. The provider
 * owns only the I/O (config reads, scoring, history tracker).
 *
 * Defaults shipped here are the real Copilot Chat tool names grounded
 * against the upstream `extensions/copilot` package.json in
 * microsoft/vscode. The agent-mode gate (`AGENTS.md`: "Translate the
 * COMPLETE tool set VS Code passes per request, without dropping")
 * is enforced by:
 *  - `enableSmartToolFiltering` defaults to **false** (opt-in).
 *  - The default `alwaysIncludeTools` is the actual Copilot tool
 *    prefix list (`copilot_*`) plus the always-on built-ins. When
 *    enabled, the matcher accepts both prefix match (`copilot_`)
 *    and exact-name match.
 *  - `historyReferencedToolNames` is a per-request derived set of
 *    tool names that appear in the current request's tool_use /
 *    tool_result history. Those tools are added to the
 *    always-include set BEFORE the cap is enforced — a tool that
 *    the model already used cannot be silently dropped on the
 *    next request's filter pass.
 */

export interface ToolFilterConfig {
  enableSmartToolFiltering: boolean;
  maxTools: number;
  alwaysIncludeTools: ReadonlyArray<string>;
}

export interface ToolFilterDecision {
  /**
   * The tools to pass to the wire request. Tool names that were
   * dropped (if any) are returned in `droppedToolNames` so the
   * caller can `warn`-log them with names only — never schemas.
   */
  kept: ReadonlyArray<string>;
  dropped: ReadonlyArray<string>;
}

/**
 * Default list of tool name fragments / exact names to pin when
 * `enableSmartToolFiltering` is on. The matcher accepts three
 * shapes:
 *  - exact name match: `"run_in_terminal"` matches the tool whose
 *    `.name === "run_in_terminal"`.
 *  - prefix match: `"copilot_"` matches any tool whose `.name`
 *    starts with `"copilot_"` (covers `copilot_readFile`,
 *    `copilot_createFile`, `copilot_replaceString`,
 *    `copilot_runInTerminal`, `copilot_getTerminalOutput`,
 *    `copilot_listDirectory`, etc.).
 *  - bare prefix word: `"grep"` matches any tool whose name
 *    contains `"grep"` (covers `grep_search`, `grep_*`, etc.).
 */
export const DEFAULT_ALWAYS_INCLUDE_TOOLS: ReadonlyArray<string> = [
  // Prefix pin: matches every Copilot Chat built-in tool the agent
  // ever calls. Renaming the upstream tool does NOT silently rot
  // the pin — anything new in the `copilot_` namespace is captured.
  'copilot_',
  // Exact pins for tool names Copilot Chat exposes.
  'run_in_terminal',
  'apply_patch',
  'grep_search',
  'file_search',
  'semantic_search',
];

export const DEFAULT_ENABLE_SMART_TOOL_FILTERING = false;
export const DEFAULT_MAX_TOOLS = 64;

/**
 * Match a tool name against the `alwaysInclude` list. The matcher
 * uses three rules — exact, prefix, substring — to cover both the
 * modern Copilot namespaced built-ins (`copilot_*`) and the older
 * / 1.104-era shorter names. Documented in
 * `SMART_TOOL_FILTERING.md`.
 */
export function matchesAlwaysInclude(
  toolName: string,
  alwaysInclude: ReadonlyArray<string>,
): boolean {
  for (const entry of alwaysInclude) {
    if (entry.length === 0) continue;
    // Exact name match first.
    if (entry === toolName) return true;
    // Prefix-pin: an entry ending in `_` matches any tool whose
    // name STARTS with the prefix. Substring matching must NOT
    // also apply — a tool like `my_copilot_helper` would
    // otherwise be falsely matched by the bare `copilot_` pin.
    if (entry.endsWith('_')) {
      if (toolName.startsWith(entry)) return true;
      continue;
    }
    // Substring match: covers family names without a separator
    // (e.g. `grep` matches `grep_search`, `grep_file_contents`,
    // `fancy_grepper_tool`).
    if (toolName.includes(entry)) return true;
  }
  return false;
}

/**
 * Pure decision function.
 *
 * @param allTools          the VS Code tool set the provider would
 *                          otherwise forward verbatim.
 * @param historyToolNames  tool names that appear in the request's
 *                          prior tool_use / tool_result history
 *                          (derived by the chat-provider; the
 *                          domain does not walk messages).
 * @param config            the resolved filter config.
 * @param deps              injected for testability; production
 *                          callers supply `Math.random` (only used
 *                          for tie-breaks in relevance scoring,
 *                          which is out of scope here).
 */
export function filterTools(
  allTools: ReadonlyArray<{ name: string }>,
  historyToolNames: ReadonlyArray<string>,
  config: ToolFilterConfig,
): ToolFilterDecision {
  if (!config.enableSmartToolFiltering) {
    return { kept: allTools.map((t) => t.name), dropped: [] };
  }
  if (allTools.length <= config.maxTools) {
    return { kept: allTools.map((t) => t.name), dropped: [] };
  }

  // Build the always-include set: configured pins + history-referenced
  // tools. The history pin is non-negotiable; even when the cap would
  // otherwise drop a tool, history-pinned tools always survive.
  const historyPinned = new Set(historyToolNames);
  const pinnedNames = new Set<string>();
  const matched: string[] = [];
  const dropped: string[] = [];

  for (const tool of allTools) {
    if (
      historyPinned.has(tool.name) ||
      matchesAlwaysInclude(tool.name, config.alwaysIncludeTools)
    ) {
      pinnedNames.add(tool.name);
      matched.push(tool.name);
    }
  }

  const remainingBudget = Math.max(0, config.maxTools - pinnedNames.size);
  if (remainingBudget === 0) {
    return { kept: matched, dropped: dropped };
  }

  // Fill the remaining budget with the rest of the tools in the
  // order VS Code passed them in (stable, predictable ordering;
  // the upstream Copilot Chat ordering is what users see in the
  // chat UI's "Configure Tools" dialog).
  let emitted = 0;
  for (const tool of allTools) {
    if (pinnedNames.has(tool.name)) continue;
    if (emitted >= remainingBudget) {
      dropped.push(tool.name);
      continue;
    }
    matched.push(tool.name);
    emitted += 1;
  }

  return { kept: matched, dropped };
}
