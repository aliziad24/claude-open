// Unit tests for assignFamilyTiers — the pure helper that tags healthy models
// in the generated FLAT inferenceModels with anthropicFamilyTier + isFamilyDefault
// so the Claude client's ConfigHealth / first-inference tier probes resolve to
// HEALTHY models instead of the built-in claude-haiku-4-5 tier id (which the
// gateway is 503-overloading).
//
// ROOT CAUSE (confirmed live): the client resolves its health/first-inference
// probe by anthropicFamilyTier (haiku|sonnet|opus|fable|mythos) — NOT by
// inferenceModels ordering. With no tier tags, the client falls back to the
// built-in claude-haiku-4-5 tier id -> ConfigHealth: unreachable.
//
// FAMILY-TIER EVIDENCE — tests/fixtures/claude-3p-config/README.md:99-101:
//   - supports1m          — optional bool (line 99)
//   - anthropicFamilyTier — optional tier alias haiku|sonnet|opus|fable|mythos (line 100)
//   - isFamilyDefault     — optional bool, default-for-tier (line 101)
// The documented lever: a family tier maps a bare tier alias to YOUR chosen
// model, so tagging a healthy opus as anthropicFamilyTier:'haiku' makes the
// client's haiku-tier probe resolve to that healthy opus.

import assert from 'node:assert/strict';
import test from 'node:test';

import { assignFamilyTiers } from '../../packages/identity-harness/src/index.js';

// Helper: index the returned model records by id for easy assertions.
function byId(models) {
  const out = {};
  for (const m of models) out[m.id] = m;
  return out;
}

// Helper: collect the records that are the family default for `tier`.
// A record represents `tier` when its familyTiers[] includes it (the healthy
// representative may own several tiers) or its single anthropicFamilyTier field
// equals it. isFamilyDefault must be true for a default representative.
function defaultForTier(models, tier) {
  return models.filter(
    (m) =>
      m.isFamilyDefault === true &&
      ((Array.isArray(m.familyTiers) && m.familyTiers.includes(tier)) ||
        m.anthropicFamilyTier === tier),
  );
}

test('healthy opus only: haiku + sonnet + opus tiers all point at a healthy opus', () => {
  const models = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ];
  // Only opus is healthy; sonnet + haiku are overloaded.
  const unhealthyIds = ['claude-sonnet-4-6', 'claude-haiku-4-5'];
  const out = assignFamilyTiers(models, { unhealthyIds });
  const idx = byId(out);

  // The healthy opus carries opus tier and is the family default.
  assert.equal(idx['claude-opus-4-8'].anthropicFamilyTier, 'opus');

  // CRITICAL fallback: the haiku-tier probe must resolve to the healthy opus.
  // Exactly one healthy representative per tier is marked isFamilyDefault:true.
  const haikuDefaults = defaultForTier(out, 'haiku');
  assert.equal(haikuDefaults.length, 1, 'exactly one haiku default');
  assert.equal(haikuDefaults[0].id, 'claude-opus-4-8');

  const sonnetDefaults = defaultForTier(out, 'sonnet');
  assert.equal(sonnetDefaults.length, 1, 'exactly one sonnet default');
  assert.equal(sonnetDefaults[0].id, 'claude-opus-4-8');

  const opusDefaults = defaultForTier(out, 'opus');
  assert.equal(opusDefaults.length, 1, 'exactly one opus default');
  assert.equal(opusDefaults[0].id, 'claude-opus-4-8');

  // The overloaded haiku/sonnet models must NEVER be tagged.
  assert.equal(idx['claude-haiku-4-5'].anthropicFamilyTier, undefined);
  assert.equal(idx['claude-sonnet-4-6'].anthropicFamilyTier, undefined);
  assert.equal(idx['claude-haiku-4-5'].isFamilyDefault, undefined);
  assert.equal(idx['claude-sonnet-4-6'].isFamilyDefault, undefined);
});

