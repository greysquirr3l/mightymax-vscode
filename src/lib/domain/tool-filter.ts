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
 *  - `enableSmartToolFiltering` defaults to **true** as of the T27
 *    perf pass — opt-OUT (not opt-in) so a fresh install immediately
 *    benefits from the latency win. The wire payload drops from ~83
 *    tool schemas to ~64 across rounds.
 *  - The MCP subset (`mcp_<server>_<tool>`) is governed by a
 *    separate rolling LRU — `selectMcpToolsToInclude` below —
 *    bounded by `mightyMax.mcpMaxTools` (default 60). Tools the
 *    model has called join the always-include set permanently
 *    for the session; new tools displace unused ones on a
 *    recency-ordered first-in basis.
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
 *
 * VS Code 1.97+ exposes two distinct built-in namespaces that
 * the model needs available on every turn: the namespaced
 * `copilot_*` tools (the legacy Copilot Chat surface) AND a
 * bare-name set the agent loop calls directly (`view_image`,
 * `runSubagent`, `manage_todo_list`) plus the `vscode_*` namespace
 * of language / refactor / search tools (`vscode_askQuestions`,
 * `vscode_listCodeUsages`, `vscode_renameSymbol`,
 * `vscode_searchExtensions_internal`). The `copilot_` prefix alone
 * does NOT capture any of the bare-name or `vscode_*` entries —
 * VS Code does not put them in the `copilot_` namespace — so
 * each set is pinned explicitly below.
 *
 * T35: `minimax_subagent` is our custom tool — it wraps VS Code's
 * built-in and synthesizes the multi-part sub-agent result into a
 * single `<task>` text block (one box in the chat widget) instead
 * of N parts. It is the *preferred* path, but it does NOT replace
 * the built-in pin: sub-agent delegation is a hard capability of
 * the agent loop, so VS Code's own sub-agent tool must never be
 * evictable by the cap.
 *
 * T37: `runSubagent` is pinned AGAIN, alongside `minimax_subagent`.
 * The T35 removal made the built-in sub-agent tool droppable — a
 * user with 80+ tools installed could lose sub-agent delegation
 * entirely on a turn where the cap bit, silently. "Preferred" is a
 * description-ordering concern; "always available" is a
 * correctness concern. Both are now reserved.
 *
 * The pin is the bare family name `runSubagent`, which the
 * substring rule resolves against every shape VS Code has used for
 * this tool across versions:
 *
 *   - `runSubagent`        (1.97–1.104 bare name)
 *   - `agent/runSubagent`  (current namespaced form)
 *   - `vscode/runSubagent` (hypothetical server-qualified form)
 *
 * `matchesAlwaysInclude` substring-matches, so one pin covers the
 * whole family — the same reason `grep_search` also covers
 * `grep_file_contents`. Do NOT pin `agent/` as a separate prefix:
 * `agent_` and `agent/` are different separators and a bare
 * `agent` substring would over-pin unrelated tools.
 */
export const DEFAULT_ALWAYS_INCLUDE_TOOLS: ReadonlyArray<string> = [
  // Prefix pin: matches every Copilot Chat built-in tool the agent
  // ever calls. Renaming the upstream tool does NOT silently rot
  // the pin — anything new in the `copilot_` namespace is captured.
  'copilot_',
  // Prefix pin: covers VS Code's `vscode_*` language / refactor /
  // search built-ins (vscode_askQuestions, vscode_listCodeUsages,
  // vscode_renameSymbol, vscode_searchExtensions_internal, ...).
  // Distinct from `copilot_*` — VS Code's chat UI does not put
  // these in the `copilot_` namespace.
  'vscode_',
  // Exact pins for tool names Copilot Chat / VS Code agent loop
  // expose directly. None of these are in a `_` namespace, so
  // the prefix rule above cannot reach them.
  'run_in_terminal',
  'apply_patch',
  'grep_search',
  'file_search',
  'semantic_search',
  'view_image',
  // T37: VS Code's built-in sub-agent tool. Substring pin, so it
  // matches every name shape the tool has shipped under
  // (`runSubagent`, `agent/runSubagent`, `vscode/runSubagent`).
  // NEVER drop this pin: with a populated toolset the cap can
  // otherwise evict sub-agent delegation for a whole turn.
  'runSubagent',
  // T35: our custom single-box wrapper. Pinned alongside the
  // built-in (not instead of it) so the model has both a
  // clean-rendering path and a guaranteed-present one.
  'minimax_subagent',
  // T36: the Hailuo-03 video generator. Pinned so the chat model
  // always has access regardless of relevance score; the actual
  // invocation is gated by `mightyMax.allowVideoToolInChat` at
  // registration time (the prepareInvocation throws when the
  // setting is `false`, so the chat host never sees the tool fire).
  'mightyMax_generateVideo',
  // T36: the image-01 generator. Same gating story as the video
  // tool — pinned here, refused at `prepareInvocation` time when
  // `mightyMax.allowImageToolInChat` is `false`.
  'mightyMax_generateImage',
  'manage_todo_list',
];

