// Security-review defect 2(a): readBody previously accumulated the entire
// request body into memory with NO size cap, so a local process could stream an
// unbounded body and OOM the adapter. The adapter now caps the body at
// maxBodyBytes (default 10MB) and returns HTTP 413 the moment the cap is
// exceeded, destroying the socket so no further bytes are buffered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../src/server.js';

function fixedSecret(value) {
  return { resolve: () => value, fingerprint: () => '<fixture>', source: () => 'fixture' };
}

async function withStack(adapterConfigExtra, fn) {
  const gw = createMockGateway({ protocols: ['anthropic'], models: [{ id: 'claude-opus-4-7' }] });
  const gwUrl = await gw.listen();
  const adapter = createAdapterServer({
    config: { baseUrl: gwUrl, auth: { kind: 'none' }, aliasSalt: 'test', ...adapterConfigExtra },
    secretStore: fixedSecret(null),
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

test('POST /v1/messages rejects an over-cap body with 413 (no OOM)', async () => {
  // Use a tiny cap so the test is cheap; the production default is 10MB.
  await withStack({ maxBodyBytes: 1024 }, async (local) => {
    const huge = 'x'.repeat(4096);
    const r = await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 8, messages: [{ role: 'user', content: huge }] }),
    });
    assert.equal(r.status, 413, 'an over-cap request body must be rejected with 413');
    const j = await r.json();
    assert.equal(j.error.type, 'request_too_large');
  });
});

test('a body within the cap is still accepted normally', async () => {
  await withStack({ maxBodyBytes: 10 * 1024 * 1024 }, async (local) => {
    const r = await fetch(`${local}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-7', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    // Not 413: a normal small body passes the cap (the mock gateway answers 200).
    assert.notEqual(r.status, 413);
  });
});

test('the default cap is 10MB when maxBodyBytes is not configured', async () => {
  await withStack({}, async (local, adapter) => {
    assert.equal(adapter.maxBodyBytes, 10 * 1024 * 1024);
  });
});
