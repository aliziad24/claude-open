// SESSION-4 phase 3.1: the stored per-user config is authoritative in the real
// production entrypoint. Save config A via the real store, start() with NO
// base-url env override, prove gateway A; replace with config B, restart, prove
// gateway B. Also prove first-run error when no config exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { saveStoredConfig } from '@claude-open/config/store';
import { start } from '../src/main.js';

function baseEnv(cfgDir, rtDir) {
  // A clean env with ONLY per-user locations set; no base-url/secret override.
  return {
    CLAUDE_OPEN_CONFIG_DIR: cfgDir,
    CLAUDE_OPEN_RUNTIME_DIR: rtDir,
    CLAUDE_OPEN_PORT: '0',
    CLAUDE_OPEN_SKIP_ACL: '1', // allow temp-dir cleanup in tests
    USERNAME: process.env.USERNAME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
}

test('first run with no stored config -> FIRST_RUN error (no healthy server bound)', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'co-cfg-'));
  const rtDir = mkdtempSync(join(tmpdir(), 'co-rt-'));
  try {
    await assert.rejects(
      () => start({ env: baseEnv(cfgDir, rtDir), fetchImpl: fetch }),
      (e) => e.firstRun === true,
    );
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  }
});

test('stored config A -> B switch drives the entrypoint (no base-url env override)', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'co-cfg-'));
  const rtDir = mkdtempSync(join(tmpdir(), 'co-rt-'));
  const gwA = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }] });
  const gwB = createMockGateway({ protocols: ['openai-chat'], models: [{ id: 'gpt-4.1' }, { id: 'qwen-2.5-coder-14b' }] });
  const urlA = await gwA.listen();
  const urlB = await gwB.listen();
  try {
    const env = baseEnv(cfgDir, rtDir);

    // Save config A through the REAL store, then start the REAL entrypoint.
    saveStoredConfig({ baseUrl: urlA, auth: { kind: 'none' }, profile: 'anthropic' }, env);
    let started = await start({ env, fetchImpl: fetch });
    let models = await (await fetch(`http://127.0.0.1:${started.port}/v1/models`, {
      headers: { authorization: `Bearer ${started.clientToken}` },
    })).json();
    let ids = models.data.map((m) => m.claude_open.realId).sort();
    assert.deepEqual(ids, ['claude-opus-4-8'], 'gateway A catalog');
    await started.adapter.close();

    // Replace with config B and restart; catalog must now reflect B.
    saveStoredConfig({ baseUrl: urlB, auth: { kind: 'none' }, profile: 'openai-chat' }, env);
    started = await start({ env, fetchImpl: fetch });
    models = await (await fetch(`http://127.0.0.1:${started.port}/v1/models`, {
      headers: { authorization: `Bearer ${started.clientToken}` },
    })).json();
    ids = models.data.map((m) => m.claude_open.realId).sort();
    assert.deepEqual(ids, ['gpt-4.1', 'qwen-2.5-coder-14b'], 'gateway B catalog');
    assert.ok(!ids.includes('claude-opus-4-8'), 'gateway A data must not survive switch');
    await started.adapter.close();
  } finally {
    await gwA.close();
    await gwB.close();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  }
});

test('production loader resolves the exact auth.credentialRef saved in config', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'co-cfg-'));
  const rtDir = mkdtempSync(join(tmpdir(), 'co-rt-'));
  const gw = createMockGateway({
    protocols: ['anthropic'],
    auth: { kind: 'bearer', secret: 'stored-ref-secret' },
    models: [{ id: 'claude-opus-4-8' }],
  });
  const url = await gw.listen();
  try {
    const env = {
      ...baseEnv(cfgDir, rtDir),
      CLAUDE_OPEN_TEST_SECRET: 'stored-ref-secret',
    };
    saveStoredConfig(
      {
        baseUrl: url,
        auth: {
          kind: 'bearer',
          credentialRef: 'ClaudeOpen/gateway/ui-selected-ref',
          envVar: 'CLAUDE_OPEN_TEST_SECRET',
        },
        profile: 'anthropic',
      },
      env,
    );
    const started = await start({ env, fetchImpl: fetch });
    try {
      const models = await fetch(`http://127.0.0.1:${started.port}/v1/models`, {
        headers: { authorization: `Bearer ${started.clientToken}` },
      });
      assert.equal(models.status, 200);
      const body = await models.json();
      assert.equal(body.data[0].claude_open.realId, 'claude-opus-4-8');
    } finally {
      await started.adapter.close();
    }
  } finally {
    await gw.close();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  }
});
