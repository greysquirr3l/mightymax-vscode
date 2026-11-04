import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { RequestRateLimiter } from './domain/rate-limiter.js';

describe('RequestRateLimiter', () => {
  it('never waits when disabled', () => {
    const l = new RequestRateLimiter(() => 0);
    for (let i = 0; i < 50; i++) strictEqual(l.reserve('k', 0), 0);
  });

  it('lets a full minute of requests through, then paces the rest', () => {
    const l = new RequestRateLimiter(() => 0);
    for (let i = 0; i < 60; i++) strictEqual(l.reserve('k', 60), 0);
    // 60 rpm = one per second; each excess request waits one more second.
    strictEqual(l.reserve('k', 60), 1000);
    strictEqual(l.reserve('k', 60), 2000);
  });

  it('refills over time and isolates keys', () => {
    let t = 0;
    const l = new RequestRateLimiter(() => t);
    for (let i = 0; i < 60; i++) l.reserve('a', 60);
    strictEqual(l.reserve('b', 60), 0);
    t = 10_000;
    // Debt of 0 tokens at t=0 plus 10 refilled → 10 free requests.
    for (let i = 0; i < 10; i++) strictEqual(l.reserve('a', 60), 0);
    strictEqual(l.reserve('a', 60), 1000);
  });
});
