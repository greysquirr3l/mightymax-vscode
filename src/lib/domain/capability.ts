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
 *
 * As of `@types/vscode` 1.125.0 — the engine floor — `toolCalling` may
 * be `boolean | number` (a positive integer is the model's per-request
 * tool cap). Both `true` and any positive number count as "tool calling
 * supported".
 */
export function evaluateAgentEligibility(capabilities: ModelCapabilities): AgentEligibility {
  const reasons: string[] = [];

  // imageInput / thinking / videoInput must remain booleans.
  const invalidBooleanFlags = [
    ['imageInput', capabilities.imageInput],
    ['thinking', capabilities.thinking],
    ['videoInput', capabilities.videoInput],
  ]
    .filter(([, value]) => typeof value !== 'boolean')
    .map(([name]) => name);

  if (invalidBooleanFlags.length > 0) {
    reasons.push(
      `model boolean capability flags must be booleans (invalid: ${invalidBooleanFlags.join(', ')})`,
    );
    return {
      utilityEligible: false,
      agentEligible: false,
      reasons,
    };
  }

  // toolCalling may be boolean or a positive integer (per-request cap).
  // Anything else (false, 0, negative, non-integer) means no tool support.
  const tc = capabilities.toolCalling;
  const toolCallingSupported =
    tc === true || (typeof tc === 'number' && Number.isInteger(tc) && tc > 0);

  if (!toolCallingSupported) {
    reasons.push('tool calling is not advertised on this model');
  }

  return {
    utilityEligible: true, // utility model has no agent-mode requirements
    agentEligible: toolCallingSupported,
    reasons,
  };
}
