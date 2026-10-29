/**
 * Manifest ↔ constants ↔ README consistency.
 *
 * Three surfaces declare the same defaults: the `contributes.configuration`
 * block in `package.json` (what VS Code's Settings UI shows and what the
 * host hands the provider), the compiled domain constants (what the code
 * falls back to when the host exposes no settings API), and the settings
 * table in `README.md` (what a user reads before installing).
 *
 * They drifted. `mightyMax.maxTools` was 64 in the manifest and the
 * domain constant but 60 in the provider's fallback; `alwaysIncludeTools`
 * was a 13-entry list in the manifest and the constant but a 6-entry
 * list in the README. A user reading the README would have set a value
 * that silently did nothing.
 *
 * This test is the guard: it fails when any surface disagrees with any
 * other, and when a setting exists in the manifest but is undocumented.
 *
 * Reads the real repo, so it is NOT a domain test — but it imports no
 * `vscode`, so it runs in the plain-Node unit runner.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, it } from 'node:test';

import {
  DEFAULT_ALWAYS_INCLUDE_TOOLS,
  DEFAULT_ENABLE_SMART_TOOL_FILTERING,
  DEFAULT_MAX_TOOLS,
  DEFAULT_MCP_MAX_TOOLS,
} from './domain/tool-filter.js';

const here = __filename;
const outDir = dirname(here);
const root = join(outDir, '..', '..');
const packageJsonPath = join(root, 'package.json');
const readmePath = join(root, 'README.md');

interface SettingDeclaration {
  type?: string;
  default?: unknown;
  scope?: string;
}

interface PackageJson {
  version?: string;
  engines?: { vscode?: string };
  contributes?: {
    configuration?: {
      properties?: Record<string, SettingDeclaration>;
    };
  };
}

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
const settings = pkg.contributes?.configuration?.properties ?? {};

/**
 * Parse the README's settings table. Rows look like:
 *
 *   | `mightyMax.baseUrl` | application | `https://api.minimax.io` | … |
 *
 * The default cell is a backticked literal. An array default is
 * backticked as a whole (`["a", "b"]`), so the regex has to capture
 * greedily up to the closing backtick.
 */
function readReadmeSettings(): Map<string, { scope: string; default: string }> {
  const readme = readFileSync(readmePath, 'utf8');
  const row = /^\|\s*`(mightyMax\.[A-Za-z0-9_.]+)`\s*\|\s*([a-z]+)\s*\|\s*`([^`]*)`\s*\|/gm;
  const found = new Map<string, { scope: string; default: string }>();
  for (const m of readme.matchAll(row)) {
    const key = m[1];
    const scope = m[2];
    const def = m[3];
    if (key !== undefined && scope !== undefined && def !== undefined) {
      found.set(key, { scope, default: def });
    }
  }
  return found;
}

describe('manifest defaults', () => {
  it('declares the same tool cap as the compiled constant', () => {
    // A mismatch means the provider's fallback (used when the host
    // exposes no settings API) silently disagrees with the manifest.
    assert.equal(settings['mightyMax.maxTools']?.default, DEFAULT_MAX_TOOLS);
    assert.equal(settings['mightyMax.mcpMaxTools']?.default, DEFAULT_MCP_MAX_TOOLS);
    assert.equal(
      settings['mightyMax.enableSmartToolFiltering']?.default,
      DEFAULT_ENABLE_SMART_TOOL_FILTERING,
    );
  });

  it('declares the same always-include pin list as the compiled constant', () => {
    assert.deepEqual(settings['mightyMax.alwaysIncludeTools']?.default, [
      ...DEFAULT_ALWAYS_INCLUDE_TOOLS,
    ]);
  });
});

describe('README settings table', () => {
  const documented = readReadmeSettings();

  it('documents every setting the manifest declares', () => {
    const missing = Object.keys(settings).filter((key) => !documented.has(key));
    assert.deepEqual(
      missing,
      [],
      `undocumented settings (a setting with no README entry is a setting a user cannot discover): ${missing.join(', ')}`,
    );
  });

  it('documents no setting the manifest does not declare', () => {
    const extra = [...documented.keys()].filter((key) => settings[key] === undefined);
    assert.deepEqual(
      extra,
      [],
      `README documents settings that are not in the manifest: ${extra.join(', ')}`,
    );
  });

  it('gives every setting the same default as the manifest', () => {
    const wrong: string[] = [];
    for (const [key, row] of documented) {
      const declared = settings[key]?.default;
      if (declared === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.default);
      } catch {
        parsed = row.default;
      }
      if (JSON.stringify(parsed) !== JSON.stringify(declared)) {
        wrong.push(
          `${key}: README says ${row.default}, manifest says ${JSON.stringify(declared)}`,
        );
      }
    }
    assert.deepEqual(wrong, [], `README defaults disagree with the manifest:\n${wrong.join('\n')}`);
  });

  it('gives every setting the same scope as the manifest', () => {
    const wrong: string[] = [];
    for (const [key, row] of documented) {
      const declared = settings[key]?.scope ?? 'window';
      if (declared !== row.scope) {
        wrong.push(`${key}: README says ${row.scope}, manifest says ${declared}`);
      }
    }
    assert.deepEqual(wrong, [], `README scopes disagree with the manifest:\n${wrong.join('\n')}`);
  });
});

describe('README engine floor', () => {
  it('states the same VS Code floor as the manifest', () => {
    const range = pkg.engines?.vscode;
    assert.ok(range, 'engines.vscode is missing from the manifest');
    const match = /(\d+)\.(\d+)/.exec(range);
    assert.ok(match, `engines.vscode is not a valid range: ${range}`);
    const floor = `${match[1]}.${match[2]}`;

    const readme = readFileSync(readmePath, 'utf8');
    // The README states the floor twice: in the Requirements list
    // ("VS Code 1.125 or later") and in the install step ("version
    // 1.125 or later").
    const stated = [...readme.matchAll(/(?:VS Code|version) (\d+\.\d+) or later/g)].map(
      (m) => m[1],
    );
    const floorNote = [...readme.matchAll(/engine floor \((\d+\.\d+)\)/g)].map((m) => m[1]);

    assert.deepEqual(
      stated,
      [floor, floor],
      `README states a VS Code floor of ${stated.join(', ')} but the manifest declares ${range}`,
    );
    assert.deepEqual(
      floorNote,
      [floor],
      `README's engine-floor note says ${floorNote.join(', ')} but the manifest declares ${range}`,
    );
  });
});
