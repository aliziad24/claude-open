import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../src/server.js';

// A static secret store stub (no OS calls) for tests.
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
      profile: 'mixed-auto',
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
    await fn(local, adapter);
  } finally {
    await adapter.close();
    await gw.close();
  }
}

test('real server: GET /health reports gateway + no secret', async () => {
  await withStack({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] }, {}, async (local) => {
    const r = await fetch(`${local}/health`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.ok(j.gateway);
    assert.equal(JSON.stringify(j).includes('secret') && JSON.stringify(j).match(/sk-|Bearer /) ? true : false, false);
  });
});

test('real server: GET /v1/models returns classified + aliased catalog, non-chat excluded', async () => {
  await withStack(
    {
      protocols: ['anthropic', 'openai-chat'],
      models: [{ id: 'claude-opus-4-7' }, { id: 'gpt-image-2' }, { id: 'voice-studio' }, { id: 'gpt-5.5' }],
    },
    {},
    async (local) => {
      const r = await fetch(`${local}/v1/models`);
      const j = await r.json();
      const ids = j.data.map((m) => m.claude_open.realId);
      assert.ok(ids.includes('claude-opus-4-7'));
      assert.ok(ids.includes('gpt-5.5'));
      assert.ok(!ids.includes('gpt-image-2'), 'image model must be excluded from chat picker');
      assert.ok(!ids.includes('voice-studio'), 'voice model must be excluded');
      // non-Claude models are presented under a picker-safe alias id
      const gpt = j.data.find((m) => m.claude_open.realId === 'gpt-5.5');
      assert.ok(gpt.id.startsWith('claude-3p-'));
      assert.equal(gpt.claude_open.modelType, 'reasoning-text');
    },
  );
});

test('real server: POST /v1/messages routes an alias back to its real model', async () => {
  await withStack({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b' }] }, {}, async (local) => {
    // discover to populate the alias map + catalog
    const models = await (await fetch(`${local}/v1/models`)).json();
    const alias = models.data.find((m) => m.claude_open.realId === 'llama-3.1-8b').id;
    const r = await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.content[0].text, 'chat-ok');
  });
});

test('real server logs request method and path without headers or bodies', async () => {
  const events = [];
  await withStack({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] }, {}, async (local) => {
    await fetch(`${local}/health?probe=phase0`, {
      headers: { authorization: 'Bearer PRIVATE-HEADER' },
    });

    const request = events.find((event) => event.evt === 'request');
    assert.deepEqual(request, { evt: 'request', method: 'GET', path: '/health' });
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE-HEADER|probe=phase0/);
  }, { log: (event) => events.push(event) });
});

test('real server: streaming /v1/messages yields Anthropic SSE frames', async () => {
  await withStack({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b' }] }, {}, async (local) => {
    await fetch(`${local}/v1/models`);
    const r = await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const text = await r.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
    const usage = await (await fetch(`${local}/usage`)).json();
    const model = usage.models.find((entry) => entry.model === 'llama-3.1-8b');
    assert.equal(model.requests, 1);
    assert.equal(model.lastRequest.stream, true);
    assert.equal(model.lastRequest.inputTokens, 9);
    assert.equal(model.lastRequest.outputTokens, 4);
  });
});

