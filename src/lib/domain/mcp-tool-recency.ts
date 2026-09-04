/**
 * In-memory per-tool recency tracker for MCP tool selection.
 *
 * The chat-provider needs a rolling subset of the live MCP tool set
 * to pin in the always-include list — large enough that the model
 * sees the tools it has used (and might use again), small enough
 * that the wire payload stays bounded regardless of how many MCP
 * servers the user has installed.
 *
 * The cap (`mightyMax.mcpMaxTools`, default 60) is enforced by
 * `selectMcpToolsToInclude` in `tool-filter.ts`. This module
 * owns the recency state. The two are split so the selection
 * function stays pure (it reads a snapshot of the state) and the
 * tracker can be exercised in isolation.
 *
 * In-memory only — like `RecentTurnUsageStore`, this is session
 * telemetry, not account state. Restarting the extension starts a
 * fresh recency window; users who run a long session will see
 * unused tools fall out naturally as they use other ones.
 *
 * Recency is timestamped per tool. The model "uses" a tool when
 * either:
 *   - the tool appears in this request's tool_use / tool_result
 *     history (`historyToolNames` from `collectHistoryReferencedToolNames`),
 *   - the tool is invoked by VS Code outside the chat pipeline
 *     (we don't have that signal in this layer, so it's
 *     history-only today).
 *
 * The "regularly used" semantic the user asked for is implemented
 * as a pure recency-ordered LRU: the cap is filled by the most
 * recently used tools. Tools the model has never called sort
 * to the top on first encounter (they get the synthetic "now"
 * timestamp), so a newly-installed MCP server immediately wins
 * slots over old-but-unused tools. A tool called once never gets
 * evicted — it joins the history-pinned set implicitly, since
 * the tracker remembers every tool it has ever seen.
 *
 * `prune(activeNames)` keeps the state from leaking entries for
 * tools the user has uninstalled. Run it at the top of every
 * request: walk the live tool set, drop tracker entries that no
 * longer correspond to a loaded tool.
 */
export interface McpToolRecency {
  /** When the tool was first recorded (first observed in the live set). */
  readonly firstUsedAt: number;
  /** Most recent observation timestamp. */
  readonly lastUsedAt: number;
  /** Number of times the model has called this tool in this session. */
  readonly callCount: number;
}

export class McpToolRecencyTracker {
  private readonly state = new Map<string, McpToolRecency>();

  /**
   * Record a single tool use. Idempotent on a no-op call (a tool
   * touched twice in the same millisecond still bumps the
   * counter — the only way to land on the same timestamp twice).
   */
  record(toolName: string, atMs: number = Date.now()): void {
    const existing = this.state.get(toolName);
    if (existing === undefined) {
      this.state.set(toolName, { firstUsedAt: atMs, lastUsedAt: atMs, callCount: 1 });
      return;
    }
    if (atMs <= existing.lastUsedAt) {
      // Stale clock or same-millisecond repeat — bump the counter
      // but don't move the timestamp backwards.
      this.state.set(toolName, {
        firstUsedAt: existing.firstUsedAt,
        lastUsedAt: existing.lastUsedAt,
        callCount: existing.callCount + 1,
      });
      return;
    }
    this.state.set(toolName, {
      firstUsedAt: existing.firstUsedAt,
      lastUsedAt: atMs,
      callCount: existing.callCount + 1,
    });
  }

  /**
   * Convenience for the chat-provider's per-request flow: bump
   * recency for every tool in `toolNames` (typically the
   * `historyToolNames` set) at the same timestamp.
   */
  recordMany(toolNames: ReadonlyArray<string>, atMs: number = Date.now()): void {
    for (const name of toolNames) this.record(name, atMs);
  }

  /**
   * Drop tracker entries that no longer correspond to a loaded
   * tool (user uninstalled the MCP server, server stopped
   * exposing that tool, etc.). Returns the names that were
   * pruned so the caller can log them.
   */
  prune(activeMcpToolNames: ReadonlySet<string>): ReadonlyArray<string> {
    const pruned: string[] = [];
    for (const name of Array.from(this.state.keys())) {
      if (!activeMcpToolNames.has(name)) {
        this.state.delete(name);
        pruned.push(name);
      }
    }
    return pruned;
  }

  /**
   * Read-only snapshot for the pure selection function. Returns
   * a fresh `Map` so callers can't mutate the tracker's
   * internal state.
   */
  snapshot(): ReadonlyMap<string, McpToolRecency> {
    return new Map(this.state);
  }

  /** Reset all state — used on extension shutdown / test teardown. */
  clear(): void {
    this.state.clear();
  }

  /** Diagnostic for the status bar / flight-deck. */
  size(): number {
    return this.state.size;
  }
}
