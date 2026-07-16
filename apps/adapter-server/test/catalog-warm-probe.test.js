// NEXT-CORRECTIVE-WAVE (ConfigHealth liveness/discovery fast path).
//
// The genuine Claude client's startup ConfigHealth reachability probe runs on a
// bounded (~10s) budget and can be starved by a first-run CCD binary download
// that stalls its event loop up to 15s. The adapter's liveness/discovery path
// (GET /v1/models, and the catalog read the /v1/messages tier-probe reconcile
// needs) must therefore answer INSTANTLY from the warm catalog cache instead of
// making a blocking live upstream round-trip on every call.
//
// Contract proven here:
//   1. A warm catalog cache serves GET /v1/models WITHOUT a live upstream fetch.
//   2. A cold catalog cache DOES fetch live once to populate.
//   3. The warm response is prompt (<200ms) and carries the configured models.
//   4. The /v1/messages path's tier-probe reconcile reads the warm cache and
//      does NOT re-fetch the catalog (only the real inference goes live).
//   5. The adapter warms its catalog once at startup (main.js) so the very first
//      client probe hits a warm cache.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../src/server.js';
import { saveStoredConfig } from '@claude-open/config/store';
import { start } from '../src/main.js';

function fixedSecret(value) {
  return { resolve: () => value, fingerprint: () => '<fixture>', source: () => 'fixture' };
}

// A fetch wrapper that counts calls per upstream path so a test can assert that
// a warm-cache probe made ZERO discovery round-trips.
function countingFetch(realFetch = fetch) {
  const counts = { total: 0, models: 0, messages: 0, other: 0 };
  const impl = async (url, init) => {
    counts.total += 1;
    const u = String(url);
    if (u.includes('/v1/models')) counts.models += 1;
    else if (u.includes('/v1/messages')) counts.messages += 1;
    else counts.other += 1;
    return realFetch(url, init);
  };
  impl.counts = counts;
  return impl;
}

async function withCountedStack(gwConfig, fn) {
  const gw = createMockGateway(gwConfig);
  const gwUrl = await gw.listen();
  const fetchImpl = countingFetch();
  const adapter = createAdapterServer({
    config: {
      baseUrl: gwUrl,
      auth: gwConfig.auth || { kind: 'none' },
      profile: 'mixed-auto',
      modelsEndpoint: '/v1/models',
      modelOverrides: {},
      aliasSalt: 'warm',
    },
    secretStore: fixedSecret(gwConfig.auth?.secret ?? null),
    fetchImpl,
  });
  const port = await adapter.listen(0, '127.0.0.1');
  const local = `http://127.0.0.1:${port}`;
  try {
    await fn(local, fetchImpl.counts, adapter);
  } finally {
    await adapter.close();
    await gw.close();
  }
}

test('GET /v1/models: cold cache fetches live once; warm cache serves WITHOUT re-fetching', async () => {
  await withCountedStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-7' }] },
    async (local, counts) => {
      // Cold: first probe must populate the cache with exactly one discovery call.
      const first = await (await fetch(`${local}/v1/models`)).json();
      assert.equal(counts.models, 1, 'cold cache does one live discovery fetch');
      assert.ok(first.data.length >= 1, 'cold probe returns the catalog');

      // Warm: subsequent probes must be served from cache with NO extra fetch.
      const t0 = Date.now();
      const second = await (await fetch(`${local}/v1/models`)).json();
      const elapsed = Date.now() - t0;
      assert.equal(counts.models, 1, 'warm cache must NOT call the live upstream again');
      assert.ok(elapsed < 200, `warm /v1/models must be prompt (<200ms), got ${elapsed}ms`);

      // Warm response carries the configured models (real, last-known-good data).
      const ids = second.data.map((m) => m.claude_open.realId);
      assert.ok(ids.includes('claude-opus-4-7'));
      assert.ok(ids.includes('claude-sonnet-4-7'));
      assert.equal(second.stale, false, 'a fresh warm catalog is not stale');
    },
  );
});

