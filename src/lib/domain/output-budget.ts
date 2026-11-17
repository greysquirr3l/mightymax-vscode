/**
 * Host-owned rolling output-token budget (pure).
 *
 * A thinking model's effort setting is only a hint; this is the hard
 * bound. Output tokens actually billed are recorded as turns finish,
 * and the budget for the next turn is whatever is left of the
 * allowance inside the sliding window. A budget of 0 disables it.
 */

export interface OutputBudgetConfig {
  /** Output tokens allowed per window; 0 disables the budget. */
  readonly tokens: number;
  readonly windowMs: number;
}

export class OutputBudget {
  private entries: { at: number; tokens: number }[] = [];

  record(tokens: number, now: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.entries.push({ at: now, tokens });
  }

  /** Tokens left in the window; `undefined` when the budget is disabled. */
  remaining(config: OutputBudgetConfig, now: number): number | undefined {
    if (config.tokens <= 0) return undefined;
    this.entries = this.entries.filter((e) => now - e.at < config.windowMs);
    const used = this.entries.reduce((sum, e) => sum + e.tokens, 0);
    return Math.max(0, config.tokens - used);
  }

  clear(): void {
    this.entries = [];
  }
}
