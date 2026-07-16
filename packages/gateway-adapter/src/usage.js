// Usage/context adapter interface. (Implementation plan section 7.7.)
//
// Rather than hard-coding one billing endpoint, a usage adapter implements:
//   getPlan(), getUsage(window), getRateLimits(), getContext(model)
//
// If a gateway has no account-usage API, the adapter returns a "not provided by
// gateway" marker — we do NOT estimate billing from local tokens as if it were
// authoritative. Context for a model comes only from gateway metadata or an
// explicit override, always with source + timestamp.

export const NOT_PROVIDED = Object.freeze({ available: false, reason: 'not provided by gateway' });

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Process-lifetime, observed-token telemetry. This deliberately does not turn
 * local token counts into billing/quota claims: gateways differ widely and an
 * account usage endpoint must be configured separately before quota is known.
 */
export class UsageTelemetry {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.startedAt = clock();
    this.models = new Map();
  }

  record({ model, usage, contextWindow = null, contextSource = 'unknown', route = null, stream = false }) {
    if (!model || !usage) return null;
    const observed = {
      inputTokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
      outputTokens: tokenCount(usage.output_tokens ?? usage.completion_tokens),
      cacheReadInputTokens: tokenCount(
        usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens,
      ),
      reasoningTokens: tokenCount(
        usage.reasoning_tokens ??
          usage.output_tokens_details?.reasoning_tokens ??
          usage.completion_tokens_details?.reasoning_tokens,
      ),
    };
    observed.totalTokens = observed.inputTokens + observed.outputTokens;

    const previous = this.models.get(model) || {
      model,
      requests: 0,
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
    };
    previous.requests += 1;
    for (const key of Object.keys(previous.totals)) previous.totals[key] += observed[key];
    previous.lastRequest = { ...observed, at: this.clock(), route, stream: Boolean(stream), source: 'gateway-response' };
    previous.context = contextSnapshot(contextWindow, contextSource, observed.totalTokens);
    this.models.set(model, previous);
    return previous;
  }

  snapshot(catalog = []) {
    const metadata = new Map(catalog.map((m) => [m.realId || m.id, m]));
    const ids = new Set([...metadata.keys(), ...this.models.keys()]);
    const models = [...ids].sort().map((id) => {
      const existing = this.models.get(id);
      const model = metadata.get(id);
      const window = model?.context?.window ?? model?.contextWindow ?? null;
      const source = model?.context?.source ?? (window == null ? 'unknown' : 'gateway');
      if (existing) {
        return {
          ...existing,
          context: contextSnapshot(window, source, existing.lastRequest.totalTokens),
        };
      }
      return {
        model: id,
        requests: 0,
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
        lastRequest: null,
        context: contextSnapshot(window, source, null),
      };
    });
    const totals = models.reduce(
      (sum, item) => {
        sum.requests += item.requests;
        for (const key of Object.keys(item.totals)) sum[key] += item.totals[key];
        return sum;
      },
      { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
    );
    return {
      scope: 'adapter-process-session',
      startedAt: this.startedAt,
      updatedAt: this.clock(),
      totals,
      models,
      quota: { ...NOT_PROVIDED },
      billing: { ...NOT_PROVIDED },
    };
  }
}

function contextSnapshot(window, source, used) {
  const validWindow = typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null;
  const validUsed = typeof used === 'number' ? used : null;
  return {
    available: validWindow != null,
    window: validWindow,
    source: validWindow == null ? 'unknown' : source || 'gateway',
    usedTokens: validUsed,
    remainingTokens: validWindow != null && validUsed != null ? Math.max(0, validWindow - validUsed) : null,
    utilizationPercent: validWindow != null && validUsed != null
      ? Math.round((validUsed / validWindow) * 10000) / 100
      : null,
    basis: validUsed == null ? 'no-completed-request' : 'last-completed-request',
  };
}

