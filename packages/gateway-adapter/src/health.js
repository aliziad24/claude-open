// Honest health checks. (Implementation plan section 7.5.)
//
// The old prototype returned a SYNTHETIC success when the health probe failed,
// hiding invalid credentials and outages. That behavior is removed. Health is a
// set of INDEPENDENT checks, each reported separately with its true result:
//
//   transport  — can we open a TLS/TCP connection and get any HTTP response?
//   auth       — do our credentials authenticate (not 401/403)?
//   discovery  — does the model-list endpoint return a usable catalog?
//   inference  — (optional) does a minimal request to a chosen model succeed?
//   tools      — (optional) does a tool-call conformance request round-trip?
//
// A gateway can be reachable but have no compatible inference model; this is
// represented accurately (transport/auth PASS, inference FAIL) — never faked.

/** @typedef {'pass'|'fail'|'skipped'} CheckStatus */

/**
 * @typedef {Object} HealthResult
 * @property {{status:CheckStatus, detail:string}} configuration  config validity
 * @property {{status:CheckStatus, detail:string}} secret         secret availability
 * @property {{status:CheckStatus, detail:string}} transport      network reachability
 * @property {{status:CheckStatus, detail:string}} auth
 * @property {{status:CheckStatus, detail:string}} discovery
 * @property {{status:CheckStatus, detail:string}} inference
 * @property {{status:CheckStatus, detail:string}} tools
 * @property {string|null} lastSuccessAt  ISO time of last fully-passing run
 * @property {boolean} healthy   true only when no enabled check FAILED
 */

function pass(detail) {
  return { status: 'pass', detail };
}
function fail(detail) {
  return { status: 'fail', detail };
}
function skipped(detail) {
  return { status: 'skipped', detail };
}

/**
 * Run health checks against a gateway.
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {Record<string,string>} params.headers  auth + custom headers (resolved)
 * @param {string} [params.modelsEndpoint]
 * @param {string} [params.inferenceModel]  real id to probe; omit to skip inference
 * @param {boolean} [params.checkTools]     run a tool-call conformance probe
 * @param {typeof fetch} params.fetchImpl   injected fetch (real or mock)
 * @returns {Promise<HealthResult>}
 */
export async function runHealthChecks({
  baseUrl,
  headers,
  modelsEndpoint = '/v1/models',
  inferenceModel,
  inferenceRoute,
  requireInference = false,
  checkTools = false,
  fetchImpl,
  configValid,
  secretPresent,
}) {
  const result = {
    configuration: skipped('not evaluated'),
    secret: skipped('not evaluated'),
    transport: skipped('not run'),
    auth: skipped('not run'),
    discovery: skipped('not run'),
    inference: requireInference ? fail('no compatible inference model available') : skipped('inference model not provided'),
    tools: skipped('tool check not requested'),
    lastSuccessAt: null,
    healthy: false,
  };

  // config + secret checks are evaluated when the caller supplies them.
  if (typeof configValid === 'boolean') {
    result.configuration = configValid ? pass('config valid') : fail('config invalid');
  }
  if (typeof secretPresent === 'boolean') {
    result.secret = secretPresent ? pass('secret resolved') : fail('secret not resolvable');
  }
  // Stop early on a fatal config/secret problem — no point probing the network.
  if (result.configuration.status === 'fail' || result.secret.status === 'fail') {
    return finalize(result);
  }

  const base = baseUrl.replace(/\/+$/, '');

  // --- transport + auth + discovery are learned from one models request ---
  let modelsResp;
  try {
    modelsResp = await fetchImpl(`${base}${modelsEndpoint}`, { method: 'GET', headers });
    result.transport = pass(`connected, HTTP ${modelsResp.status}`);
  } catch (e) {
    result.transport = fail(`connection failed: ${sanitize(e.message)}`);
    return finalize(result);
  }

  if (modelsResp.status === 401 || modelsResp.status === 403) {
    result.auth = fail(`authentication rejected (HTTP ${modelsResp.status})`);
    result.discovery = fail('not attempted: auth failed');
    return finalize(result);
  }
  result.auth = pass('credentials accepted');

  try {
    const body = await modelsResp.json();
    const list = Array.isArray(body) ? body : body.data || [];
    if (Array.isArray(list) && list.length > 0) {
      result.discovery = pass(`${list.length} model(s) discovered`);
    } else {
      result.discovery = fail('model list endpoint returned no models');
    }
  } catch (e) {
    result.discovery = fail(`could not parse model list: ${sanitize(e.message)}`);
  }

  // --- optional inference probe against a specific model ---
  if (inferenceModel) {
    try {
      const route = inferenceRoute || 'anthropic';
      const endpoint = route === 'openai-chat'
        ? '/v1/chat/completions'
        : route === 'openai-responses'
          ? '/v1/responses'
          : '/v1/messages';
      const body = route === 'openai-chat'
        ? { model: inferenceModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }
        : route === 'openai-responses'
          ? { model: inferenceModel, max_output_tokens: 16, input: 'ping' }
          : { model: inferenceModel, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
      const r = await fetchImpl(`${base}${endpoint}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) result.inference = pass(`model '${inferenceModel}' responded (HTTP ${r.status})`);
      else result.inference = fail(`model '${inferenceModel}' returned HTTP ${r.status}`);
    } catch (e) {
      result.inference = fail(`inference probe error: ${sanitize(e.message)}`);
    }
  }

  // --- optional tool-call conformance probe ---
  if (checkTools && inferenceModel) {
    try {
      const r = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: inferenceModel,
          max_tokens: 64,
          tools: [
            {
              name: 'echo',
              description: 'echo a value',
              input_schema: { type: 'object', properties: { value: { type: 'string' } } },
            },
          ],
          messages: [{ role: 'user', content: 'call the echo tool with value "hi"' }],
        }),
      });
      result.tools = r.ok
        ? pass(`tool-call request accepted (HTTP ${r.status})`)
        : fail(`tool-call request returned HTTP ${r.status}`);
    } catch (e) {
      result.tools = fail(`tool probe error: ${sanitize(e.message)}`);
    }
  } else if (checkTools) {
    result.tools = skipped('no inference model to probe tools with');
  }

  return finalize(result);
}

function finalize(result) {
  const checks = [
    result.configuration, result.secret, result.transport,
    result.auth, result.discovery, result.inference, result.tools,
  ];
  result.healthy = checks.every((c) => c.status !== 'fail');
  if (result.healthy && result.transport.status === 'pass' && result.auth.status === 'pass') {
    result.lastSuccessAt = new Date().toISOString();
  }
  return result;
}

/** Strip anything that could carry a secret from an error string. */
function sanitize(msg) {
  return String(msg || '')
    .replace(/(authorization|x-api-key|bearer)\s*[:=]\s*\S+/gi, '$1 <redacted>')
    .replace(/sk-[A-Za-z0-9\-_]{8,}/g, '<redacted>');
}
