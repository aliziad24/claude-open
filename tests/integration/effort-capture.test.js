// Proves effort controls ACTUALLY reach the upstream request at the correct
// field per control type (SESSION-3 5.2), by capturing the request the gateway
// received. Not "HTTP 200" — the exact upstream body is asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockGateway } from '../fixtures/mock-gateway.mjs';
import { handleMessage } from '@claude-open/gateway-adapter';

// A model stub with an explicit reasoning-control descriptor.
function modelWith(realId, routes, reasoning) {
  return { realId, routes, reasoning, capabilitySource: 'registry', sourceMetadata: {} };
}

async function withGw(cfg, fn) {
  const gw = createMockGateway(cfg);
  const url = await gw.listen();
  try {
    await fn(url, gw);
  } finally {
    await gw.close();
  }
}

test('Responses categorical -> reasoning.effort appears in the upstream body', async () => {
  await withGw({ protocols: ['openai-responses'] }, async (url, gw) => {
    await handleMessage({
      baseUrl: url, headers: {}, fetchImpl: fetch,
      model: modelWith('gpt-5.5', ['openai-responses'], { controlType: 'categorical', field: 'reasoning.effort', values: ['low', 'high'], default: 'high' }),
      body: { model: 'gpt-5.5', max_tokens: 16, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'x' }] },
    });
    const req = gw.lastRequest();
    assert.equal(req.endpoint, '/v1/responses');
    assert.equal(req.body.reasoning.effort, 'high', 'reasoning.effort must be set on the real upstream body');
  });
});

test('GLM boolean -> thinking.type appears in the upstream chat body', async () => {
  await withGw({ protocols: ['openai-chat'] }, async (url, gw) => {
    await handleMessage({
      baseUrl: url, headers: {}, fetchImpl: fetch,
      model: modelWith('glm-5.2', ['openai-chat'], { controlType: 'boolean', field: 'thinking.type', values: ['enabled', 'disabled'] }),
      body: { model: 'glm-5.2', max_tokens: 16, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'x' }] },
    });
    const req = gw.lastRequest();
    assert.equal(req.endpoint, '/v1/chat/completions');
    assert.equal(req.body.thinking.type, 'enabled', 'GLM thinking.type must reach the upstream body');
  });
});

test('Gemini numeric_budget -> nested thinkingConfig.thinkingBudget appears upstream', async () => {
  await withGw({ protocols: ['openai-chat'] }, async (url, gw) => {
    await handleMessage({
      baseUrl: url, headers: {}, fetchImpl: fetch,
      model: modelWith('gemini-2.5-flash-new', ['openai-chat'], {
        controlType: 'numeric_budget', field: 'thinkingConfig.thinkingBudget', min: 0, max: 24576, specialValues: { off: 0, dynamic: -1 },
      }),
      body: { model: 'gemini-2.5-flash-new', max_tokens: 16, thinking: { type: 'enabled', budget_tokens: 100000 }, messages: [{ role: 'user', content: 'x' }] },
    });
    const req = gw.lastRequest();
    assert.equal(req.body.thinkingConfig.thinkingBudget, 24576, 'clamped budget must reach nested upstream field');
  });
});

test('none/unknown control -> NO effort field is added to the upstream body', async () => {
  await withGw({ protocols: ['openai-chat'] }, async (url, gw) => {
    await handleMessage({
      baseUrl: url, headers: {}, fetchImpl: fetch,
      model: modelWith('llama-3.1-8b', ['openai-chat'], { controlType: 'none' }),
      body: { model: 'llama-3.1-8b', max_tokens: 16, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'x' }] },
    });
    const req = gw.lastRequest();
    assert.equal(req.body.reasoning, undefined);
    assert.equal(req.body.thinking, undefined);
    assert.equal(req.body.reasoning_effort, undefined);
  });
});

test('model_variant control -> NO duplicate selector field added upstream', async () => {
  await withGw({ protocols: ['openai-chat'] }, async (url, gw) => {
    await handleMessage({
      baseUrl: url, headers: {}, fetchImpl: fetch,
      model: modelWith('gemini-3.1-pro-low', ['openai-chat'], { controlType: 'model_variant' }),
      body: { model: 'gemini-3.1-pro-low', max_tokens: 16, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'x' }] },
    });
    const req = gw.lastRequest();
    assert.equal(req.body.reasoning_effort, undefined);
    assert.equal(req.body.thinking, undefined);
  });
});
