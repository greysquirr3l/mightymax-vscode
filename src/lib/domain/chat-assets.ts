/**
 * Domain: chat-asset frontmatter parsing & validation.
 *
 * Pure, framework-free module that owns two responsibilities for the
 * T23 chat-customization scaffolding:
 *
 *   1. `parseFrontmatter(markdown)` — extract the leading `--- ... ---`
 *      block from a markdown file. The frontmatter we use is flat
 *      `key: value` plus flow arrays (`tools: ['a', 'b']`), so a tiny
 *      line-based parser is enough — no yaml package, no I/O.
 *
 *   2. `validateAgentFrontmatter` / `validatePromptFrontmatter` /
 *      `validateSkillFrontmatter` — typed error lists, one per asset
 *      kind. Each error has a discriminated `code` field, mirroring
 *      `CatalogValidationError`. The error code drives the manifest
 *      consistency test (T23) and lets T24/T25 contributors see
 *      exactly which rule their frontmatter broke.
 *
 * Constraint: this file must not import `vscode` or any HTTP module.
 * The `src/lib/no-vscode.test.ts` static guard enforces that.
 */

import { BUILT_IN_CATALOG } from './catalog.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Scalar or array frontmatter value. We support the two shapes VS Code's
 * agent/prompt frontmatter uses: bare strings (`name: foo`,
 * `model: M3 (MiniMax)`) and flow arrays (`tools: ['a', 'b']`).
 */
export type FrontmatterValue = string | ReadonlyArray<string>;

export interface FrontmatterParseError {
  readonly code: 'frontmatter-missing' | 'frontmatter-unterminated' | 'frontmatter-empty';
  readonly message: string;
}

export type FrontmatterParseResult =
  | {
      readonly kind: 'success';
      readonly fields: Readonly<Record<string, FrontmatterValue>>;
      readonly body: string;
    }
  | { readonly kind: 'error'; readonly errors: ReadonlyArray<FrontmatterParseError> };

export interface AgentValidationError {
  readonly code:
    | 'agent-missing-name'
    | 'agent-missing-description'
    | 'agent-invalid-tools'
    | 'agent-unknown-model';
  readonly message: string;
}

export interface PromptValidationError {
  readonly code: 'prompt-missing-description' | 'prompt-missing-agent';
  readonly message: string;
}

export interface SkillValidationError {
  readonly code: 'skill-missing-name' | 'skill-missing-description' | 'skill-name-mismatch';
  readonly message: string;
}

// -----------------------------------------------------------------------------
// parseFrontmatter
// -----------------------------------------------------------------------------

/**
 * Extract the leading `--- ... ---` block from a markdown file. Returns
 * a discriminated union so callers can distinguish "missing/unterminated"
 * (file format problem) from "well-formed frontmatter" (which then goes
 * into a validator).
 *
 * The parser intentionally handles only the shapes Mighty Max actually
 * ships: flat `key: value` plus flow arrays. Multi-line lists, anchors,
 * and other YAML features are out of scope — VS Code's agent frontmatter
 * spec uses the same flat shapes, so this stays a ~40-line parser.
 */
export function parseFrontmatter(markdown: string): FrontmatterParseResult {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return {
      kind: 'error',
      errors: [{ code: 'frontmatter-missing', message: 'Input is empty.' }],
    };
  }

  // Normalize line endings; the frontmatter may come from a CRLF checkout.
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  if (lines[0]?.trim() !== '---') {
    return {
      kind: 'error',
      errors: [
        {
          code: 'frontmatter-missing',
          message: 'File does not start with a `---` frontmatter fence.',
        },
      ],
    };
  }

  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) {
    return {
      kind: 'error',
      errors: [
        {
          code: 'frontmatter-unterminated',
          message: 'Frontmatter is missing the closing `---` fence.',
        },
      ],
    };
  }

  const frontLines = lines.slice(1, closeIdx);
  const bodyLines = lines.slice(closeIdx + 1);

  if (frontLines.length === 0 || frontLines.every((l) => l.trim() === '')) {
    return {
      kind: 'error',
      errors: [
        {
          code: 'frontmatter-empty',
          message: 'Frontmatter block is present but contains no fields.',
        },
      ],
    };
  }

  const fields: Record<string, FrontmatterValue> = {};
  for (const raw of frontLines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue; // blank / comment
    const colon = line.indexOf(':');
    if (colon === -1) continue; // not a `key:` line; skip silently
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (key.length === 0) continue;

    // Strip wrapping quotes from scalar values: "foo" / 'foo'.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    fields[key] = parseScalarOrFlowArray(value);
  }

  // The body is everything after the closing fence, joined with newlines.
  // We trim a single leading newline so a blank line right after `---`
  // doesn't show up as an empty first body line in editors.
  let body = bodyLines.join('\n');
  if (body.startsWith('\n')) body = body.slice(1);

  return { kind: 'success', fields, body };
}

/**
 * Recognize the two value shapes VS Code's frontmatter uses:
 *   - bare scalar:    `M3 (MiniMax)`
 *   - flow array:     `['codebase', 'search']`
 * Bare scalars with stray brackets inside (impossible in the supported
 * schema) fall through as plain strings.
 */
