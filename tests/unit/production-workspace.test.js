// Unit tests for createProductionWorkspace — the production launch entrypoint.
//
// The P0.0 experiment gate exists to guard candidate EXPERIMENTS, not the
// production Control Center launch path. This entrypoint writes the exact same
// FLAT 3P config-library contract as createCandidateWorkspace, but WITHOUT
// requiring a P0.0 PASS gate file. Experiment gating stays intact for
// createCandidateWorkspace (covered by identity-candidate-harness.test.js).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionWorkspace } from '../../packages/identity-harness/src/index.js';

const TOKEN = 'ephemeral-loopback-token-TEST-0123456789';
const MODELS = [
  { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-7', display_name: 'Claude Sonnet 4.7' },
];

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-prod-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function baseOpts(root, extra = {}) {
  return {
    harnessRoot: root,
    userDataRoot: path.join(root, 'profile'),
    loopbackBaseUrl: 'http://127.0.0.1:43123',
    ephemeralToken: TOKEN,
    models: MODELS,
    preferences: { deploymentMode: '3p' },
    ...extra,
  };
}

test('writes the FLAT config-library WITHOUT any P0.0 gate file', async (t) => {
  const root = await tempDir(t);
  // No gate file is created anywhere — production must not require one.
  const result = await createProductionWorkspace(baseOpts(root));

  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  assert.equal(config.inferenceProvider, 'gateway');
  assert.equal(config.inferenceGatewayBaseUrl, 'http://127.0.0.1:43123');
  assert.equal(config.inferenceGatewayApiKey, TOKEN);
  assert.equal(config.inferenceCredentialKind, 'static');
  assert.equal(config.inferenceGatewayAuthScheme, 'bearer');
  assert.equal(config.modelDiscoveryEnabled, false);
  assert.equal(config.deploymentMode, undefined);
});

test('first inferenceModels entry is the client default (name = alias)', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  assert.equal(config.inferenceModels[0].name, 'claude-opus-4-5');
  assert.equal(config.inferenceModels[0].labelOverride, 'Claude Opus 4.5');
});

test('deploymentMode:3p is written only to claude_desktop_config.json', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root));
  const prefs = JSON.parse(await readFile(result.paths.preferences, 'utf8'));
  assert.equal(prefs.deploymentMode, '3p');
});

test('_meta.json points appliedId at the written configuration', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root, { configName: 'Claude Open' }));
  const meta = JSON.parse(await readFile(result.paths.meta, 'utf8'));
  assert.deepEqual(Object.keys(meta).sort(), ['appliedId', 'entries']);
  assert.equal(meta.appliedId, result.configurationId);
  assert.equal(meta.entries[0].name, 'Claude Open');
});

test('still enforces the loopback + unique-id invariants (no gate bypass of safety)', async (t) => {
  const root = await tempDir(t);
  await assert.rejects(
    createProductionWorkspace(baseOpts(root, { loopbackBaseUrl: 'http://example.com:80' })),
    /base URL must be an HTTP loopback URL/,
  );
  await assert.rejects(
    createProductionWorkspace(baseOpts(root, {
      models: [{ id: 'dup', display_name: 'A' }, { id: 'dup', display_name: 'B' }],
    })),
    /model IDs must be unique/,
  );
});