export const DEFAULT_ENABLE_SMART_TOOL_FILTERING = true;
export const DEFAULT_MAX_TOOLS = 64;

/**
 * Pins the chat-provider force-merges into the effective filter
 * config on EVERY request, regardless of what
 * `mightyMax.alwaysIncludeTools` is set to.
 *
 * A user-configured list replaces the default list wholesale — a
 * user who trimmed the setting to a handful of entries would
 * otherwise silently lose sub-agent delegation. Same precedent as
 * the MCP discovery tools (`MCP_LIST_SERVERS_TOOLS` and friends),
 * which the provider also merges outside the user's control.
 *
 * Membership here means "the agent loop is structurally incomplete
 * without this". Adding an entry is a compatibility decision, not
 * a tuning one — a tool that merely renders *nicer* does not
 * belong.
 */
export const MANDATORY_ALWAYS_INCLUDE_TOOLS: ReadonlyArray<string> = [
  // VS Code's built-in sub-agent tool (covers `agent/runSubagent`).
  'runSubagent',
  // Our single-box wrapper (T35). Pinned because it is the path
  // the model SHOULD take, and a user who trimmed their always-
  // include list should not lose it either.
  'minimax_subagent',
];

/**
 * Maximum number of MCP tools the chat-provider will keep in
 * the wire payload on any given request. Distinct from
 * `DEFAULT_MAX_TOOLS` (which is the global cap across all tool
 * families): the MCP subset gets its own rolling LRU so a
 * user with 10+ MCP servers installed doesn't push the wire
 * payload past what M3 can usefully consume. The chat-provider
 * uses `selectMcpToolsToInclude` (below) to enforce the cap.
 */
export const DEFAULT_MCP_MAX_TOOLS = 60;

/**
 * Match a live tool name against ONE always-include/reserved
 * entry. Shared by both surfaces so they can never disagree again.
 *
 * Three shapes, all handled:
 *   - **exact** — `runSubagent` matches only itself.
 *   - **prefix** — an entry ending in `_` (`mcp_github_mcp_se_`)
 *     matches any name starting with it. The `_` is the opt-in: a
 *     bare `copilot` must NOT match `my_copilot_helper`, so
 *     substring matching deliberately does not apply to prefixes.
 *   - **substring** — an entry without a trailing `_` matches any
 *     name containing it as a fragment (`grep` catches
 *     `grep_search` and `grep_file_contents`).
 *
 * This is the same function `mightyMax.reservedMcpTools` is sold
 * against in the Manage MCP Tools UI, which already implemented the
 * prefix rule. The filter used a bare `Array.includes` instead, so a
 * user could enter a prefix, watch the UI report "Matches N loaded
 * tools", and get zero reservation — silently. Issue #88.
 */
export function matchesToolName(toolName: string, entry: string): boolean {
  if (entry.length === 0) return false;
  if (entry === toolName) return true;
  if (entry.endsWith('_')) return toolName.startsWith(entry);
  return toolName.includes(entry);
}

/**
 * Match a tool name against the whole `alwaysInclude` list.
 *
 * Rules per entry are documented on {@link matchesToolName}, which
 * every entry is evaluated with.
 */
export function matchesAlwaysInclude(
  toolName: string,
  alwaysInclude: ReadonlyArray<string>,
): boolean {
  for (const entry of alwaysInclude) {
    if (matchesToolName(toolName, entry)) return true;
  }
  return false;
}

/**
 * VS Code's MCP integration names every MCP tool
 * `mcp_<server>_<tool>` where the server segment is the
 * user-installed MCP server's display name, normalised to
 * snake_case. There is no fixed list of MCP servers — a user
 * can install any number of them at any time. The chat-provider
 * derives the always-include set dynamically from whatever MCP
 * tools are currently loaded into VS Code so that adding a new
 * MCP server requires zero config changes: it just shows up in
 * the next chat turn.
 *
 * Pure function. Returns the set of tool names whose name starts
 * with `mcp_` (the MCP namespace). The caller merges these into
 * the always-include list of a `ToolFilterConfig` BEFORE calling
 * `filterTools`, so the cap cannot drop them.
 *
 * The `mcp_` prefix is the wire convention — we don't enumerate
 * server names because doing so would require a hard-coded list
 * that goes stale the moment the user adds a new server. If VS
 * Code ever changes the MCP tool-name convention, update this
 * single check.
 */
