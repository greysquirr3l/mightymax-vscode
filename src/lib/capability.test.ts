import { deepStrictEqual, equal, match } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateAgentEligibility } from './domain/capability.js';

describe('evaluateAgentEligibility', () => {
  it('marks valid tool-calling models as utility and agent eligible', () => {
    const out = evaluateAgentEligibility({
      toolCalling: true,
      imageInput: true,
      thinking: true,
      videoInput: true,
    });

    equal(out.utilityEligible, true);
    equal(out.agentEligible, true);
    deepStrictEqual(out.reasons, []);
  });

  it('keeps utility eligibility but blocks agent eligibility when tool calling is absent', () => {
    const out = evaluateAgentEligibility({
      toolCalling: false,
      imageInput: true,
      thinking: false,
      videoInput: false,
    });

    equal(out.utilityEligible, true);
    equal(out.agentEligible, false);
    equal(out.reasons.length, 1);
    match(out.reasons[0] ?? '', /tool calling/i);
  });

  it('treats malformed capability flags as ineligible and surfaces the validation reason', () => {
    const out = evaluateAgentEligibility({
      toolCalling: 'yes' as unknown as boolean,
      imageInput: 1 as unknown as boolean,
      thinking: null as unknown as boolean,
      videoInput: 'nope' as unknown as boolean,
    });

    equal(out.utilityEligible, false);
    equal(out.agentEligible, false);
    equal(out.reasons.length, 1);
    match(out.reasons[0] ?? '', /boolean/i);
  });
});
