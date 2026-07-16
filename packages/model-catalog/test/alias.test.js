import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AliasMap, deriveAlias, needsAlias, ALIAS_PREFIX } from '../src/alias.js';

test('needsAlias: real Claude ids pass the picker gate untouched', () => {
  assert.equal(needsAlias('claude-opus-4-7'), false);
  assert.equal(needsAlias('claude-sonnet-4-6'), false);
  assert.equal(needsAlias('opus-4'), false);
  assert.equal(needsAlias('haiku'), false);
});

test('needsAlias: non-Claude ids require an alias', () => {
  assert.equal(needsAlias('gpt-5.5'), true);
  assert.equal(needsAlias('gemini-3-pro'), true);
  assert.equal(needsAlias('llama-4-70b'), true);
  assert.equal(needsAlias('deepseek-r1'), true);
});

test('needsAlias: an existing alias is not re-aliased', () => {
  assert.equal(needsAlias(ALIAS_PREFIX + 'abc123'), false);
});

test('deriveAlias is deterministic for the same real id + salt', () => {
  const a = deriveAlias('gpt-5.5', 'salt-xyz');
  const b = deriveAlias('gpt-5.5', 'salt-xyz');
  assert.equal(a, b);
  assert.ok(a.startsWith(ALIAS_PREFIX));
});

test('deriveAlias differs by salt (per-install isolation)', () => {
  assert.notEqual(deriveAlias('gpt-5.5', 'saltA'), deriveAlias('gpt-5.5', 'saltB'));
});

test('AliasMap requires a salt', () => {
  assert.throws(() => new AliasMap({}), /salt/);
});

test('aliasFor returns real Claude ids unchanged', () => {
  const m = new AliasMap({ salt: 's' });
  assert.equal(m.aliasFor('claude-opus-4-7'), 'claude-opus-4-7');
});

test('aliasFor is stable across calls and reorders (plan criterion 5)', () => {
  const m = new AliasMap({ salt: 'install-salt' });
  const order1 = ['gpt-5.5', 'gemini-3-pro', 'llama-4'];
  const map1 = Object.fromEntries(order1.map((id) => [id, m.aliasFor(id)]));

  // Simulate the gateway REORDERING its catalog: aliases must not change.
  const order2 = ['llama-4', 'gpt-5.5', 'gemini-3-pro'];
  for (const id of order2) {
    assert.equal(m.aliasFor(id), map1[id], `alias for ${id} changed after reorder`);
  }
});

test('realFor round-trips an alias and is idempotent for real ids', () => {
  const m = new AliasMap({ salt: 's' });
  const alias = m.aliasFor('grok-4');
  assert.equal(m.realFor(alias), 'grok-4');
  assert.equal(m.realFor('claude-opus-4-7'), 'claude-opus-4-7');
});

test('an alias is never reused for a different real id', () => {
  const m = new AliasMap({ salt: 's' });
  const a1 = m.aliasFor('modelA');
  const a2 = m.aliasFor('modelB');
  assert.notEqual(a1, a2);
  assert.equal(m.realFor(a1), 'modelA');
  assert.equal(m.realFor(a2), 'modelB');
});

test('collision resolution: forced same-alias inputs get distinct aliases', () => {
  // Force a collision by pre-binding an alias to a different real id, then
  // requesting a model whose natural alias equals that bound alias.
  const salt = 'collide-salt';
  const target = 'zzz-model';
  const natural = deriveAlias(target, salt); // what zzz-model would get
  const m = new AliasMap({ salt, entries: [{ realId: 'squatter', alias: natural }] });

  const got = m.aliasFor(target);
  assert.notEqual(got, natural, 'must not steal an alias already owned by another id');
  assert.equal(m.realFor(got), target);
  assert.equal(m.realFor(natural), 'squatter');
});

test('reappearance: a removed then re-added model keeps its original alias', () => {
  const m = new AliasMap({ salt: 's' });
  const first = m.aliasFor('qwen-max');
  // model disappears from a catalog fetch, then reappears; deterministic derivation
  // means the SAME alias is produced again even without the in-memory entry.
  const fresh = new AliasMap({ salt: 's' });
  assert.equal(fresh.aliasFor('qwen-max'), first);
});

test('persistence round-trip via toJSON/fromJSON preserves mappings', () => {
  const m = new AliasMap({ salt: 's' });
  m.aliasFor('gpt-5.5');
  m.aliasFor('gemini-3-pro');
  const json = m.toJSON();
  const restored = AliasMap.fromJSON(json);
  assert.equal(restored.realFor(m.aliasFor('gpt-5.5')), 'gpt-5.5');
  assert.equal(restored.aliasFor('gemini-3-pro'), m.aliasFor('gemini-3-pro'));
});
