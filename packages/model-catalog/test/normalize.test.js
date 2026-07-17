import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AliasMap } from '../src/alias.js';
import { normalizeModel, normalizeCatalog, resolveContext } from '../src/normalize.js';
import { loadRegistry, resolveCapabilities } from '@claude-open/model-registry';

const salt = 'test-salt';
const registry = loadRegistry();
const resolveCaps = (id) => resolveCapabilities(registry, id);

test('resolveContext: only from metadata/override, source recorded', () => {
  assert.deepEqual(resolveContext({ id: 'm', context_length: 128000 }), {
    window: 128000,
    source: 'gateway',
  });
  assert.deepEqual(resolveContext({ id: 'm' }, { contextWindow: 200000 }), {
    window: 200000,
    source: 'override',
  });
  assert.deepEqual(resolveContext({ id: 'm' }), { window: null, source: 'unknown' });
});

test('normalizeModel: Claude model gets anthropic route + categorical reasoning from registry', () => {
  const aliasMap = new AliasMap({ salt });
  const m = normalizeModel({ id: 'claude-opus-4-8', context_length: 200000 }, aliasMap, { resolveCaps });
  assert.equal(m.stableAlias, 'claude-opus-4-8'); // real Claude id unchanged
  assert.deepEqual(m.routes, ['anthropic']);
  assert.equal(m.reasoning.controlType, 'categorical');
  assert.equal(m.provider, 'Anthropic');
  assert.equal(m.capabilitySource, 'registry');
  assert.equal(m.contextWindow, 200000);
});

test('normalizeModel: non-Claude model is aliased, raw metadata preserved', () => {
  const aliasMap = new AliasMap({ salt });
  const rec = { id: 'gpt-5.5', context_length: 1000000 };
  const m = normalizeModel(rec, aliasMap, { resolveCaps });
  assert.ok(m.stableAlias.startsWith('claude-3p-'));
  assert.deepEqual(m.routes, ['openai-responses']);
  assert.equal(m.sourceMetadata, rec);
});

test('normalizeModel: capabilities are three-state, never defaulted to true', () => {
  const aliasMap = new AliasMap({ salt });
  // deepseek record has tools: unknown, streaming: supported
  const m = normalizeModel({ id: 'deepseek-v4-pro' }, aliasMap, { resolveCaps });
  assert.equal(m.capabilities.tools, 'unknown');
  assert.equal(m.capabilities.streaming, 'supported');
  assert.ok(['supported', 'unsupported', 'unknown'].includes(m.capabilities.imageInput));
});

test('normalizeModel: gateway metadata overrides registry for tools/streaming', () => {
  const aliasMap = new AliasMap({ salt });
  const m = normalizeModel({ id: 'deepseek-v4-pro', tools: true }, aliasMap, { resolveCaps });
  assert.equal(m.capabilities.tools, 'supported');
});

test('normalizeModel: image-generation model has text=unsupported and a reason', () => {
  const aliasMap = new AliasMap({ salt });
  const m = normalizeModel({ id: 'gpt-image-2' }, aliasMap, { resolveCaps });
  assert.equal(m.modelType, 'image-generation');
  assert.equal(m.capabilities.text, 'unsupported');
  assert.ok(m.unavailableReason);
});

test('normalizeModel: unknown model -> everything unknown, no fabrication', () => {
  const aliasMap = new AliasMap({ salt });
  const m = normalizeModel({ id: 'mystery-zzz' }, aliasMap, { resolveCaps });
  assert.equal(m.modelType, 'unknown');
  assert.equal(m.capabilities.tools, 'unknown');
  assert.equal(m.capabilities.streaming, 'unknown');
  assert.equal(m.reasoning.controlType, 'unknown');
  assert.deepEqual(m.routes, []);
  assert.equal(m.contextWindow, null);
});

test('normalizeModel: no context metadata -> null, not a global default', () => {
  const aliasMap = new AliasMap({ salt });
  const m = normalizeModel({ id: 'claude-opus-4-8' }, aliasMap, { resolveCaps });
  assert.equal(m.contextWindow, null);
  assert.equal(m.context.source, 'unknown');
});

test('resolveContext accepts common gateway max-input and nested limit shapes', () => {
  assert.deepEqual(resolveContext({ id: 'a', max_input_tokens: 200000 }), {
    window: 200000,
    source: 'gateway',
  });
  assert.deepEqual(resolveContext({ id: 'b', limits: { context_window: 1000000 } }), {
    window: 1000000,
    source: 'gateway',
  });
});

test('normalizeCatalog: classifies a mixed catalog and skips malformed records', () => {
  const aliasMap = new AliasMap({ salt });
  const cat = normalizeCatalog(
    [null, { name: 'no id' }, { id: 'claude-opus-4-8' }, { id: 'gpt-image-2' }, { id: 'voice-studio' }],
    aliasMap,
    { resolveCaps },
  );
  assert.equal(cat.length, 3);
  const types = cat.map((m) => m.modelType).sort();
  assert.deepEqual(types, ['audio-voice', 'image-generation', 'reasoning-text']);
});
