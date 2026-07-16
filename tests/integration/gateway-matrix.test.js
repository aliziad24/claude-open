import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway } from '../fixtures/mock-gateway.mjs';
import { handleMessage, runHealthChecks } from '@claude-open/gateway-adapter';
import { AliasMap, normalizeCatalog, CatalogCache } from '@claude-open/model-catalog';
import { loadRegistry, resolveCapabilities } from '@claude-open/model-registry';

const registry = loadRegistry();
const resolveCaps = (id) => resolveCapabilities(registry, id);
// normalize a raw list into models keyed by realId for the handler.
function catalogByType(rawList, aliasMap) {
  return normalizeCatalog(rawList, aliasMap, { resolveCaps });
}
function modelFor(realId, aliasMap) {
  return normalizeCatalog([{ id: realId }], aliasMap, { resolveCaps })[0];
}

// Helper: build resolved auth headers for a given auth config.
function authHeaders(auth) {
  if (!auth || auth.kind === 'none') return {};
  if (auth.kind === 'bearer') return { authorization: `Bearer ${auth.secret}` };
  if (auth.kind === 'x-api-key') return { 'x-api-key': auth.secret };
  if (auth.kind === 'custom-header') return { [auth.headerName]: auth.secret };
  return {};
}

async function withGateway(config, fn) {
  const gw = createMockGateway(config);
  const baseUrl = await gw.listen();
  try {
    await fn(baseUrl, gw);
  } finally {
    await gw.close();
  }
}

test('anthropic-only gateway: passthrough chat succeeds', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl,
      headers: {},
      body: { model: 'claude-opus-4-7', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      model: modelFor('claude-opus-4-7', aliasMap),
      fetchImpl: fetch,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.content[0].text, 'anthropic-ok');
    assert.deepEqual(r.body.usage, { input_tokens: 3, output_tokens: 2 });
  });
});

test('openai-chat-only gateway: translated chat succeeds', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b' }] }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl,
      headers: {},
      body: { model: 'llama-3.1-8b', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] },
      model: modelFor('llama-3.1-8b', aliasMap),
      fetchImpl: fetch,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.content[0].text, 'chat-ok');
    assert.deepEqual(r.body.usage, { input_tokens: 4, output_tokens: 6 });
  });
});

test('openai-responses route: real output_config effort is honored; budget alone adds nothing', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['openai-responses'], models: [{ id: 'gpt-5.5' }] }, async (baseUrl) => {
    // Explicit categorical selection is used verbatim.
    const explicit = await handleMessage({
      baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('gpt-5.5', aliasMap),
      body: { model: 'gpt-5.5', max_tokens: 32, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(explicit.body.content[0].text, 'responses-ok(effort=high)');

    // A bare token budget must NOT be inferred and no default is injected.
    const budgetOnly = await handleMessage({
      baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('gpt-5.5', aliasMap),
      body: { model: 'gpt-5.5', max_tokens: 32, thinking: { type: 'enabled', budget_tokens: 100000 }, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(budgetOnly.body.content[0].text, 'responses-ok', 'budget must not create categorical effort');
  });
});

test('mixed gateway: per-model routing sends each model to the right endpoint', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway(
    {
      protocols: ['anthropic', 'openai-chat', 'openai-responses'],
      models: [{ id: 'claude-opus-4-7' }, { id: 'llama-3.1-8b' }, { id: 'gpt-5.5' }],
    },
    async (baseUrl) => {
      const claude = await handleMessage({
        baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('claude-opus-4-7', aliasMap),
        body: { model: 'claude-opus-4-7', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
      });
      assert.equal(claude.body.content[0].text, 'anthropic-ok');

      const llama = await handleMessage({
        baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('llama-3.1-8b', aliasMap),
        body: { model: 'llama-3.1-8b', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
      });
      assert.equal(llama.body.content[0].text, 'chat-ok');

      const gpt = await handleMessage({
        baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('gpt-5.5', aliasMap),
        body: { model: 'gpt-5.5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
      });
      assert.equal(gpt.body.content[0].text, 'responses-ok');
    },
  );
});

test('image-generation model is refused with an honest reason (not chat-routed)', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['openai-chat'], models: [{ id: 'gpt-image-2' }] }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('gpt-image-2', aliasMap),
      body: { model: 'gpt-image-2', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /image-generation|not usable/i);
  });
});

test('bearer auth: correct token passes, wrong token gives honest 401', async () => {
  const auth = { kind: 'bearer', secret: 'test-token-abc' };
  await withGateway({ protocols: ['anthropic'], auth }, async (baseUrl) => {
    const ok = await runHealthChecks({ baseUrl, headers: authHeaders(auth), fetchImpl: fetch });
    assert.equal(ok.auth.status, 'pass');

    const bad = await runHealthChecks({ baseUrl, headers: { authorization: 'Bearer WRONG' }, fetchImpl: fetch });
    assert.equal(bad.auth.status, 'fail');
    assert.equal(bad.healthy, false);
  });
});

test('x-api-key auth works', async () => {
  const auth = { kind: 'x-api-key', secret: 'k-123' };
  await withGateway({ protocols: ['anthropic'], auth }, async (baseUrl) => {
    const r = await runHealthChecks({ baseUrl, headers: authHeaders(auth), fetchImpl: fetch });
    assert.equal(r.auth.status, 'pass');
  });
});

test('custom tenant header auth works', async () => {
  const auth = { kind: 'custom-header', headerName: 'x-tenant-key', secret: 'acme-secret' };
  await withGateway({ protocols: ['anthropic'], auth }, async (baseUrl) => {
    const r = await runHealthChecks({ baseUrl, headers: authHeaders(auth), fetchImpl: fetch });
    assert.equal(r.auth.status, 'pass');
  });
});

test('temporarily failing /v1/models: cache serves last-known-good marked stale', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  const cache = new CatalogCache({ ttlMs: 10 });

  // First a healthy fetch to seed last-known-good.
  await withGateway({ models: [{ id: 'claude-opus-4-7' }, { id: 'gpt-5.5' }] }, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/v1/models`);
    const body = await resp.json();
    cache.recordFresh(normalizeCatalog(body.data, aliasMap, { resolveCaps }), resp.headers.get('etag'));
  });
  assert.equal(cache.serve().models.length, 2);

  // Now the gateway fails discovery: keep serving the 2 models, marked stale.
  await withGateway({ failModels: true }, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/v1/models`);
    if (!resp.ok) cache.recordFailure(`gateway ${resp.status} during discovery`);
  });
  const served = cache.serve();
  assert.equal(served.models.length, 2, 'does not drop to empty picker');
  assert.equal(served.stale, true);
  assert.match(served.reason, /503/);
});

