// Runtime config loader. (SESSION-4 phase 3.1.)
//
// Production precedence (strict):
//   1. an explicit test/diagnostic override supplied by the current process;
//   2. the ONE per-user stored Claude Open config (loadStoredConfig);
//   3. first-run/setup-required error.
//
// There is NO silent production fallback to legacy Claude/Open profile
// host-creds. A one-time importer (`importFromLegacyProfile`) may read it ONLY
// after explicit user confirmation, then writes the new non-secret config and a
// secure credential. Nothing here resolves the secret inline.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '@claude-open/config';
import { loadStoredConfig, gatewayFingerprint } from '@claude-open/config/store';
import { createSecretStore } from './secret-store.js';

/**
 * Discover a legacy Claude Open profile host-creds file — used ONLY by the
 * explicit one-time importer, never by the normal production flow.
 * @param {string} userDataDir
 */
export function discoverProfileGateway(userDataDir) {
  if (!userDataDir || !existsSync(userDataDir)) return null;
  let names;
  try {
    names = readdirSync(userDataDir);
  } catch {
    return null;
  }
  const credFile = names.find((n) => /^host-creds-.*\.json$/i.test(n));
  if (!credFile) return null;
  const filePath = join(userDataDir, credFile);
  try {
    const j = JSON.parse(readFileSync(filePath, 'utf8'));
    const env = j.env || {};
    const rawBase = env.ANTHROPIC_BASE_URL || null;
    const field = env.ANTHROPIC_AUTH_TOKEN ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    return { filePath, baseUrl: rawBase, field };
  } catch {
    return null;
  }
}

/**
 * Build the runtime config + secret store using strict production precedence.
 *
 * @param {object} opts
 * @param {object} [opts.override]   explicit in-process config (tests/diagnostics) — wins
 * @param {object} [opts.overrideSecret] a { resolve, fingerprint, source } store for the override
 * @param {object} [opts.env]        environment (defaults to process.env)
 * @returns {{ok:boolean, config:object|null, secretStore:object|null, fingerprint:string|null, firstRun:boolean, warnings:string[], errors:string[]}}
 */
export function loadRuntime(opts = {}) {
  const env = opts.env || process.env;
  const warnings = [];
  const errors = [];

  // 1. Explicit in-process override (tests / diagnostics only).
  if (opts.override) {
    const v = validateConfig(opts.override);
    if (!v.ok) {
      return { ok: false, config: null, secretStore: null, fingerprint: null, firstRun: false, warnings, errors: v.errors };
    }
    const secretStore =
      opts.overrideSecret ||
      createSecretStore({
        credentialTarget: opts.override.auth?.credentialRef || opts.override.credentialTarget,
        envVar: opts.override.auth?.envVar,
        env,
      });
    return { ok: true, config: v.config, secretStore, fingerprint: gatewayFingerprint(v.config), firstRun: false, warnings, errors };
  }

  // 2. The single per-user stored config.
  const stored = loadStoredConfig(env);
  if (!stored.exists) {
    return {
      ok: false,
      config: null,
      secretStore: null,
      fingerprint: null,
      firstRun: true,
      warnings,
      errors: [`no Claude Open config found at ${stored.path}; run setup first`],
    };
  }
  if (!stored.valid) {
    return { ok: false, config: null, secretStore: null, fingerprint: null, firstRun: false, warnings, errors: stored.errors || ['stored config invalid'] };
  }

  // Secret resolved at runtime from Credential Manager / DPAPI (never inline).
  // `auth.credentialRef` is the schema's authoritative pointer to the OS secret
  // store.  Older prototypes computed a second target here; that made a secret
  // saved by the setup UI impossible for the adapter to find whenever the two
  // fingerprint implementations differed.
  const target =
    stored.config.auth?.credentialRef ||
    stored.config.credentialTarget ||
    `ClaudeOpen/gateway/${stored.fingerprint}`;
  const secretStore = createSecretStore({
    credentialTarget: target,
    envVar: stored.config.auth?.envVar,
    env,
  });

  return {
    ok: true,
    config: stored.config,
    secretStore,
    fingerprint: stored.fingerprint,
    firstRun: false,
    warnings,
    errors,
  };
}
