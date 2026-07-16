// Reusable: parse the adapter's stdout NDJSON 'request' events into SANITIZED
// counters. The adapter logs one line per request as
//   {"t":"...","evt":"request","method":"GET","path":"/v1/models?limit=1000"}
// We retain ONLY method + path (query string stripped). Headers and bodies are
// never in these events, and we never reconstruct them. This is the single
// source of truth used by both the node tests and the PowerShell 5.1 runner
// (Invoke-CorrectivePhase3.ps1) to decide whether the CLIENT drove GET /v1/models
// and POST /v1/messages.

/**
 * Parse adapter stdout (NDJSON, LF or CRLF) into an ordered list of
 * { method, path, t } request events. Non-JSON lines and non-request events are
 * ignored. The path never carries a query string. The timestamp `t` (if present)
 * is retained ONLY to window client-originated traffic; it carries no secret.
 * @param {string} stdout
 * @returns {Array<{method:string, path:string, t:string|null}>}
 */
export function parseRequestEvents(stdout) {
  const events = [];
  if (!stdout) return events;
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.evt !== 'request') continue;
    const method = typeof obj.method === 'string' ? obj.method : '';
    const rawPath = typeof obj.path === 'string' ? obj.path : '';
    if (!method || !rawPath) continue;
    // Strip any query string (defence in depth: the adapter already logs the
    // pre-'?' path, but a future change must never leak query params here).
    const path = rawPath.split('?', 1)[0];
    events.push({ method, path, t: typeof obj.t === 'string' ? obj.t : null });
  }
  return events;
}

/**
 * Anti-conflation guard. Return only request events whose timestamp falls in the
 * CLIENT window [clientLaunchUtc, loopbackStartUtc). This deliberately excludes:
 *   - runner setup probes (/health/deep, /v1/models) sent BEFORE the client;
 *   - the runner's loopback-proof requests sent AT/AFTER loopbackStartUtc.
 * So a runner-originated POST /v1/messages can never be miscounted as a client
 * message. An event without a timestamp is treated as NOT client-originated
 * (fail-closed), because origin cannot be proven.
 * @param {Array<{method:string, path:string, t:string|null}>} events
 * @param {{clientLaunchUtc?:string|null, loopbackStartUtc?:string|null}} window
 */
export function filterClientOriginated(events, window = {}) {
  const launch = window.clientLaunchUtc ? Date.parse(window.clientLaunchUtc) : NaN;
  const loopback = window.loopbackStartUtc ? Date.parse(window.loopbackStartUtc) : NaN;
  return events.filter((e) => {
    if (!e.t) return false;
    const ms = Date.parse(e.t);
    if (Number.isNaN(ms)) return false;
    if (!Number.isNaN(launch) && ms < launch) return false;
    if (!Number.isNaN(loopback) && ms >= loopback) return false;
    return true;
  });
}

/**
 * Aggregate request events into a plain "METHOD path" -> count object.
 * @param {Array<{method:string, path:string}>} events
 * @returns {Record<string, number>}
 */
export function countRequests(events) {
  const counters = {};
  for (const { method, path } of events) {
    const key = `${method} ${path}`;
    counters[key] = (counters[key] || 0) + 1;
  }
  return counters;
}

/** True when at least one client-originated GET /v1/models was observed. */
export function clientDroveModels(events) {
  return events.some((e) => e.method === 'GET' && e.path === '/v1/models');
}

/** True when at least one client-originated POST /v1/messages was observed. */
export function clientDroveMessages(events) {
  return events.some((e) => e.method === 'POST' && e.path === '/v1/messages');
}

/**
 * Parse adapter stdout (NDJSON) into an ordered list of message-outcome events.
 * The adapter logs one line per completed /v1/messages inference as
 *   {"t":"...","evt":"messages","model":"<realId>","status":200}
 * We retain ONLY the real model id + numeric HTTP status + timestamp. This is
 * the authoritative record of the OUTCOME of each POST /v1/messages: it tells us
 * whether the CLIENT's own activation-time inference got 200 vs 503, which the
 * bare request-path counters cannot. Model ids are non-secret adapter aliases.
 * @param {string} stdout
 * @returns {Array<{model:string, status:number, t:string|null}>}
 */
export function parseMessageEvents(stdout) {
  const events = [];
  if (!stdout) return events;
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.evt !== 'messages') continue;
    const model = typeof obj.model === 'string' ? obj.model : '';
    const status = Number.isFinite(obj.status) ? Number(obj.status) : NaN;
    if (!model || Number.isNaN(status)) continue;
    events.push({ model, status, t: typeof obj.t === 'string' ? obj.t : null });
  }
  return events;
}

/**
 * Anti-conflation guard for message-outcome events. Same time-window semantics
 * as filterClientOriginated: keep only events whose timestamp falls in
 * [clientLaunchUtc, loopbackStartUtc). An event without a timestamp is treated
 * as NOT client-originated (fail-closed).
 * @param {Array<{model:string, status:number, t:string|null}>} events
 * @param {{clientLaunchUtc?:string|null, loopbackStartUtc?:string|null}} window
 */
export function filterClientMessages(events, window = {}) {
  const launch = window.clientLaunchUtc ? Date.parse(window.clientLaunchUtc) : NaN;
  const loopback = window.loopbackStartUtc ? Date.parse(window.loopbackStartUtc) : NaN;
  return events.filter((e) => {
    if (!e.t) return false;
    const ms = Date.parse(e.t);
    if (Number.isNaN(ms)) return false;
    if (!Number.isNaN(launch) && ms < launch) return false;
    if (!Number.isNaN(loopback) && ms >= loopback) return false;
    return true;
  });
}

/** True when at least one client-originated /v1/messages outcome was a 2xx. */
export function clientMessageSucceeded(messageEvents) {
  return messageEvents.some((e) => e.status >= 200 && e.status < 300);
}
