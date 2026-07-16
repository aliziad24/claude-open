import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute } from '../src/router.js';

// Build a minimal normalized-model stub with registry-derived routes.
function model(realId, routes, extra = {}) {
  return { realId, routes, sourceMetadata: extra.sourceMetadata, unavailableReason: extra.unavailableReason };
}

test('precedence 1: explicit override wins over everything', () => {
  const d = resolveRoute({
    realId: 'x',
    override: { route: 'openai-chat' },
    model: model('x', ['anthropic']),
  });
  assert.equal(d.route, 'openai-chat');
  assert.equal(d.source, 'override');
});

test('override with invalid route is an honest unsupported result', () => {
  const d = resolveRoute({ realId: 'x', override: { route: 'grpc' } });
  assert.equal(d.route, null);
  assert.equal(d.source, 'unsupported');
});

test('precedence 2: gateway metadata beats registry', () => {
  const d = resolveRoute({
    realId: 'weird',
    model: model('weird', ['openai-chat'], { sourceMetadata: { supported_endpoints: ['/v1/responses'] } }),
  });
  assert.equal(d.route, 'openai-responses');
  assert.equal(d.source, 'metadata');
});

test('precedence 3: saved probe result beats registry', () => {
  const probeCache = new Map([['gw1::m', 'openai-responses']]);
  const d = resolveRoute({
    realId: 'm',
    model: model('m', ['openai-chat']),
    probeCache,
    gatewayFingerprint: 'gw1',
  });
  assert.equal(d.route, 'openai-responses');
  assert.equal(d.source, 'probe');
});

test('precedence 4: registry route is used and marked confident when singular', () => {
  const d = resolveRoute({ realId: 'claude-opus-4-8', model: model('claude-opus-4-8', ['anthropic']) });
  assert.equal(d.route, 'anthropic');
  assert.equal(d.source, 'registry');
  assert.equal(d.confident, true);
});

test('registry "unsupported" route yields an honest unsupported with reason', () => {
  const d = resolveRoute({
    realId: 'gpt-image-2',
    model: model('gpt-image-2', ['unsupported'], { unavailableReason: 'image-generation model' }),
  });
  assert.equal(d.route, null);
  assert.equal(d.source, 'unsupported');
  assert.match(d.reason, /image-generation/);
});

test('precedence 5: unknown model (no data) yields honest unknown, NOT a name guess', () => {
  const d = resolveRoute({ realId: 'gpt-5.5' }); // no model/registry data supplied
  assert.equal(d.route, null);
  assert.equal(d.source, 'unknown');
  assert.match(d.reason, /no route known/);
});

test('no vendor/model-name regex path exists: a gpt id with no data is unknown', () => {
  // Proves routing does not infer from the name 'gpt'.
  const d = resolveRoute({ realId: 'gpt-4.1', model: model('gpt-4.1', []) });
  assert.equal(d.route, null);
  assert.equal(d.source, 'unknown');
});
