import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningControl, mapThinkingToUpstream, applyPatch } from '../src/effort.js';

test('reasoningControl: selector only for categorical/boolean/numeric_budget', () => {
  assert.equal(reasoningControl({ reasoning: { controlType: 'categorical', values: ['low', 'high'] } }).showSelector, true);
  assert.equal(reasoningControl({ reasoning: { controlType: 'boolean' } }).showSelector, true);
  assert.equal(reasoningControl({ reasoning: { controlType: 'numeric_budget' } }).showSelector, true);
  for (const ct of ['none', 'model_variant', 'automatic_only', 'unknown']) {
    assert.equal(reasoningControl({ reasoning: { controlType: ct } }).showSelector, false, ct);
  }
});

test('reasoningControl: direct helper precedence remains explicit', () => {
  const model = { reasoning: { controlType: 'categorical', values: ['low', 'high'] }, capabilitySource: 'registry' };
  assert.equal(reasoningControl(model, undefined, { controlType: 'boolean' }).source, 'probe');
  assert.equal(reasoningControl(model, { controlType: 'none' }, { controlType: 'boolean' }).source, 'override');
});

test('mapThinkingToUpstream: none/unknown/model_variant/automatic_only -> apply none', () => {
  for (const ct of ['none', 'unknown', 'model_variant', 'automatic_only']) {
    const p = mapThinkingToUpstream({ type: 'adaptive' }, { controlType: ct }, 'openai-chat');
    assert.equal(p.apply, 'none', ct);
  }
});

test('mapThinkingToUpstream: GLM boolean thinking.type -> set-path patch', () => {
  const control = { controlType: 'boolean', field: 'thinking.type', values: ['enabled', 'disabled'] };
  assert.deepEqual(mapThinkingToUpstream({ type: 'adaptive' }, control, 'openai-chat'), {
    apply: 'set-path', path: 'thinking.type', value: 'enabled',
  });
  assert.deepEqual(mapThinkingToUpstream({ type: 'disabled' }, control, 'openai-chat'), {
    apply: 'set-path', path: 'thinking.type', value: 'disabled',
  });
  assert.equal(mapThinkingToUpstream(null, control, 'openai-chat').apply, 'none');
});

test('mapThinkingToUpstream: Gemini numeric_budget nested field + special values', () => {
  const control = { controlType: 'numeric_budget', field: 'thinkingConfig.thinkingBudget', min: 0, max: 24576, specialValues: { off: 0, dynamic: -1 } };
  assert.deepEqual(mapThinkingToUpstream({ type: 'enabled', budget_tokens: 100000 }, control, 'openai-chat'), {
    apply: 'set-path', path: 'thinkingConfig.thinkingBudget', value: 24576,
  });
  assert.deepEqual(mapThinkingToUpstream({ type: 'disabled' }, control, 'openai-chat'), {
    apply: 'set-path', path: 'thinkingConfig.thinkingBudget', value: 0,
  });
  assert.deepEqual(mapThinkingToUpstream({ type: 'adaptive' }, control, 'openai-chat'), {
    apply: 'set-path', path: 'thinkingConfig.thinkingBudget', value: -1,
  });
});

test('mapThinkingToUpstream: categorical reads real output_config.effort and never injects a default', () => {
  const control = { controlType: 'categorical', field: 'reasoning.effort', values: ['low', 'high'], default: 'high' };
  assert.equal(mapThinkingToUpstream({ thinking: { type: 'adaptive' } }, control, 'openai-responses').apply, 'none');
  assert.deepEqual(mapThinkingToUpstream({ output_config: { effort: 'low' } }, control, 'openai-responses'), {
    apply: 'set-path', path: 'reasoning.effort', value: 'low',
  });
  assert.equal(mapThinkingToUpstream({ thinking: { type: 'enabled', budget_tokens: 1000 } }, control, 'openai-responses').apply, 'none');
  assert.equal(mapThinkingToUpstream({ output_config: { effort: 'ultra' } }, control, 'openai-responses').apply, 'none');
});

test('mapThinkingToUpstream: Grok reasoning_effort field honored', () => {
  const control = { controlType: 'categorical', field: 'reasoning_effort', values: ['low', 'high'], default: 'low' };
  const p = mapThinkingToUpstream({ output_config: { effort: 'low' } }, control, 'openai-chat');
  assert.equal(p.path, 'reasoning_effort');
});

test('applyPatch: sets nested path, creating intermediate objects', () => {
  const req = { model: 'm' };
  applyPatch(req, { apply: 'set-path', path: 'reasoning.effort', value: 'high' });
  assert.deepEqual(req.reasoning, { effort: 'high' });
  applyPatch(req, { apply: 'set-path', path: 'thinkingConfig.thinkingBudget', value: 8000 });
  assert.equal(req.thinkingConfig.thinkingBudget, 8000);
});

test('applyPatch: apply=none is a no-op', () => {
  const req = { model: 'm' };
  applyPatch(req, { apply: 'none', reason: 'x' });
  assert.deepEqual(req, { model: 'm' });
});