test('ETag conditional request yields 304 and refreshes without re-download', async () => {
  await withGateway({ models: [{ id: 'claude-opus-4-7' }], etag: 'W/"v1"' }, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/v1/models`);
    assert.equal(first.headers.get('etag'), 'W/"v1"');
    const second = await fetch(`${baseUrl}/v1/models`, { headers: { 'if-none-match': 'W/"v1"' } });
    assert.equal(second.status, 304);
  });
});

test('reordered/renamed/removed models keep stable aliases across fetches', async () => {
  const aliasMap = new AliasMap({ salt: 'stable-salt' });

  let firstMap;
  await withGateway({ models: [{ id: 'gpt-5.5' }, { id: 'gemini-3-pro-preview' }, { id: 'llama-3.1-8b' }] }, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/v1/models`)).json();
    const cat = normalizeCatalog(body.data, aliasMap, { resolveCaps });
    firstMap = Object.fromEntries(cat.map((m) => [m.realId, m.stableAlias]));
  });

  // reordered + one removed + one added
  await withGateway({ models: [{ id: 'llama-3.1-8b' }, { id: 'gpt-5.5' }, { id: 'qwen-2.5-coder-14b' }] }, async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/v1/models`)).json();
    const cat = normalizeCatalog(body.data, aliasMap, { resolveCaps });
    const byId = Object.fromEntries(cat.map((m) => [m.realId, m.stableAlias]));
    assert.equal(byId['gpt-5.5'], firstMap['gpt-5.5'], 'gpt-5.5 alias changed after reorder');
    assert.equal(byId['llama-3.1-8b'], firstMap['llama-3.1-8b'], 'llama alias changed after reorder');
    assert.ok(byId['qwen-2.5-coder-14b'], 'new model got an alias');
  });
});

test('tool-call round-trip through openai-chat translation', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['openai-chat'], models: [{ id: 'llama-3.1-8b' }] }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('llama-3.1-8b', aliasMap),
      body: {
        model: 'llama-3.1-8b', max_tokens: 64,
        tools: [{ name: 'echo', description: 'echo', input_schema: { type: 'object', properties: { value: { type: 'string' } } } }],
        messages: [{ role: 'user', content: 'call echo' }],
      },
    });
    assert.equal(r.status, 200);
    const toolUse = r.body.content.find((c) => c.type === 'tool_use');
    assert.equal(toolUse.name, 'echo');
    assert.deepEqual(toolUse.input, { value: 'hi' });
    assert.equal(r.body.stop_reason, 'tool_use');
  });
});

test('unknown model (no data) returns honest error, never a name-based guess', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  await withGateway({ protocols: ['anthropic'] }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl, headers: {}, fetchImpl: fetch, model: modelFor('totally-unknown-xyz', aliasMap),
      body: { model: 'totally-unknown-xyz', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /no route known/);
  });
});

test('bad-credentials on a real message returns honest upstream 401, no fake success', async () => {
  const aliasMap = new AliasMap({ salt: 's' });
  const auth = { kind: 'bearer', secret: 'right' };
  await withGateway({ protocols: ['anthropic'], auth }, async (baseUrl) => {
    const r = await handleMessage({
      baseUrl, headers: { authorization: 'Bearer wrong' }, fetchImpl: fetch, model: modelFor('claude-opus-4-7', aliasMap),
      body: { model: 'claude-opus-4-7', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 401);
  });
});
