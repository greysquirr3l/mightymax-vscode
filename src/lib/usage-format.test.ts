import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import {
  formatClockSeconds,
  formatCount,
  formatReset,
  formatRelative,
  utcOffsetLabel,
} from './domain/usage-format.js';

const NOW = Date.UTC(2025, 0, 1, 16, 24, 3); // a Wednesday; +130h lands on Tuesday
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('formatRelative', () => {
  it('scales from seconds to days', () => {
    strictEqual(formatRelative(NOW + 30_000, NOW), 'in under a minute');
    strictEqual(formatRelative(NOW + 47 * MIN, NOW), 'in 47m');
    strictEqual(formatRelative(NOW + HOUR + 13 * MIN, NOW), 'in 1h 13m');
    strictEqual(formatRelative(NOW + 2 * HOUR, NOW), 'in 2h');
    strictEqual(formatRelative(NOW + 130 * HOUR, NOW), 'in 5d 10h');
    strictEqual(formatRelative(NOW - 1, NOW), 'now');
  });
});

describe('formatReset', () => {
  it('shows a local clock, with a weekday beyond a day', () => {
    const soon = new Date(NOW + HOUR + 13 * MIN).toISOString();
    strictEqual(formatReset(soon, NOW, 0), 'in 1h 13m (17:37)');
    strictEqual(formatReset(soon, NOW, -300), 'in 1h 13m (12:37)');
    const later = new Date(NOW + 130 * HOUR).toISOString();
    strictEqual(formatReset(later, NOW, 0), 'in 5d 10h (Tue 02:24)');
  });
  it('passes an unparseable value through', () => {
    strictEqual(formatReset('soon', NOW, 0), 'soon');
  });
});

describe('clock helpers', () => {
  it('labels the offset and formats seconds in it', () => {
    strictEqual(utcOffsetLabel(0), 'UTC');
    strictEqual(utcOffsetLabel(-300), 'UTC-5');
    strictEqual(utcOffsetLabel(330), 'UTC+5:30');
    strictEqual(formatClockSeconds(NOW, -300), '11:24:03');
  });
});

describe('formatCount', () => {
  it('words counts by period and ignores percent-only windows', () => {
    strictEqual(formatCount({ label: 'Daily window', short: 'day', percentUsed: 0, usedCount: 0, totalCount: 3 }), '0/3 today');
    strictEqual(formatCount({ label: 'Weekly window', short: 'wk', percentUsed: 0, usedCount: 4, totalCount: 21 }), '4/21 this week');
    strictEqual(formatCount({ label: '5-hour window', short: '5h', percentUsed: 10 }), undefined);
  });
});
