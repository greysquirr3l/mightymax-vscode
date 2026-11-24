/**
 * Domain unit tests for the reply-loop guard (T44).
 *
 * The guard is a direct port of upstream MiniMax Code's
 * `llm-reply-loop-guard.js`, so the expectations here are written
 * against the upstream algorithm's two trip conditions:
 *
 *  1. The WINDOW condition — the last LOOP_WINDOW units of a channel
 *     hold no more than LOOP_DISTINCT different ones.
 *  2. The RUN-ON condition — RUN_ON_UNITS units of UNIT_MOST
 *     characters in a row, each the same few words, with no break.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  LOOP_DISTINCT,
  LOOP_WINDOW,
  ReplyLoopGuard,
  replyLoopMessage,
  runOnWords,
} from './reply-loop-guard.js';

/**
 * Build a channel whose units all share one key, so the window
 * condition can be reached: every unit is the same sentence.
 */
function repeatedUnits(count: number, text = 'I will read the file again'): string {
  return Array.from({ length: count }, () => `${text}\n`).join('');
}

describe('ReplyLoopGuard — window condition', () => {
  it('does not trip on a reply that says the same thing a few times', () => {
    const guard = new ReplyLoopGuard();
    const trip = guard.feedText(repeatedUnits(5));
    assert.equal(trip, undefined);
  });

  it('trips when a whole window of units is nearly all the same', () => {
    const guard = new ReplyLoopGuard();
    const trip = guard.feedText(repeatedUnits(LOOP_WINDOW + 1));
    assert.ok(trip, 'expected the guard to trip');
    assert.equal(trip?.reasoning, false);
    assert.equal(trip?.runOn, false);
    assert.equal(trip?.window, LOOP_WINDOW);
    assert.ok(trip && trip.units.length <= LOOP_DISTINCT);
  });

  it('does not trip when the units differ from each other', () => {
    const guard = new ReplyLoopGuard();
    let trip;
    for (let i = 0; i < LOOP_WINDOW + 1; i++) {
      trip = guard.feedText(`unit number ${i} carries its own words\n`);
      if (trip) break;
    }
    assert.equal(trip, undefined);
  });

  it('reports a reasoning trip on the reasoning channel', () => {
    const guard = new ReplyLoopGuard();
    const trip = guard.feedReasoning(repeatedUnits(LOOP_WINDOW + 1));
    assert.ok(trip, 'expected the guard to trip');
    assert.equal(trip?.reasoning, true);
  });
});

describe('ReplyLoopGuard — run-on condition', () => {
  it('trips on a unit with no break that repeats the same few words', () => {
    const guard = new ReplyLoopGuard();
    // A run-on loop is RUN_ON_UNITS (3) units of UNIT_MOST (4096)
    // characters in a row, each the same few words and with no break
    // between them. The unit is taken whole once it reaches 4096
    // characters, so the text must be long enough to fill three.
    const trip = guard.feedText('mcp '.repeat(5000));
    assert.ok(trip, 'expected the guard to trip');
    assert.equal(trip?.runOn, true);
  });

  it('does not trip on a long run of varied prose', () => {
    const guard = new ReplyLoopGuard();
    // Distinct words, so the run-on count never accumulates and the
    // window holds far more than LOOP_DISTINCT different units.
    const words: string[] = [];
    for (let i = 0; i < 2000; i++) words.push(letters(i));
    const trip = guard.feedText(words.join(' '));
    assert.equal(trip, undefined);
  });
});

/** A distinct alphabetic word for a number, so it counts as a word. */
function letters(n: number): string {
  let out = '';
  let v = n;
  for (;;) {
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26) - 1;
    if (v < 0) break;
  }
  return out;
}

describe('ReplyLoopGuard — spoke tracking', () => {
  it('starts unspeaking', () => {
    assert.equal(new ReplyLoopGuard().spoke, false);
  });

  it('counts visible text as speaking', () => {
    const guard = new ReplyLoopGuard();
    guard.feedText('Here is the summary of what I changed.');
    assert.equal(guard.spoke, true);
  });

  it('does not count whitespace-only text as speaking', () => {
    const guard = new ReplyLoopGuard();
    guard.feedText('   \n  ');
    assert.equal(guard.spoke, false);
  });

  it('counts a tool call as speaking', () => {
    const guard = new ReplyLoopGuard();
    guard.noteToolCall();
    assert.equal(guard.spoke, true);
  });
});

describe('runOnWords', () => {
  it('reads a repeated word as a loop', () => {
    // Upstream returns the first 3*p characters of the repeated
    // unit, so a 3-char unit repeated is quoted as 9 chars.
    assert.deepEqual(runOnWords('abcabcabcabc'), ['abcabcabc']);
  });

  it('returns nothing for text with many different words', () => {
    assert.equal(runOnWords('the quick brown fox jumps over the lazy dog again and again'), undefined);
  });

  it('returns nothing for text with no word and no emoji', () => {
    assert.equal(runOnWords('1234 5678 9012 3456'), undefined);
  });
});

describe('replyLoopMessage', () => {
  it('names the channel that looped', () => {
    const msg = replyLoopMessage({
      reasoning: true,
      units: ['Now.', 'Writing.'],
      window: LOOP_WINDOW,
      runOn: false,
    });
    assert.match(msg, /reasoning/);
    assert.match(msg, /stuck in a loop/);
  });

  it('distinguishes a run-on loop from a window loop', () => {
    const runOn = replyLoopMessage({
      reasoning: false,
      units: ['mcp'],
      window: 12288,
      runOn: true,
    });
    assert.match(runOn, /without a break/);
  });
});
