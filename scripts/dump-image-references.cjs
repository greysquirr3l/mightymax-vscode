#!/usr/bin/env node
'use strict';

/**
 * List every image file under `tmp/` (recursively) so the agent
 * (or the user, at session start) can see what visual references
 * are available without scanning the scratch directory by hand.
 *
 * Sorts by mtime descending (newest first) and de-duplicates by
 * absolute path. Image extensions are the same set the T04 mapper
 * accepts (png, jpg, jpeg, gif, webp). Unknown extensions are
 * silently skipped — the helper is about *visual* references, not
 * arbitrary attachments.
 *
 * Usage:
 *   node scripts/dump-image-references.cjs
 *   node scripts/dump-image-references.cjs --json   # machine-readable
 *
 * Exit codes:
 *   0 — success (even when no images are found; an empty list is
 *       a valid state)
 *   1 — `tmp/` does not exist at the repo root (cwd or one up)
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT_CANDIDATES = [process.cwd(), path.resolve(__dirname, '..')];

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function findTmpRoot() {
  for (const candidate of REPO_ROOT_CANDIDATES) {
    const tmp = path.join(candidate, 'tmp');
    if (fs.existsSync(tmp) && fs.statSync(tmp).isDirectory()) {
      return { repoRoot: candidate, tmpDir: tmp };
    }
  }
  return null;
}

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTS.has(ext)) acc.push(full);
    }
  }
  return acc;
}

const args = new Set(process.argv.slice(2));
const wantJson = args.has('--json');

const found = findTmpRoot();
if (!found) {
  if (wantJson) {
    console.log(JSON.stringify({ error: 'tmp/ not found' }));
  } else {
    console.error('tmp/ not found at the repo root — create it or run from inside the project.');
  }
  process.exit(1);
}

const files = walk(found.tmpDir, []);
const withStat = files.map((file) => {
  const stat = fs.statSync(file);
  return { file, mtimeMs: stat.mtimeMs };
});
withStat.sort((a, b) => b.mtimeMs - a.mtimeMs);

if (wantJson) {
  console.log(
    JSON.stringify(
      withStat.map(({ file, mtimeMs }) => ({
        path: file,
        mtime: new Date(mtimeMs).toISOString(),
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

if (withStat.length === 0) {
  console.log(`(no images under ${found.tmpDir})`);
  process.exit(0);
}

console.log(`Found ${String(withStat.length)} image(s) under tmp/:\n`);
for (const { file, mtimeMs } of withStat) {
  const rel = path.relative(found.repoRoot, file);
  const iso = new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ');
  console.log(`  ${iso}  ${rel}`);
}
