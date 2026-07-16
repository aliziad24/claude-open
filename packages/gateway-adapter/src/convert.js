// Protocol converters between the Anthropic Messages API (what Claude Desktop
// speaks) and OpenAI Chat Completions / OpenAI Responses.
// (Implementation plan section 7.4.)
//
// These are PURE functions with no I/O, so every branch is unit-testable.
// Rule: never silently convert unsupported blocks to text or discard
// reasoning/tool content — carry them faithfully or surface an error upstream.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function systemToString(system) {
  if (!system) return '';
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  }
  return String(system);
}

function collapseText(parts) {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

const STOP_OPENAI_TO_ANTHROPIC = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

export function mapFinishReason(reason) {
  return STOP_OPENAI_TO_ANTHROPIC[reason] || 'end_turn';
}

let _idCounter = 0;
function genId(prefix) {
  _idCounter += 1;
  return `${prefix}_${_idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Anthropic Messages  ->  OpenAI Chat Completions request
// ---------------------------------------------------------------------------

/**
 * @param {object} body Anthropic /v1/messages request body
 * @returns {object} OpenAI Chat Completions request body
 */
export function anthropicToChat(body) {
  const out = { model: body.model, stream: !!body.stream };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;

  const messages = [];
  const sys = systemToString(body.system);
  if (sys.trim()) messages.push({ role: 'system', content: sys });

  for (const msg of body.messages || []) {
    const role = msg.role;
    if (typeof msg.content === 'string') {
      messages.push({ role, content: msg.content });
      continue;
    }
    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of msg.content || []) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source) {
        if (block.source.type === 'base64') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        } else if (block.source.type === 'url') {
          parts.push({ type: 'image_url', image_url: { url: block.source.url } });
        }
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      } else if (block.type === 'tool_result') {
        const content = Array.isArray(block.content)
          ? block.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n')
          : typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        toolResults.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      }
    }

    if (role === 'assistant' && toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: parts.length ? collapseText(parts) : null,
        tool_calls: toolCalls,
      });
    } else if (toolResults.length) {
      for (const tr of toolResults) messages.push(tr);
      if (parts.length) messages.push({ role: 'user', content: collapseText(parts) });
    } else {
      messages.push({
        role,
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      });
    }
  }
  out.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }));
    if (body.tool_choice) {
      if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
      else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
      else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
        out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions response  ->  Anthropic Messages response
// ---------------------------------------------------------------------------

export function chatToAnthropic(oai, model) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id || genId('toolu'),
        name: tc.function?.name,
        input,
      });
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: oai.id || genId('msg'),
    type: 'message',
    role: 'assistant',
    model: oai.model || model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages  ->  OpenAI Responses request
// ---------------------------------------------------------------------------

/**
 * @param {object} body
 * @param {{effort?:string|null}} [opts] resolved reasoning effort (already validated)
 * @returns {object} OpenAI Responses request body
 */
export function anthropicToResponses(body, opts = {}) {
  const out = { model: body.model, stream: !!body.stream };
  if (typeof body.max_tokens === 'number') out.max_output_tokens = Math.max(16, body.max_tokens);
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (opts.effort) out.reasoning = { effort: opts.effort };

  const sys = systemToString(body.system);
  if (sys.trim()) out.instructions = sys;

  const input = [];
  for (const msg of body.messages || []) {
    const role = msg.role;
    const partType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof msg.content === 'string') {
      input.push({ role, content: [{ type: partType, text: msg.content }] });
      continue;
    }
    const parts = [];
    for (const block of msg.content || []) {
      if (block.type === 'text') {
        parts.push({ type: partType, text: block.text });
      } else if (block.type === 'tool_result') {
        // Real Responses API function-call output item (NOT text).
        const c = Array.isArray(block.content)
          ? block.content.map((x) => (typeof x === 'string' ? x : x.text || '')).join('\n')
          : typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        // Flush any pending text parts as their own message first.
        if (parts.length) {
          input.push({ role, content: parts.splice(0) });
        }
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: c });
      } else if (block.type === 'tool_use') {
        if (parts.length) input.push({ role, content: parts.splice(0) });
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === 'image' && block.source) {
        const url =
          block.source.type === 'base64'
            ? `data:${block.source.media_type};base64,${block.source.data}`
            : block.source.url;
        parts.push({ type: 'input_image', image_url: url });
      }
    }
    if (parts.length) input.push({ role, content: parts });
  }
  out.input = input.length ? input : '';

  // Tool definitions: Anthropic tools -> Responses function tools (real events).
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      }));
    if (body.tool_choice) {
      if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
      else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
      else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
        out.tool_choice = { type: 'function', name: body.tool_choice.name };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI Responses response  ->  Anthropic Messages response
// ---------------------------------------------------------------------------

export function responsesToAnthropic(resp, model) {
  const content = [];
  let text = '';
  let sawToolCall = false;

  if (typeof resp.output_text === 'string' && resp.output_text) {
    text = resp.output_text;
  } else if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (c.type === 'output_text') text += c.text || '';
      } else if (item.type === 'function_call') {
        // Real function call -> Anthropic tool_use block (NOT text).
        let input = {};
        try {
          input = JSON.parse(item.arguments || '{}');
        } catch {
          input = {};
        }
        if (text) {
          content.push({ type: 'text', text });
          text = '';
        }
        content.push({
          type: 'tool_use',
          id: item.call_id || item.id || genId('toolu'),
          name: item.name,
          input,
        });
        sawToolCall = true;
      }
    }
  }
  if (text) content.push({ type: 'text', text });
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const incomplete = resp.status === 'incomplete';
  const stop = sawToolCall ? 'tool_use' : incomplete ? 'max_tokens' : 'end_turn';
  return {
    id: resp.id || genId('msg'),
    type: 'message',
    role: 'assistant',
    model: resp.model || model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.input_tokens ?? 0,
      output_tokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// usage normalization (plan 7.7)
// ---------------------------------------------------------------------------

/**
 * Normalize token usage from either protocol into the Anthropic shape.
 * Preserves cache/reasoning token fields when present rather than dropping them.
 * @param {object} usage
 * @returns {{input_tokens:number, output_tokens:number, cache_read_input_tokens?:number, reasoning_tokens?:number}}
 */
export function normalizeUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const out = { input_tokens: input, output_tokens: output };
  const cacheRead =
    usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  if (typeof cacheRead === 'number') out.cache_read_input_tokens = cacheRead;
  const reasoning =
    usage.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ??
    usage.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === 'number') out.reasoning_tokens = reasoning;
  return out;
}
