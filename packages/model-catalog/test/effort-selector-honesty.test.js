// FIX B — effort/thinking selector honesty on gateway models.
//
// SYMPTOM: the effort selector never appears for gateway models.
//
// EVIDENCE (read-only extracted app.asar 1.20186.1 —
// .vite/build/index.chunk-c42vKsva.js): the client shows an effort/thinking
// selector ONLY when `bne(r.id)` returns a control. It reads the RAW model id
// `r.id` (the inferenceModels `name`) — NOT anthropicFamilyTier, NOT any
// capability field:
//
//   function B6(e){ /* strip bedrock ARN, anthropic. prefix, [1m] + version-date suffixes */ }
//   function bne(e){ const t=B6(e.toLowerCase()); const r=qMt[t] ?? (WMt.test(t)?HMt:void 0); if(!r) return; ... }
//   ...used as `thinking:bne(r.id)` on each picker entry.
//
//   qMt = {
//     "claude-haiku-4-5":  {...}, "claude-sonnet-4-5": {...}, "claude-sonnet-4-6": {...},
//     "claude-opus-4-6":   {...}, "claude-opus-4-7":   {...}, "claude-opus-4-8":   {...},
//   }
//   WMt = /^(?:claude-)?(?:fable|mythos)(?:-|$)/
//
// So the ONLY supported way to get the native selector is to name the
// inferenceModels entry a client-RECOGNIZED Claude id. Our gateway models are
// aliased to claude-3p-<hex>, which match NEITHER qMt NOR /fable|mythos/ =>
// correctly get NO selector.
//
// HONESTY RULE:
//   - A gateway model whose REAL id is already a recognized Claude id (the probe
//     showed the gateway exposes claude-opus-4-5/4-6/4-7/4-8, claude-haiku-4-5,
//     claude-sonnet-4-6/4-5) must KEEP its real id as the name (needsAlias=false
//     => aliasFor passes it through), so the client shows the effort selector
//     NATIVELY and honestly (the gateway genuinely serves that model).
//   - A NON-Claude gateway model (gpt/gemini/etc) must NOT be given a fake Claude
//     id just to force a selector — that would LIE about effort support. It is
//     aliased to claude-3p-<hex> (passes the picker name gate) and honestly shows
//     NO effort selector.
//
// This file encodes the client's exact selector-recognition predicate from the
// evidence above and asserts the honesty guarantee end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AliasMap,
  needsAlias,
  clientShowsEffortSelector,
  ALIAS_PREFIX,
} from '../src/alias.js';

// ---- The client's selector-recognition predicate (evidence, not capability) ----

test('clientShowsEffortSelector: recognized qMt Claude ids get the selector', () => {
  for (const id of [
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
  ]) {
    assert.equal(clientShowsEffortSelector(id), true, id);
  }
});

test('clientShowsEffortSelector: fable/mythos family match the WMt regex', () => {
  assert.equal(clientShowsEffortSelector('claude-fable-1'), true);
  assert.equal(clientShowsEffortSelector('mythos'), true);
  assert.equal(clientShowsEffortSelector('fable-2'), true);
});

test('clientShowsEffortSelector: normalization strips [1m] + version-date + anthropic. prefix', () => {
  // B6 removes a [1m] suffix, an @YYYYMMDD / -YYYYMMDD date suffix, and an
  // "anthropic." vendor prefix before matching qMt.
  assert.equal(clientShowsEffortSelector('claude-opus-4-8[1m]'), true);
  assert.equal(clientShowsEffortSelector('claude-opus-4-8@20260101'), true);
  assert.equal(clientShowsEffortSelector('anthropic.claude-opus-4-8'), true);
  assert.equal(clientShowsEffortSelector('CLAUDE-OPUS-4-8'), true); // case-insensitive
});

test('clientShowsEffortSelector: unrecognized ids (incl. aliases + unlisted Claude ids) get NO selector', () => {
  // Aliases never match.
  assert.equal(clientShowsEffortSelector(ALIAS_PREFIX + 'deadbeef01'), false);
  // Non-Claude vendor ids never match.
  assert.equal(clientShowsEffortSelector('gpt-5.5'), false);
  assert.equal(clientShowsEffortSelector('gemini-3-pro'), false);
  // Real Claude ids that are simply NOT in qMt still get no selector — the map
  // is a literal allow-list, narrower than the family/alias logic.
  assert.equal(clientShowsEffortSelector('claude-opus-4-5'), false);
  assert.equal(clientShowsEffortSelector('claude-sonnet-4-7'), false);
  assert.equal(clientShowsEffortSelector('claude-haiku-4-4'), false);
  // Total/pure on junk input.
  assert.equal(clientShowsEffortSelector(''), false);
  assert.equal(clientShowsEffortSelector(null), false);
  assert.equal(clientShowsEffortSelector(undefined), false);
});

// ---- End-to-end honesty guarantee via the alias map ----

test('FIX B: a real recognized Claude id from the gateway KEEPS its id and gets the native selector', () => {
  const m = new AliasMap({ salt: 'install-salt' });
  // Gateway genuinely exposes claude-opus-4-8: it must not be hashed away.
  const name = m.aliasFor('claude-opus-4-8');
  assert.equal(name, 'claude-opus-4-8', 'recognized Claude id must pass through unaliased');
  assert.equal(needsAlias('claude-opus-4-8'), false);
  // Client shows the effort selector natively + honestly (gateway serves it).
  assert.equal(clientShowsEffortSelector(name), true);
});

test('FIX B: a non-Claude gateway model is honestly aliased to claude-3p-xxx with NO fake selector', () => {
  const m = new AliasMap({ salt: 'install-salt' });
  const name = m.aliasFor('gpt-5.5');
  // Aliased (not a fake Claude id).
  assert.ok(name.startsWith(ALIAS_PREFIX), `expected an alias, got ${name}`);
  assert.notEqual(name, 'gpt-5.5');
  assert.equal(needsAlias('gpt-5.5'), true);
  // Round-trips back to the honest real id on requests.
  assert.equal(m.realFor(name), 'gpt-5.5');
  // No effort selector — we did NOT lie about effort support.
  assert.equal(clientShowsEffortSelector(name), false);
});

test('FIX B interaction: recognized Claude id appears in the picker (name gate) AND gets effort', () => {
  // The picker keeps a model whose name looks Anthropic-named and is not on the
  // vendor denylist. A real claude-* id passes that gate natively (needsAlias
  // returns false because it already looks Claude-named).
  const m = new AliasMap({ salt: 's' });
  const name = m.aliasFor('claude-sonnet-4-6');
  assert.equal(name, 'claude-sonnet-4-6'); // passes name gate natively
  assert.equal(clientShowsEffortSelector(name), true); // AND gets effort
});

test('FIX B interaction: non-Claude aliased model appears in the picker but WITHOUT effort', () => {
  // claude-3p-<hex> passes the Anthropic-looking name gate (starts with claude-)
  // and is denylist-clean, so it shows in the picker — but has no effort selector.
  const m = new AliasMap({ salt: 's' });
  const name = m.aliasFor('gemini-3-pro');
  assert.ok(name.startsWith(ALIAS_PREFIX));
  assert.match(name, /^claude-/); // Anthropic-looking => passes the picker name gate
  assert.equal(clientShowsEffortSelector(name), false); // honestly no effort selector
});
