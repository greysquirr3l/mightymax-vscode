import type { ChatUsageData } from '../../ports/message-mapping.js';

/** Normalized MiniMax usage captured from the most recently completed stream. */
export interface RecentTurnUsage {
  readonly usage: ChatUsageData;
  readonly atMs: number;
}

/**
 * In-memory-only store shared by the chat provider and status bar. Per-turn
 * usage is operational telemetry, not account quota state; discarding it on
 * extension restart avoids persisting conversation-derived metadata.
 */
/**
 * Token totals accumulated from every completed turn since the
 * extension started. The only usage figure a pay-as-you-go key has:
 * the Token Plan endpoint reports nothing for it.
 */
export interface SessionUsageTotals {
  readonly turns: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
}

export class RecentTurnUsageStore {
  private latest: RecentTurnUsage | undefined;
  private totals: SessionUsageTotals | undefined;
  private readonly listeners = new Set<() => void>();

  record(usage: ChatUsageData, atMs: number = Date.now()): void {
    this.latest = { usage, atMs };
    const t = this.totals;
    this.totals = {
      turns: (t?.turns ?? 0) + 1,
      promptTokens: (t?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
      completionTokens: (t?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
      cacheReadTokens: (t?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheCreateTokens: (t?.cacheCreateTokens ?? 0) + (usage.cacheCreateTokens ?? 0),
    };
    this.notify();
  }

  /** Totals across every recorded turn, or `undefined` before the first. */
  sessionTotals(): SessionUsageTotals | undefined {
    return this.totals;
  }

  snapshot(): RecentTurnUsage | undefined {
    return this.latest;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  clear(): void {
    this.latest = undefined;
    this.totals = undefined;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
