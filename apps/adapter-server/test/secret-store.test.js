import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore } from '../src/secret-store.js';

test('secret store refreshes a rotated credential after its short TTL', () => {
  let now = 1000;
  let credential = 'sk-account-one';
  let reads = 0;
  const store = createSecretStore({
    credentialTarget: 'ClaudeOpen/gateway/current',
    cacheTtlMs: 2000,
    now: () => now,
    resolveCredential: () => {
      reads += 1;
      return credential;
    },
  });

  assert.equal(store.resolve(), 'sk-account-one');
  const firstFingerprint = store.fingerprint();
  credential = 'sk-account-two';
  now += 1999;
  assert.equal(store.resolve(), 'sk-account-one', 'the bounded cache remains stable inside its TTL');
  now += 1;
  assert.equal(store.resolve(), 'sk-account-two');
  assert.notEqual(store.fingerprint(), firstFingerprint);
  assert.equal(reads, 2);
});

test('secret store invalidation forces the next request to use the live credential', () => {
  let credential = 'sk-old';
  const store = createSecretStore({
    credentialTarget: 'ClaudeOpen/gateway/current',
    cacheTtlMs: 60000,
    resolveCredential: () => credential,
  });

  assert.equal(store.resolve(), 'sk-old');
  credential = 'sk-new';
  store.invalidate();
  assert.equal(store.resolve(), 'sk-new');
  assert.equal(store.source(), 'credential-manager');
});
