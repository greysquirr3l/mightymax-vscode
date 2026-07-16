/**
 * T23 — Manifest ↔ disk consistency for bundled chat customizations.
 *
 * Plain Mocha test (no VS Code host required) that walks the on-disk
 * `chat/` tree and the `contributes.{chatAgents,chatPromptFiles,chatSkills}`
 * entries in the real `package.json` and asserts the two are in sync:
 *
 *   (a) every contributed path exists on disk
 *   (b) every `*.agent.md` / `*.prompt.md` / `SKILL.md` under `chat/`
 *       is contributed (no orphans)
 *   (c) every contributed file passes its frontmatter validator
 *
 * This is the test that keeps T24 (max-review agent + review-code prompt)
 * and T25 (12 review skills) honest without re-running plumbing.
 *
 * The test is allowed to import `fs`/`path` because it walks the real
 * repo; it is NOT a domain test. Lives under `src/lib/` so the unit
 * Mocha profile picks it up.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { describe, it } from 'node:test';
import type { FrontmatterValue } from './domain/chat-assets.js';

import {
  parseFrontmatter,
  validateAgentFrontmatter,
  validatePromptFrontmatter,
  validateSkillFrontmatter,
} from './domain/chat-assets.js';

const here = __filename;
const outDir = dirname(here);
const root = join(outDir, '..', '..');
const chatDir = join(root, 'chat');
const packageJsonPath = join(root, 'package.json');

interface PackageJson {
  contributes?: {
    chatAgents?: ReadonlyArray<{ path: string }>;
    chatPromptFiles?: ReadonlyArray<{ path: string }>;
    chatSkills?: ReadonlyArray<{ path: string }>;
  };
}

function* walk(directory: string): Generator<string> {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function toRepoPath(abs: string): string {
  const rel = relative(root, abs).split(sep).join('/');
  // Normalize to the `./` prefix that `contributes` paths carry — deep
  // equality against `package.json` would otherwise see `[chat/agents/x]`
  // vs `[./chat/agents/x]` and trip every "no orphan" assertion.
  return rel.startsWith('./') ? rel : `./${rel}`;
}

function isAgentFile(p: string): boolean {
  return p.endsWith('.agent.md');
}

function isPromptFile(p: string): boolean {
  return p.endsWith('.prompt.md');
}

function isSkillFile(p: string): boolean {
  return basename(p) === 'SKILL.md';
}

describe('chat-asset manifest consistency', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  const contributes = pkg.contributes ?? {};
  const chatAgents = contributes.chatAgents ?? [];
  const chatPromptFiles = contributes.chatPromptFiles ?? [];
  const chatSkills = contributes.chatSkills ?? [];

  it('package.json declares at least one chatAgents entry (T23 ships max-planner)', () => {
    assert.ok(
      chatAgents.length > 0,
      'Expected contributes.chatAgents to be non-empty; T23 ships chat/agents/max-planner.agent.md.',
    );
  });

  it('every contributed path exists on disk', () => {
    const all = [
      ...chatAgents.map((e) => e.path),
      ...chatPromptFiles.map((e) => e.path),
      ...chatSkills.map((e) => e.path),
    ];
    for (const p of all) {
      assert.ok(p && typeof p === 'string', `contributed path must be a non-empty string: ${p}`);
      const abs = join(root, p);
      assert.ok(existsSync(abs), `contributed path missing on disk: ${p}`);
    }
  });

  it('no orphan chat/*.agent.md exists outside the chatAgents list', () => {
    if (!existsSync(join(chatDir, 'agents'))) return;
    const onDisk = [...walk(join(chatDir, 'agents'))].filter(isAgentFile).map(toRepoPath).sort();
    const contributed = [...chatAgents.map((e) => e.path)].sort();
    assert.deepEqual(onDisk, contributed);
  });

  it('no orphan chat/*.prompt.md exists outside the chatPromptFiles list', () => {
    if (!existsSync(join(chatDir, 'prompts'))) return;
    const onDisk = [...walk(join(chatDir, 'prompts'))].filter(isPromptFile).map(toRepoPath).sort();
    const contributed = [...chatPromptFiles.map((e) => e.path)].sort();
    assert.deepEqual(onDisk, contributed);
  });

  it('no orphan chat/*/SKILL.md exists outside the chatSkills list', () => {
    if (!existsSync(join(chatDir, 'skills'))) return;
    const onDisk = [...walk(join(chatDir, 'skills'))].filter(isSkillFile).map(toRepoPath).sort();
    const contributed = [...chatSkills.map((e) => e.path)].sort();
    assert.deepEqual(onDisk, contributed);
  });

  it('every contributed agent file passes validateAgentFrontmatter', () => {
    for (const { path: p } of chatAgents) {
      const md = readFileSync(join(root, p), 'utf8');
      const parsed = parseFrontmatter(md);
      assert.equal(parsed.kind, 'success', `${p}: frontmatter must parse cleanly`);
      if (parsed.kind !== 'success') continue;
      const errors = validateAgentFrontmatter(parsed.fields);
      assert.deepEqual(errors, [], `${p}: ${JSON.stringify(errors)}`);
    }
  });

  it('every contributed prompt file passes validatePromptFrontmatter', () => {
    for (const { path: p } of chatPromptFiles) {
      const md = readFileSync(join(root, p), 'utf8');
      const parsed = parseFrontmatter(md);
      assert.equal(parsed.kind, 'success', `${p}: frontmatter must parse cleanly`);
      if (parsed.kind !== 'success') continue;
      const errors = validatePromptFrontmatter(parsed.fields);
      assert.deepEqual(errors, [], `${p}: ${JSON.stringify(errors)}`);
    }
  });

  it('every contributed skill file passes validateSkillFrontmatter (name === dirname)', () => {
    for (const { path: p } of chatSkills) {
      const md = readFileSync(join(root, p), 'utf8');
      const parsed = parseFrontmatter(md);
      assert.equal(parsed.kind, 'success', `${p}: frontmatter must parse cleanly`);
      if (parsed.kind !== 'success') continue;
      const dir = basename(dirname(join(root, p)));
      const errors = validateSkillFrontmatter(parsed.fields, dir);
      assert.deepEqual(errors, [], `${p}: ${JSON.stringify(errors)}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T24 — max-review agent + /review-code prompt
//
// Behavior-level invariants the agent body MUST hold. The general
// manifest consistency block above already proves the files exist,
// frontmatter parses, and validators accept them; this block pins
// behavior that the validators intentionally do not see — model
// pinning, read-only tool set, body word-count ceiling, and the
// verbatim dispatch table referencing every T25 skill by name.
// ─────────────────────────────────────────────────────────────────────────────

const TWELVE_SKILL_NAMES: ReadonlyArray<string> = [
  'code-review-dotnet',
  'code-review-rust',
  'code-review-go',
  'code-review-typescript',
  'code-review-python',
  'code-review-kotlin',
  'code-review-swift',
  'code-review-powershell',
  'code-review-bash',
  'code-review-github-actions',
  'owasp-top-10-2025',
  'owasp-api-security-2023',
];

// Canonical VS Code agent-file tool ids for the dangerous surfaces. The
// T23 domain module intentionally does NOT cross-check tool ids (extension
// and MCP tools are allowed), so this list is the only thing standing
// between a reviewer that reads and one that silently rewrites code.
// Source: VS Code 1.111+ agent-file editor canonical names; pinned here
// because the agent's frontmatter is the single source of truth.
const FORBIDDEN_EDIT_TOOL_IDS: ReadonlyArray<string> = ['edit', 'applyPatch'];
const FORBIDDEN_TERMINAL_TOOL_IDS: ReadonlyArray<string> = ['runCommands', 'runInTerminal'];

const MAX_REVIEW_AGENT_PATH = 'chat/agents/max-review.agent.md';
const REVIEW_CODE_PROMPT_PATH = 'chat/prompts/review-code.prompt.md';
const MAX_REVIEW_BODY_WORD_CEILING = 2_500;

function countWords(body: string): number {
  // Plain whitespace split; the body is natural-language prose, so
  // markdown punctuation and code-fence tokens count as words. That
  // gives a generous upper bound — the ceiling is generous on purpose.
  return body.split(/\s+/).filter((w) => w.length > 0).length;
}

function loadAgent(repoPath: string): {
  fields: Readonly<Record<string, FrontmatterValue>>;
  body: string;
} {
  const md = readFileSync(join(root, repoPath), 'utf8');
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.kind, 'success', `${repoPath}: frontmatter must parse cleanly`);
  if (parsed.kind !== 'success') throw new Error(`unreachable: ${repoPath} did not parse`);
  return { fields: parsed.fields, body: parsed.body };
}

function loadPromptFields(repoPath: string): Readonly<Record<string, FrontmatterValue>> {
  const md = readFileSync(join(root, repoPath), 'utf8');
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.kind, 'success', `${repoPath}: frontmatter must parse cleanly`);
  if (parsed.kind !== 'success') throw new Error(`unreachable: ${repoPath} did not parse`);
  return parsed.fields;
}

describe('T24 — max-review agent + /review-code prompt', () => {
  const maxReview = existsSync(join(root, MAX_REVIEW_AGENT_PATH))
    ? loadAgent(MAX_REVIEW_AGENT_PATH)
    : undefined;
  const reviewCode = existsSync(join(root, REVIEW_CODE_PROMPT_PATH))
    ? loadPromptFields(REVIEW_CODE_PROMPT_PATH)
    : undefined;

  it('chat/agents/max-review.agent.md exists and passes validateAgentFrontmatter', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    const errors = validateAgentFrontmatter(maxReview.fields);
    assert.deepEqual(errors, [], `${MAX_REVIEW_AGENT_PATH}: ${JSON.stringify(errors)}`);
  });

  it('max-review is model-pinned to M3 (MiniMax) — the catalog display name', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    assert.equal(
      maxReview.fields.model,
      'M3 (MiniMax)',
      'max-review must be pinned to the M3 (MiniMax) catalog display name',
    );
  });

  it('max-review.tools is an array', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    assert.ok(Array.isArray(maxReview.fields.tools), 'max-review.tools must be a flow array');
  });

  it('max-review.tools excludes the forbidden edit tool ids (read-only guarantee)', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    const tools = maxReview.fields.tools;
    assert.ok(Array.isArray(tools), 'max-review.tools must be a flow array');
    for (const forbidden of FORBIDDEN_EDIT_TOOL_IDS) {
      assert.ok(
        !(tools as ReadonlyArray<string>).includes(forbidden),
        `max-review.tools must NOT include the edit tool id \`${forbidden}\`; a reviewer that rewrites code mid-review is a footgun`,
      );
    }
  });

  it('max-review.tools excludes the forbidden terminal tool ids (read-only guarantee)', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    const tools = maxReview.fields.tools;
    assert.ok(Array.isArray(tools), 'max-review.tools must be a flow array');
    for (const forbidden of FORBIDDEN_TERMINAL_TOOL_IDS) {
      assert.ok(
        !(tools as ReadonlyArray<string>).includes(forbidden),
        `max-review.tools must NOT include the terminal tool id \`${forbidden}\`; a reviewer that runs commands mid-review is a footgun`,
      );
    }
  });

  it(`max-review body word count is <= ${MAX_REVIEW_BODY_WORD_CEILING} (token wire budget)`, () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    const words = countWords(maxReview.body);
    assert.ok(
      words <= MAX_REVIEW_BODY_WORD_CEILING,
      `max-review body has ${words} words; the budget ceiling is ${MAX_REVIEW_BODY_WORD_CEILING}. Depth belongs in skills, not the agent body.`,
    );
  });

  it('max-review body names every T25 skill verbatim in the dispatch table', () => {
    assert.ok(maxReview, `${MAX_REVIEW_AGENT_PATH} must exist on disk`);
    for (const skill of TWELVE_SKILL_NAMES) {
      assert.ok(
        maxReview.body.includes(skill),
        `max-review body must reference skill \`${skill}\` verbatim (dispatch table); otherwise the loader cannot trigger it`,
      );
    }
  });

  it('chat/prompts/review-code.prompt.md exists and passes validatePromptFrontmatter', () => {
    assert.ok(reviewCode, `${REVIEW_CODE_PROMPT_PATH} must exist on disk`);
    const errors = validatePromptFrontmatter(reviewCode);
    assert.deepEqual(errors, [], `${REVIEW_CODE_PROMPT_PATH}: ${JSON.stringify(errors)}`);
  });

  it('/review-code prompt is wired to the max-review agent', () => {
    assert.ok(reviewCode, `${REVIEW_CODE_PROMPT_PATH} must exist on disk`);
    assert.equal(
      reviewCode.agent,
      'max-review',
      '/review-code must delegate to the `max-review` agent',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T25 — 12 domain review skills
//
// Pin the structural contract for the bundled review-skill corpus. The
// general manifest-consistency block above already proves each file
// exists and the per-asset validator accepts it; this block pins the
// shape that makes the corpus actually useful — exact directory count
// (no orphan dirs sneaking in), "Use when" retrieval-key signal in
// every description, and the OWASP IDs (A01..A10 / API1..API10) that
// the cross-link header in `max-review` advertises to the model.
// ─────────────────────────────────────────────────────────────────────────────

const EXPECTED_SKILL_DIRS: ReadonlyArray<string> = [
  'code-review-dotnet',
  'code-review-rust',
  'code-review-go',
  'code-review-typescript',
  'code-review-python',
  'code-review-kotlin',
  'code-review-swift',
  'code-review-powershell',
  'code-review-bash',
  'code-review-github-actions',
  'owasp-top-10-2025',
  'owasp-api-security-2023',
];

const SKILLS_ROOT = join(root, 'chat', 'skills');

// Re-read the manifest here: the chatSkills array is captured inside the
// first describe block's closure, so the T25 block — which is declared
// after it — needs its own local view to assert against.
const T25_PKG = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
const T25_CHAT_SKILLS = T25_PKG.contributes?.chatSkills ?? [];

function listSkillDirs(): string[] {
  if (!existsSync(SKILLS_ROOT)) return [];
  return readdirSync(SKILLS_ROOT)
    .filter((entry) => statSync(join(SKILLS_ROOT, entry)).isDirectory())
    .sort();
}

function loadSkill(dirName: string): {
  fields: Readonly<Record<string, FrontmatterValue>>;
  body: string;
} {
  const md = readFileSync(join(SKILLS_ROOT, dirName, 'SKILL.md'), 'utf8');
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.kind, 'success', `${dirName}/SKILL.md: frontmatter must parse cleanly`);
  if (parsed.kind !== 'success') throw new Error(`unreachable: ${dirName}/SKILL.md did not parse`);
  return { fields: parsed.fields, body: parsed.body };
}

describe('T25 — 12 domain review skills', () => {
  it('chat/skills/ contains exactly the 12 expected skill directories (no orphans, no missing)', () => {
    const onDisk = listSkillDirs();
    assert.deepEqual(
      onDisk,
      [...EXPECTED_SKILL_DIRS].sort(),
      `chat/skills/ must contain exactly the 12 frozen skill directories; got ${JSON.stringify(onDisk)}`,
    );
  });

  it('every skill file parses cleanly and passes validateSkillFrontmatter', () => {
    for (const dir of EXPECTED_SKILL_DIRS) {
      const { fields } = loadSkill(dir);
      const errors = validateSkillFrontmatter(fields, dir);
      assert.deepEqual(errors, [], `${dir}/SKILL.md: ${JSON.stringify(errors)}`);
    }
  });

  it('every skill description contains the literal substring "Use when" (retrieval-key signal)', () => {
    for (const dir of EXPECTED_SKILL_DIRS) {
      const { fields } = loadSkill(dir);
      const description = stringFieldValue(fields.description);
      assert.ok(description, `${dir}/SKILL.md: description must be a non-empty string`);
      assert.ok(
        description.includes('Use when'),
        `${dir}/SKILL.md: description must contain "Use when" (loader matches on it) — got: ${description}`,
      );
    }
  });

  it('owasp-top-10-2025 body contains every ID A01..A10 (no false positives on A1)', () => {
    const { body } = loadSkill('owasp-top-10-2025');
    for (const id of ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10']) {
      assert.ok(
        body.includes(id),
        `owasp-top-10-2025/SKILL.md must reference ${id}; the dispatch table advertises it to the model`,
      );
    }
  });

  it('owasp-api-security-2023 body contains every ID API1..API10', () => {
    const { body } = loadSkill('owasp-api-security-2023');
    for (const id of [
      'API1',
      'API2',
      'API3',
      'API4',
      'API5',
      'API6',
      'API7',
      'API8',
      'API9',
      'API10',
    ]) {
      assert.ok(
        body.includes(id),
        `owasp-api-security-2023/SKILL.md must reference ${id}; the dispatch table advertises it to the model`,
      );
    }
  });

  it('every expected skill is registered in contributes.chatSkills (no missing, no orphan paths)', () => {
    const contributed = T25_CHAT_SKILLS.map((e: { path: string }) => e.path).sort();
    const expected = EXPECTED_SKILL_DIRS.map((d) => `./chat/skills/${d}/SKILL.md`).sort();
    assert.deepEqual(
      contributed,
      expected,
      `contributes.chatSkills must list exactly the 12 expected paths; got ${JSON.stringify(contributed)}`,
    );
  });
});

// `FrontmatterValue` is a string-or-array union; only string values are
// valid for `description`. Centralize the narrowing so the "Use when"
// test reads naturally.
function stringFieldValue(v: FrontmatterValue | undefined): string | undefined {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}
