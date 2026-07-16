// Unit tests for selectDefaultModel — the pure healthy-default chooser used by
// the Control Center launch path before it writes the FLAT 3P config.
//
// Contract (verified facts): the client uses the FIRST inferenceModels entry as
// its default, so the launcher must place a HEALTHY model first.
//   1. Prefer an available anthropic opus alias (claude-opus-4-5/4-6/4-7/4-8).
//   2. Else the first model that is NOT in a known-overloaded/unhealthy set.
//   3. Else (all overloaded / empty guidance) the first model as a last resort.
// The function is pure: given the live model id list + an optional unhealthy set,
// it returns the preferred default alias. It never mutates its inputs.

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectDefaultModel } from '../../packages/identity-harness/src/index.js';

// The six UPSTREAM-overloaded aliases observed right now (verified facts).
const KNOWN_UNHEALTHY = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'gemini-3-flash-v2',
  'minimax-m3',
  'gpt-5.4',
];

test('prefers an available opus-4-5 alias over other healthy models', () => {
  const ids = ['gpt-5.4', 'claude-sonnet-4-6', 'claude-opus-4-5', 'gemini-3-flash-v2'];
  assert.equal(selectDefaultModel(ids, KNOWN_UNHEALTHY), 'claude-opus-4-5');
});

test('prefers the newest opus alias when several opus versions are present', () => {
  const ids = ['claude-opus-4-5', 'claude-opus-4-8', 'claude-opus-4-6'];
  assert.equal(selectDefaultModel(ids, KNOWN_UNHEALTHY), 'claude-opus-4-8');
});

test('does not choose an opus alias that is itself flagged unhealthy', () => {
  const ids = ['claude-opus-4-5', 'claude-sonnet-4-7'];
  // opus-4-5 is unhealthy here, so fall back to the first healthy non-opus model.
  const unhealthy = ['claude-opus-4-5'];
  assert.equal(selectDefaultModel(ids, unhealthy), 'claude-sonnet-4-7');
});

test('falls back to the first healthy model when no opus is present', () => {
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-4-7', 'claude-haiku-4-5'];
  // sonnet-4-6 and haiku-4-5 are overloaded; sonnet-4-7 is the first healthy one.
  assert.equal(selectDefaultModel(ids, KNOWN_UNHEALTHY), 'claude-sonnet-4-7');
});

test('returns the first model as a last resort when every model is unhealthy', () => {
  const ids = ['claude-sonnet-4-6', 'claude-sonnet-5'];
  assert.equal(selectDefaultModel(ids, KNOWN_UNHEALTHY), 'claude-sonnet-4-6');
});

test('treats an omitted unhealthy set as empty (opus still wins, else first)', () => {
  assert.equal(selectDefaultModel(['gpt-5.4', 'claude-opus-4-7']), 'claude-opus-4-7');
  assert.equal(selectDefaultModel(['gpt-5.4', 'minimax-m3']), 'gpt-5.4');
});

test('opus matching is case-insensitive and version-aware', () => {
  const ids = ['CLAUDE-OPUS-4-5', 'claude-sonnet-4-7'];
  assert.equal(selectDefaultModel(ids, []), 'CLAUDE-OPUS-4-5');
});

test('ignores an opus alias without a 4-5..4-8 version suffix', () => {
  // A bare "claude-opus" (no supported version) is NOT preferred over a healthy
  // model; it is treated as a normal candidate, so the first healthy model wins.
  const ids = ['claude-sonnet-4-7', 'claude-opus'];
  assert.equal(selectDefaultModel(ids, []), 'claude-sonnet-4-7');
});

test('returns null for an empty model list', () => {
  assert.equal(selectDefaultModel([], KNOWN_UNHEALTHY), null);
  assert.equal(selectDefaultModel(null, KNOWN_UNHEALTHY), null);
});

test('does not mutate the input arrays', () => {
  const ids = ['claude-sonnet-4-6', 'claude-opus-4-5'];
  const unhealthy = ['claude-sonnet-4-6'];
  const idsCopy = ids.slice();
  const unhealthyCopy = unhealthy.slice();
  selectDefaultModel(ids, unhealthy);
  assert.deepEqual(ids, idsCopy);
  assert.deepEqual(unhealthy, unhealthyCopy);
});
