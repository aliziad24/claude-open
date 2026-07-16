// SESSION-4 phase 3.2 regression test reproducing the live facts:
//   - saved silent-ignore for GLM/Gemini -> NO selector advertised, NO effort field sent
//   - saved accepted gpt-5.5/reasoning.effort=high -> enabled AND sent
// Uses the real ConformanceStore + real adapter server + request-capturing mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGateway } from '../fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../../apps/adapter-server/src/server.js';
import { ConformanceStore } from '@claude-open/gateway-adapter';

function secret() {
  return { resolve: () => null, fingerprint: () => '<none>', source: () => 'none' };
}
const FP = 'fp-test';

async function stackWith(models, conformance, probeStorePath = null) {
  const gw = createMockGateway({ protocols: ['openai-responses', 'openai-chat', 'anthropic'], models });
  const url = await gw.listen();
  const adapter = createAdapterServer({
    config: { baseUrl: url, auth: { kind: 'none' }, aliasSalt: 't' },
    secretStore: secret(),
    gatewayFingerprint: FP,
    conformanceStore: conformance,
    probeStorePath,
  });
  const port = await adapter.listen(0, '127.0.0.1');
  return { gw, adapter, base: `http://127.0.0.1:${port}`, close: async () => { await adapter.close(); await gw.close(); } };
}

test('behavior-observed gpt-5.5/high -> selector advertised AND effort sent upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-conf-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    store.record({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high', result: 'behavior-observed', evidence: 'upstream echoed reasoning.effort=high' });

    const s = await stackWith([{ id: 'gpt-5.5' }], store);
    try {
      // /v1/models advertises the selector (behaviorally proven)
      const models = await (await fetch(`${s.base}/v1/models`)).json();
      const gpt = models.data.find((m) => m.claude_open.realId === 'gpt-5.5');
      assert.equal(gpt.claude_open.reasoning.source, 'probe');
      assert.deepEqual(gpt.claude_open.reasoning.values, ['high']);
      assert.equal(gpt.claude_open.reasoning.verification, 'behavior-observed');

      // a request with explicit effort=high actually sends reasoning.effort upstream
      await fetch(`${s.base}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', max_tokens: 16, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'x' }] }),
      });
      const req = s.gw.lastRequest();
      assert.equal(req.endpoint, '/v1/responses');
      assert.equal(req.body.reasoning.effort, 'high');
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema-accepted gpt-5.5/high -> recorded but NOT verified: NO selector advertised, NO effort sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-conf-schema-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    // schema-accepted proves the field forwarded/validated only — it is a
    // truth-state, but Phase 6 says it must never flip a selector to verified.
    store.record({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high', result: 'schema-accepted', evidence: 'invalid rejected while valid accepted' });

    // The record is still persisted as a truth-state (kept, not enabling).
    assert.equal(
      store.lookup({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high' }).result,
      'schema-accepted',
    );
    assert.equal(
      store.isEnabled({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high' }),
      false,
    );

    const s = await stackWith([{ id: 'gpt-5.5' }], store);
    try {
      // /v1/models must NOT advertise a selector for a merely schema-accepted value.
      const models = await (await fetch(`${s.base}/v1/models`)).json();
      const gpt = models.data.find((m) => m.claude_open.realId === 'gpt-5.5');
      assert.equal(gpt.claude_open.reasoning.controlType, 'unknown', 'schema-accepted must not advertise a control');
      assert.ok(!gpt.claude_open.reasoning.values, 'no values may be advertised for schema-accepted only');

      // and an explicit effort=high must NOT be forwarded upstream.
      await fetch(`${s.base}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', max_tokens: 16, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'x' }] }),
      });
      const req = s.gw.lastRequest();
      assert.equal(req.body.reasoning, undefined, 'schema-accepted-only effort must not be sent upstream');
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verified Control Center selection persists and changes future upstream bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-pref-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    store.record({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high', result: 'behavior-observed', evidence: 'upstream echoed reasoning.effort=high' });
    const s = await stackWith([{ id: 'gpt-5.5' }], store, dir);
    try {
      const set = await fetch(`${s.base}/control/set-effort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-open-diag': s.adapter.diagToken },
        body: JSON.stringify({ model: 'gpt-5.5', value: 'high' }),
      });
      assert.equal(set.status, 200);
      assert.equal((await set.json()).applied, true);

      await fetch(`${s.base}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(s.gw.lastRequest().body.reasoning.effort, 'high');
      assert.match(JSON.stringify(await (await fetch(`${s.base}/v1/models`)).json()), /"selected":"high"/);
    } finally { await s.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verified effort preference survives an adapter restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-pref-restart-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    store.record({ fingerprint: FP, realId: 'gpt-5.5', route: 'openai-responses', field: 'reasoning.effort', value: 'high', result: 'behavior-observed', evidence: 'explicit echo' });
    const first = await stackWith([{ id: 'gpt-5.5' }], store, dir);
    await fetch(`${first.base}/control/set-effort`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-open-diag': first.adapter.diagToken },
      body: JSON.stringify({ model: 'gpt-5.5', value: 'high' }),
    });
    await first.close();

    const second = await stackWith([{ id: 'gpt-5.5' }], store, dir);
    try {
      await fetch(`${second.base}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(second.gw.lastRequest().body.reasoning.effort, 'high');
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saved silent-ignore glm-5.2 -> NO selector advertised AND NO effort field sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-conf-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    store.record({ fingerprint: FP, realId: 'glm-5.2', route: 'openai-chat', field: 'thinking.type', value: 'enabled', result: 'silent-ignore', evidence: 'invalid also accepted (HTTP 200)' });

    const s = await stackWith([{ id: 'glm-5.2' }], store);
    try {
      const models = await (await fetch(`${s.base}/v1/models`)).json();
      const glm = models.data.find((m) => m.claude_open.realId === 'glm-5.2');
      // silent-ignore -> control downgraded, no selector advertised
      assert.notEqual(glm.claude_open.reasoning.controlType, 'boolean');
      assert.ok(!glm.claude_open.reasoning.values, 'no values should be advertised');

      await fetch(`${s.base}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'glm-5.2', max_tokens: 16, thinking: { type: 'enabled' }, messages: [{ role: 'user', content: 'x' }] }),
      });
      const req = s.gw.lastRequest();
      assert.equal(req.endpoint, '/v1/chat/completions');
      assert.equal(req.body.thinking, undefined, 'no thinking field must be sent for a silent-ignored control');
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no probe yet -> documented control is treated as unverified (no selector)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-conf-'));
  try {
    const store = new ConformanceStore({ filePath: join(dir, 'c.json') });
    const s = await stackWith([{ id: 'gpt-5.5' }], store); // no recorded probe
    try {
      const models = await (await fetch(`${s.base}/v1/models`)).json();
      const gpt = models.data.find((m) => m.claude_open.realId === 'gpt-5.5');
      assert.equal(gpt.claude_open.reasoning.controlType, 'unknown', 'unverified documented effort must not be advertised');
    } finally {
      await s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