/** Incrementally extracts usage from Anthropic SSE, including split chunks. */
export class AnthropicUsageObserver {
  constructor() {
    this.buffer = '';
    this.usage = null;
  }

  push(chunk) {
    this.buffer += String(chunk);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) this.#line(line);
  }

  finish() {
    if (this.buffer) this.#line(this.buffer);
    this.buffer = '';
    return this.usage;
  }

  #line(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    const candidate = event.type === 'message_start' ? event.message?.usage : event.usage;
    if (!candidate) return;
    this.usage ||= {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'reasoning_tokens']) {
      if (typeof candidate[key] === 'number') this.usage[key] = candidate[key];
    }
  }
}

/**
 * The null adapter: honestly reports that the gateway exposes no usage data.
 * @type {{getPlan:Function,getUsage:Function,getRateLimits:Function,getContext:Function}}
 */
export const noneUsageAdapter = {
  async getPlan() {
    return { ...NOT_PROVIDED };
  },
  async getUsage() {
    return { ...NOT_PROVIDED };
  },
  async getRateLimits() {
    return { ...NOT_PROVIDED };
  },
  async getContext(model) {
    return contextFromModel(model);
  },
};

/**
 * Context for a model: value + provenance + timestamp. Never a global default.
 * @param {object} model normalized model
 * @returns {{available:boolean, window:number|null, source:string, at:number}}
 */
export function contextFromModel(model) {
  const window = model?.context?.window ?? model?.contextWindow ?? null;
  const source = model?.context?.source ?? (window != null ? 'gateway' : 'unknown');
  return { available: window != null, window, source, at: Date.now() };
}

/**
 * A usage adapter backed by OpenAI-style response headers (rate limits).
 * Reads x-ratelimit-* headers captured from the last upstream response.
 * @param {() => Headers|Map<string,string>|Record<string,string>} getLastHeaders
 */
export function openAIHeadersUsageAdapter(getLastHeaders) {
  const read = (h, key) => {
    if (!h) return undefined;
    if (typeof h.get === 'function') return h.get(key);
    return h[key];
  };
  return {
    async getPlan() {
      return { ...NOT_PROVIDED };
    },
    async getUsage() {
      return { ...NOT_PROVIDED };
    },
    async getRateLimits() {
      const h = getLastHeaders();
      const remainingReq = read(h, 'x-ratelimit-remaining-requests');
      const remainingTok = read(h, 'x-ratelimit-remaining-tokens');
      if (remainingReq == null && remainingTok == null) return { ...NOT_PROVIDED };
      return {
        available: true,
        remainingRequests: remainingReq != null ? Number(remainingReq) : null,
        remainingTokens: remainingTok != null ? Number(remainingTok) : null,
        source: 'response-headers',
        at: Date.now(),
      };
    },
    async getContext(model) {
      return contextFromModel(model);
    },
  };
}

/**
 * A usage adapter driven by a user-supplied JSON mapping describing where the
 * gateway exposes plan/usage. This keeps the interface open without hard-coding.
 * @param {object} mapping { planEndpoint?, usageEndpoint? }
 * @param {(path:string)=>Promise<object>} fetchJson
 */
export function mappedUsageAdapter(mapping, fetchJson) {
  return {
    async getPlan() {
      if (!mapping?.planEndpoint) return { ...NOT_PROVIDED };
      try {
        return { available: true, source: 'gateway', data: await fetchJson(mapping.planEndpoint) };
      } catch {
        return { available: false, reason: 'plan endpoint error' };
      }
    },
    async getUsage() {
      if (!mapping?.usageEndpoint) return { ...NOT_PROVIDED };
      try {
        return { available: true, source: 'gateway', data: await fetchJson(mapping.usageEndpoint) };
      } catch {
        return { available: false, reason: 'usage endpoint error' };
      }
    },
    async getRateLimits() {
      return { ...NOT_PROVIDED };
    },
    async getContext(model) {
      return contextFromModel(model);
    },
  };
}
