import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseLineParser, ToolCallAccumulator } from '../src/sse.js';

test('SseLineParser: emits complete data payloads, ignores non-data lines', () => {
  const p = new SseLineParser();
  const out = p.push('event: x\ndata: {"a":1}\n\n: comment\ndata: [DONE]\n');
  assert.deepEqual(out, ['{"a":1}', '[DONE]']);
});

test('SseLineParser: buffers a line split across two chunks', () => {
  const p = new SseLineParser();
  assert.deepEqual(p.push('data: {"hel'), []);
  assert.deepEqual(p.push('lo":true}\n'), ['{"hello":true}']);
});

test('SseLineParser: JSON split across THREE chunks mid-object', () => {
  const p = new SseLineParser();
  assert.deepEqual(p.push('data: {"to'), []);
  assert.deepEqual(p.push('ol":"sea'), []);
  const out = p.push('rch"}\n');
  assert.deepEqual(out, ['{"tool":"search"}']);
  assert.deepEqual(JSON.parse(out[0]), { tool: 'search' });
});

test('SseLineParser: handles CRLF line endings', () => {
  const p = new SseLineParser();
  assert.deepEqual(p.push('data: {"x":1}\r\n'), ['{"x":1}']);
});

test('SseLineParser: flush returns a trailing line without newline', () => {
  const p = new SseLineParser();
  assert.deepEqual(p.push('data: {"y":2}'), []);
  assert.deepEqual(p.flush(), ['{"y":2}']);
});

test('ToolCallAccumulator: stitches arguments split across deltas', () => {
  const acc = new ToolCallAccumulator();
  const a = acc.feed({ index: 0, id: 't1', function: { name: 'search', arguments: '{"q":' } });
  assert.equal(a.isNew, true);
  acc.feed({ index: 0, function: { arguments: '"cats"' } });
  acc.feed({ index: 0, function: { arguments: '}' } });
  const [call] = acc.finalize();
  assert.equal(call.id, 't1');
  assert.equal(call.name, 'search');
  assert.deepEqual(JSON.parse(call.args), { q: 'cats' });
});

test('ToolCallAccumulator: tracks two parallel tool calls by index', () => {
  const acc = new ToolCallAccumulator();
  acc.feed({ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":1}' } });
  acc.feed({ index: 1, id: 'b', function: { name: 'g', arguments: '{"y":2}' } });
  const calls = acc.finalize();
  assert.equal(calls.length, 2);
  assert.equal(calls.find((c) => c.index === 1).name, 'g');
});