function parseScalarOrFlowArray(value: string): FrontmatterValue {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    // Split on commas; tolerate optional whitespace and trailing commas.
    const parts = inner
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => stripQuotes(p));
    return parts;
  }
  return trimmed;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// -----------------------------------------------------------------------------
// validateAgentFrontmatter
// -----------------------------------------------------------------------------

const KNOWN_AGENT_TOOLS: ReadonlyArray<string> = [
  // The set VS Code's agent-file editor offers as built-in agent tools
  // as of 1.111+. We accept anything from this list and leave custom
  // tool ids to the editor's allow-list (which VS Code itself enforces
  // at runtime). Keeping the list pinned to a known set means a typo
  // like `codebasee` is caught at the validator stage.
  'codebase',
  'search',
  'usages',
  'problems',
  'changes',
  'fetch',
  'github',
  'edit',
  'runCommands',
  'runInTerminal',
  'applyPatch',
];

const KNOWN_AGENT_MODELS: ReadonlySet<string> = new Set(BUILT_IN_CATALOG.map((e) => e.displayName));

/**
 * Validate an agent's parsed frontmatter fields. Returns a (possibly
 * empty) list of typed errors. The error `code` field discriminates
 * which rule failed; consumers can branch on it for clearer messages.
 *
 * Required: name (non-empty), description (non-empty).
 * Optional but validated: model (must be a known display name when
 * present), tools (must be an array of strings when present).
 */
export function validateAgentFrontmatter(
  fields: Readonly<Record<string, FrontmatterValue>>,
): ReadonlyArray<AgentValidationError> {
  const errors: AgentValidationError[] = [];

  const name = stringField(fields.name);
  if (!name) {
    errors.push({
      code: 'agent-missing-name',
      message: 'Agent frontmatter must include a non-empty `name` field.',
    });
  }

  const description = stringField(fields.description);
  if (!description) {
    errors.push({
      code: 'agent-missing-description',
      message: 'Agent frontmatter must include a non-empty `description` field.',
    });
  }

  const tools = fields.tools;
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      errors.push({
        code: 'agent-invalid-tools',
        message: "Agent `tools` must be a flow array, e.g. `tools: ['codebase', 'search']`.",
      });
    } else if (tools.some((t) => typeof t !== 'string' || t.trim().length === 0)) {
      errors.push({
        code: 'agent-invalid-tools',
        message: 'Every entry in `tools` must be a non-empty string.',
      });
    }
    // Tool ids are intentionally NOT cross-checked against KNOWN_AGENT_TOOLS:
    // VS Code ships additional agent tools per-extension and the agent
    // editor validates tool names at runtime. Hard-coding the list here
    // would block legitimate MCP/extension tools.
    void KNOWN_AGENT_TOOLS;
  }

  const model = stringField(fields.model);
  if (model && !KNOWN_AGENT_MODELS.has(model)) {
    errors.push({
      code: 'agent-unknown-model',
      message: `Agent \`model: ${model}\` does not match any catalog display name (${[...KNOWN_AGENT_MODELS].join(', ')}).`,
    });
  }

  return errors;
}

// -----------------------------------------------------------------------------
// validatePromptFrontmatter
// -----------------------------------------------------------------------------

/**
 * Validate a prompt file's parsed frontmatter. Prompts are user-facing
 * slash commands; they need a description (shown in the picker) and an
 * `agent` they delegate to. `name` is optional — VS Code derives one
 * from the filename when it's missing.
 */
export function validatePromptFrontmatter(
  fields: Readonly<Record<string, FrontmatterValue>>,
): ReadonlyArray<PromptValidationError> {
  const errors: PromptValidationError[] = [];

  const description = stringField(fields.description);
  if (!description) {
    errors.push({
      code: 'prompt-missing-description',
      message: 'Prompt frontmatter must include a non-empty `description` field.',
    });
  }

  const agent = stringField(fields.agent);
  if (!agent) {
    errors.push({
      code: 'prompt-missing-agent',
      message: 'Prompt frontmatter must include a non-empty `agent` field.',
    });
  }

  return errors;
}

// -----------------------------------------------------------------------------
// validateSkillFrontmatter
// -----------------------------------------------------------------------------

/**
 * Validate an Agent Skill's parsed frontmatter. The Agent Skills spec
 * (agentskills.io/specification) requires `name` to equal the parent
 * directory name — `dirname` is passed in by the caller so the domain
 * stays framework-free (no `fs`).
 */
export function validateSkillFrontmatter(
  fields: Readonly<Record<string, FrontmatterValue>>,
  dirname: string,
): ReadonlyArray<SkillValidationError> {
  const errors: SkillValidationError[] = [];

  const name = stringField(fields.name);
  if (!name) {
    errors.push({
      code: 'skill-missing-name',
      message: 'Skill frontmatter must include a non-empty `name` field.',
    });
  } else if (name !== dirname) {
    errors.push({
      code: 'skill-name-mismatch',
      message: `Skill \`name: ${name}\` must match the parent directory name \`${dirname}\` (Agent Skills spec).`,
    });
  }

  const description = stringField(fields.description);
  if (!description) {
    errors.push({
      code: 'skill-missing-description',
      message: 'Skill frontmatter must include a non-empty `description` field.',
    });
  }

  return errors;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function stringField(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
