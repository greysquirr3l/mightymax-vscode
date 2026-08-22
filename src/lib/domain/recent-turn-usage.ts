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
export class RecentTurnUsageStore {
  private latest: RecentTurnUsage | undefined;
  private readonly listeners = new Set<() => void>();

  record(usage: ChatUsageData, atMs: number = Date.now()): void {
    this.latest = { usage, atMs };
    this.notify();
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
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
