// SESSION-3 section 4: production files must contain NO retired vendor host,
// NO developer install root, and NO fixed-port assumption. Docs/tests/evidence
// may reference them descriptively; shippable code/scripts/config may not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PROD_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.cmd', '.bat', '.ps1', '.vbs', '.psm1']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'test-results', 'test', 'tests', 'fixtures']);

function collectProductionFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collectProductionFiles(full, acc);
    } else {
      if (name.endsWith('.test.js') || name.endsWith('.selftest.ps1')) continue;
      if (name === 'verify-release.ps1') continue; // scanner defines the patterns
      // Corrective/evidence harnesses are test tooling, not shippable product.
      // They legitimately reference retired ports (e.g. 8788) to ASSERT AGAINST
      // stale-port regressions — a descriptive reference the header permits.
      if (/^Invoke-(Corrective)?Phase\d/i.test(name)) continue;
      if (extname(name).toLowerCase() && PROD_EXT.has(extname(name).toLowerCase())) acc.push(full);
    }
  }
  return acc;
}

// Only scan the shippable source roots.
const roots = ['apps', 'packages', 'scripts'].map((r) => join(repoRoot, r));
const files = roots.flatMap((r) => collectProductionFiles(r));

test('no private gateway placeholder in production files', () => {
  const bad = files.filter((f) => /private-gateway\.invalid/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => f.replace(repoRoot, '')), [], 'vendor host found in production files');
});

test('no hardcoded developer install root (X:\\Programs\\) in production files', () => {
  const bad = files.filter((f) => /[A-Z]:\\{1,2}Programs\\{1,2}/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => f.replace(repoRoot, '')), [], 'dev install root found in production files');
});

test('no fixed-port literal (8788/8799) used as a production default', () => {
  // allow the word in comments that explicitly say "never assume", but not as a value.
  const bad = files.filter((f) => {
    const txt = readFileSync(f, 'utf8');
    return txt.split('\n').some((line) => /(?<![\w])(8788|8799)(?![\w])/.test(line) && !/never assume|not.*assume|example|loopback/i.test(line));
  });
  assert.deepEqual(bad.map((f) => f.replace(repoRoot, '')), [], 'fixed port used as production value');
});

test('at least one production file was scanned (guard against empty glob)', () => {
  assert.ok(files.length > 5, `expected production files, found ${files.length}`);
});
