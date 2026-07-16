// SESSION-3 section 3 + 11: prove ONE dynamic config drives every component,
// that switching from gateway A to gateway B (no source edit) changes the
// served catalog, and that alias/catalog state does not leak across gateways.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGateway } from '../fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../../apps/adapter-server/src/server.js';
import { gatewayFingerprint } from '@claude-open/config/store';

function secret(v) {
  return { resolve: () => v, fingerprint: () => '<fixture>', source: () => 'fixture' };
}

async function serveCatalog(cfg, secretVal, aliasStore) {
  const adapter = createAdapterServer({
    config: cfg,
    secretStore: secret(secretVal),
    aliasStorePath: aliasStore,
    gatewayFingerprint: gatewayFingerprint(cfg),
  });
  const port = await adapter.listen(0, '127.0.0.1');
  const j = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  await adapter.close();
  return j.data.map((m) => m.claude_open.realId).sort();
}

test('switching gateway A -> B (config only, no source change) changes the served catalog', async () => {
  const store = mkdtempSync(join(tmpdir(), 'co-switch-'));
  try {
    const gwA = createMockGateway({ protocols: ['anthropic', 'openai-chat'], models: [{ id: 'claude-opus-4-8' }, { id: 'llama-3.1-8b' }], auth: { kind: 'bearer', secret: 'A-key' } });
    const gwB = createMockGateway({ protocols: ['openai-chat'], models: [{ id: 'gpt-4.1' }, { id: 'qwen-2.5-coder-14b' }], auth: { kind: 'x-api-key', secret: 'B-key' } });
    const urlA = await gwA.listen();
    const urlB = await gwB.listen();
    try {
      const cfgA = { baseUrl: urlA, auth: { kind: 'bearer' }, modelsEndpoint: '/v1/models' };
      const cfgB = { baseUrl: urlB, auth: { kind: 'x-api-key' }, modelsEndpoint: '/v1/models' };

      const catA = await serveCatalog(cfgA, 'A-key', store);
      assert.deepEqual(catA, ['claude-opus-4-8', 'llama-3.1-8b']);

      const catB = await serveCatalog(cfgB, 'B-key', store);
      assert.deepEqual(catB, ['gpt-4.1', 'qwen-2.5-coder-14b']);

      // Different gateway fingerprints => separate alias stores => no A data in B.
      assert.notEqual(gatewayFingerprint(cfgA), gatewayFingerprint(cfgB));
      assert.ok(!catB.includes('claude-opus-4-8'), 'gateway A model must not survive switch to B');
    } finally {
      await gwA.close();
      await gwB.close();
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('each auth kind drives the correct upstream header (bearer / x-api-key / custom / none)', async () => {
  const cases = [
    { auth: { kind: 'bearer' }, secret: 'tb', gw: { kind: 'bearer', secret: 'tb' } },
    { auth: { kind: 'x-api-key' }, secret: 'tk', gw: { kind: 'x-api-key', secret: 'tk' } },
    { auth: { kind: 'custom-header', headerName: 'x-tenant-key' }, secret: 'tc', gw: { kind: 'custom-header', headerName: 'x-tenant-key', secret: 'tc' } },
    { auth: { kind: 'none' }, secret: null, gw: { kind: 'none' } },
  ];
  for (const c of cases) {
    const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }], auth: c.gw });
    const url = await gw.listen();
    try {
      const adapter = createAdapterServer({ config: { baseUrl: url, auth: c.auth }, secretStore: secret(c.secret), gatewayFingerprint: 'fp' });
      const port = await adapter.listen(0, '127.0.0.1');
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const j = await r.json();
      assert.equal(j.data.length, 1, `${c.auth.kind}: catalog should load with correct auth`);
      await adapter.close();
    } finally {
      await gw.close();
    }
  }
});

test('wrong secret -> catalog fails to load (no fake success)', async () => {
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }], auth: { kind: 'bearer', secret: 'right' } });
  const url = await gw.listen();
  try {
    const adapter = createAdapterServer({ config: { baseUrl: url, auth: { kind: 'bearer' } }, secretStore: secret('WRONG'), gatewayFingerprint: 'fp' });
    const port = await adapter.listen(0, '127.0.0.1');
    const j = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    assert.equal(j.data.length, 0, 'wrong secret must not yield models');
    await adapter.close();
  } finally {
    await gw.close();
  }
});
