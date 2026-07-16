// P0.3 root-cause fix (NEXT-CORRECTIVE-WAVE): the Claude client's ConfigHealth /
// first-inference probe can hit a gateway model that is momentarily overloaded
// (HTTP 429/500/502/503/529). A single transient 5xx must NOT blackhole 3P
// activation. handleMessage retries the SAME real model with bounded backoff.
// It NEVER substitutes a different model (plan Phase 4 rule) and NEVER fakes a
// success: a persistent transient error is returned honestly after the retries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMessage } from '../src/handler.js';

const ANTHROPIC_MODEL = { realId: 'claude-opus-4-5', routes: ['anthropic'], provider: 'anthropic' };

function seqFetch(statuses, okBody) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, model: JSON.parse(init.body).model });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    const ok = status >= 200 && status < 300;
    const bodyText = ok ? JSON.stringify(okBody) : JSON.stringify({ error: { message: `overloaded ${status}` } });
    return {
      status,
      ok,
      async text() { return bodyText; },
      async json() { return JSON.parse(bodyText); },
    };
  };
  impl.calls = calls;
  return impl;
}

test('transient 503 then 200 on the anthropic route retries the SAME model and returns 200', async () => {
  const fetchImpl = seqFetch([503, 200], { type: 'message', content: [{ type: 'text', text: 'CLAUDE_OPEN_GATEWAY_OK' }] });
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'claude-opus-4-5', messages: [] },
    model: ANTHROPIC_MODEL,
    fetchImpl,
    retry: { attempts: 3, baseDelayMs: 0 },
  });
  assert.equal(result.status, 200);
  assert.equal(fetchImpl.calls.length, 2, 'should retry exactly once after the 503');
  // The retry must target the SAME real model, never a substitute.
  assert.ok(fetchImpl.calls.every((c) => c.model === 'claude-opus-4-5'));
});

test('persistent 503 is returned honestly after exhausting retries (no fake success)', async () => {
  const fetchImpl = seqFetch([503, 503, 503], {});
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'claude-opus-4-5', messages: [] },
    model: ANTHROPIC_MODEL,
    fetchImpl,
    retry: { attempts: 3, baseDelayMs: 0 },
  });
  assert.equal(result.status, 503, 'must surface the honest upstream status, not a synthetic 200');
  assert.equal(fetchImpl.calls.length, 3, 'should attempt exactly the configured number of times');
});

test('a non-transient 400 is NOT retried', async () => {
  const fetchImpl = seqFetch([400, 200], {});
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'claude-opus-4-5', messages: [] },
    model: ANTHROPIC_MODEL,
    fetchImpl,
    retry: { attempts: 3, baseDelayMs: 0 },
  });
  assert.equal(result.status, 400);
  assert.equal(fetchImpl.calls.length, 1, 'client errors must not be retried');
});

test('retry is bounded and defaults to a single attempt when not configured', async () => {
  const fetchImpl = seqFetch([503], {});
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'claude-opus-4-5', messages: [] },
    model: ANTHROPIC_MODEL,
    fetchImpl,
  });
  assert.equal(result.status, 503);
  assert.equal(fetchImpl.calls.length, 1, 'default is no extra retries unless explicitly enabled');
});