test('healthy opus + haiku: haiku tier points at the real healthy haiku', () => {
  const models = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  ];
  // opus + haiku healthy; sonnet overloaded.
  const unhealthyIds = ['claude-sonnet-4-6'];
  const out = assignFamilyTiers(models, { unhealthyIds });

  // Real healthy haiku owns the haiku tier — do NOT borrow opus for it.
  const haikuDefaults = defaultForTier(out, 'haiku');
  assert.equal(haikuDefaults.length, 1);
  assert.equal(haikuDefaults[0].id, 'claude-haiku-4-5');

  // Opus owns opus tier.
  const opusDefaults = defaultForTier(out, 'opus');
  assert.equal(opusDefaults.length, 1);
  assert.equal(opusDefaults[0].id, 'claude-opus-4-8');

  // No healthy sonnet exists -> sonnet tier falls back to the healthy opus
  // (never left unset, so the client's sonnet probe still resolves healthy).
  const sonnetDefaults = defaultForTier(out, 'sonnet');
  assert.equal(sonnetDefaults.length, 1);
  assert.equal(sonnetDefaults[0].id, 'claude-opus-4-8');
});

test('healthy opus + sonnet + haiku: each tier owns its own real model', () => {
  const models = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4-7', display_name: 'Claude Sonnet 4.7' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ];
  const out = assignFamilyTiers(models, { unhealthyIds: [] });

  assert.equal(defaultForTier(out, 'opus')[0].id, 'claude-opus-4-8');
  assert.equal(defaultForTier(out, 'sonnet')[0].id, 'claude-sonnet-4-7');
  assert.equal(defaultForTier(out, 'haiku')[0].id, 'claude-haiku-4-5');
});

test('unhealthy set is respected: never tag an overloaded model', () => {
  const models = [
    { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  ];
  // The newest opus is overloaded; the healthy older opus must be chosen.
  const out = assignFamilyTiers(models, { unhealthyIds: ['claude-opus-4-8'] });
  const idx = byId(out);

  assert.equal(idx['claude-opus-4-8'].anthropicFamilyTier, undefined, 'unhealthy opus untagged');
  assert.equal(idx['claude-opus-4-8'].isFamilyDefault, undefined);

  // Every tier default must be the healthy opus-4-5.
  for (const tier of ['haiku', 'sonnet', 'opus']) {
    const d = defaultForTier(out, tier);
    assert.equal(d.length, 1, `one ${tier} default`);
    assert.equal(d[0].id, 'claude-opus-4-5');
  }
});

test('no healthy Anthropic models: no tiers assigned (nothing to borrow)', () => {
  const models = [
    { id: 'gpt-5.4', display_name: 'GPT 5.4' },
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  ];
  // The only Anthropic model is overloaded; a non-Anthropic model must never
  // borrow an Anthropic family tier.
  const out = assignFamilyTiers(models, { unhealthyIds: ['claude-opus-4-8'] });
  for (const m of out) {
    assert.equal(m.anthropicFamilyTier, undefined);
    assert.equal(m.isFamilyDefault, undefined);
  }
});

test('opus version matching: only claude-opus-4-5..4-8 count as opus family', () => {
  const models = [
    { id: 'claude-opus', display_name: 'Claude Opus (bare)' },
    { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
  ];
  const out = assignFamilyTiers(models, { unhealthyIds: [] });
  const idx = byId(out);
  // The versioned opus owns the tiers; the bare alias is not opus-family.
  assert.equal(idx['claude-opus'].anthropicFamilyTier, undefined);
  assert.equal(defaultForTier(out, 'opus')[0].id, 'claude-opus-4-6');
});

test('is pure: does not mutate the input model records or array', () => {
  const models = [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
  ];
  const snapshot = JSON.parse(JSON.stringify(models));
  assignFamilyTiers(models, { unhealthyIds: [] });
  assert.deepEqual(models, snapshot, 'inputs untouched');
});

test('tolerates omitted options (defaults to empty unhealthy set)', () => {
  const models = [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }];
  const out = assignFamilyTiers(models);
  assert.equal(defaultForTier(out, 'haiku')[0].id, 'claude-opus-4-8');
});

test('empty model list returns an empty array', () => {
  assert.deepEqual(assignFamilyTiers([], { unhealthyIds: [] }), []);
});

test('family detection uses display name / alias (matches by real name)', () => {
  // The adapter alias may be picker-safe (claude-3p-*) while the display name
  // carries the real family. Detection must key off the family in the alias OR
  // the display name so opus/sonnet/haiku are found by their real name.
  const models = [
    { id: 'claude-3p-abc123', display_name: 'Claude Opus 4.8' },
    { id: 'claude-3p-def456', display_name: 'Claude Haiku 4.5' },
  ];
  const out = assignFamilyTiers(models, { unhealthyIds: [] });
  assert.equal(defaultForTier(out, 'opus')[0].id, 'claude-3p-abc123');
  assert.equal(defaultForTier(out, 'haiku')[0].id, 'claude-3p-def456');
});
