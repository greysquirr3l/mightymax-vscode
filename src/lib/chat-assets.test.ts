/**
 * T23 — Chat-asset frontmatter parser & validators.
 *
 * Pure-domain tests for `src/lib/domain/chat-assets.ts`. The module
 * parses the leading `--- ... ---` block out of a markdown file and
 * applies per-asset validation rules (agents, prompts, skills) so
 * the T24/T25 contributors and the manifest-consistency test can
 * trust the frontmatter shape on disk.
 *
 * Pattern mirrors `src/lib/catalog.test.ts`: node:test describe/it,
 * node:assert/strict, zero `vscode` or HTTP imports.
 */

import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseFrontmatter,
  validateAgentFrontmatter,
  validatePromptFrontmatter,
  validateSkillFrontmatter,
  type AgentValidationError,
  type FrontmatterParseError,
  type PromptValidationError,
  type SkillValidationError,
} from './domain/chat-assets.js';
import { BUILT_IN_CATALOG } from './domain/catalog.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseFrontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('extracts fields and body from a flat key/value frontmatter', () => {
    const md = [
      '---',
      'name: max-planner',
      "description: 'A read-only planner'",
      '---',
      '',
      'Body line one.',
      'Body line two.',
    ].join('\n');

    const result = parseFrontmatter(md);
    equal(result.kind, 'success');
    if (result.kind !== 'success') return;
    equal(result.fields.name, 'max-planner');
    equal(result.fields.description, 'A read-only planner');
    equal(result.body, 'Body line one.\nBody line two.');
  });

  it("parses flow-array values: tools: ['codebase', 'search']", () => {
    const md = [
      '---',
      'name: max-planner',
      "tools: ['codebase', 'search', 'usages']",
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = parseFrontmatter(md);
    equal(result.kind, 'success');
    if (result.kind !== 'success') return;
    deepStrictEqual(result.fields.tools, ['codebase', 'search', 'usages']);
  });

  it('preserves parens and spaces in display-name values', () => {
    const md = ['---', 'name: max-planner', 'model: M3 (MiniMax)', '---', '', 'Body.'].join('\n');

    const result = parseFrontmatter(md);
    equal(result.kind, 'success');
    if (result.kind !== 'success') return;
    equal(result.fields.model, 'M3 (MiniMax)');
  });

  it('returns a typed error when the closing --- is missing', () => {
    const md = ['---', 'name: max-planner', 'description: no closing fence', '', 'Body.'].join(
      '\n',
    );

    const result = parseFrontmatter(md);
    equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    const codes = result.errors.map((e: FrontmatterParseError) => e.code);
    ok(
      codes.includes('frontmatter-unterminated'),
      `expected unterminated code, got ${codes.join(', ')}`,
    );
  });

  it('returns a typed error when there is no frontmatter at all', () => {
    const result = parseFrontmatter('Just a body, no frontmatter here.');
    equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    const codes = result.errors.map((e: FrontmatterParseError) => e.code);
    ok(codes.includes('frontmatter-missing'), `expected missing code, got ${codes.join(', ')}`);
  });

  it('returns a typed error when the frontmatter block is empty', () => {
    const md = ['---', '---', '', 'Body.'].join('\n');
    const result = parseFrontmatter(md);
    equal(result.kind, 'error');
    if (result.kind !== 'error') return;
    const codes = result.errors.map((e: FrontmatterParseError) => e.code);
    ok(codes.includes('frontmatter-empty'), `expected empty code, got ${codes.join(', ')}`);
  });

  it('ignores a `---` line in the body when a closing fence was already seen', () => {
    const md = ['---', 'name: x', '---', '', 'Body with a --- separator line.', 'Still body.'].join(
      '\n',
    );

    const result = parseFrontmatter(md);
    equal(result.kind, 'success');
    if (result.kind !== 'success') return;
    equal(result.fields.name, 'x');
    ok(result.body.includes('--- separator line'), 'body should contain the inner ---');
    ok(result.body.includes('Still body.'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAgentFrontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('validateAgentFrontmatter', () => {
  it('passes for the canonical max-planner shape', () => {
    const errors = validateAgentFrontmatter({
      name: 'max-planner',
      description: 'A read-only planner running on M3.',
      model: 'M3 (MiniMax)',
      tools: ['codebase', 'search'],
    });
    deepStrictEqual(errors, []);
  });

  it('passes when model is omitted (agent uses the default model)', () => {
    const errors = validateAgentFrontmatter({
      name: 'max-planner',
      description: 'Read-only planner.',
    });
    deepStrictEqual(errors, []);
  });

  it('reports agent-missing-name when name is absent or empty', () => {
    const errors = validateAgentFrontmatter({
      description: 'No name field.',
    });
    ok(
      errors.some((e: AgentValidationError) => e.code === 'agent-missing-name'),
      `expected agent-missing-name, got ${JSON.stringify(errors)}`,
    );
  });

  it('reports agent-missing-description when description is absent or empty', () => {
    const errors = validateAgentFrontmatter({
      name: 'max-planner',
    });
    ok(
      errors.some((e: AgentValidationError) => e.code === 'agent-missing-description'),
      `expected agent-missing-description, got ${JSON.stringify(errors)}`,
    );
  });

  it('reports agent-invalid-tools when tools is a non-array scalar', () => {
    const errors = validateAgentFrontmatter({
      name: 'max-planner',
      description: 'Read-only planner.',
      tools: 'codebase',
    });
    ok(
      errors.some((e: AgentValidationError) => e.code === 'agent-invalid-tools'),
      `expected agent-invalid-tools, got ${JSON.stringify(errors)}`,
    );
  });

  it('reports agent-unknown-model when model is not a known display name', () => {
    const errors = validateAgentFrontmatter({
      name: 'max-planner',
      description: 'Read-only planner.',
      model: 'gpt-9000',
    });
    ok(
      errors.some((e: AgentValidationError) => e.code === 'agent-unknown-model'),
      `expected agent-unknown-model, got ${JSON.stringify(errors)}`,
    );
  });

  it('accepts every display name shipped in BUILT_IN_CATALOG', () => {
    for (const entry of BUILT_IN_CATALOG) {
      const errors = validateAgentFrontmatter({
        name: 'x',
        description: 'd',
        model: entry.displayName,
      });
      deepStrictEqual(errors, [], `display name "${entry.displayName}" should be accepted`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePromptFrontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePromptFrontmatter', () => {
  it('passes for a prompt with description + agent + optional name', () => {
    const errors = validatePromptFrontmatter({
      name: 'review-code',
      description: 'Run a maintainer-level code review.',
      agent: 'max-planner',
    });
    deepStrictEqual(errors, []);
  });

  it('reports prompt-missing-description', () => {
    const errors = validatePromptFrontmatter({ agent: 'max-planner' });
    ok(
      errors.some((e: PromptValidationError) => e.code === 'prompt-missing-description'),
      `expected prompt-missing-description, got ${JSON.stringify(errors)}`,
    );
  });

  it('reports prompt-missing-agent', () => {
    const errors = validatePromptFrontmatter({ description: 'No agent.' });
    ok(
      errors.some((e: PromptValidationError) => e.code === 'prompt-missing-agent'),
      `expected prompt-missing-agent, got ${JSON.stringify(errors)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSkillFrontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSkillFrontmatter', () => {
  it('passes when name matches the parent directory', () => {
    const errors = validateSkillFrontmatter(
      {
        name: 'owasp-top-10-2025',
        description: 'OWASP Top 10 2025 review checklist.',
      },
      'owasp-top-10-2025',
    );
    deepStrictEqual(errors, []);
  });

  it('reports skill-name-mismatch when name differs from dirname', () => {
    const errors = validateSkillFrontmatter(
      {
        name: 'owasp-top-ten',
        description: 'OWASP Top 10 2025 review checklist.',
      },
      'owasp-top-10-2025',
    );
    ok(
      errors.some((e: SkillValidationError) => e.code === 'skill-name-mismatch'),
      `expected skill-name-mismatch, got ${JSON.stringify(errors)}`,
    );
  });

  it('reports skill-missing-name and skill-missing-description', () => {
    const errors = validateSkillFrontmatter({}, 'whatever');
    const codes = errors.map((e: SkillValidationError) => e.code);
    ok(
      codes.includes('skill-missing-name'),
      `expected skill-missing-name, got ${codes.join(', ')}`,
    );
    ok(
      codes.includes('skill-missing-description'),
      `expected skill-missing-description, got ${codes.join(', ')}`,
    );
  });
});
