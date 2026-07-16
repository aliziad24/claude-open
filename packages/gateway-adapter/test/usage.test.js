import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noneUsageAdapter,
  openAIHeadersUsageAdapter,
  mappedUsageAdapter,
  contextFromModel,
  NOT_PROVIDED,
  UsageTelemetry,
  AnthropicUsageObserver,
} from '../src/usage.js';

test('noneUsageAdapter honestly reports no plan/usage', async () => {
  assert.equal((await noneUsageAdapter.getPlan()).available, false);
  assert.equal((await noneUsageAdapter.getUsage()).available, false);
  assert.equal((await noneUsageAdapter.getRateLimits()).available, false);
});

test('contextFromModel uses gateway metadata + source, never a global default', () => {
  const c = contextFromModel({ context: { window: 128000, source: 'gateway' } });
  assert.equal(c.available, true);
  assert.equal(c.window, 128000);
  assert.equal(c.source, 'gateway');

  const unknown = contextFromModel({ contextWindow: null });
  assert.equal(unknown.available, false);
  assert.equal(unknown.window, null);
  assert.equal(unknown.source, 'unknown');
});

test('openAIHeadersUsageAdapter reads rate-limit headers when present', async () => {
  const headers = { 'x-ratelimit-remaining-requests': '42', 'x-ratelimit-remaining-tokens': '1000' };
  const a = openAIHeadersUsageAdapter(() => headers);
  const rl = await a.getRateLimits();
  assert.equal(rl.available, true);
  assert.equal(rl.remainingRequests, 42);
  assert.equal(rl.remainingTokens, 1000);
});

test('openAIHeadersUsageAdapter reports not-provided when no headers', async () => {
  const a = openAIHeadersUsageAdapter(() => ({}));
  assert.equal((await a.getRateLimits()).available, false);
});

test('mappedUsageAdapter uses configured endpoints or reports not-provided', async () => {
  const noMap = mappedUsageAdapter({}, async () => ({}));
  assert.equal((await noMap.getPlan()).available, false);

  const mapped = mappedUsageAdapter({ planEndpoint: '/plan' }, async (p) => ({ path: p, tier: 'pro' }));
  const plan = await mapped.getPlan();
  assert.equal(plan.available, true);
  assert.equal(plan.data.tier, 'pro');
});

test('NOT_PROVIDED is a stable marker', () => {
  assert.equal(NOT_PROVIDED.available, false);
  assert.equal(typeof NOT_PROVIDED.reason, 'string');
});

test('UsageTelemetry separates observed session tokens from unavailable quota', () => {
  let now = 1000;
  const telemetry = new UsageTelemetry({ clock: () => now++ });
  telemetry.record({
    model: 'model-a',
    usage: { input_tokens: 25, output_tokens: 5, cache_read_input_tokens: 4, reasoning_tokens: 2 },
    contextWindow: 100,
    contextSource: 'gateway',
    route: 'anthropic',
  });
  telemetry.record({
    model: 'model-a',
    usage: { prompt_tokens: 10, completion_tokens: 10 },
    contextWindow: 100,
    contextSource: 'gateway',
    route: 'openai-chat',
    stream: true,
  });

  const snapshot = telemetry.snapshot([{ realId: 'model-a', contextWindow: 100, context: { source: 'gateway' } }]);
  assert.equal(snapshot.scope, 'adapter-process-session');
  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.totals.inputTokens, 35);
  assert.equal(snapshot.totals.outputTokens, 15);
  assert.equal(snapshot.quota.available, false);
  assert.equal(snapshot.quota.reason, 'not provided by gateway');
  assert.equal(snapshot.models[0].lastRequest.stream, true);
  assert.equal(snapshot.models[0].context.usedTokens, 20);
  assert.equal(snapshot.models[0].context.remainingTokens, 80);
  assert.equal(snapshot.models[0].context.utilizationPercent, 20);
  assert.equal(snapshot.models[0].context.basis, 'last-completed-request');
});

test('UsageTelemetry lists catalog models with unknown usage without inventing utilization', () => {
  const telemetry = new UsageTelemetry({ clock: () => 7 });
  const snapshot = telemetry.snapshot([{ realId: 'unused', contextWindow: null }]);
  assert.equal(snapshot.models[0].requests, 0);
  assert.equal(snapshot.models[0].lastRequest, null);
  assert.equal(snapshot.models[0].context.available, false);
  assert.equal(snapshot.models[0].context.usedTokens, null);
  assert.equal(snapshot.models[0].context.utilizationPercent, null);
});

test('AnthropicUsageObserver handles split SSE and merges start/delta usage', () => {
  const observer = new AnthropicUsageObserver();
  observer.push('event: message_start\r\ndata: {"type":"message_start","message":{"us');
  observer.push('age":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3}}}\r\n\r\n');
  observer.push('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n');
  assert.deepEqual(observer.finish(), {
    input_tokens: 12,
    output_tokens: 9,
    cache_read_input_tokens: 3,
  });
});
