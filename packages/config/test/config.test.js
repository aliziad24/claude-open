import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig,
  redactSecret,
  validateBaseUrl,
  validateAuth,
  validateCustomHeaders,
  validateConfig,
  COMPATIBILITY_PROFILES,
} from '../src/index.js';
import { loadStoredConfig } from '../src/store.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('defaultConfig has no vendor-specific hard-coded values', () => {
  const c = defaultConfig();
  assert.equal(c.baseUrl, '');
  assert.equal(c.profile, 'mixed-auto');
  assert.deepEqual(c.routes, []);
  assert.deepEqual(c.modelOverrides, {});
});

test('redactSecret never exposes more than head + length', () => {
  assert.equal(redactSecret('supersecretvalue123'), 'supe…(len=19)');
  assert.equal(redactSecret(''), '<none>');
  assert.equal(redactSecret(null), '<none>');
  assert.equal(redactSecret(undefined), '<none>');
});

test('validateBaseUrl requires a URL', () => {
  assert.equal(validateBaseUrl('').ok, false);
  assert.equal(validateBaseUrl('   ').ok, false);
});

test('validateBaseUrl rejects non-http(s) schemes', () => {
  const r = validateBaseUrl('ftp://example.com');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('scheme')));
});

test('validateBaseUrl rejects embedded credentials', () => {
  const r = validateBaseUrl('https://user:secret@example.com');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('embedded credentials')));
});

test('validateBaseUrl requires https for non-loopback', () => {
  assert.equal(validateBaseUrl('http://gateway.example.com').ok, false);
  assert.equal(validateBaseUrl('https://gateway.example.com').ok, true);
});

test('validateBaseUrl allows http on loopback', () => {
  assert.equal(validateBaseUrl('http://127.0.0.1:8788').ok, true);
  assert.equal(validateBaseUrl('http://localhost:9000').ok, true);
});

test('validateAuth: bearer requires credentialRef or secret', () => {
  assert.equal(validateAuth({ kind: 'bearer' }).ok, false);
  assert.equal(validateAuth({ kind: 'bearer', credentialRef: 'ref-1' }).ok, true);
});

test('validateAuth: inline secret warns but passes', () => {
  const r = validateAuth({ kind: 'x-api-key', secret: 'k' });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('credentialRef')));
});

test('validateAuth: custom-header requires headerName', () => {
  assert.equal(validateAuth({ kind: 'custom-header', credentialRef: 'r' }).ok, false);
  assert.equal(
    validateAuth({ kind: 'custom-header', credentialRef: 'r', headerName: 'x-tenant-key' }).ok,
    true,
  );
});

test('validateAuth: none needs no secret', () => {
  assert.equal(validateAuth({ kind: 'none' }).ok, true);
});

test('validateAuth: unknown kind fails', () => {
  assert.equal(validateAuth({ kind: 'oauth2' }).ok, false);
});

test('validateCustomHeaders rejects reserved headers', () => {
  assert.equal(validateCustomHeaders({ Host: 'x' }).ok, false);
  assert.equal(validateCustomHeaders({ 'content-length': '5' }).ok, false);
  assert.equal(validateCustomHeaders({ 'x-tenant': 'acme' }).ok, true);
});

test('validateCustomHeaders rejects secret-bearing auth headers', () => {
  for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Proxy-Authorization']) {
    const r = validateCustomHeaders({ [name]: 'must-not-be-in-config' });
    assert.equal(r.ok, false, name);
  }
});

test('validateCustomHeaders rejects invalid names and non-string values', () => {
  assert.equal(validateCustomHeaders({ 'bad header': 'v' }).ok, false);
  assert.equal(validateCustomHeaders({ 'x-n': 5 }).ok, false);
});

test('validateConfig: full valid config normalizes', () => {
  const r = validateConfig({
    baseUrl: 'https://gateway.example.com',
    auth: { kind: 'bearer', credentialRef: 'cred-abc' },
    profile: 'openai-chat',
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.config.modelsEndpoint, '/v1/models');
  assert.deepEqual(r.config.routes, []);
});

test('validateConfig: bad profile fails', () => {
  const r = validateConfig({
    baseUrl: 'https://g.example.com',
    auth: { kind: 'none' },
    profile: 'grpc',
  });
  assert.equal(r.ok, false);
});

test('validateConfig: all documented profiles are accepted', () => {
  for (const p of COMPATIBILITY_PROFILES) {
    const r = validateConfig({
      baseUrl: 'https://g.example.com',
      auth: { kind: 'none' },
      profile: p,
    });
    assert.equal(r.ok, true, `${p}: ${r.errors.join('; ')}`);
  }
});

test('validateConfig: rejects non-object and bad routes', () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(
    validateConfig({
      baseUrl: 'https://g.example.com',
      auth: { kind: 'none' },
      routes: 'nope',
    }).ok,
    false,
  );
});

test('stored config accepts a Windows UTF-8 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-bom-'));
  try {
    const cfg = { baseUrl: 'https://gateway.example', auth: { kind: 'none' }, profile: 'mixed-auto' };
    writeFileSync(join(dir, 'config.json'), '\uFEFF' + JSON.stringify(cfg), 'utf8');
    const loaded = loadStoredConfig({ CLAUDE_OPEN_CONFIG_DIR: dir });
    assert.equal(loaded.valid, true);
    assert.equal(loaded.config.baseUrl, cfg.baseUrl);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
