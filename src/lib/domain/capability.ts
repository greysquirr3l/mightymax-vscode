/**
 * Domain: capability detection.
 *
 * Pure, framework-free. T02 fills in the real per-model capability
 * rules; T01 ships the gating logic so the chat-provider can be wired
 * to hide non-tool-calling models from agent mode before the catalog
 * itself exists.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` test enforces that statically.
 */

import type { ModelCapabilities } from '../../ports/model-catalog.js';

/** Returned by `evaluateAgentEligibility`. */
export interface AgentEligibility {
  /** True iff the model can serve as a chat.utilityModel target. */
  utilityEligible: boolean;
  /** True iff the model can serve in agent mode. */
  agentEligible: boolean;
  /** Human-readable reasons; empty when both flags are true. */
  reasons: ReadonlyArray<string>;
}

/**
 * Decide whether a model can be used in agent mode or as a utility
 * model. The agent mode gate is the `capabilities.toolCalling` flag —
 * a model without it is hidden from the agent model picker.
 */
export function evaluateAgentEligibility(capabilities: ModelCapabilities): AgentEligibility {
  const reasons: string[] = [];
  const invalidFlags = [
    ['toolCalling', capabilities.toolCalling],
    ['imageInput', capabilities.imageInput],
    ['thinking', capabilities.thinking],
    ['videoInput', capabilities.videoInput],
  ]
    .filter(([, value]) => typeof value !== 'boolean')
    .map(([name]) => name);

  if (invalidFlags.length > 0) {
    reasons.push(`model capabilities must be boolean flags (invalid: ${invalidFlags.join(', ')})`);
    return {
      utilityEligible: false,
      agentEligible: false,
      reasons,
    };
  }

  if (!capabilities.toolCalling) {
    reasons.push('tool calling is not advertised on this model');
  }

  return {
    utilityEligible: true, // utility model has no agent-mode requirements
    agentEligible: capabilities.toolCalling,
    reasons,
  };
}
