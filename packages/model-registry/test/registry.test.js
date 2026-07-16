import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, resolveCapabilities, isChatUsable, matchRule } from '../src/index.js';

const registry = loadRegistry();

// The 43 real model ids observed on the live gateway (public identifiers only).
const LIVE_IDS = [
  '/home/robocup/.cache/llama.cpp/Qwen_Qwen3-VL-32B-Instruct-GGUF_Qwen3VL-32B-Instruct-Q8_0.gguf',
  'claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5', 'deepseek-v4-pro',
  'gemini-2.5-flash-new', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-low',
  'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview',
  'gemini-3-flash-v2', 'gemini-3-pro-preview', 'gemma-3', 'glm-4.7', 'glm-4-7',
  'glm-5.1', 'glm-5.2', 'gpt-4.1', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-image-2', 'hy-mt1', 'kimi-k2.6',
  'kimi-k2.7', 'llama-3.1-8b', 'minimax-m3',
  'mradermacher-strawberrylemonade-l3-70b-v1-2-i1', 'mythalion-13b', 'nanobanana',
  'qwen-2.5-coder-14b', 'qwen-3-6-35b-uncensored', 'qwen3-vl-4b', 'sdxl-turbo-v3',
  'voice-studio', 'voice-studio-pro',
];

test('registry loads and validates', () => {
  assert.ok(registry.records.length > 0);
  assert.ok(registry.version);
});

test('matchRule: exact/prefix/regex semantics', () => {
  assert.equal(matchRule({ kind: 'exact', pattern: 'gpt-5.5' }, 'gpt-5.5'), true);
  assert.equal(matchRule({ kind: 'exact', pattern: 'gpt-5.5' }, 'gpt-5.6'), false);
  assert.equal(matchRule({ kind: 'prefix', pattern: 'glm-' }, 'glm-5.2'), true);
  assert.equal(matchRule({ kind: 'regex', pattern: '^claude-(opus|sonnet)' }, 'claude-opus-4-7'), true);
});

test('Claude models -> anthropic route, categorical thinking, documented source', () => {
  const c = resolveCapabilities(registry, 'claude-opus-4-8');
  assert.deepEqual(c.routes, ['anthropic']);
  assert.equal(c.reasoning.controlType, 'categorical');
  assert.equal(c.provider, 'Anthropic');
  assert.match(c.source.url, /anthropic|claude/i);
});

test('exact Claude effort ladders match documented model support', () => {
  assert.equal(resolveCapabilities(registry, 'claude-haiku-4-5').reasoning.controlType, 'numeric_budget');
  assert.deepEqual(resolveCapabilities(registry, 'claude-opus-4-5').reasoning.values, ['low', 'medium', 'high']);
  assert.deepEqual(resolveCapabilities(registry, 'claude-sonnet-4-6').reasoning.values, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(resolveCapabilities(registry, 'claude-opus-4-8').reasoning.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(resolveCapabilities(registry, 'claude-opus-4-8').reasoning.field, 'output_config.effort');
});

test('exact GPT-5 ladders are model-specific', () => {
  assert.deepEqual(resolveCapabilities(registry, 'gpt-5.4').reasoning.values, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(resolveCapabilities(registry, 'gpt-5.4').reasoning.default, 'none');
  assert.equal(resolveCapabilities(registry, 'gpt-5.5').reasoning.default, 'medium');
  assert.deepEqual(resolveCapabilities(registry, 'gpt-5.6-luna').reasoning.values, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('gpt-5 family -> responses route + reasoning.effort', () => {
  const c = resolveCapabilities(registry, 'gpt-5.6-sol');
  assert.deepEqual(c.routes, ['openai-responses']);
  assert.equal(c.reasoning.field, 'reasoning.effort');
});

test('gpt-4.1 -> chat route, no reasoning control', () => {
  const c = resolveCapabilities(registry, 'gpt-4.1');
  assert.deepEqual(c.routes, ['openai-chat']);
  assert.equal(c.reasoning.controlType, 'none');
});

test('image-generation models are NOT chat-usable', () => {
  for (const id of ['gpt-image-2', 'nanobanana', 'sdxl-turbo-v3']) {
    const c = resolveCapabilities(registry, id);
    assert.equal(c.modelType, 'image-generation', id);
    assert.equal(isChatUsable(c), false, `${id} must not be chat-usable`);
    assert.ok(c.unavailableReason, `${id} needs an unavailable reason`);
  }
});

test('voice models are NOT chat-usable', () => {
  for (const id of ['voice-studio', 'voice-studio-pro']) {
    const c = resolveCapabilities(registry, id);
    assert.equal(c.modelType, 'audio-voice');
    assert.equal(isChatUsable(c), false);
  }
});

test('documented exact GLM uses boolean; unverified gateway alias stays unknown', () => {
  const c = resolveCapabilities(registry, 'glm-4.7');
  assert.equal(c.reasoning.controlType, 'boolean');
  assert.deepEqual(c.reasoning.values, ['enabled', 'disabled']);
  assert.equal(resolveCapabilities(registry, 'glm-5.2').reasoning.controlType, 'unknown');
});

test('gateway Gemini alias stays unknown; exact Gemini 3 ladder and variant are explicit', () => {
  assert.equal(resolveCapabilities(registry, 'gemini-2.5-flash-new').reasoning.controlType, 'unknown');
  assert.equal(resolveCapabilities(registry, 'gemini-3-pro-preview').reasoning.controlType, 'categorical');
  const variant = resolveCapabilities(registry, 'gemini-3.1-pro-low');
  assert.equal(variant.reasoning.controlType, 'model_variant');
});

test('local GGUF path is classified as local-gguf', () => {
  const c = resolveCapabilities(registry, LIVE_IDS[0]);
  assert.equal(c.modelType, 'local-gguf');
});

test('qwen VL is vision-input; plain qwen is text-chat', () => {
  assert.equal(resolveCapabilities(registry, 'qwen3-vl-4b').modelType, 'vision-input');
  assert.equal(resolveCapabilities(registry, 'qwen-2.5-coder-14b').modelType, 'text-chat');
});

test('unknown model yields an unknown skeleton, never a fabricated capability', () => {
  const c = resolveCapabilities(registry, 'totally-unheard-of-model-zzz');
  assert.equal(c.matchedRecord, null);
  assert.equal(c.modelType, 'unknown');
  assert.equal(c.tools, 'unknown');
  assert.equal(c.streaming, 'unknown');
  assert.equal(c.reasoning.controlType, 'unknown');
  assert.deepEqual(c.routes, []);
});

test('EVERY live catalog model classifies with a definite modelType', () => {
  const unclassified = [];
  for (const id of LIVE_IDS) {
    const c = resolveCapabilities(registry, id);
    if (c.modelType === 'unknown') unclassified.push(id);
  }
  assert.deepEqual(unclassified, [], `unclassified live models: ${unclassified.join(', ')}`);
});

test('no chat model advertises a reasoning control it cannot have (tools/streaming tri-state only)', () => {
  for (const id of LIVE_IDS) {
    const c = resolveCapabilities(registry, id);
    assert.ok(['supported', 'unsupported', 'unknown'].includes(c.tools), `${id} tools tri-state`);
    assert.ok(['supported', 'unsupported', 'unknown'].includes(c.streaming), `${id} streaming tri-state`);
  }
});