test('POST /v1/messages tier-probe reconcile reads the WARM cache (no catalog re-fetch on the probe path)', async () => {
  await withCountedStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] },
    async (local, counts) => {
      // Warm the cache first (the launcher does this before the client launches).
      await fetch(`${local}/v1/models`);
      assert.equal(counts.models, 1, 'exactly one discovery fetch to warm');

      // A client inference probe. The reconcile needs the catalog, but a warm
      // cache must be reused — it must NOT trigger another /v1/models round-trip.
      const r = await fetch(`${local}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      assert.equal(r.status, 200, 'real inference still goes live and returns 200');
      assert.equal(counts.models, 1, 'the probe path must not re-fetch the catalog when warm');
      assert.equal(counts.messages, 1, 'the real inference call still hits upstream /v1/messages exactly once');
    },
  );
});

test('adapter warms its catalog cache at startup so the first client probe is instant', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'co-warm-cfg-'));
  const rtDir = mkdtempSync(join(tmpdir(), 'co-warm-rt-'));
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] });
  const gwUrl = await gw.listen();
  const env = {
    CLAUDE_OPEN_CONFIG_DIR: cfgDir,
    CLAUDE_OPEN_RUNTIME_DIR: rtDir,
    CLAUDE_OPEN_PORT: '0',
    CLAUDE_OPEN_SKIP_ACL: '1',
    CLAUDE_OPEN_CLIENT_TOKEN: 'warm-client',
    USERNAME: process.env.USERNAME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  saveStoredConfig(
    { baseUrl: gwUrl, auth: { kind: 'none' }, profile: 'mixed-auto', modelsEndpoint: '/v1/models' },
    env,
  );
  const fetchImpl = countingFetch();
  let started;
  try {
    started = await start({ env, fetchImpl });
    // Startup must have already populated the catalog with ONE discovery call,
    // before any client probe arrives.
    assert.equal(fetchImpl.counts.models, 1, 'startup warms the catalog exactly once');

    // The first client GET /v1/models must now be served warm (no extra fetch).
    const local = `http://127.0.0.1:${started.port}`;
    const r = await fetch(`${local}/v1/models`, { headers: { authorization: 'Bearer warm-client' } });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(fetchImpl.counts.models, 1, 'the first client probe hits the warm cache (no re-fetch)');
    assert.ok(j.data.some((m) => m.claude_open.realId === 'claude-opus-4-7'));
  } finally {
    if (started) await started.adapter.close();
    await gw.close();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  }
});

test('production entrypoint starts the opt-in companion on a separate authenticated loopback port', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'co-companion-cfg-'));
  const rtDir = mkdtempSync(join(tmpdir(), 'co-companion-rt-'));
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] });
  const gwUrl = await gw.listen();
  const env = {
    CLAUDE_OPEN_CONFIG_DIR: cfgDir,
    CLAUDE_OPEN_RUNTIME_DIR: rtDir,
    CLAUDE_OPEN_PORT: '0',
    CLAUDE_OPEN_COMPANION: '1',
    CLAUDE_OPEN_SKIP_ACL: '1',
    CLAUDE_OPEN_CLIENT_TOKEN: 'companion-entrypoint-client',
    USERNAME: process.env.USERNAME,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  saveStoredConfig(
    { baseUrl: gwUrl, auth: { kind: 'none' }, profile: 'mixed-auto', modelsEndpoint: '/v1/models', companion: { enabled: true } },
    env,
  );
  let started;
  try {
    started = await start({ env });
    assert.ok(started.companion, 'companion starts only when explicitly enabled');
    const companionPort = started.companion.server.address().port;
    assert.notEqual(companionPort, started.port, 'companion and adapter have separate listeners');
    assert.equal(started.companion.server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${companionPort}`;
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ code: started.companion.pairingCode }),
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';', 1)[0];
    const models = await fetch(`${base}/api/models`, { headers: { cookie } });
    assert.equal(models.status, 200);
    assert.ok((await models.json()).data.some((model) => model.display_name.includes('claude-opus-4-7')));

    const runtime = JSON.parse(readFileSync(join(rtDir, 'runtime.json'), 'utf8'));
    assert.equal(runtime.companion.enabled, true);
    assert.equal(runtime.companion.port, companionPort);
    assert.equal(runtime.companion.exposure, 'loopback-only');
  } finally {
    if (started?.companion) await started.companion.close();
    if (started) await started.adapter.close();
    await gw.close();
    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(rtDir, { recursive: true, force: true });
  }
});
