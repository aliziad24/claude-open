// Identity-candidate harness — REAL contract tests.
//
// Contract source (empirically verified, redacted evidence in
// tests/fixtures/claude-3p-config/README.md): Claude Desktop 1.20186.1
// app.asar writer/loader in .vite/build/index.chunk-c42vKsva.js.
//
// The local active config file configLibrary/<uuid>.json is FLAT:
//   inferenceProvider, inferenceGatewayBaseUrl, inferenceGatewayApiKey,
//   inferenceCredentialKind, inferenceGatewayAuthScheme, modelDiscoveryEnabled,
//   inferenceModels[] ({ name, labelOverride?, supports1m?, anthropicFamilyTier?,
//   isFamilyDefault? }). NOT nested inference{}, NOT models.list, NOT
//   inference.models.
//   _meta.json = { appliedId, entries:[{id,name}] } (writer UE()/lB()).
//   deploymentMode ("3p"|"1p") lives ONLY in claude_desktop_config.json.
//   userData root honours CLAUDE_USER_DATA_DIR.
//
// These tests load the sanitized fixtures to assert exact shapes and must not be
// weakened to pass. If the harness diverges from the real client contract, the
// harness is wrong — not the test.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CANDIDATE_IDS,
  createCandidateWorkspace,
  readP0Gate,
  redactHarnessValue,
} from '../../packages/identity-harness/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, '..', 'fixtures', 'claude-3p-config');
const FIXTURE_UUID = '00000000-0000-0000-0000-000000000000';

// Word-delimited placeholder token: exercises redaction / no-leak assertions
// without tripping the release-privacy high-entropy scanner.
const TOKEN = 'ephemeral-loopback-token-TEST-0123456789';
// Real Claude model IDs used as the exact adapter aliases the client sends.
const MODELS = [
  { id: 'claude-opus-4', display_name: 'Claude Opus 4 (Loopback)' },
  { id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4 (Loopback)' },
];

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeGate(root, status) {
  const gate = path.join(root, 'run.json');
  await writeFile(gate, JSON.stringify({ p0_0: { status } }), 'utf8');
  return gate;
}

function baseOpts(root, gate, extra = {}) {
  return {
    candidateId: 'A',
    evidenceFile: gate,
    harnessRoot: root,
    loopbackBaseUrl: 'http://127.0.0.1:43123',
    ephemeralToken: TOKEN,
    models: MODELS,
    ...extra,
  };
}

test('readP0Gate: P0.0 must be an explicit PASS before any candidate is runnable', async (t) => {
  const root = await tempDir(t);
  const failedGate = await writeGate(root, 'FAIL');

  assert.deepEqual(await readP0Gate(failedGate), { status: 'FAIL', permitsExperiment: false });
  await assert.rejects(
    createCandidateWorkspace(baseOpts(root, failedGate)),
    /P0\.0 is FAIL; client experiments are blocked/,
  );
});

test('readP0Gate: repaired gate id p0_0 with status PASS permits an experiment', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  assert.deepEqual(await readP0Gate(gate), { status: 'PASS', permitsExperiment: true });
});

// ---- C2: active config FLAT keys, asserted against the real fixture shape ----

test('active config is FLAT and its key names/types match the fixture exactly', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate, {
    preferences: { deploymentMode: '3p' },
  }));

  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  const fixture = JSON.parse(await readFile(path.join(FIXTURE_DIR, `${FIXTURE_UUID}.json`), 'utf8'));

  // Same key set as the real fixture (flat, no nested inference{}/models.list).
  assert.deepEqual(Object.keys(config).sort(), Object.keys(fixture).sort());
  assert.equal(config.inference, undefined);
  assert.equal(config.models, undefined);

  // Exact flat key names + value types the writer persists.
  assert.equal(config.inferenceProvider, 'gateway');
  assert.equal(config.inferenceGatewayBaseUrl, 'http://127.0.0.1:43123');
  assert.equal(config.inferenceGatewayApiKey, TOKEN);
  assert.equal(config.inferenceCredentialKind, 'static');
  assert.equal(config.inferenceGatewayAuthScheme, 'bearer');
  assert.equal(typeof config.modelDiscoveryEnabled, 'boolean');
  assert.ok(Array.isArray(config.inferenceModels));

  // FIX A: the Chat surface toggle is a FLAT config-library key (same file), so
  // the written config enables Chat while leaving Cowork/Code at their default-on.
  assert.equal(config.chatTabEnabled, true);
  assert.notEqual(config.coworkTabEnabled, false);
  assert.notEqual(config.isClaudeCodeForDesktopEnabled, false);

  // deploymentMode NEVER lives in the config-library file.
  assert.equal(config.deploymentMode, undefined);
});

