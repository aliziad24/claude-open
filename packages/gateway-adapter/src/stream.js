// Streaming translators: OpenAI Chat/Responses SSE -> Anthropic SSE frames.
// (Implementation plan sections 7.4, 10.1.)
//
// Written as generators over an async iterable of decoded string chunks so they
// are testable without a live socket. Each yields Anthropic SSE frame strings in
// the correct order:
//   message_start -> content_block_start -> content_block_delta* ->
//   content_block_stop -> message_delta(stop_reason,usage) -> message_stop

import { SseLineParser, ToolCallAccumulator, anthropicFrame } from './sse.js';
import { mapFinishReason, normalizeUsage } from './convert.js';

let _sid = 0;
function msgId() {
  _sid += 1;
  return `msg_${_sid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Translate an OpenAI Chat Completions stream to Anthropic SSE frames.
 * Handles interleaved text and tool-call deltas with split JSON arguments.
 * @param {AsyncIterable<string>} chunks decoded upstream chunks
 * @param {string} model
 * @returns {AsyncGenerator<string>}
 */
export async function* translateChatStream(chunks, model, opts = {}) {
  const id = msgId();
  yield anthropicFrame('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield anthropicFrame('ping', { type: 'ping' });

  const parser = new SseLineParser();
  const tools = new ToolCallAccumulator();
  let textOpen = false;
  let textIndex = 0;
  let nextBlock = 0;
  const toolBlockIndex = new Map(); // accumulator index -> anthropic block index
  let finishReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  const openText = function* () {
    if (!textOpen) {
      textIndex = nextBlock++;
      textOpen = true;
      yield anthropicFrame('content_block_start', {
        type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' },
      });
    }
  };
  const closeText = function* () {
    if (textOpen) {
      textOpen = false;
      yield anthropicFrame('content_block_stop', { type: 'content_block_stop', index: textIndex });
    }
  };

  for await (const chunk of chunks) {
    for (const payload of parser.push(chunk)) {
      if (payload === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue; // partial — SseLineParser only emits complete lines, so skip junk
      }
      if (ev.error) {
        yield* closeText();
        yield anthropicFrame('error', {
          type: 'error',
          error: { type: 'api_error', message: ev.error.message || 'upstream error' },
        });
        return;
      }
      const ch = (ev.choices && ev.choices[0]) || {};
      const delta = ch.delta || {};
      if (ch.finish_reason) finishReason = ch.finish_reason;
      if (ev.usage) usage = normalizeUsage(ev.usage);

      if (typeof delta.content === 'string' && delta.content.length) {
        yield* openText();
        yield anthropicFrame('content_block_delta', {
          type: 'content_block_delta', index: textIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const { index, isNew, argsDelta } = tools.feed(tc);
          if (isNew) {
            yield* closeText();
            const bi = nextBlock++;
            toolBlockIndex.set(index, bi);
            const st = tools.finalize().find((s) => s.index === index);
            yield anthropicFrame('content_block_start', {
              type: 'content_block_start', index: bi,
              content_block: { type: 'tool_use', id: st.id || `toolu_${bi}`, name: st.name, input: {} },
            });
          }
          if (argsDelta) {
            yield anthropicFrame('content_block_delta', {
              type: 'content_block_delta', index: toolBlockIndex.get(index),
              delta: { type: 'input_json_delta', partial_json: argsDelta },
            });
          }
        }
      }
    }
  }

  yield* closeText();
  for (const bi of toolBlockIndex.values()) {
    yield anthropicFrame('content_block_stop', { type: 'content_block_stop', index: bi });
  }
  yield anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  if (typeof opts.onUsage === 'function') opts.onUsage(usage);
  yield anthropicFrame('message_stop', { type: 'message_stop' });
}

/**
 * Translate an OpenAI Responses stream to Anthropic SSE frames.
 * @param {AsyncIterable<string>} chunks
 * @param {string} model
 * @param {{includeReasoning?:boolean}} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* translateResponsesStream(chunks, model, opts = {}) {
  const id = msgId();
  yield anthropicFrame('message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield anthropicFrame('ping', { type: 'ping' });
  yield anthropicFrame('content_block_start', {
    type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
  });

  const parser = new SseLineParser();
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = 'end_turn';

  for await (const chunk of chunks) {
    for (const payload of parser.push(chunk)) {
      if (payload === '[DONE]') continue;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      const t = ev.type;
      if (t === 'response.output_text.delta' && typeof ev.delta === 'string') {
        yield anthropicFrame('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.delta },
        });
      } else if (
        opts.includeReasoning &&
        t === 'response.reasoning_summary_text.delta' &&
        typeof ev.delta === 'string'
      ) {
        yield anthropicFrame('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.delta },
        });
      } else if (t === 'response.completed' || t === 'response.incomplete') {
        if (ev.response?.usage) usage = normalizeUsage(ev.response.usage);
        if (ev.response?.status === 'incomplete') stopReason = 'max_tokens';
      } else if (t === 'error' || t === 'response.failed') {
        yield anthropicFrame('error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: ev.message || ev.response?.error?.message || 'responses stream error',
          },
        });
        return;
      }
    }
  }

  yield anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 });
  yield anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  if (typeof opts.onUsage === 'function') opts.onUsage(usage);
  yield anthropicFrame('message_stop', { type: 'message_stop' });
}
