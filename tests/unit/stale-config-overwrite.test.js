// FIX 1(b): a pre-existing stale config-library file (e.g. from a prior launch
// carrying the retired fixed port) must never linger. createProductionWorkspace
// generates a FRESH configurationId each launch; without purging, an old
// configLibrary/<old-uuid>.json with a stale inferenceGatewayBaseUrl remains on
// disk. The client's _meta.appliedId points at the fresh config, but a stale
// file is a latent footgun. This suite pins:
//   1. createProductionWorkspace removes OTHER config-library configs so only the
//      freshly written config (+ its manifest + _meta) remain.
//   2. _meta.appliedId points at the freshly written config using the LIVE port.
//   3. A stale config carrying the retired 8788 port does not survive.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionWorkspace } from '../../packages/identity-harness/src/index.js';

const TOKEN = 'ephemeral-loopback-token-TEST-stale-0001';
const MODELS = [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }];

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-stale-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Seed a stale config-library entry as if a prior launch wrote the retired
// fixed port 8788 under a different configurationId.
async function seedStaleConfig(userDataRoot) {
  const library = path.join(userDataRoot, 'configLibrary');
  await mkdir(library, { recursive: true });
  const staleId = '11111111-1111-4111-8111-111111111111';
  const staleConfigPath = path.join(library, `${staleId}.json`);
  await writeFile(
    staleConfigPath,
    JSON.stringify({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'http://127.0.0.1:8788',
      inferenceGatewayApiKey: 'STALE-TOKEN',
      inferenceModels: [{ name: 'claude-old', labelOverride: 'Old' }],
    }, null, 2),
  );
  // A stale _meta.json pointing appliedId at the old config.
  await writeFile(
    path.join(library, '_meta.json'),
    JSON.stringify({ appliedId: staleId, entries: [{ id: staleId, name: 'Old Profile' }] }, null, 2),
  );
  return { staleId, staleConfigPath };
}

test('purges a pre-existing stale config so the retired 8788 port cannot linger', async (t) => {
  const root = await tempDir(t);
  const userDataRoot = path.join(root, 'profile');
  const { staleConfigPath } = await seedStaleConfig(userDataRoot);

  const result = await createProductionWorkspace({
    harnessRoot: root,
    userDataRoot,
    loopbackBaseUrl: 'http://127.0.0.1:49876',
    ephemeralToken: TOKEN,
    models: MODELS,
    preferences: { deploymentMode: '3p' },
    configName: 'Claude Open',
  });

  // The fresh config uses the LIVE port.
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  assert.equal(config.inferenceGatewayBaseUrl, 'http://127.0.0.1:49876');

  // The stale file is gone.
  await assert.rejects(readFile(staleConfigPath, 'utf8'), /ENOENT/, 'stale config must be deleted');

  // No lingering *.json config carries the retired port.
  const library = path.join(userDataRoot, 'configLibrary');
  const names = await readdir(library);
  for (const name of names) {
    if (!name.endsWith('.json') || name === '_meta.json' || name.endsWith('.manifest.json')) continue;
    const txt = await readFile(path.join(library, name), 'utf8');
    assert.ok(!txt.includes('8788'), `config ${name} must not contain the retired 8788 port`);
  }

  // Only the freshly written configuration remains among config-library configs.
  const configJsons = names.filter(
    (n) => n.endsWith('.json') && n !== '_meta.json' && !n.endsWith('.manifest.json'),
  );
  assert.deepEqual(configJsons, [`${result.configurationId}.json`], 'only the fresh config remains');
});

test('_meta.appliedId points at the freshly written config (not the stale one)', async (t) => {
  const root = await tempDir(t);
  const userDataRoot = path.join(root, 'profile');
  const { staleId } = await seedStaleConfig(userDataRoot);

  const result = await createProductionWorkspace({
    harnessRoot: root,
    userDataRoot,
    loopbackBaseUrl: 'http://127.0.0.1:49876',
    ephemeralToken: TOKEN,
    models: MODELS,
    preferences: { deploymentMode: '3p' },
    configName: 'Claude Open',
  });

  const meta = JSON.parse(await readFile(result.paths.meta, 'utf8'));
  assert.equal(meta.appliedId, result.configurationId);
  assert.notEqual(meta.appliedId, staleId, 'appliedId must not point at the stale config');
  assert.equal(meta.entries.length, 1, 'stale entries are replaced, not appended');
  assert.equal(meta.entries[0].id, result.configurationId);
});

test('purge is opt-in: createCandidateWorkspace keeps prior configs by default', async (t) => {
  // The experiment path is unchanged; only the production launch path purges.
  const { createCandidateWorkspace } = await import('../../packages/identity-harness/src/index.js');
  const root = await tempDir(t);
  const userDataRoot = path.join(root, 'profile');
  const { staleConfigPath } = await seedStaleConfig(userDataRoot);

  // Provide a PASS gate so the experiment path runs.
  const gate = path.join(root, 'gate.json');
  await writeFile(gate, JSON.stringify({ p0_0: { status: 'PASS' } }));

  await createCandidateWorkspace({
    candidateId: 'B',
    evidenceFile: gate,
    harnessRoot: root,
    userDataRoot,
    loopbackBaseUrl: 'http://127.0.0.1:49876',
    ephemeralToken: TOKEN,
    models: MODELS,
    preferences: { deploymentMode: '3p' },
  });

  // Default (experiment) path leaves the stale file in place.
  const stale = await readFile(staleConfigPath, 'utf8');
  assert.ok(stale.includes('8788'), 'candidate path must not purge by default');
});