export function discoverMcpTools(allTools: ReadonlyArray<{ name: string }>): ReadonlyArray<string> {
  const out: string[] = [];
  for (const tool of allTools) {
    if (tool.name.startsWith('mcp_')) out.push(tool.name);
  }
  return out;
}

/**
 * Subset of `McpToolRecency` needed by the selection function.
 * Re-declared as a local structural type so the `tool-filter`
 * module doesn't have to depend on the recency module's class
 * definition (the `McpToolRecencyTracker` is the only producer;
 * consumers work off this shape).
 */
export interface McpRecencyEntry {
  readonly firstUsedAt: number;
  readonly lastUsedAt: number;
  readonly callCount: number;
}

export interface McpSelectionResult {
  /** The MCP tools to add to the always-include set this turn. */
  readonly included: ReadonlyArray<string>;
  /** The MCP tools that did not make the cut (the rolling tail). */
  readonly dropped: ReadonlyArray<string>;
  /** Tools pinned because the model called them in a prior turn. */
  readonly historyPinned: ReadonlyArray<string>;
  /** The LIVE tool names matched by the user's `reservedMcpTools` entries. A prefix entry can resolve to many tools. */
  readonly reserved: ReadonlyArray<string>;
  /**
   * Reserved entries that matched no live tool — a typo, or a
   * server that is not currently loaded. Reported so the
   * chat-provider can warn: the entry is doing nothing, and
   * silently is how issue #88 stayed invisible.
   */
  readonly unmatchedReserved: ReadonlyArray<string>;
  /**
   * True when the RESOLVED reserved set exceeds `mcpMaxTools` —
   * chat-provider warns the user. Measured after expansion, so a
   * single prefix reserving hundreds of tools is correctly reported
   * rather than counting as one entry.
   */
  readonly reservedOverflow: boolean;
  /** Tools that had been used in a prior turn but lost their slot to a newer tool this turn. */
  readonly evicted: ReadonlyArray<string>;
}

/**
 * Choose which MCP tools the chat-provider should pin in the
 * always-include set for the current request, bounded by
 * `mcpMaxTools`. The selection is a rolling LRU with a bias
 * toward recency:
 *
 *   1. History-pinned tools first: any MCP tool that appears in
 *      `historyToolNames` is included unconditionally. The model
 *      called it in a prior turn and the request carries its
 *      tool_result; the next turn must be able to call it again.
 *
 *   2. Then fill the remaining budget with the most-recently-used
 *      tools from `trackerSnapshot` (sorted by `lastUsedAt`
 *      descending). Tools the model has never called appear with
 *      `lastUsedAt = 0`; they sort to the bottom, which means
 *      newly-installed MCP servers' tools initially lose out to
 *      recently-used tools from older servers. The chat-provider
 *      bumps a tool's recency the first time it appears in
 *      `historyToolNames` (see `recordMany`), so the model can
 *      discover a new server by calling one of its tools — once
 *      it does, the tool joins the recency set and stays.
 *
 *   3. Anything that doesn't make the cut is reported in
 *      `dropped` so the chat-provider can surface a structured
 *      log line ("MCP tool LRU evicted mcp_x_y") on the rare
 *      turns where a long-running session reshuffles the set.
 *
 * The user's `reservedMcpTools` setting is a separate, explicit
 * always-include set: tools the user wants guaranteed to be in
 * the wire regardless of recency. Reserved entries reduce the
 * LRU budget — the total MCP tools in the wire stays bounded by
 * `mcpMaxTools`. For example, with `mcpMaxTools = 60` and 5
 * reserved entries, the LRU gets 55 slots. A warning is logged
 * when the reserved count alone would exceed the cap.
 *
 * Pure function. Takes a `Map` snapshot of the recency state
 * (the tracker is the only producer; consumers work off a frozen
 * view to avoid races with concurrent updates).
 */
