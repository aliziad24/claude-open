// Production loopback adapter server. (NEXT-INSTRUCTIONS 4.)
//
// This is the real HTTP service Claude Open owns. Claude Desktop points its
// ANTHROPIC_BASE_URL at http://127.0.0.1:<port> and this server:
//   - GET  /health                     liveness + gateway fingerprint (no secret)
//   - GET  /v1/models                  live discovery -> classified + aliased catalog
//   - POST /v1/messages                routed to the correct upstream protocol
//   - POST /v1/messages/count_tokens   passthrough or labeled local estimate
//   - GET  /diagnostics                authenticated; redacted status for control center
//
// It binds ONLY to loopback, resolves the secret at runtime from the secret
// store, forwards the configured auth exactly, and never puts the base URL or
// secret in source. Port conflicts are handled by picking a free port and
// persisting it so the isolated Claude config can be pointed at it.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  handleMessage,
  anthropicToChat,
  anthropicToResponses,
  chatToAnthropic,
  responsesToAnthropic,
  translateChatStream,
  translateResponsesStream,
  resolveRoute,
  reasoningControl,
  mapThinkingToUpstream,
  applyPatch,
  runHealthChecks,
  probeEffort,
  UsageTelemetry,
  AnthropicUsageObserver,
} from '@claude-open/gateway-adapter';
import { ConformanceStore } from '@claude-open/gateway-adapter';
import { AliasMap, normalizeCatalog, CatalogCache } from '@claude-open/model-catalog';
import { loadRegistry, resolveCapabilities, isChatUsable } from '@claude-open/model-registry';

const REGISTRY = loadRegistry();

/** Sanitize any string that might carry a secret before logging. */
function redact(s) {
  return String(s || '')
    .replace(/(authorization|x-api-key|bearer)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/sk-[A-Za-z0-9\-_]{6,}/g, '<redacted>');
}

/**
 * Create (but do not start) the adapter server.
 * @param {object} opts
 * @param {object} opts.config validated gateway config (baseUrl, auth, profile, modelsEndpoint, modelOverrides, customHeaders)
 * @param {{resolve:()=>string|null, fingerprint:()=>string, source:()=>string}} opts.secretStore
 * @param {(line:object)=>void} [opts.log] structured redacted logger
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.gatewayFingerprint] stable id for probe caching
 */
