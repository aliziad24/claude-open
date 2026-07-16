// Route resolution: decide which upstream protocol/endpoint a model uses.
// (Plan 7.3; NEXT-INSTRUCTIONS 5.1/7 — data-driven, NO vendor/model-name
// regexes in the production path.)
//
// Precedence (first that yields a route wins):
//   1. explicit per-model override (config.modelOverrides[realId].route)
//   2. gateway-provided endpoint/capability metadata on the model record
//   3. saved live conformance-probe result for this gateway + model
//   4. the data-driven registry record's declared route(s)
//   5. honest "unsupported"/"unknown" result — never a name-based guess
//
// There is NO conditional on "gpt"/"llama"/"gemini" etc. in this file. Any such
// knowledge lives in the versioned registry data, applied via the normalized
// model's `routes` field.

export const ROUTES = /** @type {const} */ (['anthropic', 'openai-chat', 'openai-responses']);

/**
 * @typedef {Object} RouteDecision
 * @property {string|null} route
 * @property {'override'|'metadata'|'probe'|'registry'|'unsupported'|'unknown'} source
 * @property {boolean} confident
 * @property {string} [reason]
 */

/** Read a route hint from raw gateway model metadata, if present. */
function routeFromMetadata(rec) {
  if (!rec) return null;
  const explicit = rec.route || rec.protocol || rec.api || rec.endpoint_type;
  if (typeof explicit === 'string') {
    const e = explicit.toLowerCase();
    if (e.includes('response')) return 'openai-responses';
    if (e.includes('chat') || e === 'openai') return 'openai-chat';
    if (e.includes('message') || e === 'anthropic') return 'anthropic';
  }
  if (Array.isArray(rec.supported_endpoints)) {
    const set = rec.supported_endpoints.map((s) => String(s).toLowerCase());
    if (set.some((s) => s.includes('/responses'))) return 'openai-responses';
    if (set.some((s) => s.includes('/chat/completions'))) return 'openai-chat';
    if (set.some((s) => s.includes('/messages'))) return 'anthropic';
  }
  return null;
}

/**
 * Resolve the route for a model.
 * @param {object} params
 * @param {string} params.realId
 * @param {object} [params.model]     normalized model (carries registry routes + sourceMetadata)
 * @param {object} [params.override]  config.modelOverrides[realId]
 * @param {Map<string,string>|object} [params.probeCache]  gatewayFingerprint+id -> proven route
 * @param {string} [params.gatewayFingerprint]
 * @returns {RouteDecision}
 */
export function resolveRoute({ realId, model, override, probeCache, gatewayFingerprint }) {
  // 1. explicit override
  if (override && typeof override.route === 'string') {
    if (!ROUTES.includes(override.route)) {
      return {
        route: null,
        source: 'unsupported',
        confident: false,
        reason: `override route '${override.route}' is not one of ${ROUTES.join(', ')}`,
      };
    }
    return { route: override.route, source: 'override', confident: true };
  }

  // 2. gateway metadata (from the raw record captured on the normalized model)
  const meta = routeFromMetadata(model?.sourceMetadata);
  if (meta) return { route: meta, source: 'metadata', confident: true };

  // 3. saved live conformance-probe result
  if (probeCache && gatewayFingerprint) {
    const key = `${gatewayFingerprint}::${realId}`;
    const proven =
      typeof probeCache.get === 'function' ? probeCache.get(key) : probeCache[key];
    if (proven && ROUTES.includes(proven)) {
      return { route: proven, source: 'probe', confident: true };
    }
  }

  // 4. registry-declared routes on the normalized model
  const routes = model?.routes;
  if (Array.isArray(routes) && routes.length) {
    if (routes.length === 1 && routes[0] === 'unsupported') {
      return {
        route: null,
        source: 'unsupported',
        confident: true,
        reason:
          model?.unavailableReason ||
          `model '${realId}' is not usable from Claude Desktop's chat surface`,
      };
    }
    const first = routes.find((r) => ROUTES.includes(r));
    if (first) {
      // Confident only if the registry named a single concrete route.
      return { route: first, source: 'registry', confident: routes.length === 1 };
    }
  }

  // 5. honest unknown — never guess from the name
  return {
    route: null,
    source: 'unknown',
    confident: false,
    reason: `no route known for '${realId}'; add a registry record, a gateway metadata hint, a probe result, or set modelOverrides['${realId}'].route`,
  };
}
