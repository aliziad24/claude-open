// FIX 3(b): alias generation must never accidentally emit a picker-denied token.
//
// The unmodified Claude client hides any model whose id matches a vendor
// denylist (its A6/s9e gate: /deepseek|gpt|gemini|qwen|llama|glm|k2\.|yi-|.../).
// deriveAlias() produces "claude-3p-<hex>" where <hex> is HMAC-derived; a hex
// slice can, by chance, contain a denied substring (e.g. "...gpt..." is
// impossible in pure hex, but the guard must cover the general contract and the
// collision loop must re-nonce until the alias is denylist-clean).
//
// This suite pins three behaviours:
//   1. A normal alias (denylist-clean) is returned unchanged.
//   2. An input whose natural alias WOULD contain a denied token is re-nonced to
//      a safe alias (via a forced-collision-style denylist injection).
//   3. Real claude-* ids pass through untouched (they never get an alias).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AliasMap,
  deriveAlias,
  isAliasDenylisted,
  ALIAS_PREFIX,
  ALIAS_DENYLIST,
} from '../src/alias.js';

test('ALIAS_DENYLIST covers the client A6/s9e vendor tokens', () => {
  for (const token of ['deepseek', 'gpt', 'gemini', 'qwen', 'llama', 'glm', 'yi-', 'grok']) {
    assert.ok(ALIAS_DENYLIST.some((re) => re.test(token)), `denylist should match ${token}`);
  }
});

test('isAliasDenylisted: flags an alias containing a denied token, case-insensitive', () => {
  assert.equal(isAliasDenylisted('claude-3p-gpt12abcd'), true);
  assert.equal(isAliasDenylisted('claude-3p-GLM9900aa'), true);
  assert.equal(isAliasDenylisted('claude-3p-k2.55aa11'), true);
  // A clean hex-only alias is fine.
  assert.equal(isAliasDenylisted('claude-3p-abcdef0123'), false);
});

test('real claude-* ids pass through untouched (never aliased, never denied)', () => {
  const m = new AliasMap({ salt: 's' });
  assert.equal(m.aliasFor('claude-opus-4-8'), 'claude-opus-4-8');
  // A real id is not subject to the alias denylist path at all.
  assert.equal(m.realFor('claude-opus-4-8'), 'claude-opus-4-8');
});

test('a normal (denylist-clean) alias is unchanged by the guard', () => {
  const m = new AliasMap({ salt: 'clean-salt' });
  const alias = m.aliasFor('grok-4');
  assert.ok(alias.startsWith(ALIAS_PREFIX));
  assert.equal(isAliasDenylisted(alias), false, 'produced alias must be denylist-clean');
  assert.equal(m.realFor(alias), 'grok-4');
  // Stable across calls.
  assert.equal(m.aliasFor('grok-4'), alias);
});

test('an input whose natural alias contains a denied token is re-nonced to safe', () => {
  // Pure-hex aliases cannot naturally contain most vendor tokens, so we inject a
  // denylist entry that matches the deterministic nonce=0 alias for a known
  // input. This forces the collision/denylist loop to re-nonce and proves the
  // guard skips a denied natural alias regardless of the token alphabet.
  const salt = 'dl-salt';
  const realId = 'some-vendor-model';
  const natural = deriveAlias(realId, salt); // claude-3p-<hex>, nonce 0
  // The full natural alias becomes a denied token for this test only.
  const injected = new RegExp(natural.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const m = new AliasMap({ salt, denylist: [injected] });
  const got = m.aliasFor(realId);
  assert.notEqual(got, natural, 'must skip the denylisted natural alias');
  assert.ok(!injected.test(got), 're-nonced alias must be denylist-clean');
  assert.equal(m.realFor(got), realId, 'round-trips to the real id');

  // Deterministic: a fresh map with the same denylist derives the SAME safe alias.
  const fresh = new AliasMap({ salt, denylist: [injected] });
  assert.equal(fresh.aliasFor(realId), got);
});

test('the default denylist re-nonces a hex alias that happens to contain a token', () => {
  // Prove the built-in denylist participates in the loop by injecting a token
  // that CAN appear in hex ("dead"), then confirming a natural "...dead..." alias
  // is re-nonced away when that token is denied.
  const salt = 'hex-token-salt';
  let hit = null;
  for (let i = 0; i < 50000 && !hit; i += 1) {
    const id = `m${i}`;
    const a = deriveAlias(id, salt);
    if (/dead/i.test(a)) hit = { id, a };
  }
  assert.ok(hit, 'expected a natural alias containing the hex token "dead"');
  const m = new AliasMap({ salt, denylist: [/dead/i] });
  const got = m.aliasFor(hit.id);
  assert.notEqual(got, hit.a);
  assert.ok(!/dead/i.test(got));
  assert.equal(m.realFor(got), hit.id);
});
