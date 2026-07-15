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
  return relative(root, abs).split(sep).join('/');
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
