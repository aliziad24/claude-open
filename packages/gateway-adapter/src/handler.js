// Request handler: turns an inbound Anthropic /v1/messages request into an
// upstream gateway call using the resolved route, then converts the response
// back to Anthropic shape. Non-streaming path (streaming is covered by
// src/stream.js). This is the composition point the launcher's loopback server
// wraps; keeping it as a pure-ish function (fetch injected) makes it testable
// against a mock gateway. (Implementation plan sections 7.3, 7.4, 7.5.)

import { resolveRoute } from './router.js';
import {
  anthropicToChat,
  chatToAnthropic,
  anthropicToResponses,
  responsesToAnthropic,
} from './convert.js';
import { reasoningControl, mapThinkingToUpstream, applyPatch } from './effort.js';

/**
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {Record<string,string>} params.headers   resolved auth + custom headers
 * @param {object} params.body                      inbound Anthropic request (real model id already unwrapped)
 * @param {object} [params.model]                   normalized model record for this id (for effort/route metadata)
 * @param {object} [params.override]                config.modelOverrides[realId]
 * @param {Map<string,string>|object} [params.probeCache]   proven routes per gateway+model
 * @param {string} [params.gatewayFingerprint]
 * @param {typeof fetch} params.fetchImpl
 * @returns {Promise<{status:number, body:object}>}  Anthropic-shaped response
 */
// Transient upstream statuses that a bounded retry may re-attempt. These are
// server-side/overload conditions where re-sending the SAME request to the SAME
// model is legitimate. 4xx client errors (except 429) are never retried.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 529]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded, honest retry wrapper for a single upstream call.
 * - Retries ONLY transient statuses, re-sending the identical request (never a
 *   substituted model — plan Phase 4 rule).
 * - Returns the last response honestly (no synthetic success) once attempts are
 *   exhausted.
 * @param {() => Promise<Response>} doFetch
 * @param {{attempts?:number, baseDelayMs?:number}} [retry]
 */
async function fetchWithRetry(doFetch, retry) {
  const attempts = Math.max(1, retry?.attempts ?? 1);
  const baseDelayMs = retry?.baseDelayMs ?? 250;
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = await doFetch();
    if (last.ok || !TRANSIENT_STATUSES.has(last.status)) return last;
    if (i < attempts - 1) await sleep(baseDelayMs * (i + 1)); // linear backoff
  }
  return last;
}

export async function handleMessage({ baseUrl, headers, body, model, override, probeCache, gatewayFingerprint, fetchImpl, enforcedControl, retry }) {
  const base = baseUrl.replace(/\/+$/, '');
  const realId = body.model;
  const decision = resolveRoute({ realId, model, override, probeCache, gatewayFingerprint });

  if (!decision.route) {
    return {
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: decision.reason } },
    };
  }

  const h = { ...headers, 'content-type': 'application/json' };

  try {
    if (decision.route === 'anthropic') {
      const up = await fetchWithRetry(
        () => fetchImpl(`${base}/v1/messages`, { method: 'POST', headers: h, body: JSON.stringify(body) }),
        retry,
      );
      const text = await up.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { type: 'error', error: { type: 'api_error', message: 'non-JSON upstream response' } };
      }
      return { status: up.status, body: parsed };
    }

    if (decision.route === 'openai-chat') {
      const req = anthropicToChat({ ...body, stream: false });
      // Probe-enforced reasoning control (the server supplies enforcedControl;
      // falls back to registry-only if a direct caller omits it).
      const control = enforcedControl || reasoningControl(model, override?.reasoning);
      applyPatch(req, mapThinkingToUpstream(body, control, 'openai-chat'));
      const up = await fetchWithRetry(
        () => fetchImpl(`${base}/v1/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify(req) }),
        retry,
      );
      if (!up.ok) return upstreamError(up);
      const oai = await up.json();
      return { status: 200, body: chatToAnthropic(oai, realId) };
    }

    if (decision.route === 'openai-responses') {
      const control = enforcedControl || reasoningControl(model, override?.reasoning);
      const req = anthropicToResponses({ ...body, stream: false });
      // reasoning.effort (or the model's documented field) applied via patch.
      applyPatch(req, mapThinkingToUpstream(body, control, 'openai-responses'));
      const up = await fetchWithRetry(
        () => fetchImpl(`${base}/v1/responses`, { method: 'POST', headers: h, body: JSON.stringify(req) }),
        retry,
      );
      if (!up.ok) return upstreamError(up);
      const resp = await up.json();
      return { status: 200, body: responsesToAnthropic(resp, realId) };
    }
  } catch (e) {
    return {
      status: 502,
      body: { type: 'error', error: { type: 'api_error', message: `gateway error: ${sanitize(e.message)}` } },
    };
  }

  return {
    status: 400,
    body: { type: 'error', error: { type: 'invalid_request_error', message: 'unsupported route' } },
  };
}

async function upstreamError(up) {
  const text = await up.text();
  let message = text;
  try {
    message = JSON.parse(text).error?.message || text;
  } catch {
    /* keep raw */
  }
  // Security-review defect 2(b): run the returned upstream message through the
  // same sanitizer the catch-block uses, so a misconfigured or hostile upstream
  // cannot echo a secret-shaped string (e.g. sk-...) straight back to the client.
  return { status: up.status, body: { type: 'error', error: { type: 'api_error', message: sanitize(message) } } };
}

function sanitize(msg) {
  return String(msg || '').replace(/sk-[A-Za-z0-9\-_]{8,}/g, '<redacted>');
}