export function createAdapterServer({ config, secretStore, log = () => {}, fetchImpl = fetch, gatewayFingerprint, aliasStorePath, probeStorePath, conformanceStore, clientToken = null }) {
  const base = config.baseUrl.replace(/\/+$/, '');
  // Security-review defect 2(a): cap the request body so a local process cannot
  // stream an unbounded body and OOM the adapter. Default 10MB; readBody rejects
  // with a 413-carrying error the moment the cap is exceeded and stops buffering.
  const maxBodyBytes = config.maxBodyBytes ?? 10 * 1024 * 1024;
  const fp = gatewayFingerprint || hostFingerprint(base);
  const salt = config.aliasSalt || `claude-open::${fp}`;

  // Persist alias mappings per gateway fingerprint so alias->realId stays stable
  // across real restarts (Defect 2.7). aliasStorePath is a directory owned by
  // the isolated runtime; the file is namespaced by fingerprint.
  const aliasFile = aliasStorePath ? join(aliasStorePath, `aliases-${fp}.json`) : null;
  let aliasMap;
  if (aliasFile && existsSync(aliasFile)) {
    try {
      aliasMap = AliasMap.fromJSON(JSON.parse(readFileSync(aliasFile, 'utf8')));
    } catch {
      aliasMap = new AliasMap({ salt });
    }
  } else {
    aliasMap = new AliasMap({ salt });
  }
  function persistAliases() {
    if (!aliasFile) return;
    try {
      mkdirSync(dirname(aliasFile), { recursive: true });
      writeFileSync(aliasFile, JSON.stringify(aliasMap.toJSON(), null, 2), { encoding: 'utf8' });
    } catch (e) {
      log({ evt: 'warn', msg: `alias persist failed: ${redact(e.message)}` });
    }
  }

  const cache = new CatalogCache({ ttlMs: config.catalogTtlMs ?? 5 * 60 * 1000 });
  const probeCache = new Map();
  const diagToken = randomBytes(24).toString('hex'); // guards /diagnostics
  const resolveCaps = (id) => resolveCapabilities(REGISTRY, id);
  const telemetry = new UsageTelemetry();

  function recordUsage(realId, usage, model, route, stream = false) {
    if (!usage) return;
    telemetry.record({
      model: realId,
      usage,
      contextWindow: model?.context?.window ?? model?.contextWindow ?? null,
      contextSource: model?.context?.source ?? (model?.contextWindow != null ? 'gateway' : 'unknown'),
      route,
      stream,
    });
  }

  // Conformance store: enforces live probe results at catalog + request time.
  const conformance =
    conformanceStore ||
    new ConformanceStore({
      filePath: probeStorePath ? ConformanceStore.pathFor(probeStorePath, fp) : null,
      version: REGISTRY.version || 'unversioned',
      // Security-review defect 2(c): surface a persist write failure of verified
      // probe results through the adapter's redacted logger instead of silently
      // discarding it.
      log,
    });

  // Per-gateway, per-user effort selections. A preference is applied only while
  // the exact field/value still has a current conformance proof. It never turns
  // an unverified registry hint into an upstream field.
  const effortPreferencesFile = probeStorePath ? join(probeStorePath, `effort-preferences-${fp}.json`) : null;
  const effortPreferences = loadJsonObject(effortPreferencesFile);
  const persistEffortPreferences = () => {
    if (!effortPreferencesFile) return;
    mkdirSync(dirname(effortPreferencesFile), { recursive: true });
    writeFileSync(effortPreferencesFile, JSON.stringify(effortPreferences, null, 2), { encoding: 'utf8' });
  };

  /**
   * Resolve the PROBE-ENFORCED reasoning control for a model on its route.
   * Documented registry data is only an unverified hint; stored probe results
   * gate what is actually advertised/sent.
   */
  function enforcedReasoning(model, override, actualRoute = null) {
    const route = actualRoute || (Array.isArray(model?.routes) ? model.routes[0] : null);
    const candidate = override?.reasoning || model?.reasoning;
    const probe = conformance.enforce({
      fingerprint: fp,
      realId: model?.realId,
      route,
      reasoning: candidate,
    });
    return reasoningControl({ ...model, reasoning: candidate }, undefined, probe);
  }

  /** Build upstream headers from the configured auth + resolved secret. */
  function upstreamHeaders(extra = {}) {
    const h = { 'content-type': 'application/json', ...(config.customHeaders || {}), ...extra };
    const secret = secretStore.resolve();
    const kind = config.auth?.kind;
    if (kind === 'bearer' && secret) h['authorization'] = `Bearer ${secret}`;
    else if (kind === 'x-api-key' && secret) h['x-api-key'] = secret;
    else if (kind === 'custom-header' && secret && config.auth.headerName) h[config.auth.headerName] = secret;
    // kind 'none' -> no auth header
    return h;
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  function isClientAuthorized(req) {
    if (!clientToken) return true; // injected/unit servers may opt out
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return (
      bearer === clientToken ||
      req.headers['x-api-key'] === clientToken ||
      req.headers['x-claude-open-client'] === clientToken
    );
  }

  function requireClient(req, res) {
    if (isClientAuthorized(req)) return true;
    sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'local client authentication required' } });
    return false;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let d = '';
      let bytes = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return; // already over cap: drop further chunks, stop buffering
        // Count actual bytes (a chunk may be a Buffer or a string). Once the cap
        // is exceeded, stop buffering and reject with a 413-carrying error. We do
        // NOT keep accumulating into `d`, so an unbounded body cannot OOM us. We
        // pause the stream rather than destroy the socket so the caller can still
        // write a clean 413 response back to the client.
        bytes += Buffer.byteLength(c);
        if (bytes > maxBodyBytes) {
          over = true;
          req.pause();
          const err = new Error('request body exceeds maximum allowed size');
          err.statusCode = 413;
          reject(err);
          return;
        }
        d += c;
      });
      req.on('end', () => {
        if (!over) resolve(d);
      });
      req.on('error', (e) => {
        if (!over) reject(e);
      });
    });
  }

  /**
   * Read a body, translating an over-cap rejection into a 413 response instead
   * of the generic 502 error handler. Returns null when the response was already
   * sent (caller must return immediately).
   */
  async function readBodyOr413(req, res) {
    try {
      return await readBody(req);
    } catch (e) {
      if (e && e.statusCode === 413) {
        if (!res.headersSent) {
          sendJson(res, 413, {
            type: 'error',
            error: { type: 'request_too_large', message: 'request body exceeds the maximum allowed size' },
          });
        }
        return null;
      }
      throw e;
    }
  }

  // Bounded timeout for the COLD-cache discovery fetch so the client's
  // ConfigHealth reachability probe (a ~10s one-shot that a first-run CCD binary
  // download can starve to ~8s) never blocks on a slow live upstream round-trip.
  const COLD_DISCOVERY_TIMEOUT_MS = config.coldDiscoveryTimeoutMs ?? 4000;

  /**
   * Fetch + normalize + classify the live model catalog (with cache).
   *
   * LIVENESS/DISCOVERY FAST PATH (NEXT-CORRECTIVE-WAVE): when `preferCache` is
   * set (the default) and the cache already holds data, serve it IMMEDIATELY
   * with no upstream round-trip. This is what the client's ConfigHealth probe
   * hits (directly via GET /v1/models, and indirectly via the /v1/messages
   * tier-probe reconcile) — a warm cache must answer in <200ms. A cold cache
   * still does exactly one live fetch to populate, bounded by a short timeout so
   * even the first probe is prompt. Pass { preferCache:false } to FORCE a live
   * refresh (used only by the deliberate deep-health check, never the probe).
   *
   * The served catalog is always REAL data from the last successful fetch and is
   * marked `stale` when older than the TTL — no fabricated liveness.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.preferCache=true] serve a warm cache without fetching
   */
  async function getCatalog({ preferCache = true } = {}) {
    // Fast path: a populated cache answers the probe without touching upstream.
    if (preferCache && cache.hasData()) return cache.serve();
    try {
      const headers = { ...upstreamHeaders(), ...cache.conditionalHeaders() };
      const resp = await fetchImpl(`${base}${config.modelsEndpoint || '/v1/models'}?limit=1000`, {
        method: 'GET',
        headers,
        // Only bound the COLD fetch; a warm cache never reaches here. If the
        // signal cannot be created (old runtime), fall through unbounded.
        signal: timeoutSignal(COLD_DISCOVERY_TIMEOUT_MS),
      });
      if (resp.status === 304) {
        cache.recordNotModified();
        return cache.serve();
      }
      if (!resp.ok) {
        cache.recordFailure(`gateway HTTP ${resp.status} during discovery`);
        return cache.serve();
      }
      const body = await resp.json();
      const list = Array.isArray(body) ? body : body.data || [];
      const normalized = normalizeCatalog(list, aliasMap, {
        resolveCaps,
        modelOverrides: config.modelOverrides || {},
      });
      cache.recordFresh(normalized, resp.headers.get?.('etag') || null);
      persistAliases(); // Defect 2.7: keep alias->realId stable across restarts
      return cache.serve();
    } catch (e) {
      cache.recordFailure(`discovery error: ${redact(e.message)}`);
      return cache.serve();
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    log({ evt: 'request', method, path: url.split('?', 1)[0] });
    try {
      // --- health (liveness only; NOT overall gateway health) ---
      if (method === 'GET' && (url === '/health' || url === '/')) {
        return sendJson(res, 200, {
          ok: true,
          product: 'claude-open-adapter',
          scope: 'liveness-only',
          note: 'this endpoint proves the adapter process is up; use /health/deep for gateway health',
          gateway: fp,
          secretSource: secretStore.source(),
          hasCatalog: cache.hasData(),
        });
      }

      // --- deep layered health (config/secret/network/auth/discovery/inference) ---
      if (method === 'GET' && url.startsWith('/health/deep')) {
        if (!requireClient(req, res)) return;
        const q = new URL(url, 'http://x').searchParams;
        // Deep health is the DELIBERATE live check: force a fresh upstream
        // discovery so it reports real current gateway state, never a warm cache.
        const served = await getCatalog({ preferCache: false });
        const requested = q.get('model') ? aliasMap.realFor(q.get('model')) : null;
        const healthModel = requested
          ? served.models.find((m) => m.realId === requested)
          : served.models.find((m) => isChatUsable({ modelType: m.modelType, routes: m.routes }));
        const inferenceModel = healthModel?.realId;
        const healthDecision = inferenceModel
          ? resolveRoute({ realId: inferenceModel, model: healthModel, override: (config.modelOverrides || {})[inferenceModel], probeCache, gatewayFingerprint: fp })
          : { route: null };
        const result = await runHealthChecks({
          baseUrl: base,
          headers: upstreamHeaders(),
          modelsEndpoint: config.modelsEndpoint || '/v1/models',
          inferenceModel,
          inferenceRoute: healthDecision.route,
          requireInference: true,
          configValid: Boolean(config.baseUrl),
          secretPresent: config.auth?.kind === 'none' ? true : Boolean(secretStore.resolve()),
          fetchImpl,
        });
        return sendJson(res, 200, {
          liveness: 'pass',
          gateway: fp,
          ...result,
        });
      }

      // --- diagnostics (authenticated) ---
      if (method === 'GET' && url.startsWith('/diagnostics')) {
        const auth = req.headers['x-claude-open-diag'];
        if (auth !== diagToken) return sendJson(res, 403, { error: 'forbidden' });
        const served = cache.serve();
        return sendJson(res, 200, {
          gateway: fp,
          baseUrlHost: safeHost(base),
          authKind: config.auth?.kind,
          secret: secretStore.fingerprint(),
          secretSource: secretStore.source(),
          catalog: { count: served.models.length, stale: served.stale, reason: served.reason },
          port: server.address()?.port ?? null,
        });
      }

      // --- authenticated on-demand effort conformance probe ---
      if (method === 'POST' && url.startsWith('/control/probe-effort')) {
        const auth = req.headers['x-claude-open-diag'];
        if (auth !== diagToken) return sendJson(res, 403, { error: 'forbidden' });
        const raw = await readBodyOr413(req, res);
        if (raw === null) return;
        let input;
        try { input = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const served = await getCatalog();
        const realId = aliasMap.realFor(input.model);
        const model = served.models.find((m) => m.realId === realId);
        if (!model) return sendJson(res, 404, { error: 'model not found in current gateway catalog' });
        const override = (config.modelOverrides || {})[realId];
        const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp });
        if (!decision.route) return sendJson(res, 400, { error: 'model route is unknown; configure or probe the route first' });
        const hint = reasoningControl(model, override?.reasoning);
        if (!hint.field || hint.controlType === 'none' || hint.controlType === 'unknown' ||
            hint.controlType === 'model_variant' || hint.controlType === 'automatic_only') {
          return sendJson(res, 400, { error: 'model has no probeable effort field' });
        }
        if (input.field && input.field !== hint.field) {
          return sendJson(res, 400, { error: 'requested field does not match the current model descriptor' });
        }
        const value = resolveCandidateValue(hint, input.value);
        if (value === NO_VALUE) {
          return sendJson(res, 400, { error: 'requested value is outside the documented/overridden candidate set' });
        }
        const result = await probeEffort({
          baseUrl: base,
          headers: upstreamHeaders(),
          route: decision.route,
          realId,
          controlPatch: { path: hint.field, value },
          fetchImpl,
        });
        const record = conformance.record({
          fingerprint: fp,
          realId,
          route: decision.route,
          field: hint.field,
          value,
          result: result.result,
          evidence: result.evidence,
        });
        return sendJson(res, 200, {
          model: realId,
          route: decision.route,
          field: hint.field,
          value,
          result: record.result,
          evidence: record.evidence,
          at: record.at,
        });
      }

      // --- persist a verified per-model selection used by future app requests ---
      if (method === 'POST' && url.startsWith('/control/set-effort')) {
        const auth = req.headers['x-claude-open-diag'];
        if (auth !== diagToken) return sendJson(res, 403, { error: 'forbidden' });
        const raw = await readBodyOr413(req, res);
        if (raw === null) return;
        let input;
        try { input = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const served = await getCatalog();
        const realId = aliasMap.realFor(input.model);
        const model = served.models.find((m) => m.realId === realId);
        if (!model) return sendJson(res, 404, { error: 'model not found in current gateway catalog' });
        if (input.value == null || input.value === '') {
          delete effortPreferences[realId];
          persistEffortPreferences();
          return sendJson(res, 200, { model: realId, selected: null, applied: false });
        }
        const override = (config.modelOverrides || {})[realId];
        const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp });
        const control = enforcedReasoning(model, override, decision.route);
        const value = resolveCandidateValue(control, input.value);
        if (value === NO_VALUE || !control.showSelector || !control.field ||
            !conformance.isEnabled({ fingerprint: fp, realId, route: decision.route, field: control.field, value })) {
          return sendJson(res, 409, { error: 'selection is not verified for this exact gateway, model, route, field, and value' });
        }
        // isEnabled() above guarantees a behavior-observed proof, so a persisted
        // selection is always behaviorally verified — never schema-accepted.
        effortPreferences[realId] = { field: control.field, value, verification: control.verification || 'behavior-observed' };
        persistEffortPreferences();
        return sendJson(res, 200, { model: realId, selected: value, applied: true, verification: effortPreferences[realId].verification });
      }

      // --- models ---
      if (method === 'GET' && url.startsWith('/v1/models')) {
        if (!requireClient(req, res)) return;
        const served = await getCatalog();
        // Emit an Anthropic-picker-shaped list: alias as id, real name as display.
        const data = served.models
          .filter((m) => isChatUsable({ modelType: m.modelType, routes: m.routes }))
          .map((m) => ({
            id: m.stableAlias,
            display_name: m.displayName,
            type: 'model',
            created_at: undefined,
            // The patched client consumes this native-looking field. Advertise
            // only behaviorally verified categorical values; unknown/schema-only
            // controls remain hidden instead of becoming decorative UI.
            effort_options: (() => {
              const override = (config.modelOverrides || {})[m.realId];
              const decision = resolveRoute({ realId: m.realId, model: m, override, probeCache, gatewayFingerprint: fp });
              const rc = enforcedReasoning(m, override, decision.route);
              if (!rc.showSelector || !Array.isArray(rc.values)) return undefined;
              const names = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
              return rc.values.map((id) => ({ id, name: names[id] || String(id) }));
            })(),
            // expose classification + provenance so the control center can show it
            claude_open: {
              realId: m.realId,
              modelType: m.modelType,
              provider: m.provider,
              routes: m.routes,
              contextWindow: m.contextWindow,
              contextSource: m.context?.source,
              reasoning: (() => {
                const override = (config.modelOverrides || {})[m.realId];
                const decision = resolveRoute({ realId: m.realId, model: m, override, probeCache, gatewayFingerprint: fp });
                const rc = enforcedReasoning(m, override, decision.route);
                const candidate = reasoningControl(m, override?.reasoning);
                const selected = effortPreferences[m.realId]?.value ?? null;
                return rc.showSelector
                  ? {
                      controlType: rc.controlType,
                      field: rc.field ?? null,
                      values: rc.values ?? null,
                      allowedValues: rc.allowedValues ?? null,
                      default: rc.default ?? null,
                      min: rc.min ?? null,
                      max: rc.max ?? null,
                      specialValues: rc.specialValues ?? null,
                      source: rc.source,
                      verification: rc.verification ?? null,
                      selected,
                    }
                  : {
                      controlType: rc.controlType,
                      source: rc.source,
                      reason: rc.reason,
                      field: candidate.field ?? null,
                      candidateControlType: candidate.controlType,
                      candidateValues: candidate.values ?? candidate.allowedValues ?? numericCandidates(candidate),
                      selected,
                    };
              })(),
              capabilities: m.capabilities,
              capabilitySource: m.capabilitySource,
            },
          }));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data, has_more: false, stale: served.stale }));
      }

      // --- truthful process-session token/context telemetry ---
      if (method === 'GET' && url.startsWith('/usage')) {
        if (!requireClient(req, res)) return;
        const served = await getCatalog();
        return sendJson(res, 200, telemetry.snapshot(served.models));
      }

      // --- count_tokens ---
      if (method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
        if (!requireClient(req, res)) return;
        const raw = await readBodyOr413(req, res);
        if (raw === null) return;
        let bodyObj = {};
        try {
          bodyObj = JSON.parse(raw);
        } catch {}
        const realId = aliasMap.realFor(bodyObj.model);
        const model = findModel(cache, realId);
        const decision = resolveRoute({ realId, model, override: (config.modelOverrides || {})[realId], probeCache, gatewayFingerprint: fp });
        if (decision.route === 'anthropic') {
          const up = await fetchImpl(`${base}/v1/messages/count_tokens`, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify({ ...bodyObj, model: realId }),
          });
          if (up.ok) {
            const t = await up.text();
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(t);
          }
        }
        // labeled local estimate (~4 chars/token) for non-Anthropic routes
        let chars = 0;
        const walk = (v) => {
          if (typeof v === 'string') chars += v.length;
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(bodyObj.system);
        walk(bodyObj.messages);
        return sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)), _estimate: true });
      }

      // --- messages ---
      if (method === 'POST' && url.startsWith('/v1/messages')) {
        if (!requireClient(req, res)) return;
        const raw = await readBodyOr413(req, res);
        if (raw === null) return;
        let bodyObj;
        try {
          bodyObj = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } });
        }
        // TIER-PROBE RECONCILE (CHANGE 2): the client's ConfigHealth /
        // first-inference probe resolves by anthropicFamilyTier and can fall back
        // to a BUILT-IN tier id (e.g. claude-haiku-4-5) that the gateway is
        // 503-overloading. If the inbound model is such a tier-probe id (or any id
        // absent from the current live catalog aliases) AND a configured healthy
        // default exists, reconcile it to the persisted healthy default BEFORE
        // upstream — ONLY for this tier-probe case, never for a user-picked model
        // that IS in the catalog (plan Phase 4). Emit a diagnostic {from,to}.
        const reconciledModel = reconcileTierProbe(bodyObj.model, await getCatalog());
        if (reconciledModel && reconciledModel !== bodyObj.model) {
          log({ evt: 'tier-probe-reconcile', from: bodyObj.model, to: reconciledModel });
          bodyObj.model = reconciledModel;
        }
        const realId = aliasMap.realFor(bodyObj.model);
        bodyObj.model = realId;
        const model = findModel(cache, realId) || normalizeCatalog([{ id: realId }], aliasMap, { resolveCaps })[0];
        const override = (config.modelOverrides || {})[realId];
        // Remote Companion may choose one already-proven effort value for this
        // request only. Keeping this separate from the persisted desktop
        // preference prevents a phone session from changing the desktop UI's
        // selection or racing an unrelated desktop request.
        const requestEffort = req.headers['x-claude-open-effort'];
        if (requestEffort != null) {
          if (Array.isArray(requestEffort) || requestEffort.length > 64 ||
              !applyVerifiedEffortValue(bodyObj, model, override, realId, requestEffort)) {
            return sendJson(res, 409, { type: 'error', error: { type: 'invalid_request_error', message: 'effort is not verified for this exact gateway, model, route, field, and value' } });
          }
        } else {
          applyEffortPreference(bodyObj, model, override, realId);
        }
        const wantStream = !!bodyObj.stream;

        if (wantStream) {
          return streamMessage(res, { bodyObj, model, override, realId });
        }
        const result = await handleMessage({
          baseUrl: base,
          headers: upstreamHeaders(),
          body: bodyObj,
          model,
          override,
          probeCache,
          gatewayFingerprint: fp,
          fetchImpl,
          enforcedControl: enforcedReasoning(model, override, resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp }).route),
          // Bounded, honest retry on transient upstream overload (429/5xx) so a
          // momentarily busy gateway model does not blackhole the client's
          // ConfigHealth/first-inference probe on 3P activation. Same model is
          // retried; never substituted (plan Phase 4). Persistent errors surface
          // honestly. (NEXT-CORRECTIVE-WAVE P0.3 root-cause fix.)
          retry: { attempts: 3, baseDelayMs: 300 },
        });
        if (result.status >= 200 && result.status < 300) {
          const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp });
          recordUsage(realId, result.body?.usage, model, decision.route, false);
        }
        log({ evt: 'messages', model: realId, status: result.status });
        return sendJson(res, result.status, result.body);
      }

      // --- unknown ---
      return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'unknown endpoint' } });
    } catch (e) {
      log({ evt: 'error', msg: redact(e.message) });
      if (!res.headersSent) sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `adapter error: ${redact(e.message)}` } });
      else res.end();
    }
  });

  /** Stream a /v1/messages response by translating the upstream SSE. */
  async function streamMessage(res, { bodyObj, model, override, realId }) {
    const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp });
    if (!decision.route) {
      return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: decision.reason } });
    }
    const headers = upstreamHeaders();
    let upstream;
    let translate;
    if (decision.route === 'anthropic') {
      upstream = await fetchImpl(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
      // Anthropic route: passthrough the SSE bytes unchanged.
      res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const observer = new AnthropicUsageObserver();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          observer.push(decoder.decode(value, { stream: true }));
          res.write(Buffer.from(value));
        }
        observer.push(decoder.decode());
        recordUsage(realId, observer.finish(), model, decision.route, true);
      }
      return res.end();
    }
    if (decision.route === 'openai-chat') {
      const req = anthropicToChat({ ...bodyObj, stream: true });
      const control = enforcedReasoning(model, override, decision.route);
      applyPatch(req, mapThinkingToUpstream(bodyObj, control, 'openai-chat'));
      upstream = await fetchImpl(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(req) });
      translate = translateChatStream;
    } else {
      const control = enforcedReasoning(model, override, decision.route);
      const req = anthropicToResponses({ ...bodyObj, stream: true });
      applyPatch(req, mapThinkingToUpstream(bodyObj, control, 'openai-responses'));
      upstream = await fetchImpl(`${base}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(req) });
      translate = translateResponsesStream;
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      return sendJson(res, upstream.status, { type: 'error', error: { type: 'api_error', message: redact(safeErr(text)) } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const onUsage = (usage) => recordUsage(realId, usage, model, decision.route, true);
    for await (const frame of translate(decodedChunks(upstream.body), realId, { onUsage })) res.write(frame);
    return res.end();
  }

  // Built-in tier-probe ids the Claude client uses for ConfigHealth /
  // first-inference when resolving by anthropicFamilyTier. These are the bare
  // tier aliases baked into the client that get 503-overloaded upstream. Any of
  // these — or any id NOT present in the current live catalog aliases — is a
  // tier-probe candidate for reconciliation (never a user-picked catalog model).
  const BUILTIN_TIER_PROBE_IDS = new Set([
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-3-5-haiku',
  ]);

  /**
   * Resolve a tier-probe model id to the configured healthy default alias.
   *
   * Returns the healthy default alias ONLY when a healthy default is configured
   * (config.healthyDefaultAlias) AND the inbound id is a tier-probe id, i.e.:
   *   - a BUILT-IN tier-probe id (claude-haiku-4-5 / claude-sonnet-4-5 / ...),
   *     which the client only ever emits as its AUTOMATIC ConfigHealth /
   *     first-inference tier probe — never as a deliberate user chat pick (users
   *     pick from the configured inferenceModels aliases). This holds EVEN WHEN
   *     that built-in id also happens to appear in the live upstream catalog: a
   *     healthy default is configured precisely because that catalog entry is
   *     503-overloading the probe (confirmed live: the real gateway catalog
   *     contains claude-haiku-4-5 and 503s it, so an in-catalog check alone let
   *     the probe fail and ConfigHealth stayed 'unreachable'); OR
   *   - any id ABSENT from the current live catalog aliases (stableAlias/realId).
   *
   * A real, in-catalog model that is NOT a built-in tier-probe id is a genuine
   * user pick and is ALWAYS returned unchanged (plan Phase 4 rule).
   * Otherwise returns the original id (no reconciliation).
   */
  function reconcileTierProbe(inboundId, served) {
    const healthyDefault = config.healthyDefaultAlias;
    if (!healthyDefault || !inboundId) return inboundId;
    // The healthy default itself must never be reconciled away.
    if (inboundId === healthyDefault) return inboundId;

    // A built-in tier-probe id is the client's automatic probe, not a user pick.
    // Reconcile it to the healthy default regardless of catalog membership — the
    // whole point of a configured healthy default is to steer this probe away
    // from an overloaded built-in tier id that IS present (and 503ing) upstream.
    if (BUILTIN_TIER_PROBE_IDS.has(inboundId)) return healthyDefault;

    const models = (served && Array.isArray(served.models)) ? served.models : [];
    const inCatalog = models.some(
      (m) => m.stableAlias === inboundId || m.realId === inboundId,
    );
    // A real, in-catalog user pick is authoritative — never substitute it.
    if (inCatalog) return inboundId;

    // Absent from catalog: treat as a tier-probe fallback and reconcile.
    return healthyDefault;
  }

  function applyEffortPreference(body, model, override, realId) {
    const pref = effortPreferences[realId];
    if (!pref) return;
    applyVerifiedEffortValue(body, model, override, realId, pref.value, pref.field);
  }

  function applyVerifiedEffortValue(body, model, override, realId, requestedValue, expectedField = null) {
    const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint: fp });
    const control = enforcedReasoning(model, override, decision.route);
    const value = resolveCandidateValue(control, requestedValue);
    if (value === NO_VALUE || !control.showSelector || !control.field ||
        (expectedField && control.field !== expectedField) ||
        !conformance.isEnabled({ fingerprint: fp, realId, route: decision.route, field: control.field, value })) return false;
    if (control.controlType === 'categorical') {
      if (body.output_config?.effort == null) {
        body.output_config ||= {};
        body.output_config.effort = value;
      }
    } else if (control.controlType === 'boolean') {
      if (body.thinking == null) {
        const enabledValue = Array.isArray(control.values) ? control.values[0] : 'enabled';
        body.thinking = { type: Object.is(value, enabledValue) ? 'enabled' : 'disabled' };
      }
    } else if (control.controlType === 'numeric_budget' && body.thinking == null) {
      const off = control.specialValues?.off;
      body.thinking = Object.is(value, off)
        ? { type: 'disabled' }
        : { type: 'enabled', budget_tokens: value };
    }
    return true;
  }

  return {
    server,
    diagToken,
    gatewayFingerprint: fp,
    maxBodyBytes,
    /** Listen on the configured/free port. Returns the chosen port. */
    async listen(preferredPort = 0, host = '127.0.0.1') {
      const port = await tryListen(server, preferredPort, host);
      return port;
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
    _getCatalog: getCatalog,
  };
}

// ---- helpers ----

function findModel(cache, realId) {
  const served = cache.serve();
  return served.models.find((m) => m.realId === realId) || null;
}

/**
 * Build an AbortSignal that trips after `ms`, or undefined if the runtime lacks
 * AbortSignal.timeout. Keeps the cold-cache discovery fetch prompt without
 * blocking the client's ConfigHealth probe on a slow upstream.
 */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch {
    /* fall through: no bounded signal available */
  }
  return undefined;
}

async function* decodedChunks(webStream) {
  const reader = webStream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield dec.decode(value, { stream: true });
  }
}

function safeErr(text) {
  try {
    return JSON.parse(text).error?.message || text.slice(0, 200);
  } catch {
    return String(text).slice(0, 200);
  }
}

const NO_VALUE = Symbol('no-value');

function resolveCandidateValue(control, value) {
  if (control.controlType === 'categorical' || control.controlType === 'boolean') {
    const values = Array.isArray(control.values) ? control.values : [];
    return values.find((candidate) => Object.is(candidate, value) || String(candidate) === String(value)) ?? NO_VALUE;
  }
  if (control.controlType === 'numeric_budget') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return NO_VALUE;
    if (Array.isArray(control.allowedValues)) {
      return control.allowedValues.find((candidate) => Object.is(candidate, numeric)) ?? NO_VALUE;
    }
    if (typeof control.min === 'number' && numeric < control.min) return NO_VALUE;
    if (typeof control.max === 'number' && numeric > control.max) return NO_VALUE;
    return numeric;
  }
  return NO_VALUE;
}

function numericCandidates(control) {
  if (control?.controlType !== 'numeric_budget') return null;
  const values = Object.values(control.specialValues || {});
  if (control.default != null) values.push(control.default);
  return [...new Set(values)];
}

function loadJsonObject(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function safeHost(base) {
  try {
    return new URL(base).host;
  } catch {
    return 'invalid';
  }
}

function hostFingerprint(base) {
  return safeHost(base);
}

/**
 * Try to listen on a preferred port; if busy, fall back to an ephemeral port.
 * Never assumes 8788. Returns the actual bound port.
 */
function tryListen(server, preferredPort, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.removeListener('error', onError);
        server.listen(0, host, () => resolve(server.address().port));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(preferredPort, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}
