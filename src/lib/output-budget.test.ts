import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert/strict';

import { OutputBudget } from './domain/output-budget.js';

const CFG = { tokens: 1_000, windowMs: 60_000 };

describe('OutputBudget', () => {
  it('is disabled when tokens is 0', () => {
    strictEqual(new OutputBudget().remaining({ tokens: 0, windowMs: 1 }, 0), undefined);
  });
  it('decrements as turns are recorded and floors at 0', () => {
    const b = new OutputBudget();
    b.record(400, 0);
    strictEqual(b.remaining(CFG, 1), 600);
    b.record(900, 2);
    strictEqual(b.remaining(CFG, 3), 0);
  });
  it('refills as turns age out of the window', () => {
    const b = new OutputBudget();
    b.record(1_000, 0);
    strictEqual(b.remaining(CFG, 30_000), 0);
    strictEqual(b.remaining(CFG, 60_000), 1_000);
  });
});
