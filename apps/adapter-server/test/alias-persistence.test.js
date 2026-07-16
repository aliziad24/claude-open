// Defect 2.7: alias mappings must persist across REAL server restarts so that
// alias->realId is stable (no collision drift). Proven by starting a server,
// recording aliases, stopping it, starting a NEW server against the same alias
// store + a REORDERED catalog, and asserting the aliases are identical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockGateway } from '../../../tests/fixtures/mock-gateway.mjs';
import { createAdapterServer } from '../src/server.js';

function fixedSecret() {
  return { resolve: () => null, fingerprint: () => '<none>', source: () => 'none' };
}

async function aliasesFrom(gwModels, aliasStorePath) {
  const gw = createMockGateway({ protocols: ['anthropic', 'openai-chat'], models: gwModels });
  const gwUrl = await gw.listen();
  const adapter = createAdapterServer({
    config: { baseUrl: gwUrl, auth: { kind: 'none' }, aliasSalt: 'persist-test' },
    secretStore: fixedSecret(),
    aliasStorePath,
    gatewayFingerprint: 'fp-fixed',
  });
  const port = await adapter.listen(0, '127.0.0.1');
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const j = await res.json();
  const map = Object.fromEntries(j.data.map((m) => [m.claude_open.realId, m.id]));
  await adapter.close();
  await gw.close();
  return map;
}

test('aliases persist and stay stable across a real restart with a reordered catalog', async () => {
  const store = mkdtempSync(join(tmpdir(), 'co-alias-'));
  try {
    // First server run: original catalog order.
    const first = await aliasesFrom(
      [{ id: 'gpt-5.5' }, { id: 'gemini-3-pro-preview' }, { id: 'llama-3.1-8b' }],
      store,
    );
    assert.ok(first['gpt-5.5'].startsWith('claude-3p-'));

    // Second server run (fresh process/object) against the SAME alias store,
    // catalog REORDERED + one new model. Prior aliases must be identical.
    const second = await aliasesFrom(
      [{ id: 'llama-3.1-8b' }, { id: 'gpt-5.5' }, { id: 'gemini-3-pro-preview' }, { id: 'qwen-2.5-coder-14b' }],
      store,
    );
    assert.equal(second['gpt-5.5'], first['gpt-5.5'], 'gpt-5.5 alias drifted across restart');
    assert.equal(second['gemini-3-pro-preview'], first['gemini-3-pro-preview'], 'gemini alias drifted');
    assert.equal(second['llama-3.1-8b'], first['llama-3.1-8b'], 'llama alias drifted');
    assert.ok(second['qwen-2.5-coder-14b'], 'new model still gets an alias');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
