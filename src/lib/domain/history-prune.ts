/**
 * T40 — History pruning (pure).
 *
 * `truncateToolResults` caps each tool RESULT at 4096 chars, but
 * nothing bounded the message COUNT. A captured 0.9.2 session grew to
 * 186 messages / ~269k chars and ended in a hard HTTP 500 — and
 * because a 500 classifies as `kind: 'http'`, the key pool rotated
 * slots looking for an auth problem that did not exist.
 *
 * ## The constraint that makes this non-trivial
 *
 * Anthropic rejects a `tool_result` whose `tool_use_id` has no
 * matching assistant `tool_use` (error 2013). So a tool result and
 * the assistant turn that produced it must be dropped TOGETHER. A
 * naive "keep the last N messages" slice strands results and 400s
 * the request — trading a 500 for a 400.
 *
 * ## Strategy
 *
 * Walk from the oldest end, grouping each assistant turn with the
 * contiguous `tool` turns that answer it, and drop whole groups until
 * the remainder fits the budget. A `user` turn starts a new group, so
 * a mid-conversation user message is never spliced away. The first
 * message and the final group are always kept — an empty history
 * would read to the model as "the user said nothing".
 *
 * Runs AFTER `truncateToolResults` and the orphan reconciliation, so
 * a result has already been capped and adopted by the time we count
 * it. Trimming here rather than earlier keeps the "drop whole
 * exchanges" invariant in one place.
 */

import type { MiniMaxWireMessage } from '../../ports/minimax-client.js';

/** Default history budget in characters. See `DEFAULT_HISTORY_MAX_CHARS`. */
export const DEFAULT_HISTORY_MAX_CHARS = 500_000;

export interface HistoryPruneOptions {
  /** Character budget for the retained history. */
  readonly maxChars?: number;
}

export interface HistoryPruneResult {
  readonly messages: ReadonlyArray<MiniMaxWireMessage>;
  /** Messages removed (whole exchange groups only — never a half pair). */
  readonly droppedMessages: number;
  /** Characters reclaimed, for the provider to log. */
  readonly droppedChars: number;
}

/**
 * Approximate the character cost of a wire message. Deliberately an
 * over-estimate for images and tool arguments: those are the two
 * shapes where a naive `content.length` would report near-zero and
 * let the real payload through unbudgeted.
 */
export function estimateWireChars(message: MiniMaxWireMessage): number {
  let chars = 0;
  if (typeof message.content === 'string') {
    chars += message.content.length;
  } else {
    for (const part of message.content) {
      if (part.type === 'text') {
        chars += part.text.length;
      } else if (part.type === 'thinking') {
        chars += part.thinking.length;
      } else if (part.type === 'image_url') {
        // A data URI is ~4/3 of the raw bytes; count the string
        // length so a large screenshot cannot hide behind a small
        // field count.
        chars += part.image_url.url.length;
      } else if (part.type === 'video_url') {
        chars += part.video_url.url.length;
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    chars += call.function.arguments.length + call.function.name.length + call.id.length;
  }
  if (message.toolCallId !== undefined) chars += message.toolCallId.length;
  return chars;
}

/**
 * Partition a history into exchange groups that can be dropped
 * atomically.
 *
 * A group is one `assistant` turn plus the contiguous `tool` turns
 * answering it. A `user` turn closes the current group and starts a
 * new one, so pruning can never splice two unrelated user requests
 * together. A leading `system` or `user` run forms its own group.
 */
function groupExchanges(
  messages: ReadonlyArray<MiniMaxWireMessage>,
): ReadonlyArray<{ readonly messages: ReadonlyArray<MiniMaxWireMessage>; readonly chars: number }> {
  const groups: { messages: MiniMaxWireMessage[]; chars: number }[] = [];
  let current: { messages: MiniMaxWireMessage[]; chars: number } | undefined;

  // A `user` turn is a boundary: it must not be merged with what
  // precedes it, and it must not collect the assistant turn that
  // follows. So it is emitted as a complete group of its own and
  // the group cursor is cleared.
  //
  // `system` is handled the same way. Both are "requests", not
  // "exchanges", and dropping one mid-prune would splice two
  // unrelated user requests together.
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'system') {
      if (current !== undefined && current.messages.length > 0) groups.push(current);
      current = undefined;
      groups.push({ messages: [m], chars: estimateWireChars(m) });
      continue;
    }
    // `assistant` and `tool` accumulate into ONE group. A new
    // assistant turn closes any in-flight group first (it is the
    // next exchange), and then opens a fresh one that its own tool
    // results will join.
    //
    // This is the load-bearing part: an assistant turn and the tool
    // results answering it must land in the same group, or pruning
    // can drop the turn and strand the result — the 2013 rejection
    // this whole module exists to prevent.
    if (m.role === 'assistant' && current !== undefined) {
      groups.push(current);
      current = undefined;
    }
    if (current === undefined) {
      current = { messages: [m], chars: estimateWireChars(m) };
      continue;
    }
    current.messages.push(m);
    current.chars += estimateWireChars(m);
  }
  if (current !== undefined && current.messages.length > 0) groups.push(current);
  return groups;
}

