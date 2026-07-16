// @claude-open/config
//
// Vendor-neutral gateway configuration schema + validation.
// (Implementation plan sections 6.1, 7.1.)
//
// A config describes how to reach ONE gateway and how to route/authenticate.
// Secrets are never stored inline in production: `auth.credentialRef` names a
// secret held by the OS secret store; a raw `auth.secret` is allowed only for
// CI/tests and is flagged by validation.

/** @typedef {'anthropic'|'openai-chat'|'openai-responses'|'mixed-auto'} CompatibilityProfile */
/** @typedef {'bearer'|'x-api-key'|'custom-header'|'none'} AuthKind */

export const COMPATIBILITY_PROFILES = /** @type {const} */ ([
  'anthropic',
  'openai-chat',
  'openai-responses',
  'mixed-auto',
]);

export const AUTH_KINDS = /** @type {const} */ ([
  'bearer',
  'x-api-key',
  'custom-header',
  'none',
]);

/**
 * Default config skeleton. No vendor, drive, port, or account is hard-coded.
 * @returns {object}
 */
export function defaultConfig() {
  return {
    baseUrl: '',
    auth: { kind: 'bearer', credentialRef: null, headerName: null },
    profile: 'mixed-auto',
    modelsEndpoint: '/v1/models',
    usage: { adapter: 'none' },
    routes: [],
    modelOverrides: {},
    companion: { enabled: false },
  };
}

/**
 * Redact a secret to a non-reversible fingerprint for logs/diagnostics.
 * Never returns more than a 4-char head + length.
 * @param {string|null|undefined} secret
 * @returns {string}
 */
export function redactSecret(secret) {
  if (secret == null || secret === '') return '<none>';
  const s = String(secret);
  const head = s.slice(0, 4);
  return `${head}…(len=${s.length})`;
}

/**
 * Validate a URL for the gateway base URL.
 * Enforces http/https, and (unless loopback) requires https.
 * @param {string} url
 * @returns {{ok:boolean, errors:string[], parsed?:URL}}
 */
export function validateBaseUrl(url) {
  const errors = [];
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, errors: ['baseUrl is required'] };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, errors: [`baseUrl is not a valid URL: ${url}`] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push(`baseUrl scheme must be http or https, got ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    errors.push('baseUrl must not contain embedded credentials');
  }
  const host = parsed.hostname;
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  if (parsed.protocol === 'http:' && !isLoopback) {
    errors.push('baseUrl must use https unless the host is loopback');
  }
  return { ok: errors.length === 0, errors, parsed };
}

/**
 * Validate an auth object.
 * @param {object} auth
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateAuth(auth) {
  const errors = [];
  const warnings = [];
  if (!auth || typeof auth !== 'object') {
    return { ok: false, errors: ['auth is required'], warnings };
  }
  if (!AUTH_KINDS.includes(auth.kind)) {
    errors.push(`auth.kind must be one of ${AUTH_KINDS.join(', ')}, got ${auth.kind}`);
  }
  if (auth.kind === 'custom-header') {
    if (!auth.headerName || typeof auth.headerName !== 'string') {
      errors.push('auth.headerName is required when auth.kind is custom-header');
    }
  }
  if (auth.kind !== 'none') {
    const hasRef = typeof auth.credentialRef === 'string' && auth.credentialRef.length > 0;
    const hasRaw = typeof auth.secret === 'string' && auth.secret.length > 0;
    if (!hasRef && !hasRaw) {
      errors.push('auth requires a credentialRef (production) or secret (test only)');
    }
    if (hasRaw) {
      warnings.push('auth.secret is set inline; use credentialRef + OS secret store in production');
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate custom headers: only allow safe header names, forbid reserved ones.
 * @param {Record<string,string>|undefined} headers
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateCustomHeaders(headers) {
  const errors = [];
  if (headers == null) return { ok: true, errors };
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    return { ok: false, errors: ['customHeaders must be an object'] };
  }
  const reserved = new Set([
    'content-length', 'host', 'connection', 'transfer-encoding',
    // Secrets belong in auth + the OS credential store, never plaintext config.
    'authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie',
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      errors.push(`invalid header name: ${name}`);
    }
    if (reserved.has(name.toLowerCase())) {
      errors.push(`header name is reserved and must not be overridden: ${name}`);
    }
    if (typeof value !== 'string') {
      errors.push(`header value must be a string: ${name}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a full config object. Returns normalized config on success.
 * @param {object} raw
 * @returns {{ok:boolean, errors:string[], warnings:string[], config?:object}}
 */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['config must be an object'], warnings };
  }

  const cfg = { ...defaultConfig(), ...raw };
  cfg.auth = { ...defaultConfig().auth, ...(raw.auth || {}) };

  const urlRes = validateBaseUrl(cfg.baseUrl);
  errors.push(...urlRes.errors);

  const authRes = validateAuth(cfg.auth);
  errors.push(...authRes.errors);
  warnings.push(...authRes.warnings);

  if (!COMPATIBILITY_PROFILES.includes(cfg.profile)) {
    errors.push(`profile must be one of ${COMPATIBILITY_PROFILES.join(', ')}, got ${cfg.profile}`);
  }

  if (cfg.customHeaders !== undefined) {
    const hRes = validateCustomHeaders(cfg.customHeaders);
    errors.push(...hRes.errors);
  }

  if (cfg.modelOverrides && typeof cfg.modelOverrides === 'object') {
    for (const [id, ov] of Object.entries(cfg.modelOverrides)) {
      if (ov == null || typeof ov !== 'object') {
        errors.push(`modelOverrides['${id}'] must be an object`);
      }
    }
  } else if (cfg.modelOverrides !== undefined) {
    errors.push('modelOverrides must be an object');
  }

  if (!Array.isArray(cfg.routes)) {
    errors.push('routes must be an array');
  }

  if (!cfg.companion || typeof cfg.companion !== 'object' || Array.isArray(cfg.companion)) {
    errors.push('companion must be an object');
  } else if (typeof cfg.companion.enabled !== 'boolean') {
    errors.push('companion.enabled must be a boolean');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    config: errors.length === 0 ? cfg : undefined,
  };
}
