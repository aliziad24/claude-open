// CHANGE 2 (adapter-side belt-and-suspenders) — tier-probe reconciliation.
//
// ROOT CAUSE (confirmed live): the Claude client's ConfigHealth / first-inference
// probe resolves by anthropicFamilyTier and can fall back to the BUILT-IN tier id
// (e.g. 'claude-haiku-4-5') which is not in the live catalog and is being
// 503-overloaded upstream. When the inbound model is one of those built-in
// tier-probe ids (or any id absent from the current live catalog aliases) AND a
// configured healthy default exists, the adapter reconciles it to the persisted
// healthy default alias BEFORE upstream — ONLY for this tier-probe case — and
// logs evt:'tier-probe-reconcile' {from,to}.
//
// It must NEVER silently substitute a user-picked chat model that IS in the
// catalog (plan Phase 4 rule): a normal in-catalog model is passed through
// unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../src/server.js';

function fixedSecret(value) {
  return { resolve: () => value, fingerprint: () => '<fixture>', source: () => 'fixture' };
}

async function withStack(gwConfig, adapterConfigExtra, fn, adapterOptions = {}) {
  const gw = createMockGateway(gwConfig);
  const gwUrl = await gw.listen();
  const adapter = createAdapterServer({
    config: {
      baseUrl: gwUrl,
      auth: gwConfig.auth || { kind: 'none' },
      profile: 'anthropic',
      modelsEndpoint: '/v1/models',
      modelOverrides: {},
      aliasSalt: 'test',
      ...adapterConfigExtra,
    },
    secretStore: fixedSecret(gwConfig.auth?.secret ?? null),
    ...adapterOptions,
  });
  const port = await adapter.listen(0, '127.0.0.1');
  const local = `http://127.0.0.1:${port}`;
  try {
    await fn(local, adapter, gw);
  } finally {
    await adapter.close();
    await gw.close();
  }
}

test('probe to built-in claude-haiku-4-5 (unhealthy/absent) reconciles to the healthy default -> 200', async () => {
  const events = [];
  await withStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }] },
    { healthyDefaultAlias: 'claude-opus-4-8' },
    async (local, adapter, gw) => {
      // Populate the catalog so the alias map / catalog is live.
      await fetch(`${local}/v1/models`);

      const r = await fetch(`${local}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5', // built-in tier-probe id, NOT in catalog
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      assert.equal(r.status, 200, 'tier probe must succeed after reconcile');

      // Upstream must have received the HEALTHY default, not the overloaded id.
      const upstreamModel = gw.captured.length
        ? gw.lastRequest()?.body?.model
        : null;
      // The mock echoes body.model back in the response; assert on that too.
      const j = await r.json();
      assert.equal(j.model, 'claude-opus-4-8', 'upstream saw the healthy default');
      // (upstreamModel is null for the anthropic route since it is not captured;
      // the echoed response model is the authoritative signal here.)
      void upstreamModel;

      // A tier-probe-reconcile diagnostic was logged with from/to.
      const reconcile = events.find((e) => e.evt === 'tier-probe-reconcile');
      assert.ok(reconcile, 'tier-probe-reconcile event logged');
      assert.equal(reconcile.from, 'claude-haiku-4-5');
      assert.equal(reconcile.to, 'claude-opus-4-8');
    },
    { log: (e) => events.push(e) },
  );
});

test('built-in tier-probe id that IS ALSO in the live catalog still reconciles (live 503 repro)', async () => {
  // Live root cause: the real gateway catalog CONTAINS claude-haiku-4-5 and is
  // 503-overloading it. The client's ConfigHealth tier probe sends
  // claude-haiku-4-5; an in-catalog check alone would pass it through -> 503 ->
  // ConfigHealth 'unreachable'. A built-in tier-probe id must reconcile to the
  // configured healthy default EVEN WHEN present in the catalog.
  const events = [];
  await withStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }] },
    { healthyDefaultAlias: 'claude-opus-4-8' },
    async (local, adapter, gw) => {
      await fetch(`${local}/v1/models`); // haiku IS now in the live catalog

      const r = await fetch(`${local}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5', // built-in tier-probe id, ALSO in catalog
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      assert.equal(r.status, 200, 'tier probe must succeed after reconcile even when the id is in-catalog');
      const j = await r.json();
      assert.equal(j.model, 'claude-opus-4-8', 'upstream saw the healthy default, not the overloaded in-catalog haiku');

      const reconcile = events.find((e) => e.evt === 'tier-probe-reconcile');
      assert.ok(reconcile, 'tier-probe-reconcile event logged');
      assert.equal(reconcile.from, 'claude-haiku-4-5');
      assert.equal(reconcile.to, 'claude-opus-4-8');
      void gw;
    },
    { log: (e) => events.push(e) },
  );
});

test('a normal in-catalog model is NEVER reconciled (plan Phase 4 rule)', async () => {
  const events = [];
  await withStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }, { id: 'claude-opus-4-6' }] },
    { healthyDefaultAlias: 'claude-opus-4-8' },
    async (local) => {
      const models = await (await fetch(`${local}/v1/models`)).json();
      // Pick a real in-catalog alias that is NOT the healthy default.
      const picked = models.data.find((m) => m.claude_open.realId === 'claude-opus-4-6');
      assert.ok(picked, 'in-catalog model present');

      const r = await fetch(`${local}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: picked.id,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const j = await r.json();
      assert.equal(r.status, 200);
      // Upstream must have seen the user's chosen model, NOT the healthy default.
      assert.equal(j.model, 'claude-opus-4-6', 'user-picked in-catalog model preserved');
      // No reconcile diagnostic for an in-catalog model.
      assert.equal(events.find((e) => e.evt === 'tier-probe-reconcile'), undefined);
    },
    { log: (e) => events.push(e) },
  );
});

test('with NO configured healthy default, a tier-probe id is passed through unchanged', async () => {
  await withStack(
    { protocols: ['anthropic'], models: [{ id: 'claude-opus-4-8' }] },
    {}, // no healthyDefaultAlias configured
    async (local, adapter, gw) => {
      await fetch(`${local}/v1/models`);
      const r = await fetch(`${local}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const j = await r.json();
      // No reconcile -> upstream saw the original (unhealthy/absent) id. The
      // mock still 200s, but the point is: the adapter did not invent a target.
      assert.equal(j.model, 'claude-haiku-4-5', 'no reconcile without a configured default');
      void gw;
    },
  );
});