export function selectMcpToolsToInclude(
  liveMcpToolNames: ReadonlyArray<string>,
  historyToolNames: ReadonlyArray<string>,
  trackerSnapshot: ReadonlyMap<string, McpRecencyEntry>,
  mcpMaxTools: number,
  reservedMcpToolNames: ReadonlyArray<string> = [],
): McpSelectionResult {
  // Cap of 0 or negative disables MCP tool pinning entirely.
  // Useful for tests and for users who want zero MCP tools in
  // the wire (set mightyMax.mcpMaxTools to 0).
  if (mcpMaxTools <= 0 || liveMcpToolNames.length === 0) {
    return {
      included: [],
      dropped: [...liveMcpToolNames],
      historyPinned: [],
      evicted: [],
      reserved: [],
      // Every entry is unmatched here by definition — no live
      // tools means nothing can match. Reported so the provider
      // warns rather than leaving the user to wonder why their
      // reserved list does nothing.
      unmatchedReserved: [...reservedMcpToolNames],
      reservedOverflow: false,
    };
  }

  // Resolve the reserved entries against the live set.
  //
  // Issue #88: this used a bare `liveMcpToolNames.includes(name)`,
  // so a prefix entry (`mcp_github_mcp_se_`) matched nothing —
  // `includes` is an exact array lookup and the prefix is not
  // itself a tool name. The Manage MCP Tools UI already
  // implemented the prefix rule and advertised "Matches N loaded
  // tools", so a user could configure a prefix, watch it report a
  // match count, and get zero reservation with no error. Both
  // surfaces now go through `matchesToolName`, which implements
  // all three shapes (exact / prefix-on-trailing-`_` / substring).
  //
  // An entry matching nothing is still a silent no-op — the
  // selection function is pure and has no logger. The
  // chat-provider logs unmatched reserved entries; see
  // `selectMcpToolsToInclude`'s doc comment.
  const reservedSet = new Set<string>();
  const reservedLive: string[] = [];
  const unmatchedReserved: string[] = [];
  for (const entry of reservedMcpToolNames) {
    let matchedAny = false;
    for (const live of liveMcpToolNames) {
      if (!matchesToolName(live, entry)) continue;
      matchedAny = true;
      // Two entries can resolve to the same tool (a prefix plus an
      // exact name); reserve it once.
      if (!reservedSet.has(live)) {
        reservedSet.add(live);
        reservedLive.push(live);
      }
    }
    if (!matchedAny) unmatchedReserved.push(entry);
  }
  // Overflow is measured on the RESOLVED count. Comparing the raw
  // entry count under-counted badly once a single prefix could
  // expand to hundreds of tools — it would report "fits" for a
  // prefix that reserves 200 tools against a cap of 60.
  const reservedOverflow = reservedLive.length > mcpMaxTools;

  // The LRU budget is what's left after reserved + history.
  // If reserved + history already exceeds the cap, history
  // wins (it has the model's in-flight tool calls) and
  // reserved is honored but the LRU gets nothing.
  const historySet = new Set(historyToolNames);

  // Reserved + history should both be honored. We dedupe
  // because a tool may appear in both lists.
  const alwaysOn = new Set<string>(reservedLive);
  for (const name of historyToolNames) {
    if (liveMcpToolNames.includes(name)) alwaysOn.add(name);
  }
  const alwaysOnLive = liveMcpToolNames.filter((n) => alwaysOn.has(n));

  // When the live set fits, return everything. No LRU bookkeeping
  // needed — the cap is not under pressure.
  if (alwaysOnLive.length >= mcpMaxTools) {
    // Reserved + history alone exceeds the cap. Honor alwaysOn
    // (it contains the user's reserved + the model's in-flight
    // tools). No room for the LRU; the rest is dropped.
    return {
      included: alwaysOnLive,
      dropped: liveMcpToolNames.filter((n) => !alwaysOn.has(n)),
      historyPinned: alwaysOnLive.filter((n) => historySet.has(n)),
      reserved: reservedLive,
      unmatchedReserved,
      evicted: [],
      reservedOverflow,
    };
  }

  // Build the LRU pool: live MCP tools minus the always-on set.
  // (The budget is implicit in the `included.length >= mcpMaxTools`
  // check below — we just take what fits in the remaining slots
  // after reserved + history.)
  const lruPool = liveMcpToolNames.filter((n) => !alwaysOn.has(n));

  // Sort the LRU pool by lastUsedAt descending. Tools that
  // have never been recorded carry an implicit recency of 0
  // and sort to the bottom. Ties broken by name for
  // determinism (so test outputs are stable).
  const lruSorted = [...lruPool].sort((a, b) => {
    const aRecency = trackerSnapshot.get(a);
    const bRecency = trackerSnapshot.get(b);
    const aLast = aRecency?.lastUsedAt ?? 0;
    const bLast = bRecency?.lastUsedAt ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    return a.localeCompare(b);
  });

  const included: string[] = [...alwaysOnLive];
  const evicted: string[] = [];
  for (const name of lruSorted) {
    if (included.length >= mcpMaxTools) {
      // Everything from here on is dropped this turn. We
      // additionally flag previously-tracked tools that lost
      // their slot as `evicted` so the log line is meaningful.
      if (trackerSnapshot.has(name)) evicted.push(name);
      continue;
    }
    included.push(name);
  }

  const dropped: string[] = lruSorted.filter((n) => !included.includes(n));
  return {
    included,
    dropped,
    historyPinned: alwaysOnLive.filter((n) => historySet.has(n)),
    reserved: reservedLive,
    unmatchedReserved,
    evicted,
    reservedOverflow,
  };
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
