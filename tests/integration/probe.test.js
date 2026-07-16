// Proves the conformance probe distinguishes real acceptance from silent-ignore
// (SESSION-3 5.2) — never treating HTTP 200 alone as support. Uses a mock that
// can be configured to (a) validate the field strictly, or (b) ignore unknown
// fields and always 200.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeEffort } from '@claude-open/gateway-adapter';

function makeGateway({ mode }) {
  // mode: 'strict' rejects an invalid effort value; 'ignore' accepts anything.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch {}
      const effort = j?.reasoning?.effort;
      if (mode === 'strict' && effort === '__definitely_invalid_effort__') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid reasoning.effort value' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'r', output_text: 'ok', status: 'completed', usage: {} }));
    });
  });
  return {
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { await new Promise((r) => server.close(r)); },
  };
}

test('probe: strict gateway that rejects invalid value -> schema-accepted, not behavioral proof', async () => {
  const gw = makeGateway({ mode: 'strict' });
  const url = await gw.listen();
  try {
    const r = await probeEffort({
      baseUrl: url, headers: {}, route: 'openai-responses', realId: 'gpt-5.5',
      controlPatch: { path: 'reasoning.effort', value: 'high' }, fetchImpl: fetch,
    });
    assert.equal(r.result, 'schema-accepted');
  } finally { await gw.close(); }
});

test('probe: explicit response echo -> behavior-observed', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      if (j?.reasoning?.effort === '__definitely_invalid_effort__') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid reasoning.effort value' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output_text: 'ok', reasoning: j.reasoning || {} }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await probeEffort({ baseUrl: url, headers: {}, route: 'openai-responses', realId: 'm', controlPatch: { path: 'reasoning.effort', value: 'high' }, fetchImpl: fetch });
    assert.equal(r.result, 'behavior-observed');
  } finally { await new Promise((r) => server.close(r)); }
});

test('probe: gateway that ignores unknown fields -> silent-ignore (NOT accepted)', async () => {
  const gw = makeGateway({ mode: 'ignore' });
  const url = await gw.listen();
  try {
    const r = await probeEffort({
      baseUrl: url, headers: {}, route: 'openai-responses', realId: 'some-model',
      controlPatch: { path: 'reasoning.effort', value: 'high' }, fetchImpl: fetch,
    });
    assert.equal(r.result, 'silent-ignore', 'HTTP 200 with ignored field must NOT be "accepted"');
  } finally { await gw.close(); }
});

test('probe: auth failure surfaces as error, not accepted', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await probeEffort({
      baseUrl: url, headers: {}, route: 'openai-responses', realId: 'm',
      controlPatch: { path: 'reasoning.effort', value: 'high' }, fetchImpl: fetch,
    });
    assert.equal(r.result, 'error');
  } finally { await new Promise((r) => server.close(r)); }
});
