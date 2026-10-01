/**
 * T39 — `minimax_subagent` registration contract.
 *
 * The tool was registered with a bare `{ invoke }` object. The
 * `LanguageModelTool` interface in `@types/vscode` declares only
 * `invoke` and `prepareInvocation`, but the VS Code runtime also
 * reads `description` / `inputSchema` off the implementation object
 * to advertise the tool to the model — the same escape hatch
 * `mcp-search-adapter.ts` documents at its own `registerTool` call.
 *
 * With neither field present, VS Code had nothing to advertise and
 * the tool never entered the model's tool list. Observed in a
 * captured 0.9.2 session: three `runSubagent` emissions, zero
 * `minimax_subagent`, and the name absent from every logged tool
 * array — i.e. T35's "prefer our wrapper" had been inert since it
 * shipped.
 *
 * These tests run without a vscode import by injecting the
 * registrar, so they stay in the plain `node --test` runner.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildRegisteredSubAgentTool } from './subagent-tool-adapter.js';
import { MINIMAX_SUBAGENT_TOOL } from '../lib/domain/subagent-tool.js';
import type { Logger } from '../ports/logger.js';

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('T39 — buildRegisteredSubAgentTool', () => {
  it('carries a non-empty description for model advertisement', () => {
    const tool = buildRegisteredSubAgentTool({ logger: quietLogger });
    assert.equal(typeof tool.description, 'string');
    assert.ok(
      tool.description.length > 20,
      'description must be substantive enough for the model to choose the tool',
    );
  });

  it('carries the input schema the runtime needs to advertise the tool', () => {
    const tool = buildRegisteredSubAgentTool({ logger: quietLogger });
    const schema = tool.inputSchema as
      | { type?: string; required?: ReadonlyArray<string>; properties?: Record<string, unknown> }
      | undefined;
    // This is the field whose absence made the tool invisible.
    assert.notEqual(schema, undefined, 'inputSchema must be present on the implementation object');
    assert.equal(schema?.type, 'object');
    assert.deepEqual([...(schema?.required ?? [])].sort(), ['description', 'prompt']);
    assert.notEqual(schema?.properties?.['prompt'], undefined, 'prompt property must be declared');
  });

  it('reuses the domain descriptor so the schema cannot drift from validation', () => {
    const tool = buildRegisteredSubAgentTool({ logger: quietLogger });
    const schema = tool.inputSchema as { properties?: Record<string, unknown> };
    // `validateSubAgentInput` reads exactly these three keys.
    for (const key of ['description', 'prompt', 'subagent_type']) {
      assert.ok(schema.properties?.[key] !== undefined, `${key} must be in the schema`);
    }
  });

  it('still exposes an invoke handler', () => {
    const tool = buildRegisteredSubAgentTool({ logger: quietLogger });
    assert.equal(typeof tool.invoke, 'function', 'invoke must remain callable');
  });

  it('keeps the tool name stable', () => {
    assert.equal(MINIMAX_SUBAGENT_TOOL, 'minimax_subagent');
  });
});
