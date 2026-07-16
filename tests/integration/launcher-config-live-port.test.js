// FIX 1(a)+(b) end-to-end: the launcher writes the client 3P config using the
// LIVE bound adapter port (activePort), never the retired fixed 8788, and a
// pre-existing stale config (carrying 8788) is overwritten with the live port.
//
// This drives scripts/write-3p-config.mjs exactly as apps/launcher/ClaudeOpen.cs
// invokes it in WriteThirdPartyConfig(): --production, --base-url
// http://127.0.0.1:<activePort>, --models <file>, --default <opus>, and the
// FIX 3(a) flags --assign-family-tiers + --unhealthy <csv>. It asserts on the
// written configLibrary/<uuid>.json + _meta.json in the isolated profile.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shim = path.join(repoRoot, 'scripts', 'write-3p-config.mjs');

// A simulated LIVE ephemeral adapter port — deliberately NOT 8788.
const ACTIVE_PORT = 51843;
const TOKEN = 'ephemeral-loopback-token-TEST-liveport-01';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-liveport-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Reproduce the exact argv the launcher builds (ClaudeOpen.cs:WriteThirdPartyConfig
// + BuildArguments), including the FIX 3(a) family-tier flags.
function launcherArgv({ harnessRoot, userData, modelsFile, activePort, defaultAlias, unhealthy }) {
  const argv = [
    shim,
    '--production',
    '--harness-root', harnessRoot,
    '--user-data', userData,
    '--base-url', `http://127.0.0.1:${activePort}`,
    '--token', TOKEN,
    '--models', modelsFile,
    '--assign-family-tiers',
    '--unhealthy', unhealthy,
  ];
  if (defaultAlias) { argv.push('--default', defaultAlias); }
  argv.push('--config-name', 'Claude Open');
  return argv;
}

async function writeModels(dir, models) {
  const file = path.join(dir, 'models.json');
  await writeFile(file, JSON.stringify(models), 'utf8');
  return file;
}

function findConfigJson(names) {
  return names.filter(
    (n) => n.endsWith('.json') && n !== '_meta.json' && !n.endsWith('.manifest.json'),
  );
}

test('written client config uses the LIVE activePort, not 8788', async (t) => {
  const root = await tempDir(t);
  const userData = path.join(root, 'profile');
  const modelsFile = await writeModels(root, [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ]);

  const res = spawnSync(process.execPath, launcherArgv({
    harnessRoot: path.join(root, 'harness'),
    userData,
    modelsFile,
    activePort: ACTIVE_PORT,
    defaultAlias: 'claude-opus-4-8',
    unhealthy: 'claude-haiku-4-5,claude-sonnet-4-6',
  }), { encoding: 'utf8' });

  assert.equal(res.status, 0, `shim failed: ${res.stderr}`);

  const library = path.join(userData, 'configLibrary');
  const names = await readdir(library);
  const configs = findConfigJson(names);
  assert.equal(configs.length, 1, 'exactly one config written');

  const config = JSON.parse(await readFile(path.join(library, configs[0]), 'utf8'));
  assert.equal(config.inferenceGatewayBaseUrl, `http://127.0.0.1:${ACTIVE_PORT}`);
  assert.ok(!JSON.stringify(config).includes('8788'), 'no retired 8788 port anywhere');

  // _meta.appliedId points at the freshly written config.
  const meta = JSON.parse(await readFile(path.join(library, '_meta.json'), 'utf8'));
  assert.equal(meta.appliedId, path.basename(configs[0], '.json'));
});

test('a pre-existing stale 8788 config is overwritten with the live port', async (t) => {
  const root = await tempDir(t);
  const userData = path.join(root, 'profile');

  // Seed a stale config from a prior launch that used the retired fixed port.
  const library = path.join(userData, 'configLibrary');
  await mkdir(library, { recursive: true });
  const staleId = '22222222-2222-4222-8222-222222222222';
  await writeFile(
    path.join(library, `${staleId}.json`),
    JSON.stringify({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'http://127.0.0.1:8788',
      inferenceGatewayApiKey: 'STALE',
      inferenceModels: [{ name: 'claude-old', labelOverride: 'Old' }],
    }),
  );
  await writeFile(
    path.join(library, '_meta.json'),
    JSON.stringify({ appliedId: staleId, entries: [{ id: staleId, name: 'Old' }] }),
  );

  const modelsFile = await writeModels(root, [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  ]);

  const res = spawnSync(process.execPath, launcherArgv({
    harnessRoot: path.join(root, 'harness'),
    userData,
    modelsFile,
    activePort: ACTIVE_PORT,
    defaultAlias: 'claude-opus-4-8',
    unhealthy: '',
  }), { encoding: 'utf8' });
  assert.equal(res.status, 0, `shim failed: ${res.stderr}`);

  // The stale config is gone; no lingering file carries 8788.
  const names = await readdir(library);
  assert.ok(!names.includes(`${staleId}.json`), 'stale config deleted');
  for (const name of findConfigJson(names)) {
    const txt = await readFile(path.join(library, name), 'utf8');
    assert.ok(!txt.includes('8788'), `config ${name} must not carry the retired port`);
    assert.ok(txt.includes(`127.0.0.1:${ACTIVE_PORT}`), `config ${name} must carry the live port`);
  }

  // appliedId points at the fresh config, not the stale one.
  const meta = JSON.parse(await readFile(path.join(library, '_meta.json'), 'utf8'));
  assert.notEqual(meta.appliedId, staleId);
});

test('FIX 3(a): family-tier tags are written so every tier resolves to healthy opus', async (t) => {
  const root = await tempDir(t);
  const userData = path.join(root, 'profile');
  // Only opus is healthy; haiku + sonnet are overloaded (the live failure mode).
  const modelsFile = await writeModels(root, [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ]);

  const res = spawnSync(process.execPath, launcherArgv({
    harnessRoot: path.join(root, 'harness'),
    userData,
    modelsFile,
    activePort: ACTIVE_PORT,
    defaultAlias: 'claude-opus-4-8',
    unhealthy: 'claude-haiku-4-5,claude-sonnet-4-6',
  }), { encoding: 'utf8' });
  assert.equal(res.status, 0, `shim failed: ${res.stderr}`);

  const library = path.join(userData, 'configLibrary');
  const names = await readdir(library);
  const config = JSON.parse(await readFile(path.join(library, findConfigJson(names)[0]), 'utf8'));

  // Collect the family-default entry per tier.
  const tierDefault = (tier) => config.inferenceModels.filter(
    (m) => m.anthropicFamilyTier === tier && m.isFamilyDefault === true,
  );
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const d = tierDefault(tier);
    assert.equal(d.length, 1, `exactly one ${tier} default`);
    assert.equal(d[0].name, 'claude-opus-4-8', `${tier} tier resolves to the healthy opus`);
  }

  // The overloaded models are NEVER tagged as a family default.
  const tagged = config.inferenceModels.filter((m) => m.isFamilyDefault === true).map((m) => m.name);
  assert.ok(!tagged.includes('claude-haiku-4-5'), 'overloaded haiku not tagged default');
  assert.ok(!tagged.includes('claude-sonnet-4-6'), 'overloaded sonnet not tagged default');
});