test('inferenceModels: name equals adapter ID, labelOverride survives, first is default', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  assert.deepEqual(config.inferenceModels, [
    { name: 'claude-opus-4', labelOverride: 'Claude Opus 4 (Loopback)' },
    { name: 'claude-sonnet-4', labelOverride: 'Claude Sonnet 4 (Loopback)' },
  ]);
  // name is the exact adapter alias; labelOverride is the friendly display.
  assert.equal(config.inferenceModels[0].name, MODELS[0].id);
  assert.equal(config.inferenceModels[0].labelOverride, MODELS[0].display_name);
  // First entry of inferenceModels is the default.
  assert.equal(config.inferenceModels[0].name, 'claude-opus-4');
});

// ---- C1: _meta.json is { appliedId, entries:[{id,name}] } exactly ----

test('_meta.json is { appliedId, entries:[{id,name}] } with no invented keys', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate, {
    configName: 'Claude Open Gateway',
  }));

  const meta = JSON.parse(await readFile(result.paths.meta, 'utf8'));
  const fixtureMeta = JSON.parse(await readFile(path.join(FIXTURE_DIR, '_meta.json'), 'utf8'));

  assert.deepEqual(Object.keys(meta).sort(), Object.keys(fixtureMeta).sort());
  assert.deepEqual(Object.keys(meta).sort(), ['appliedId', 'entries']);
  assert.equal(meta.appliedId, result.configurationId);
  assert.ok(Array.isArray(meta.entries));
  assert.deepEqual(Object.keys(meta.entries[0]).sort(), ['id', 'name']);
  assert.equal(meta.entries[0].id, result.configurationId);
  assert.equal(meta.entries[0].name, 'Claude Open Gateway');

  // Explicitly reject the invented keys from the prior wave.
  assert.equal(meta.appliedConfigurationId, undefined);
  assert.equal(meta.schemaVerified, undefined);
});

test('userData honours CLAUDE_USER_DATA_DIR-style userDataRoot and lays out configLibrary/', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'Claude-3p');
  const result = await createCandidateWorkspace(baseOpts(root, gate, { userDataRoot }));

  assert.equal(
    path.dirname(result.paths.configuration),
    path.join(userDataRoot, 'configLibrary'),
  );
  assert.equal(path.basename(result.paths.configuration), `${result.configurationId}.json`);
  assert.equal(path.basename(result.paths.meta), '_meta.json');
  assert.equal(result.paths.preferences, path.join(userDataRoot, 'claude_desktop_config.json'));
});

// ---- deploymentMode lives only in preferences; unrelated keys preserved ----

test('deploymentMode is written only to claude_desktop_config.json; unrelated keys preserved', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'existing-profile');
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(path.join(userDataRoot, 'claude_desktop_config.json'), JSON.stringify({
    deploymentMode: '1p', theme: 'dark', plugins: { keep: true },
  }), 'utf8');

  const result = await createCandidateWorkspace(baseOpts(root, gate, {
    userDataRoot,
    preferences: { deploymentMode: '3p' },
  }));

  const prefs = JSON.parse(await readFile(result.paths.preferences, 'utf8'));
  assert.equal(prefs.deploymentMode, '3p');
  assert.equal(prefs.theme, 'dark');
  assert.deepEqual(prefs.plugins, { keep: true });

  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));
  assert.equal(config.deploymentMode, undefined);
});

// ---- C3: UUID + traversal / reserved-name rejection ----

test('C3: an invalid supplied configurationId UUID is rejected (throws)', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  await assert.rejects(
    createCandidateWorkspace(baseOpts(root, gate, { configurationId: 'not-a-uuid' })),
    /configurationId must be a valid UUID/,
  );
});

test('C3: path-traversal and reserved-name configurationId values are rejected', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  for (const bad of ['..', 'CON', 'a/b', 'a\\b', '../escape', './x', 'con', 'PRN', 'NUL']) {
    await assert.rejects(
      createCandidateWorkspace(baseOpts(root, gate, { configurationId: bad })),
      /configurationId must be a valid UUID|configurationId is unsafe/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test('a valid supplied UUID is accepted and used as the file name', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const id = '85d71ac0-983f-4ea8-a17a-ee269d2b8fc1';
  const result = await createCandidateWorkspace(baseOpts(root, gate, { configurationId: id }));
  assert.equal(result.configurationId, id);
  assert.equal(path.basename(result.paths.configuration), `${id}.json`);
});

// ---- No BOM on any write ----

test('all writes are UTF-8 without a BOM', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate));

  for (const file of [
    result.paths.configuration,
    result.paths.meta,
    result.paths.preferences,
    result.paths.manifest,
  ]) {
    const bytes = await readFile(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
  }
});

