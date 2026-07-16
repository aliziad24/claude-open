// Authoritative per-user configuration store. (SESSION-3 section 3, priority A.)
//
// There is EXACTLY ONE per-user config that every runtime component reads. It
// contains only NON-SECRET values (base URL, auth kind, credential reference,
// header name, custom headers, models endpoint, overrides). The secret itself
// is never stored here — it lives in Windows Credential Manager / DPAPI and is
// resolved at runtime by the secret store, keyed by `credentialTarget`.
//
// No vendor host, drive, username, or port is hard-coded. The store location is
// resolved from Windows per-user env (APPDATA / LOCALAPPDATA) or an explicit
// caller-supplied directory.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfig } from './index.js';

/**
 * Resolve the per-user Claude Open config directory without hard-coding a drive.
 * @param {object} [env]
 * @returns {string}
 */
export function configDir(env = process.env) {
  const base =
    env.CLAUDE_OPEN_CONFIG_DIR ||
    (env.APPDATA ? join(env.APPDATA, 'ClaudeOpen') : null) ||
    (env.HOME ? join(env.HOME, '.config', 'claude-open') : null);
  if (!base) {
    if (env.NODE_ENV === 'test') {
      return join(process.cwd(), '.claude-open');
    }
    throw new Error('cannot resolve a per-user config dir (no APPDATA/HOME)');
  }
  return base;
}

export function configPath(env = process.env) {
  return join(configDir(env), 'config.json');
}

/**
 * Compute a stable, non-reversible gateway fingerprint from the identity-defining
 * config fields. Used to key catalog/route/probe/usage caches so switching
 * gateways invalidates old data. Excludes the secret entirely.
 * @param {object} config
 * @returns {string}
 */
export function gatewayFingerprint(config) {
  const ident = JSON.stringify({
    baseUrl: (config.baseUrl || '').replace(/\/+$/, ''),
    authKind: config.auth?.kind || 'none',
    headerName: config.auth?.headerName || null,
    modelsEndpoint: config.modelsEndpoint || '/v1/models',
  });
  return createHash('sha256').update(ident).digest('hex').slice(0, 16);
}

/**
 * Load the config. Returns { exists, config, path, fingerprint }.
 * @param {object} [env]
 */
export function loadStoredConfig(env = process.env) {
  const path = configPath(env);
  if (!existsSync(path)) {
    return { exists: false, config: null, path, fingerprint: null };
  }
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const raw = JSON.parse(text);
  const v = validateConfig(raw);
  const cfg = v.ok ? v.config : raw;
  return { exists: true, config: cfg, path, fingerprint: gatewayFingerprint(cfg), valid: v.ok, errors: v.errors };
}

/**
 * Persist a NON-SECRET config. Refuses to write an inline secret.
 * @param {object} config
 * @param {object} [env]
 * @returns {{path:string, fingerprint:string}}
 */
export function saveStoredConfig(config, env = process.env) {
  if (config?.auth && typeof config.auth.secret === 'string' && config.auth.secret.length) {
    throw new Error('refusing to persist an inline secret; store it in Credential Manager and set auth.credentialRef');
  }
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  // strip any accidental secret field defensively
  const clean = JSON.parse(JSON.stringify(config));
  if (clean.auth) delete clean.auth.secret;
  for (const name of Object.keys(clean.customHeaders || {})) {
    if (['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'set-cookie'].includes(name.toLowerCase())) {
      throw new Error(`refusing to persist secret-bearing custom header: ${name}`);
    }
  }
  writeFileSync(path, JSON.stringify(clean, null, 2), { encoding: 'utf8' });
  return { path, fingerprint: gatewayFingerprint(clean) };
}
