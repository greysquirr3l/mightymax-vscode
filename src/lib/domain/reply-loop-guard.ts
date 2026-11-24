/**
 * T44 — Live reply-loop guard.
 *
 * Pure domain. A model can fall into a loop it never leaves: its
 * reasoning goes on as "Now." "Writing." "Go." "Let me write." "OK." …
 * with a word or two changing between rounds, until the reply's
 * token limit. This module reads a reply's reasoning and text as they
 * stream and says when either has become such a loop, so the stream
 * can be ended with an error instead of running on.
 *
 * The reply is cut into units — its lines and sentences. A loop is a
 * long run of units that are nearly all the same few: of the last
 * LOOP_WINDOW units of a channel, no more than LOOP_DISTINCT
 * different ones. Code, a table, a list or a log differ line to line
 * in their names, numbers and cells, and a unit with no word and no
 * emoji in it (a brace, a rule, a row of hex or numbers) is not
 * counted at all. An emoji counts as a word: a reply stuck emitting
 * the same emoji is a loop like any other. A loop with no break in it
 * ("mcp mcp mcp …", "🤯🤯🤯…") is read on its own once a unit grows
 * to UNIT_MOST characters.
 *
 * Ported from MiniMax Code's `llm-reply-loop-guard.js` (upstream
 * `agent-core/dist/pi-turn-runner/`), which is MIT-licensed; see
 * THIRD_PARTY_NOTICES.md. The algorithm and constants are kept
 * faithful to upstream so the two guards trip on the same inputs.
 */

/** Units of a channel looked at. */
export const LOOP_WINDOW = 256;
/**
 * Most different units the window may hold and still be a loop; kept
 * low so ordinary repetitive output is further from the line.
 */
export const LOOP_DISTINCT = 16;
/** How long a unit grows without a break before it is taken whole. */
const UNIT_MOST = 4096;
/** How much of a unit tells it apart. */
const UNIT_KEPT = 256;
/** Units cut at UNIT_MOST in a row, each the same few words, that are a loop. */
const RUN_ON_UNITS = 3;
/** Most different words a run-on loop has. */
const RUN_ON_DISTINCT = 8;

/**
 * What the agent and the logs are told of a loop. Never carries more
 * than a few short quotes.
 */
export interface LoopTrip {
  /** Which channel tripped: the model's reasoning or its visible text. */
  readonly reasoning: boolean;
  /** The repeated units, or the repeated words of a run-on loop. */
  readonly units: ReadonlyArray<string>;
  /** How much of the reply the loop covered, in units or characters. */
  readonly window: number;
  /** True when the loop had no break in it (a run-on unit). */
  readonly runOn: boolean;
}

export function replyLoopMessage(trip: LoopTrip): string {
  const what = trip.reasoning ? 'reasoning' : 'text';
  const quoted = trip.units.slice(0, 6).map((unit) => JSON.stringify(unit));
  if (trip.units.length > 6) quoted.push('…');
  return trip.runOn
    ? `The reply was stopped: the model's ${what} was stuck in a loop, its last ${trip.window} characters ` +
        `the same few words over and over without a break (${quoted.join(' ')}), and would have run on to its output limit. Ask again.`
    : `The reply was stopped: the model's ${what} was stuck in a loop, its last ${trip.window} lines and ` +
        `sentences all among the same ${trip.units.length} (${quoted.join(' ')}), and would have run on to its output limit. Ask again.`;
}

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const WORD_CHAR = /[\p{L}\p{Nd}_]/u;
const SPACE = /\s/u;
const UNIT_TAIL = /[.!?。！？,，;；:：…\s]+$/u;
/** A word, or one emoji: the tokens a run-on loop is counted in. */
const TOKEN = /[\p{L}\p{Nd}_]+|\p{Extended_Pictographic}/gu;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * One channel of the reply, cut into units as they arrive.
 *
 * `ring` holds the last LOOP_WINDOW unit keys; `counts` tallies how
 * often each key appears in that window. When the window is full and
 * holds no more than LOOP_DISTINCT distinct keys, the channel is a
 * loop.
 */
class UnitRun {
  /** The unit written so far. */
  private cur = '';
  /** `cur` ends in a sentence's stop: a space after it ends the unit. */
  private stop = false;
  /** `cur` has a letter, for a stop after it to end a sentence. */
  private lettered = false;
  private readonly ring: Array<string | undefined> = new Array<string | undefined>(LOOP_WINDOW);
  private n = 0;
  private readonly counts = new Map<string, { n: number; text: string; at: number }>();
  /** Units in a row cut at UNIT_MOST, each the same few words over and over. */
  private runOn = 0;

