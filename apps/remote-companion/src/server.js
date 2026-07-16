import http from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { APP_CSS, APP_JS, ICON_SVG, INDEX_HTML, MANIFEST, SERVICE_WORKER } from './ui.js';

const COOKIE = 'claude_open_companion';
const MAX_SESSIONS = 20;
// A 4K-token response can legitimately contain thousands of small SSE deltas.
// Keep enough bounded cursor history for a complete normal response instead of
// truncating reconnect state at an arbitrary few hundred chunks.
const MAX_EVENTS = 5_000;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_CHARS = 200_000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const DEVICE_TOKEN_MS = 12 * 60 * 60 * 1000;

export function createRemoteCompanionServer({ adapterBaseUrl, clientToken, fetchImpl = fetch, log = () => {}, now = () => Date.now(), pairingCode: pairingCodeOverride = null }) {
  if (!adapterBaseUrl || !clientToken) throw new Error('companion requires the authenticated loopback adapter');
  const pairingCode = pairingCodeOverride == null ? String(randomInt(100000, 1000000)) : String(pairingCodeOverride);
  if (!/^\d{6}$/.test(pairingCode)) throw new Error('companion pairing code must contain exactly six digits');
  const pairingExpiresAt = now() + 30 * 60 * 1000;
  const devices = new Map();
  const sessions = new Map();
  const failedPairs = [];
  let lockedUntil = 0;

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url || '/', 'http://companion.local');
    const path = parsed.pathname;
    const method = req.method || 'GET';
    setSecurityHeaders(req, res);
    log({ evt: 'companion-request', method, path });
    try {
      if (method === 'GET' && STATIC[path]) return sendStatic(res, STATIC[path]);
      if (method === 'POST' && path === '/api/pair') return await pair(req, res);
      if (method === 'GET' && path === '/api/status') return sendJson(res, 200, { paired: isAuthorized(req), product: 'claude-open-companion' });
      if (!isAuthorized(req)) return sendJson(res, 401, { error: 'pairing required' });
      if (method === 'POST' && !safeMutation(req)) return sendJson(res, 403, { error: 'same-origin JSON request required' });
      if (method === 'POST' && path === '/api/logout') return logout(res);
      if (method === 'GET' && path === '/api/models') return await proxyModels(res);
      if (method === 'GET' && path === '/api/usage') return await proxyUsage(res);
      if (method === 'POST' && path === '/api/sessions') return createSession(res);

      const match = path.match(/^\/api\/sessions\/([A-Za-z0-9_-]{20,64})(?:\/(messages|events|cancel))?$/);
      if (match) {
        const session = sessions.get(match[1]);
        if (!session) return sendJson(res, 404, { error: 'session expired' });
        session.touchedAt = now();
        if (method === 'GET' && !match[2]) return snapshot(res, session);
        if (method === 'GET' && match[2] === 'events') return openEvents(req, res, session);
        if (method === 'POST' && match[2] === 'messages') return await startMessage(req, res, session);
        if (method === 'POST' && match[2] === 'cancel') return cancelMessage(res, session);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      log({ evt: 'companion-error', msg: safeError(error) });
      if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.publicMessage || 'companion request failed' });
      else res.end();
    }
  });

  function isAuthorized(req) {
    const raw = parseCookies(req.headers.cookie || '')[COOKIE];
    if (!raw) return false;
    const hash = tokenHash(raw);
    const expiresAt = devices.get(hash);
    if (!expiresAt || expiresAt <= now()) {
      devices.delete(hash);
      return false;
    }
    return true;
  }

  async function pair(req, res) {
    if (!safeMutation(req)) return sendJson(res, 403, { error: 'same-origin JSON request required' });
    if (now() < lockedUntil) return sendJson(res, 429, { error: 'pairing temporarily locked; wait one minute' });
    const body = await readJson(req, 4096);
    const supplied = String(body.code || '');
    const valid = now() <= pairingExpiresAt && safeEqual(supplied, pairingCode);
    if (!valid) {
      const cutoff = now() - 10 * 60 * 1000;
      while (failedPairs.length && failedPairs[0] < cutoff) failedPairs.shift();
      failedPairs.push(now());
      if (failedPairs.length >= 5) {
        lockedUntil = now() + 60 * 1000;
        failedPairs.length = 0;
      }
      return sendJson(res, 401, { error: now() > pairingExpiresAt ? 'pairing code expired; restart Claude Open to rotate it' : 'incorrect pairing code' });
    }
    failedPairs.length = 0;
    const token = randomBytes(32).toString('base64url');
    devices.set(tokenHash(token), now() + DEVICE_TOKEN_MS);
    const secure = forwardedHttps(req) || !loopbackHost(req.headers.host);
    res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);
    return sendJson(res, 200, { ok: true, expiresAt: new Date(now() + DEVICE_TOKEN_MS).toISOString() });
  }

  function logout(res) {
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  async function proxyModels(res) {
    const response = await adapterFetch('/v1/models');
    if (!response.ok) return sendJson(res, response.status, { error: 'model discovery failed' });
    const body = await response.json();
    const data = (body.data || []).map((model) => ({
      id: model.id,
      display_name: model.display_name,
      effort_options: Array.isArray(model.effort_options) ? model.effort_options : [],
    }));
    return sendJson(res, 200, { data, stale: Boolean(body.stale) });
  }

  async function proxyUsage(res) {
    const response = await adapterFetch('/usage');
    if (!response.ok) return sendJson(res, response.status, { error: 'usage unavailable' });
    return sendJson(res, 200, await response.json());
  }

  function createSession(res) {
    prune();
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (oldest) destroySession(oldest);
    }
    const id = randomBytes(18).toString('base64url');
    sessions.set(id, { id, events: [], nextEventId: 1, history: [], subscribers: new Set(), busy: false, controller: null, touchedAt: now() });
    return sendJson(res, 201, { id });
  }

  function snapshot(res, session) {
    return sendJson(res, 200, { id: session.id, busy: session.busy, cursor: session.nextEventId - 1, events: session.events });
  }

  function openEvents(req, res, session) {
    const parsed = new URL(req.url, 'http://companion.local');
    const after = Math.max(Number(parsed.searchParams.get('after') || 0), Number(req.headers['last-event-id'] || 0)) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    for (const event of session.events) if (event.id > after) writeEvent(res, event);
    res.write(': connected\n\n');
    session.subscribers.add(res);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 20_000);
    const close = () => { clearInterval(heartbeat); session.subscribers.delete(res); };
    req.on('close', close);
    res.on('close', close);
  }

  async function startMessage(req, res, session) {
    if (session.busy) return sendJson(res, 409, { error: 'a response is already streaming' });
    const body = await readJson(req, 110_000);
    const text = String(body.text || '').trim();
    const model = String(body.model || '');
    const effort = body.effort == null ? null : String(body.effort);
    if (!text || text.length > 100_000) return sendJson(res, 400, { error: 'message must contain 1 to 100000 characters' });
    if (!model || model.length > 256) return sendJson(res, 400, { error: 'select a valid model' });
    if (effort && effort.length > 64) return sendJson(res, 400, { error: 'invalid effort value' });
    const userId = randomBytes(10).toString('base64url');
    const assistantId = randomBytes(10).toString('base64url');
    session.history.push({ role: 'user', content: text });
    trimHistory(session);
    push(session, 'user', { messageId: userId, text });
    push(session, 'assistant-start', { messageId: assistantId });
    session.busy = true;
    session.controller = new AbortController();
    void streamFromAdapter(session, { model, effort, assistantId }).catch((error) => {
      if (error.name === 'AbortError') push(session, 'cancelled', { messageId: assistantId });
      else push(session, 'error', { messageId: assistantId, message: safeError(error) });
    }).finally(() => {
      session.busy = false;
      session.controller = null;
      session.touchedAt = now();
    });
    return sendJson(res, 202, { accepted: true, messageId: assistantId });
  }

  function cancelMessage(res, session) {
    if (session.controller) session.controller.abort();
    return sendJson(res, 202, { cancelling: Boolean(session.controller) });
  }

  async function streamFromAdapter(session, { model, effort, assistantId }) {
    const response = await adapterFetch('/v1/messages', {
      method: 'POST',
      headers: effort ? { 'x-claude-open-effort': effort } : {},
      body: JSON.stringify({ model, max_tokens: 4096, stream: true, messages: session.history }),
      signal: session.controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(String(body.error?.message || `gateway request failed (${response.status})`).slice(0, 240));
    }
    let assistantText = '';
    try {
      for await (const frame of sseFrames(response.body)) {
        let value;
        try { value = JSON.parse(frame); } catch { continue; }
        const text = value.type === 'content_block_delta' && value.delta?.type === 'text_delta'
          ? value.delta.text
          : value.type === 'content_block_start' && value.content_block?.type === 'text'
            ? value.content_block.text
            : '';
        if (text) {
          assistantText += text;
          push(session, 'assistant-delta', { messageId: assistantId, text });
        }
      }
    } catch (error) {
      // Preserve the exact partial response the user already saw so a cancelled
      // or interrupted turn does not make the next request's context diverge.
      if (assistantText) {
        session.history.push({ role: 'assistant', content: assistantText });
        trimHistory(session);
      }
      throw error;
    }
    session.history.push({ role: 'assistant', content: assistantText });
    trimHistory(session);
    push(session, 'assistant-done', { messageId: assistantId });
  }

  function adapterFetch(path, options = {}) {
    return fetchImpl(`${adapterBaseUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json', ...(options.headers || {}) },
    });
  }

  function push(session, type, payload) {
    const event = { id: session.nextEventId++, type, payload, at: new Date(now()).toISOString() };
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
    for (const subscriber of session.subscribers) {
      if (!subscriber.writableEnded) writeEvent(subscriber, event);
    }
  }

  function trimHistory(session) {
    while (session.history.length > MAX_HISTORY_MESSAGES || historyChars(session.history) > MAX_HISTORY_CHARS) session.history.shift();
  }

  function prune() {
    const cutoff = now() - SESSION_IDLE_MS;
    for (const session of sessions.values()) if (session.touchedAt < cutoff) destroySession(session);
    for (const [hash, expiresAt] of devices) if (expiresAt <= now()) devices.delete(hash);
  }

  function destroySession(session) {
    if (session.controller) session.controller.abort();
    for (const res of session.subscribers) res.end();
    sessions.delete(session.id);
  }

  const cleanup = setInterval(prune, 60_000);
  cleanup.unref();

  return {
    server,
    pairingCode,
    pairingExpiresAt: new Date(pairingExpiresAt).toISOString(),
    async listen(preferredPort = 0, host = '127.0.0.1') {
      if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw new Error('Remote Companion must remain loopback-only behind a trusted HTTPS tunnel');
      return await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferredPort, host, () => { server.removeListener('error', reject); resolve(server.address().port); });
      });
    },
    async close() {
      clearInterval(cleanup);
      for (const session of sessions.values()) destroySession(session);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const STATIC = {
  '/': { type: 'text/html; charset=utf-8', body: INDEX_HTML, cache: 'no-store' },
  '/index.html': { type: 'text/html; charset=utf-8', body: INDEX_HTML, cache: 'no-store' },
  '/app.css': { type: 'text/css; charset=utf-8', body: APP_CSS, cache: 'public, max-age=3600' },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: APP_JS, cache: 'public, max-age=3600' },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: MANIFEST, cache: 'public, max-age=3600' },
  '/icon.svg': { type: 'image/svg+xml', body: ICON_SVG, cache: 'public, max-age=86400' },
  '/service-worker.js': { type: 'text/javascript; charset=utf-8', body: SERVICE_WORKER, cache: 'no-cache' },
};

function setSecurityHeaders(req, res) {
  res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'");
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  if (forwardedHttps(req) || !loopbackHost(req.headers.host)) {
    res.setHeader('strict-transport-security', 'max-age=31536000');
  }
}

function sendStatic(res, asset) {
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': asset.cache });
  res.end(asset.body);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function safeMutation(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function forwardedHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function loopbackHost(value = '') {
  let host;
  try { host = new URL(`http://${String(value)}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { return false; }
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.endsWith('.localhost');
}

async function readJson(req, maxBytes) {
  let bytes = 0;
  let text = '';
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw requestError(413, 'request body too large');
    text += chunk;
  }
  try { return JSON.parse(text || '{}'); } catch { throw requestError(400, 'invalid JSON'); }
}

function requestError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function parseCookies(value) {
  const result = {};
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeError(error) {
  const text = String(error?.message || error || 'request failed')
    .replace(/(authorization|x-api-key|bearer|token|cookie|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '<redacted>');
  return text.slice(0, 240);
}

function writeEvent(res, event) {
  res.write(`id: ${event.id}\nevent: companion\ndata: ${JSON.stringify(event)}\n\n`);
}

function historyChars(history) {
  return history.reduce((sum, item) => sum + String(item.content || '').length, 0);
}

async function* sseFrames(stream) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const normalized = buffer.replace(/\r\n/g, '\n');
    const blocks = normalized.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield data;
    }
    if (done) break;
  }
}
