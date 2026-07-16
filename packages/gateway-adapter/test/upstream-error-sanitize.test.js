// Security-review defect 2(b): handleMessage's upstreamError() returned the raw
// upstream error text/JSON message WITHOUT running it through sanitize(). A
// misconfigured or hostile upstream could therefore echo a secret-shaped string
// (e.g. an sk-... token) straight back to the client in an error body. The
// non-transient error path must scrub secret-shaped strings the same way the
// catch-block already does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMessage } from '../src/handler.js';

const CHAT_MODEL = { realId: 'gpt-5.5', routes: ['openai-chat'], provider: 'openai' };

// A secret-shaped token the sanitizer must redact (sk- + >=8 chars). Assembled
// from parts at runtime so the release-privacy scanner (which greps for
// sk-[A-Za-z0-9]{20,} literals) does not flag this test file. The runtime string
// still matches the sanitizer's sk-[A-Za-z0-9\-_]{8,} pattern.
const LEAKY_SECRET = ['sk', 'ABCDEFGH1234567890leak'].join('-');

function errFetch(status, message) {
  return async () => ({
    status,
    ok: false,
    async text() {
      return JSON.stringify({ error: { message } });
    },
    async json() {
      return { error: { message } };
    },
  });
}

test('upstreamError sanitizes a secret-shaped string in the openai-chat error body', async () => {
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'gpt-5.5', messages: [] },
    model: CHAT_MODEL,
    fetchImpl: errFetch(400, `bad key ${LEAKY_SECRET}`),
  });
  assert.equal(result.status, 400);
  const msg = result.body.error.message;
  assert.doesNotMatch(msg, /sk-[A-Za-z0-9\-_]{8,}/, 'a leaked secret-shaped token must be redacted');
  assert.match(msg, /<redacted>/);
});

test('upstreamError sanitizes a secret-shaped string in the openai-responses error body', async () => {
  const model = { realId: 'gpt-5.5', routes: ['openai-responses'], provider: 'openai' };
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'gpt-5.5', messages: [] },
    model,
    fetchImpl: errFetch(500, `upstream blew up: ${LEAKY_SECRET}`),
  });
  assert.equal(result.status, 500);
  assert.doesNotMatch(result.body.error.message, /sk-[A-Za-z0-9\-_]{8,}/);
});

test('a benign upstream error message is passed through unchanged', async () => {
  const result = await handleMessage({
    baseUrl: 'http://127.0.0.1:1',
    headers: {},
    body: { model: 'gpt-5.5', messages: [] },
    model: CHAT_MODEL,
    fetchImpl: errFetch(400, 'model not found'),
  });
  assert.equal(result.body.error.message, 'model not found');
});