// ---- C4: REAL backup — original bytes hashed, private rollback dir, no token ----

test('C4: backup manifest records original bytes hash and a private rollback artifact', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'backup-profile');
  await mkdir(userDataRoot, { recursive: true });
  const preferencesPath = path.join(userDataRoot, 'claude_desktop_config.json');
  const originalBytes = Buffer.from('{"sentinel":"ORIGINAL-BEFORE-REPLACE"}', 'utf8');
  await writeFile(preferencesPath, originalBytes);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');

  const result = await createCandidateWorkspace(baseOpts(root, gate, { userDataRoot }));
  const manifest = JSON.parse(await readFile(result.paths.manifest, 'utf8'));

  // Backup entry for preferences: existed=true, hash of the ORIGINAL bytes
  // (captured BEFORE replacement) — not the new file.
  const backup = manifest.files.find((e) => e.role === 'backup' && e.target === 'preferences');
  assert.ok(backup, 'preferences backup entry present');
  assert.equal(backup.existed, true);
  assert.equal(backup.sha256, originalHash);

  // The new (replaced) preferences file differs from the original, proving the
  // backup hash is the pre-change hash, not a post-replacement re-read.
  const newBytes = await readFile(preferencesPath);
  assert.notEqual(createHash('sha256').update(newBytes).digest('hex'), originalHash);

  // A private rollback backup artifact was actually persisted under a private dir.
  assert.ok(backup.backupPath, 'backup entry names a private rollback artifact');
  assert.match(backup.backupPath, /[\\/]\.rollback[\\/]/);
  const backedUp = await readFile(backup.backupPath);
  assert.equal(createHash('sha256').update(backedUp).digest('hex'), originalHash);

  // Backup entry must not sit inside any public export path.
  assert.doesNotMatch(backup.backupPath, /[\\/]dist[\\/]|[\\/]export[\\/]/);
});

test('C4: backup entry for a not-yet-existing target records existed=false', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate));
  const manifest = JSON.parse(await readFile(result.paths.manifest, 'utf8'));

  const configBackup = manifest.files.find((e) => e.role === 'backup' && e.target === 'configuration');
  assert.ok(configBackup);
  assert.equal(configBackup.existed, false);
});

test('every manifest sha256 is a full hex digest and a configuration role is present', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const result = await createCandidateWorkspace(baseOpts(root, gate));
  const manifest = JSON.parse(await readFile(result.paths.manifest, 'utf8'));

  assert.ok(manifest.files.every((e) => /^[a-f0-9]{64}$/.test(e.sha256)));
  assert.ok(manifest.files.some((e) => e.role === 'configuration'));
  assert.ok(manifest.files.some((e) => e.role === 'backup'));
});

test('the loopback token never appears anywhere in the manifest', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'no-leak-profile');
  await mkdir(userDataRoot, { recursive: true });
  // Seed a prior config that itself contains the token, to prove backups do not
  // re-leak it into the manifest.
  const library = path.join(userDataRoot, 'configLibrary');
  await mkdir(library, { recursive: true });
  const id = '85d71ac0-983f-4ea8-a17a-ee269d2b8fc1';
  await writeFile(path.join(library, `${id}.json`),
    JSON.stringify({ inferenceGatewayApiKey: TOKEN }), 'utf8');

  const result = await createCandidateWorkspace(baseOpts(root, gate, {
    userDataRoot, configurationId: id,
  }));
  const manifestRaw = await readFile(result.paths.manifest, 'utf8');
  assert.doesNotMatch(manifestRaw, new RegExp(TOKEN));
});

// ---- Atomic write + full rollback of every target to original bytes ----

test('failAfterReplace rolls every target back to original bytes and leaves no .tmp-', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'rollback-profile');
  const library = path.join(userDataRoot, 'configLibrary');
  await mkdir(library, { recursive: true });

  const id = '85d71ac0-983f-4ea8-a17a-ee269d2b8fc1';
  const prefsPath = path.join(userDataRoot, 'claude_desktop_config.json');
  const configPath = path.join(library, `${id}.json`);
  const metaPath = path.join(library, '_meta.json');
  await writeFile(prefsPath, '{"sentinel":"prefs-original"}', 'utf8');
  await writeFile(configPath, '{"sentinel":"config-original"}', 'utf8');
  await writeFile(metaPath, '{"sentinel":"meta-original"}', 'utf8');

  await assert.rejects(createCandidateWorkspace(baseOpts(root, gate, {
    userDataRoot, configurationId: id, failAfterReplace: 1,
  })), /injected atomic write failure/);

  // All three targets restored to their exact original bytes.
  assert.equal(await readFile(prefsPath, 'utf8'), '{"sentinel":"prefs-original"}');
  assert.equal(await readFile(configPath, 'utf8'), '{"sentinel":"config-original"}');
  assert.equal(await readFile(metaPath, 'utf8'), '{"sentinel":"meta-original"}');

  // No temporary files anywhere under userData.
  const files = await readdir(userDataRoot, { recursive: true });
  assert.ok(files.every((name) => !name.includes('.tmp-')), files.join(','));
});

