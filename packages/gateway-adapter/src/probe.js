// Live, non-destructive conformance probe runner. (SESSION-3 section 5.2.)
//
// CRITICAL RULE: a 2xx response does NOT prove a feature is supported, because a
// gateway may silently ignore an unknown field. We classify each probe as:
//   'accepted'      — positive evidence the value took effect
//   'rejected'      — provider validation error naming the field/value
//   'silent-ignore' — 2xx but no evidence the value changed anything
//   'unknown'       — could not distinguish
//   'error'         — transport / auth / other failure
//
// Acceptance evidence = a returned reasoning/usage field, a response difference
// vs a baseline, or an explicit provider acknowledgement. Otherwise NOT accepted.

/**
 * Probe whether an effort/reasoning value is truly honored by the gateway for a
 * model on a route. Sends a baseline request and a with-control request and
 * compares observable signals. Non-destructive (tiny max tokens).
 *
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {Record<string,string>} p.headers
 * @param {string} p.route 'openai-responses' | 'openai-chat' | 'anthropic'
 * @param {string} p.realId
 * @param {{path:string, value:any}} p.controlPatch  the effort field+value to test
 * @param {typeof fetch} p.fetchImpl
 * @returns {Promise<{result:string, evidence:string, httpStatus:number|null}>}
 */
export async function probeEffort({ baseUrl, headers, route, realId, controlPatch, fetchImpl }) {
  const base = baseUrl.replace(/\/+$/, '');
  const h = { ...headers, 'content-type': 'application/json' };

  const endpoint =
    route === 'openai-responses' ? '/v1/responses' :
    route === 'openai-chat' ? '/v1/chat/completions' :
    '/v1/messages';

  const baseBody = buildMinimal(route, realId);
  const withBody = JSON.parse(JSON.stringify(baseBody));
  setPath(withBody, controlPatch.path, controlPatch.value);
  // Also set a deliberately INVALID sentinel to detect validation strictness.
  const invalidBody = JSON.parse(JSON.stringify(baseBody));
  setPath(invalidBody, controlPatch.path, '__definitely_invalid_effort__');

  try {
    // Establish transport/auth baseline. It is intentionally not used as
    // stochastic text-difference "proof"; only explicit validation behavior
    // can promote a control to accepted.
    const baselineResp = await fetchImpl(`${base}${endpoint}`, { method: 'POST', headers: h, body: JSON.stringify(baseBody) });
    if (baselineResp.status === 401 || baselineResp.status === 403) {
      return { result: 'error', evidence: `baseline auth failed (HTTP ${baselineResp.status})`, httpStatus: baselineResp.status };
    }
    await baselineResp.text();
    if (!baselineResp.ok) {
      return { result: 'error', evidence: `baseline failed (HTTP ${baselineResp.status})`, httpStatus: baselineResp.status };
    }
    const withResp = await fetchImpl(`${base}${endpoint}`, { method: 'POST', headers: h, body: JSON.stringify(withBody) });
    const withStatus = withResp.status;
    const withText = await withResp.text();

    if (withStatus === 401 || withStatus === 403) {
      return { result: 'error', evidence: `auth failed (HTTP ${withStatus})`, httpStatus: withStatus };
    }

    // Try the invalid value: a strict provider rejects it -> proves the field is
    // real (accepted when valid). A gateway that ignores unknown fields returns 2xx.
    const invalidResp = await fetchImpl(`${base}${endpoint}`, { method: 'POST', headers: h, body: JSON.stringify(invalidBody) });
    const invalidStatus = invalidResp.status;
    const invalidText = await invalidResp.text();

    if (!withResp.ok) {
      // The VALID value was rejected -> the value is not supported for this model.
      return { result: 'rejected', evidence: `valid value rejected (HTTP ${withStatus})`, httpStatus: withStatus };
    }

    if (invalidStatus >= 400 && validationNamesField(invalidText, controlPatch.path)) {
      if (responseExplicitlyEchoes(withText, controlPatch.path, controlPatch.value)) {
        return { result: 'behavior-observed', evidence: `response explicitly echoed ${controlPatch.path}; invalid value rejected (HTTP ${invalidStatus})`, httpStatus: withStatus };
      }
      return { result: 'schema-accepted', evidence: `valid accepted and invalid ${controlPatch.path} rejected (HTTP ${invalidStatus}); behavioral effect not observable`, httpStatus: withStatus };
    }

    if (invalidStatus < 400) {
      // The gateway accepted an obviously-invalid value too -> it is ignoring the field.
      return { result: 'silent-ignore', evidence: `invalid value also accepted (HTTP ${invalidStatus}); field appears ignored`, httpStatus: withStatus };
    }

    return { result: 'unknown', evidence: `2xx but no field-specific distinguishing signal (invalid HTTP ${invalidStatus})`, httpStatus: withStatus };
  } catch (e) {
    return { result: 'error', evidence: sanitize(e.message), httpStatus: null };
  }
}

function buildMinimal(route, model) {
  if (route === 'anthropic') {
    return { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
  }
  if (route === 'openai-responses') {
    return { model, max_output_tokens: 16, input: 'ping' };
  }
  return { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function clip(s) {
  return String(s || '').slice(0, 160);
}
function sanitize(s) {
  return String(s || '').replace(/sk-[A-Za-z0-9\-_]{6,}/g, '<redacted>');
}

function validationNamesField(text, path) {
  const haystack = String(text || '').toLowerCase();
  const leaf = String(path || '').toLowerCase().split('.').at(-1)?.replace(/[^a-z0-9_]/g, '');
  const compact = haystack.replace(/[^a-z0-9_]/g, '');
  return !!leaf && compact.includes(leaf) && /invalid|unsupported|unknown|not allowed|not supported|enum|value/i.test(haystack);
}

function responseExplicitlyEchoes(text, path, expected) {
  let body;
  try { body = JSON.parse(text); } catch { return false; }
  const candidates = [body, body?.metadata, body?.response, body?.request, body?.model_settings].filter(Boolean);
  for (const root of candidates) {
    let cur = root;
    for (const part of String(path).split('.')) cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    if (Object.is(cur, expected)) return true;
  }
  return false;
}
