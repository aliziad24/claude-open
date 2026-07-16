// FIX A — Chat tab surface in the FLAT 3P config-library file.
//
// SYMPTOM: with the offline 3P bundle the client shows only Cowork + Code tabs.
//
// EVIDENCE (read-only extracted app.asar 1.20186.1 —
// .vite/build/index.chunk-c42vKsva.js):
//   - The three surface toggles are FLAT config keys in the SAME
//     configLibrary/<uuid>.json object the harness already writes (they live on
//     the flat schema `ml.shape`, read by the loader's flat allow-list `Vf`):
//       * flatKey:"coworkTabEnabled"               support scopes:["3p"]      (avail 1.9659.0)
//       * flatKey:"isClaudeCodeForDesktopEnabled"  support scopes:["3p","1p"] (avail 1.2581.0)
//       * flatKey:"chatTabEnabled"                 support scopes:["3p"]      (avail 1.13576.0), betaFeatureKey:"chatTab"
//   - The client's surface-normalizer reads them off the SAME flat object `r`:
//       r.coworkTabEnabled===!1 && r.isClaudeCodeForDesktopEnabled===!1 && r.chatTabEnabled!==!0
//       ...then "At least one surface must remain enabled; the Cowork tab has been re-enabled."
//     => Cowork + Code default-ENABLED (only disabled when explicitly ===false);
//        Chat is default-DISABLED (only enabled when explicitly ===true).
//   Prior working configs also placed chatTabEnabled:true in the flat
//     configLibrary/<uuid>.json file (see docs/SETUP.md history).
//
// FIX: buildFlatActiveConfig must emit chatTabEnabled:true so the Chat surface is
// enabled, WITHOUT disabling the Cowork/Code defaults => 3P shows Chat + Cowork
// + Code. These are surface config keys in the flat config-library file, exactly
// where the harness already writes (NOT claude_desktop_config.json).
//
// HONEST LIMIT: the new unified "Home" layout is a FIRST-PARTY claude.ai REMOTE
// feature that the offline 3P bundle cannot render. Chat + Cowork + Code is the
// best achievable surface set for the gateway/3P path.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionWorkspace } from '../../packages/identity-harness/src/index.js';

const TOKEN = 'ephemeral-loopback-token-TEST-0123456789';
const MODELS = [
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
];

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'co-chat-surface-'));
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

test('FIX A: written FLAT config enables the Chat surface (chatTabEnabled:true)', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  // Chat surface explicitly enabled — the flat key the client reads for 3p.
  assert.equal(config.chatTabEnabled, true);
});

test('FIX A: Cowork + Code surface defaults are preserved (not disabled)', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  // The client's normalizer treats these as ENABLED unless they are explicitly
  // ===false. So they must be either omitted (default-on) or true — NEVER false.
  assert.notEqual(config.coworkTabEnabled, false);
  assert.notEqual(config.isClaudeCodeForDesktopEnabled, false);
});

test('FIX A: at least one surface stays enabled (client would not re-enable Cowork)', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  // Reproduce the client's surface-warn condition: it re-enables Cowork ONLY
  // when cowork===false AND code===false AND chat!==true. With our config that
  // condition must be FALSE (chat is true), so no surface is force-re-enabled.
  const wouldForceReenable =
    config.coworkTabEnabled === false &&
    config.isClaudeCodeForDesktopEnabled === false &&
    config.chatTabEnabled !== true;
  assert.equal(wouldForceReenable, false);
});

test('production native discovery omits the stale static model list', async (t) => {
  const root = await tempDir(t);
  const result = await createProductionWorkspace(baseOpts(root, { modelDiscoveryEnabled: true }));
  const config = JSON.parse(await readFile(result.paths.configuration, 'utf8'));

  assert.equal(config.modelDiscoveryEnabled, true);
  assert.equal(config.disableAutoUpdates, true);
  assert.equal(Object.hasOwn(config, 'inferenceModels'), false);
});
