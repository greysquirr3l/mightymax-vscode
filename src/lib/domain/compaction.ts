/**
 * History compaction helpers (pure).
 *
 * When the history pruner drops old exchanges, they are summarized by
 * the model instead of vanishing. Summaries are cached by a hash of the
 * dropped prefix, so a conversation that keeps growing re-summarizes
 * only the newly dropped tail on top of the previous summary.
 */

import { createHash } from 'node:crypto';

import type { MiniMaxWireMessage } from '../../ports/minimax-client.js';

/** Per-message and total caps for the transcript handed to the summarizer. */
const MESSAGE_CHARS = 2_000;
const TRANSCRIPT_CHARS = 200_000;
const MAX_CACHED_SUMMARIES = 8;

export const COMPACTION_INSTRUCTIONS =
  'You are compacting the older part of a coding-assistant conversation so it can continue ' +
  'with less context. Write a dense, factual summary: the user\'s goals, decisions made, files ' +
  'and symbols touched, commands run and their outcomes, errors hit, and anything still ' +
  'unresolved. No preamble, no reasoning, no advice. Under 1500 words.';

function messageText(message: MiniMaxWireMessage): string {
  let text = '';
  if (typeof message.content === 'string') text = message.content;
  else {
    for (const part of message.content) {
      if (part.type === 'text') text += `${part.text}\n`;
    }
  }
  for (const call of message.toolCalls ?? []) {
    text += `[called ${call.function.name} ${call.function.arguments}]\n`;
  }
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…[truncated]` : text;
}

/** Plain-text transcript of messages, newest content kept when over the total cap. */
export function renderTranscript(messages: ReadonlyArray<MiniMaxWireMessage>): string {
  const lines = messages.map((m) => `${m.role.toUpperCase()}: ${messageText(m).trim()}`);
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (total + line.length > TRANSCRIPT_CHARS) break;
    total += line.length;
    kept.push(line);
  }
  return kept.reverse().join('\n\n');
}

/** Cumulative hash after each message: `keys[i]` identifies `messages[0..i]`. */
export function prefixKeys(
  modelId: string,
  messages: ReadonlyArray<MiniMaxWireMessage>,
): ReadonlyArray<string> {
  const hasher = createHash('sha256').update(modelId);
  return messages.map((m) => {
    hasher.update('\u0000').update(JSON.stringify(m));
    return hasher.copy().digest('hex');
  });
}

export interface CompactionHit {
  /** How many leading dropped messages the cached summary covers. */
  readonly covered: number;
  readonly summary: string;
}

/** Small LRU of summaries keyed by dropped-prefix hash. */
export class CompactionCache {
  private readonly map = new Map<string, string>();

  /** Longest cached prefix of the dropped list, if any. */
  find(keys: ReadonlyArray<string>): CompactionHit | undefined {
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      const summary = key === undefined ? undefined : this.map.get(key);
      if (key !== undefined && summary !== undefined) {
        this.map.delete(key);
        this.map.set(key, summary);
        return { covered: i + 1, summary };
      }
    }
    return undefined;
  }

  set(key: string, summary: string): void {
    this.map.delete(key);
    this.map.set(key, summary);
    while (this.map.size > MAX_CACHED_SUMMARIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
