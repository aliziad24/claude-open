// Incremental SSE (Server-Sent Events) parser.
// (Implementation plan section 10.1: "SSE parser with split JSON and split tool
//  arguments" — chunk boundaries may fall anywhere, including mid-line and
//  mid-JSON.)
//
// This parser is transport-agnostic: feed it arbitrary byte-string chunks and it
// yields complete `data:` payload strings in order. It buffers partial lines
// across chunks so a JSON object split across two network reads is never
// truncated. Downstream code is responsible for JSON.parse and for accumulating
// tool-call argument fragments (which arrive as multiple deltas).

export class SseLineParser {
  constructor() {
    this._buf = '';
  }

  /**
   * Push a raw chunk; returns the list of complete `data:` payloads found.
   * Non-data lines (event:, id:, comments, blanks) are ignored here — the
   * Anthropic/OpenAI streams we translate carry their type inside the JSON.
   * @param {string} chunk
   * @returns {string[]} payload strings (the text after "data:")
   */
  push(chunk) {
    this._buf += chunk;
    const out = [];
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '') continue;
      out.push(payload);
    }
    return out;
  }

  /** Flush any trailing complete data line held without a final newline. */
  flush() {
    const rest = this._buf;
    this._buf = '';
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5).trim();
      if (payload) return [payload];
    }
    return [];
  }
}

/**
 * Accumulates OpenAI streaming tool-call fragments. Tool-call arguments arrive
 * split across many deltas keyed by index; this stitches them back together.
 */
export class ToolCallAccumulator {
  constructor() {
    /** @type {Map<number,{id:string|null,name:string,args:string}>} */
    this._byIndex = new Map();
  }

  /**
   * Feed one OpenAI streaming tool_call delta.
   * @param {{index?:number, id?:string, function?:{name?:string, arguments?:string}}} tc
   * @returns {{index:number, isNew:boolean, argsDelta:string}}
   */
  feed(tc) {
    const index = tc.index ?? 0;
    let st = this._byIndex.get(index);
    const isNew = !st;
    if (!st) {
      st = { id: tc.id || null, name: tc.function?.name || '', args: '' };
      this._byIndex.set(index, st);
    }
    if (tc.id && !st.id) st.id = tc.id;
    if (tc.function?.name && !st.name) st.name = tc.function.name;
    const argsDelta = tc.function?.arguments || '';
    st.args += argsDelta;
    return { index, isNew, argsDelta };
  }

  /** @returns {Array<{index:number, id:string|null, name:string, args:string}>} */
  finalize() {
    return [...this._byIndex.entries()].map(([index, s]) => ({ index, ...s }));
  }
}

/**
 * Format an Anthropic SSE frame (event + data).
 * @param {string} event
 * @param {object} data
 * @returns {string}
 */
export function anthropicFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
