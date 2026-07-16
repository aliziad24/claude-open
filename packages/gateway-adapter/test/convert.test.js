import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToChat,
  chatToAnthropic,
  anthropicToResponses,
  responsesToAnthropic,
  normalizeUsage,
  mapFinishReason,
} from '../src/convert.js';

test('anthropicToChat: system string becomes a system message', () => {
  const out = anthropicToChat({ model: 'm', system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'be brief');
  assert.equal(out.messages[1].content, 'hi');
});

test('anthropicToChat: system array of blocks is joined', () => {
  const out = anthropicToChat({ model: 'm', system: [{ text: 'a' }, { text: 'b' }], messages: [] });
  assert.equal(out.messages[0].content, 'a\nb');
});

test('anthropicToChat: base64 image -> data url', () => {
  const out = anthropicToChat({
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ],
  });
  const part = out.messages[0].content[0];
  assert.equal(part.type, 'image_url');
  assert.equal(part.image_url.url, 'data:image/png;base64,AAAA');
});

test('anthropicToChat: url image passes through', () => {
  const out = anthropicToChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  });
  assert.equal(out.messages[0].content[0].image_url.url, 'https://x/y.png');
});

test('anthropicToChat: assistant tool_use -> tool_calls', () => {
  const out = anthropicToChat({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'cats' } }] },
    ],
  });
  const m = out.messages[0];
  assert.equal(m.tool_calls[0].function.name, 'search');
  assert.deepEqual(JSON.parse(m.tool_calls[0].function.arguments), { q: 'cats' });
});

test('anthropicToChat: tool_result -> tool role message', () => {
  const out = anthropicToChat({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found' }] }],
  });
  const tool = out.messages.find((x) => x.role === 'tool');
  assert.equal(tool.tool_call_id, 't1');
  assert.equal(tool.content, 'found');
});

test('anthropicToChat: tools + tool_choice conversions', () => {
  const out = anthropicToChat({
    model: 'm',
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
    messages: [],
  });
  assert.equal(out.tools[0].function.name, 'f');
  assert.equal(out.tool_choice, 'required');
});

test('chatToAnthropic: text + tool_calls round-trip into content blocks', () => {
  const a = chatToAnthropic(
    {
      id: 'o1',
      model: 'gpt',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: 'sure',
            tool_calls: [{ id: 'tc1', function: { name: 'go', arguments: '{"x":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    },
    'gpt',
  );
  assert.equal(a.content[0].text, 'sure');
  assert.equal(a.content[1].type, 'tool_use');
  assert.deepEqual(a.content[1].input, { x: 1 });
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.usage, { input_tokens: 3, output_tokens: 5 });
});

test('chatToAnthropic: malformed tool args degrade to empty object, not crash', () => {
  const a = chatToAnthropic(
    { choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'g', arguments: '{bad' } }] } }] },
    'm',
  );
  assert.deepEqual(a.content.find((c) => c.type === 'tool_use').input, {});
});

test('mapFinishReason maps known reasons and defaults to end_turn', () => {
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason('whatever'), 'end_turn');
});

test('anthropicToResponses: effort applied only when provided', () => {
  const withEffort = anthropicToResponses({ model: 'm', messages: [] }, { effort: 'high' });
  assert.deepEqual(withEffort.reasoning, { effort: 'high' });
  const without = anthropicToResponses({ model: 'm', messages: [] });
  assert.equal(without.reasoning, undefined);
});

test('anthropicToResponses: input/output text typing by role', () => {
  const out = anthropicToResponses({
    model: 'm',
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ],
  });
  assert.equal(out.input[0].content[0].type, 'input_text');
  assert.equal(out.input[1].content[0].type, 'output_text');
});

test('responsesToAnthropic: output_text and output[] both supported', () => {
  assert.equal(responsesToAnthropic({ output_text: 'hello' }, 'm').content[0].text, 'hello');
  const viaArray = responsesToAnthropic(
    { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }], status: 'incomplete' },
    'm',
  );
  assert.equal(viaArray.content[0].text, 'hi');
  assert.equal(viaArray.stop_reason, 'max_tokens');
});

test('anthropicToResponses: tools become real function tools, not text', () => {
  const out = anthropicToResponses({
    model: 'm',
    tools: [{ name: 'search', description: 'find', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: 'go' }],
  });
  assert.equal(out.tools[0].type, 'function');
  assert.equal(out.tools[0].name, 'search');
  assert.equal(out.tool_choice, 'required');
});

test('anthropicToResponses: tool_use/tool_result become function_call items, not text', () => {
  const out = anthropicToResponses({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'go', input: { x: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'done' }] },
    ],
  });
  const call = out.input.find((i) => i.type === 'function_call');
  const result = out.input.find((i) => i.type === 'function_call_output');
  assert.equal(call.name, 'go');
  assert.deepEqual(JSON.parse(call.arguments), { x: 1 });
  assert.equal(result.call_id, 'c1');
  assert.equal(result.output, 'done');
});

test('responsesToAnthropic: function_call output item -> real tool_use block', () => {
  const a = responsesToAnthropic(
    {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'let me search' }] },
        { type: 'function_call', call_id: 'c9', name: 'search', arguments: '{"q":"x"}' },
      ],
      status: 'completed',
    },
    'm',
  );
  const toolUse = a.content.find((c) => c.type === 'tool_use');
  assert.equal(toolUse.name, 'search');
  assert.deepEqual(toolUse.input, { q: 'x' });
  assert.equal(a.stop_reason, 'tool_use');
});

test('normalizeUsage: preserves cache and reasoning tokens across shapes', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4 }), {
    input_tokens: 10,
    output_tokens: 4,
  });
  const u = normalizeUsage({
    input_tokens: 2,
    output_tokens: 3,
    cache_read_input_tokens: 1,
    output_tokens_details: { reasoning_tokens: 7 },
  });
  assert.equal(u.cache_read_input_tokens, 1);
  assert.equal(u.reasoning_tokens, 7);
});
