import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAdapterServer } from '../../apps/adapter-server/src/server.js';

const noSecret = { resolve: () => null, fingerprint: () => 'none', source: () => 'none' };

test('expired catalog refreshes additions/removals and keeps the requested family order', async () => {
  let models = [
    { id: 'llama-3.3' },
    { id: 'qwen-3-coder' },
    { id: 'minimax-m2' },
    { id: 'kimi-k2' },
    { id: 'grok-4' },
    { id: 'gpt-5.5' },
    { id: 'claude-opus-4-8' },
  ];
  let discoveryRequests = 0;
  const gateway = http.createServer((req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      discoveryRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: models }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = gateway.address().port;
  const adapter = createAdapterServer({
    config: {
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      auth: { kind: 'none' },
      catalogTtlMs: 20,
    },
    secretStore: noSecret,
    gatewayFingerprint: 'catalog-refresh-order',
  });
  const adapterPort = await adapter.listen(0, '127.0.0.1');
  try {
    const first = await (await fetch(`http://127.0.0.1:${adapterPort}/v1/models`)).json();
    assert.deepEqual(first.data.map((model) => model.claude_open.realId), [
      'claude-opus-4-8',
      'gpt-5.5',
      'grok-4',
      'kimi-k2',
      'minimax-m2',
      'qwen-3-coder',
      'llama-3.3',
    ]);

    models = [{ id: 'qwen-3-coder' }, { id: 'claude-sonnet-4-6' }, { id: 'gpt-5.6' }];
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await (await fetch(`http://127.0.0.1:${adapterPort}/v1/models`)).json();
    assert.deepEqual(second.data.map((model) => model.claude_open.realId), [
      'claude-sonnet-4-6',
      'gpt-5.6',
      'qwen-3-coder',
    ]);
    assert.ok(discoveryRequests >= 2, 'TTL expiry must trigger another live discovery request');
  } finally {
    await adapter.close();
    await new Promise((resolve) => gateway.close(resolve));
  }
});