test('failAfterReplace deletes freshly created files that did not previously exist', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  const userDataRoot = path.join(root, 'fresh-rollback');
  await mkdir(userDataRoot, { recursive: true });

  // configLibrary/ starts empty: the configuration (first target) does NOT exist.
  const id = '85d71ac0-983f-4ea8-a17a-ee269d2b8fc1';
  const configPath = path.join(userDataRoot, 'configLibrary', `${id}.json`);
  await assert.rejects(createCandidateWorkspace(baseOpts(root, gate, {
    userDataRoot, configurationId: id, failAfterReplace: 1,
  })), /injected atomic write failure/);

  // The freshly created configuration file must be deleted on rollback, not left
  // as a partial artifact.
  await assert.rejects(readFile(configPath), /ENOENT/);

  const files = await readdir(userDataRoot, { recursive: true });
  assert.ok(files.every((name) => !name.includes('.tmp-')), files.join(','));
});

// ---- No upstream gateway secret; only ephemeral loopback token ----

test('no upstream gateway secret ends up in the client config; only the loopback token', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  // Synthetic, non-credential-shaped upstream marker: proves the harness never
  // copies a supplied upstream gateway secret into the client config, without
  // planting a real key shape that the release scanner would (correctly) flag.
  const UPSTREAM_SECRET = 'upstream-gateway-secret-MARKER-do-not-copy';
  const result = await createCandidateWorkspace(baseOpts(root, gate, {
    upstreamGatewaySecret: UPSTREAM_SECRET,
  }));

  const configRaw = await readFile(result.paths.configuration, 'utf8');
  assert.doesNotMatch(configRaw, new RegExp('MARKER-do-not-copy'));
  const config = JSON.parse(configRaw);
  assert.equal(config.inferenceGatewayApiKey, TOKEN);
});

// ---- Loopback / model validation without leaking credentials ----

test('non-loopback base URL and duplicate model IDs are rejected; redaction is deep', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');

  await assert.rejects(createCandidateWorkspace(baseOpts(root, gate, {
    loopbackBaseUrl: 'https://gateway.example.test',
  })), /base URL must be an HTTP loopback URL/);

  await assert.rejects(createCandidateWorkspace(baseOpts(root, gate, {
    models: [{ id: 'x', display_name: 'X' }, { id: 'x', display_name: 'dup' }],
  })), /model IDs must be unique/);

  const redacted = redactHarnessValue({
    authorization: `Bearer ${TOKEN}`,
    apiKey: TOKEN,
    nested: { token: TOKEN, secret: TOKEN, credential: TOKEN, password: TOKEN },
    keep: 'visible',
  });
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(TOKEN));
  assert.deepEqual(redacted, {
    authorization: '[REDACTED]',
    apiKey: '[REDACTED]',
    nested: {
      token: '[REDACTED]', secret: '[REDACTED]',
      credential: '[REDACTED]', password: '[REDACTED]',
    },
    keep: 'visible',
  });
});

// ---- Candidate matrix never implies an unrun experiment passed ----

test('candidate matrix: A/B READY_NOT_RUN, C/D PLACEHOLDER; never emits PASS or P0.1', async (t) => {
  const root = await tempDir(t);
  const gate = await writeGate(root, 'PASS');
  assert.deepEqual(CANDIDATE_IDS, ['A', 'B', 'C', 'D']);

  const expected = {
    A: 'READY_NOT_RUN',
    B: 'READY_NOT_RUN',
    C: 'PLACEHOLDER_NOT_IMPLEMENTED',
    D: 'PLACEHOLDER_NOT_IMPLEMENTED',
  };
  for (const candidateId of CANDIDATE_IDS) {
    const result = await createCandidateWorkspace(baseOpts(root, gate, { candidateId }));
    assert.equal(result.status, expected[candidateId]);
    assert.equal(result.experimentRan, false);
    assert.doesNotMatch(JSON.stringify(result), /"status":"PASS"|P0\.1/i);
  }
});