test('real server: count_tokens returns a labeled estimate for non-anthropic route', async () => {
  await withStack({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b' }] }, {}, async (local) => {
    await fetch(`${local}/v1/models`);
    const r = await fetch(`${local}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b', messages: [{ role: 'user', content: 'hello world' }] }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.ok(j.input_tokens >= 1);
    assert.equal(j._estimate, true);
  });
});

test('real server: /diagnostics requires the diag token', async () => {
  await withStack({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] }, {}, async (local, adapter) => {
    const forbidden = await fetch(`${local}/diagnostics`);
    assert.equal(forbidden.status, 403);
    const ok = await fetch(`${local}/diagnostics`, { headers: { 'x-claude-open-diag': adapter.diagToken } });
    const j = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(j.secret, '<fixture>');
    assert.ok(j.baseUrlHost);
  });
});

test('production client token protects catalog, deep health, and inference endpoints', async () => {
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] });
  const gwUrl = await gw.listen();
  const adapter = createAdapterServer({
    config: { baseUrl: gwUrl, auth: { kind: 'none' }, aliasSalt: 'secure' },
    secretStore: fixedSecret(null),
    clientToken: 'test-client',
  });
  const port = await adapter.listen(0, '127.0.0.1');
  const local = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${local}/v1/models`)).status, 401);
    assert.equal((await fetch(`${local}/health/deep`)).status, 401);
    assert.equal((await fetch(`${local}/usage`)).status, 401);
    assert.equal((await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 8, messages: [] }),
    })).status, 401);
    const headers = { authorization: 'Bearer test-client' };
    assert.equal((await fetch(`${local}/v1/models`, { headers })).status, 200);
    assert.equal((await fetch(`${local}/usage`, { headers })).status, 200);
    const deep = await (await fetch(`${local}/health/deep`, { headers })).json();
    assert.equal(deep.inference.status, 'pass');
    assert.equal(deep.healthy, true);
  } finally {
    await adapter.close();
    await gw.close();
  }
});

test('real server: /usage records real non-stream token usage and context without claiming quota', async () => {
  await withStack({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b', context_window: 128000 }] }, {}, async (local) => {
    await fetch(`${local}/v1/models`);
    const response = await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.1-8b', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    const usage = await (await fetch(`${local}/usage`)).json();
    const model = usage.models.find((entry) => entry.model === 'llama-3.1-8b');
    assert.equal(model.requests, 1);
    assert.equal(model.lastRequest.inputTokens, 4);
    assert.equal(model.lastRequest.outputTokens, 6);
    assert.equal(model.lastRequest.source, 'gateway-response');
    assert.equal(model.context.usedTokens, 10);
    assert.equal(usage.totals.totalTokens, 10);
    assert.equal(usage.quota.available, false);
    assert.equal(usage.quota.reason, 'not provided by gateway');
    assert.equal(usage.billing.available, false);
  });
});

test('real server: /usage fetches fresh account data through the configured gateway and active auth', async () => {
  await withStack(
    {
      protocols: ['anthropic'],
      models: [{ id: 'claude-opus-4-7' }],
      auth: { kind: 'bearer', secret: 'fixture-secret' },
      plan: { monthly_token_limit: 500_000_000 },
      accountUsage: { monthly_used: 141_448_246 },
    },
    {
      usage: {
        adapter: 'mapped',
        planEndpoint: '/api/billing/plan',
        usageEndpoint: '/api/billing/usage',
      },
    },
    async (local) => {
      const result = await (await fetch(`${local}/usage`)).json();
      assert.equal(result.gateway.source, 'configured-gateway');
      assert.equal(result.gateway.plan.available, true);
      assert.equal(result.gateway.plan.data.monthly_token_limit, 500_000_000);
      assert.equal(result.gateway.usage.data.monthly_used, 141_448_246);
      assert.equal(result.quota.source, 'gateway');
      assert.equal(result.billing.source, 'gateway');
      assert.ok(result.gateway.fetchedAt > 0);
      assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    },
  );
});

test('real server: port-conflict falls back to an ephemeral port (never assumes a fixed one)', async () => {
  // Occupy a port, then ask the adapter to prefer it; it must fall back.
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] });
  const gwUrl = await gw.listen();
  const a1 = createAdapterServer({ config: { baseUrl: gwUrl, auth: { kind: 'none' }, aliasSalt: 't' }, secretStore: fixedSecret(null) });
  const p1 = await a1.listen(0, '127.0.0.1');
  const a2 = createAdapterServer({ config: { baseUrl: gwUrl, auth: { kind: 'none' }, aliasSalt: 't' }, secretStore: fixedSecret(null) });
  const p2 = await a2.listen(p1, '127.0.0.1'); // prefer the busy port
  assert.notEqual(p2, p1, 'must not bind the busy port');
  assert.ok(p2 > 0);
  await a1.close();
  await a2.close();
  await gw.close();
});