/**
 * Drop whole exchange groups from the oldest end until the retained
 * history fits `maxChars`.
 *
 * Guarantees:
 *  - the first message (the user's original task) is always kept;
 *  - the final group is always kept, even when over budget;
 *  - no `tool` message is retained without its assistant turn.
 */
export function pruneHistory(
  messages: ReadonlyArray<MiniMaxWireMessage>,
  options: HistoryPruneOptions = {},
): HistoryPruneResult {
  const maxChars = options.maxChars ?? DEFAULT_HISTORY_MAX_CHARS;

  // Cheap exit: under budget, or too short to have an exchange.
  if (messages.length <= 2) {
    return { messages, droppedMessages: 0, droppedChars: 0 };
  }
  const totalChars = messages.reduce((sum, m) => sum + estimateWireChars(m), 0);
  if (totalChars <= maxChars) {
    return { messages, droppedMessages: 0, droppedChars: 0 };
  }

  const groups = groupExchanges(messages);
  if (groups.length <= 1) {
    return { messages, droppedMessages: 0, droppedChars: 0 };
  }

  const kept: MiniMaxWireMessage[] = [];
  let keptChars = 0;
  let droppedMessages = 0;
  let droppedChars = 0;

  // Always keep group 0 (the user's original task) and the last
  // group (the exchange the model is currently answering).
  const firstGroup = groups[0];
  const lastIndex = groups.length - 1;
  const lastGroup = groups[lastIndex];
  if (firstGroup === undefined || lastGroup === undefined) {
    return { messages, droppedMessages: 0, droppedChars: 0 };
  }
  kept.push(...firstGroup.messages);
  keptChars += firstGroup.chars;

  // Walk the middle from NEWEST to oldest, admitting groups while
  // they fit. Iterating in reverse is what makes "keep the most
  // recent context" the natural outcome rather than something we
  // have to reverse afterwards.
  const admitted: (typeof groups)[number][] = [];
  for (let i = lastIndex - 1; i >= 1; i--) {
    const group = groups[i];
    if (group === undefined) continue;
    if (keptChars + group.chars > maxChars) continue;
    admitted.push(group);
    keptChars += group.chars;
  }

  // Restore chronological order.
  admitted.reverse();
  for (const group of admitted) kept.push(...group.messages);

  // The final group goes on last and is exempt from the budget:
  // dropping it would strand the tool result the model is about
  // to be asked about.
  kept.push(...lastGroup.messages);

  for (let i = 1; i < lastIndex; i++) {
    const group = groups[i];
    if (group === undefined || admitted.includes(group)) continue;
    droppedMessages += group.messages.length;
    droppedChars += group.chars;
  }

  return { messages: kept, droppedMessages, droppedChars };
}
