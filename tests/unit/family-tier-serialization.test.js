// Unit tests for FLAT inferenceModels serialization of family-tier metadata.
//
// After assignFamilyTiers tags healthy models, the FLAT config-library writer
// must serialize anthropicFamilyTier + isFamilyDefault ONLY when set, and expand
// a healthy representative that owns MULTIPLE tiers (familyTiers[]) into one FLAT
// inferenceModels item PER TIER so the client's per-tier probe resolves.
//
// FAMILY-TIER EVIDENCE — tests/fixtures/claude-3p-config/README.md:99-101:
//   anthropicFamilyTier (100) + isFamilyDefault (101) are OPTIONAL per-item
//   fields on the flat inferenceModels array. They must be absent when unset.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assignFamilyTiers,
  createProductionWorkspace,
} from '../../packages/identity-harness/src/index.js';

const TOKEN = 'ephemeral-loopback-token-TEST-0123456789';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-fam-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function baseOpts(root, models) {
  return {
    harnessRoot: root,
    userDataRoot: path.join(root, 'profile'),
    loopbackBaseUrl: 'http://127.0.0.1:43123',
    ephemeralToken: TOKEN,
    models,
    preferences: { deploymentMode: '3p' },
  };
}

test('untagged models never serialize anthropicFamilyTier / isFamilyDefault', async (t) => {
  const root = await tempDir(t);
  const models = [
    { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-7', display_name: 'Claude Sonnet 4.7' },
  ];
  const result = await createProductionWorkspace(baseOpts(root, models));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  for (const item of config.inferenceModels) {
    assert.equal('anthropicFamilyTier' in item, false, 'no tier when unset');
    assert.equal('isFamilyDefault' in item, false, 'no default flag when unset');
    // familyTiers is an internal marker and must NEVER leak into the flat item.
    assert.equal('familyTiers' in item, false, 'familyTiers must not serialize');
  }
});

test('healthy-opus-only: haiku/sonnet/opus probes each get a flat item pointing at the opus', async (t) => {
  const root = await tempDir(t);
  const raw = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ];
  const models = assignFamilyTiers(raw, {
    unhealthyIds: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
  });
  const result = await createProductionWorkspace(baseOpts(root, models));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  // For every tier probe, there is exactly one flat item that is the family
  // default and whose name is the healthy opus alias.
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const defaults = config.inferenceModels.filter(
      (i) => i.anthropicFamilyTier === tier && i.isFamilyDefault === true,
    );
    assert.equal(defaults.length, 1, `one flat default for ${tier}`);
    assert.equal(defaults[0].name, 'claude-opus-4-8', `${tier} -> healthy opus`);
  }

  // The overloaded haiku/sonnet models must NOT be tagged in the flat output.
  const overloaded = config.inferenceModels.filter(
    (i) => i.name === 'claude-haiku-4-5' || i.name === 'claude-sonnet-4-6',
  );
  for (const i of overloaded) {
    assert.equal('anthropicFamilyTier' in i, false);
    assert.equal('isFamilyDefault' in i, false);
  }
});

test('healthy opus + haiku: haiku probe resolves to the REAL haiku, opus to opus', async (t) => {
  const root = await tempDir(t);
  const raw = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  ];
  const models = assignFamilyTiers(raw, { unhealthyIds: ['claude-sonnet-4-6'] });
  const result = await createProductionWorkspace(baseOpts(root, models));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  const haiku = config.inferenceModels.filter(
    (i) => i.anthropicFamilyTier === 'haiku' && i.isFamilyDefault === true,
  );
  assert.equal(haiku.length, 1);
  assert.equal(haiku[0].name, 'claude-haiku-4-5', 'real haiku owns haiku tier');

  const opus = config.inferenceModels.filter(
    (i) => i.anthropicFamilyTier === 'opus' && i.isFamilyDefault === true,
  );
  assert.equal(opus.length, 1);
  assert.equal(opus[0].name, 'claude-opus-4-8');
});

test('the base (first) inferenceModels item stays the healthy default alias', async (t) => {
  const root = await tempDir(t);
  const raw = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ];
  const models = assignFamilyTiers(raw, { unhealthyIds: [] });
  const result = await createProductionWorkspace(baseOpts(root, models));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  // The first entry (client default) is still the first model's alias.
  assert.equal(config.inferenceModels[0].name, 'claude-opus-4-8');
});
