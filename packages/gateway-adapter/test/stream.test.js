import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateChatStream, translateResponsesStream } from '../src/stream.js';

async function collect(gen) {
  let s = '';
  for await (const frame of gen) s += frame;
  return s;
}

// Parse the Anthropic SSE frames back into {event, data} objects.
function parseFrames(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event: '));
    const dt = lines.find((l) => l.startsWith('data: '));
    if (ev && dt) frames.push({ event: ev.slice(7), data: JSON.parse(dt.slice(6)) });
  }
  return frames;
}

async function* fromChunks(arr) {
  for (const c of arr) yield c;
}

test('translateChatStream: text deltas produce correct Anthropic frame order', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n',
    'data: [DONE]\n',
  ];
  const frames = parseFrames(await collect(translateChatStream(fromChunks(chunks), 'm')));
  const events = frames.map((f) => f.event);
  assert.equal(events[0], 'message_start');
  assert.ok(events.includes('content_block_start'));
  const text = frames
    .filter((f) => f.event === 'content_block_delta' && f.data.delta.type === 'text_delta')
    .map((f) => f.data.delta.text)
    .join('');
  assert.equal(text, 'Hello');
  assert.equal(events[events.length - 1], 'message_stop');
  const md = frames.find((f) => f.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'end_turn');
});

test('translateChatStream: tool call with split arguments', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"go","arguments":"{\\"a\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ];
  const frames = parseFrames(await collect(translateChatStream(fromChunks(chunks), 'm')));
  const startTool = frames.find((f) => f.event === 'content_block_start' && f.data.content_block.type === 'tool_use');
  assert.equal(startTool.data.content_block.name, 'go');
  const argFrames = frames.filter(
    (f) => f.event === 'content_block_delta' && f.data.delta.type === 'input_json_delta',
  );
  const args = argFrames.map((f) => f.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(args), { a: 1 });
  const md = frames.find((f) => f.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
});

test('translateChatStream: upstream error becomes an Anthropic error frame', async () => {
  const chunks = ['data: {"error":{"message":"rate limited"}}\n'];
  const frames = parseFrames(await collect(translateChatStream(fromChunks(chunks), 'm')));
  const err = frames.find((f) => f.event === 'error');
  assert.equal(err.data.error.message, 'rate limited');
});

test('translateResponsesStream: output_text deltas + incomplete stop reason', async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"Hi "}\n',
    'data: {"type":"response.output_text.delta","delta":"there"}\n',
    'data: {"type":"response.incomplete","response":{"status":"incomplete","usage":{"output_tokens":3}}}\n',
  ];
  const frames = parseFrames(await collect(translateResponsesStream(fromChunks(chunks), 'm')));
  const text = frames
    .filter((f) => f.event === 'content_block_delta')
    .map((f) => f.data.delta.text)
    .join('');
  assert.equal(text, 'Hi there');
  const md = frames.find((f) => f.event === 'message_delta');
  assert.equal(md.data.delta.stop_reason, 'max_tokens');
});

test('translateResponsesStream: split-JSON chunk boundaries are handled', async () => {
  // The delta object is split across two chunks mid-JSON.
  const chunks = ['data: {"type":"response.output', '_text.delta","delta":"ok"}\n'];
  const frames = parseFrames(await collect(translateResponsesStream(fromChunks(chunks), 'm')));
  const text = frames
    .filter((f) => f.event === 'content_block_delta')
    .map((f) => f.data.delta.text)
    .join('');
  assert.equal(text, 'ok');
});

test('stream translators report final upstream usage through onUsage', async () => {
  let chatUsage;
  await collect(translateChatStream(fromChunks([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}\n',
  ]), 'chat-model', { onUsage: (usage) => { chatUsage = usage; } }));
  assert.deepEqual(chatUsage, { input_tokens: 11, output_tokens: 4, reasoning_tokens: 2 });

  let responsesUsage;
  await collect(translateResponsesStream(fromChunks([
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":8,"output_tokens":3}}}\n',
  ]), 'responses-model', { onUsage: (usage) => { responsesUsage = usage; } }));
  assert.deepEqual(responsesUsage, { input_tokens: 8, output_tokens: 3 });
});
