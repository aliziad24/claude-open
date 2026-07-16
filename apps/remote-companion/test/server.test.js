import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteCompanionServer } from '../src/server.js';

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://${host}:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function pair(base, code, extraHeaders = {}) {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...extraHeaders },
    body: JSON.stringify({ code }),
  });
  return { response, cookie: cookieFrom(response), body: await response.json() };
}

test('companion stays loopback-only and requires rate-limited pairing', async (t) => {
  const adapter = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const adapterBaseUrl = await listen(adapter);
  const logs = [];
  const companion = createRemoteCompanionServer({ adapterBaseUrl, clientToken: 'local-client-token-for-test', log: (line) => logs.push(line) });
  const port = await companion.listen();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await companion.close(); await close(adapter); });

  assert.equal(companion.server.address().address, '127.0.0.1');
  await assert.rejects(() => companion.listen(0, '0.0.0.0'), /loopback-only/);

  const shell = await fetch(base);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get('x-frame-options'), 'DENY');
  assert.equal(shell.headers.get('access-control-allow-origin'), null);

  const unauthorized = await fetch(`${base}/api/status`);
  assert.equal(unauthorized.status, 200);
  assert.equal((await unauthorized.json()).paired, false);

  const wrong = await pair(base, '000000');
  assert.equal(wrong.response.status, 401);

  const paired = await pair(base, companion.pairingCode, { 'x-forwarded-proto': 'https' });
  assert.equal(paired.response.status, 200);
  assert.equal(paired.body.ok, true);
  assert.equal(Object.hasOwn(paired.body, 'token'), false);
  assert.match(paired.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(paired.response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(paired.response.headers.get('set-cookie'), /Secure/);
  assert.match(paired.response.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.ok(paired.cookie.startsWith('claude_open_companion='));
  assert.equal(JSON.stringify(logs).includes(companion.pairingCode), false);
  assert.equal(JSON.stringify(logs).includes('local-client-token-for-test'), false);

  const authorized = await fetch(`${base}/api/status`, { headers: { cookie: paired.cookie } });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).paired, true);

  const crossSite = await fetch(`${base}/api/logout`, {
    method: 'POST',
    headers: { cookie: paired.cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  await crossSite.text();

  const invalidJson = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: '{',
  });
  assert.equal(invalidJson.status, 400);
  await invalidJson.text();
});

test('stream continues through disconnect and authenticated snapshot resumes every event', async (t) => {
  const adapterRequests = [];
  const adapter = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer adapter-client-token');
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'model-alias', display_name: 'Test Model', effort_options: [{ id: 'high', name: 'High' }] }] }));
    }
    if (req.url === '/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ total: { input_tokens: 4, output_tokens: 2 } }));
    }
    if (req.url === '/v1/messages') {
      let input = '';
      for await (const chunk of req) input += chunk;
      adapterRequests.push({ message: JSON.parse(input), effort: req.headers['x-claude-open-effort'] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (let i = 0; i < 600; i++) {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n');
      }
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n');
      setTimeout(() => {
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" mobile"}}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 35);
      return;
    }
    res.writeHead(404); res.end();
  });
  const adapterBaseUrl = await listen(adapter);
  const companion = createRemoteCompanionServer({
    adapterBaseUrl,
    clientToken: 'adapter-client-token',
  });
  const port = await companion.listen();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await companion.close(); await close(adapter); });

  const paired = await pair(base, companion.pairingCode);
  const headers = { cookie: paired.cookie, 'content-type': 'application/json', origin: base };
  const models = await (await fetch(`${base}/api/models`, { headers })).json();
  assert.deepEqual(models.data[0].effort_options, [{ id: 'high', name: 'High' }]);

  const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: '{}' });
  assert.equal(created.status, 201);
  const session = await created.json();
  const accepted = await fetch(`${base}/api/sessions/${session.id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'model-alias', effort: 'high', text: 'Say hello' }),
  });
  assert.equal(accepted.status, 202);

  let snapshot;
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    snapshot = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
    if (!snapshot.busy && snapshot.events.some((event) => event.type === 'assistant-done')) break;
  }
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.events.filter((event) => event.type === 'assistant-delta').map((event) => event.payload.text).join(''), `${'x'.repeat(600)}Hello mobile`);
  assert.equal(snapshot.events.find((event) => event.type === 'user').payload.text, 'Say hello');
  assert.equal(adapterRequests[0].effort, 'high');
  assert.equal(adapterRequests[0].message.model, 'model-alias');
  assert.equal(adapterRequests[0].message.stream, true);

  // A new browser connection can authenticate with the same HttpOnly cookie and
  // reconstruct the complete in-memory session from event zero.
  const resumed = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
  assert.deepEqual(resumed.events, snapshot.events);

  const abort = new AbortController();
  const eventResponse = await fetch(`${base}/api/sessions/${session.id}/events?after=0`, { headers, signal: abort.signal });
  assert.equal(eventResponse.status, 200);
  const firstChunk = await eventResponse.body.getReader().read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: companion/);
  abort.abort();
});