  /**
   * Feed a chunk of the channel. Returns the trip when the channel
   * has become a loop, `undefined` otherwise.
   */
  add(s: string): LoopTrip | undefined {
    for (const c of s) {
      if (c === '\n' || (this.stop && SPACE.test(c))) {
        const trip = this.end();
        if (trip) return trip;
        continue;
      }
      this.cur += c;
      if (c === '.' || c === '!' || c === '?') {
        // A sentence's stop, not a list's number (1.) or a decimal.
        this.stop = this.lettered;
      } else if (c === '。' || c === '！' || c === '？') {
        const trip = this.end();
        if (trip) return trip;
        continue;
      } else {
        this.stop = false;
        this.lettered = this.lettered || LETTER.test(c);
      }
      if (this.cur.length >= UNIT_MOST) {
        const words = runOnWords(this.cur);
        if (words) {
          this.runOn += 1;
          if (this.runOn >= RUN_ON_UNITS) {
            return { reasoning: false, units: words, window: this.runOn * UNIT_MOST, runOn: true };
          }
        } else {
          this.runOn = 0;
        }
        const trip = this.end();
        if (trip) return trip;
      }
    }
    return undefined;
  }

  /**
   * Takes the unit written so far; says whether the window has
   * become a loop with it.
   */
  private end(): LoopTrip | undefined {
    const raw = this.cur;
    if (raw.length < UNIT_MOST) {
      // A break; a long unit before it that still runs on keeps the count.
      if (raw.length < UNIT_MOST / 8 || !runOnWords(raw)) this.runOn = 0;
    }
    this.cur = '';
    this.stop = false;
    this.lettered = false;
    const key = unitKey(raw);
    if (key === undefined) return undefined;
    const slot = this.n % LOOP_WINDOW;
    if (this.n >= LOOP_WINDOW) {
      const old = this.ring[slot];
      if (old !== undefined) {
        const count = this.counts.get(old);
        if (count) {
          count.n -= 1;
          if (count.n === 0) this.counts.delete(old);
        }
      }
    }
    this.ring[slot] = key;
    let count = this.counts.get(key);
    if (!count) {
      const trimmed = raw.trim();
      const chars = Array.from(trimmed);
      count = {
        n: 0,
        text: chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : trimmed,
        at: this.n,
      };
      this.counts.set(key, count);
    }
    count.n += 1;
    this.n += 1;
    if (this.n < LOOP_WINDOW || this.counts.size > LOOP_DISTINCT) return undefined;
    const all = [...this.counts.values()].sort((a, b) => b.n - a.n || a.at - b.at);
    return { reasoning: false, units: all.map((entry) => entry.text), window: LOOP_WINDOW, runOn: false };
  }
}

/**
 * Reads one reply's stream events; one guard per physical attempt.
 *
 * The plugin's stream events are not upstream's, so the guard is fed
 * by the caller rather than by a `feed(event)` method: the pump
 * forwards thinking and text deltas as they arrive.
 */
export class ReplyLoopGuard {
  private readonly think = new UnitRun();
  private readonly text = new UnitRun();
  /** The reply has said something the agent acts on: text or a tool call. */
  spoke = false;

  /** Feed a reasoning delta. Returns the trip when reasoning has looped. */
  feedReasoning(delta: string): LoopTrip | undefined {
    const trip = this.think.add(delta);
    return trip ? { ...trip, reasoning: true } : undefined;
  }

  /** Feed a visible-text delta. Returns the trip when text has looped. */
  feedText(delta: string): LoopTrip | undefined {
    if (delta.trim().length > 0) this.spoke = true;
    return this.text.add(delta);
  }

  /** A tool call is the reply acting, not narrating. */
  noteToolCall(): void {
    this.spoke = true;
  }
}

/**
 * Whether `s`, written with no break, is the same few words or emoji
 * over and over, and which. A long line of prose, code, JSON, base64
 * or a table row has many different words (its names, numbers and
 * cells) or none.
 */
export function runOnWords(s: string): string[] | undefined {
  if (!hasWordOrEmoji(s)) return undefined;
  // One piece repeated: a word or a few with no space between.
  for (let p = 1; p <= 64 && 4 * p <= s.length; p += 1) {
    let i = p;
    while (i < s.length && s[i] === s[i - p]) i += 1;
    if (i === s.length) return [s.slice(0, Math.min(3 * p, s.length)).trim()];
  }
  const counts = new Map<string, number>();
  let words = 0;
  for (const [word] of s.toLowerCase().matchAll(TOKEN)) {
    words += 1;
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (counts.size > RUN_ON_DISTINCT) return undefined;
  }
  // A few long words: not read as a loop.
  if (words * 32 < s.length) return undefined;
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

/**
 * What tells a unit apart, and whether it counts: its words, without
 * case or its closing stop. A unit with no word and no emoji in it is
 * no sentence and is left out.
 */
function unitKey(raw: string): string | undefined {
  const s = raw.trim().replace(UNIT_TAIL, '');
  if (!hasWordOrEmoji(s)) return undefined;
  const lower = s.toLowerCase();
  return lower.length > UNIT_KEPT ? lower.slice(0, UNIT_KEPT) : lower;
}

function hasWordOrEmoji(s: string): boolean {
  return hasWord(s) || PICTOGRAPH.test(s);
}

/** A run of letters with no digit in it (Now, Writing, 好), not 0x00, v2 or a hash. */
function hasWord(s: string): boolean {
  let letters = false;
  let digits = false;
  for (const c of `${s} `) {
    if (WORD_CHAR.test(c)) {
      letters = letters || LETTER.test(c);
      digits = digits || DIGIT.test(c);
      continue;
    }
    if (letters && !digits) return true;
    letters = false;
    digits = false;
  }
  return false;
}
