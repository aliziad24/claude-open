// Production adapter entrypoint. (SESSION-4 phase 3.1.)
//
// The stored per-user config is authoritative. There is no production base-url
// or secret on the command line and no silent legacy fallback. Runtime files
// (port, alias, probe, token, logs) live under the isolated per-user runtime
// root, never process.cwd().
//
// Env (non-secret) used only to LOCATE things / for tests:
//   CLAUDE_OPEN_RUNTIME_DIR   isolated runtime dir (default: <LocalAppData>\ClaudeOpen\runtime)
//   CLAUDE_OPEN_PORT          preferred loopback port (0 = ephemeral)

import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createAdapterServer } from './server.js';
import { loadRuntime } from './config-loader.js';

/** Resolve the isolated per-user runtime dir without hard-coding a drive. */
export function runtimeDir(env = process.env) {
  if (env.CLAUDE_OPEN_RUNTIME_DIR) return env.CLAUDE_OPEN_RUNTIME_DIR;
  const base =
    (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ClaudeOpen', 'runtime') : null) ||
    (env.HOME ? join(env.HOME, '.local', 'share', 'claude-open', 'runtime') : null);
  if (!base) throw new Error('cannot resolve a per-user runtime dir (no LOCALAPPDATA/HOME)');
  return base;
}

/**
 * Start the adapter from authoritative config.
 * @param {object} [opts] { env, override, overrideSecret, fetchImpl }
 */
export async function start(opts = {}) {
  const env = opts.env || process.env;
  const loaded = loadRuntime({ override: opts.override, overrideSecret: opts.overrideSecret, env });

  if (!loaded.ok) {
    if (loaded.firstRun) {
      const err = new Error('FIRST_RUN: no Claude Open configuration; run setup');
      err.firstRun = true;
      err.details = loaded.errors;
      throw err;
    }
    const err = new Error('CONFIG_INVALID: ' + loaded.errors.join('; '));
    err.details = loaded.errors;
    throw err; // reject invalid config BEFORE binding a healthy-looking server
  }

  for (const w of loaded.warnings) log({ evt: 'warn', msg: w });

  // Wire the launcher-chosen healthy default alias into the live config so the
  // adapter's tier-probe reconcile (server.js reconcileTierProbe) can redirect
  // the client's built-in haiku/sonnet tier ConfigHealth probe to a healthy
  // model. This is the belt-and-suspenders companion to the config-side
  // anthropicFamilyTier mapping. Env-supplied, never a secret.
  if (env.CLAUDE_OPEN_HEALTHY_DEFAULT && loaded.config && !loaded.config.healthyDefaultAlias) {
    loaded.config.healthyDefaultAlias = env.CLAUDE_OPEN_HEALTHY_DEFAULT;
  }

  const rtDir = runtimeDir(env);
  mkdirSync(rtDir, { recursive: true });
  restrictAcl(rtDir, env);

  // A per-run bearer protects every secret-bearing loopback endpoint from
  // unrelated local processes and browser pages.  It is delivered only through
  // the ACL-protected runtime file and the isolated client's environment.
  const clientToken = env.CLAUDE_OPEN_CLIENT_TOKEN || randomBytes(32).toString('base64url');
  const adapter = createAdapterServer({
    config: loaded.config,
    secretStore: loaded.secretStore,
    log,
    fetchImpl: opts.fetchImpl,
    gatewayFingerprint: loaded.fingerprint,
    aliasStorePath: rtDir,
    probeStorePath: rtDir,
    clientToken,
  });

  const preferred = parseInt(env.CLAUDE_OPEN_PORT || '0', 10) || 0;
  const port = await adapter.listen(preferred, '127.0.0.1');

  // STARTUP CATALOG WARM (NEXT-CORRECTIVE-WAVE): pre-fetch the model catalog once
  // as soon as we are listening, so the genuine client's very first ConfigHealth
  // reachability probe (GET /v1/models, and the /v1/messages tier-probe
  // reconcile) is served instantly from a warm cache rather than blocking on a
  // live upstream round-trip while a first-run CCD download starves its ~10s
  // probe budget. Non-fatal: if the gateway is briefly unreachable the cold-cache
  // path still fetches (bounded) on first probe. The launcher separately GETs
  // /v1/models against THIS same running adapter before launch, which warms the
  // SAME process cache — this is belt-and-suspenders for adapter-first startups.
  try {
    await adapter._getCatalog();
    log({ evt: 'catalog-warm', ok: true });
  } catch (e) {
    log({ evt: 'warn', msg: `startup catalog warm failed (non-fatal): ${e.message}` });
  }

  // The official renderer's CSP allows same-origin assets but blocks a direct
  // loopback fetch. When the patched usage widget is installed, publish only
  // non-secret adapter snapshots into its asset directory. The upstream API key
  // never enters these files; the adapter already holds it via Credential
  // Manager and the local bearer remains confined to this process/runtime file.
  const widgetDir = env.CLAUDE_OPEN_WIDGET_DIR ? resolve(env.CLAUDE_OPEN_WIDGET_DIR) : null;
  if (widgetDir) {
    mkdirSync(widgetDir, { recursive: true });
    const writeSnapshot = (name, value) => {
      const target = join(widgetDir, name);
      const temp = `${target}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(value));
      renameSync(temp, target);
    };
    const refreshWidget = async () => {
      const headers = { authorization: `Bearer ${clientToken}` };
      try {
        const [usageResponse, modelsResponse] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/usage`, { headers }),
          fetch(`http://127.0.0.1:${port}/v1/models`, { headers }),
        ]);
        if (!usageResponse.ok || !modelsResponse.ok) throw new Error('local snapshot endpoint failed');
        writeSnapshot('co-usage-session.json', await usageResponse.json());
        writeSnapshot('co-usage-models.json', await modelsResponse.json());
      } catch {
        // Keep the last known good snapshot. The widget labels stale data by its
        // generatedAt timestamp and never needs a secret-bearing error string.
      }
    };
    await refreshWidget();
    setInterval(refreshWidget, 15000).unref();
  }

  const runtimeFile = join(rtDir, 'runtime.json');
  try {
    writeFileSync(
      runtimeFile,
      JSON.stringify(
        {
          port,
          gateway: adapter.gatewayFingerprint,
          controlToken: adapter.diagToken,
          clientToken,
          secretSource: loaded.secretStore.source(),
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    restrictAcl(runtimeFile, env);
  } catch (e) {
    log({ evt: 'warn', msg: `could not write runtime.json: ${e.message}` });
  }

  log({ evt: 'listening', port, gateway: adapter.gatewayFingerprint, secretSource: loaded.secretStore.source() });
  return { adapter, port, runtimeDir: rtDir, clientToken };
}

/**
 * Apply restrictive per-user ACLs to a runtime path that holds the bearer /
 * control tokens.
 *
 * Security-review defect 2(d): this previously caught+suppressed every ACL
 * failure in an empty catch, so the hardening was silently fail-OPEN even though
 * the docs describe restricted-ACL as an invariant. It is now FAIL-LOUD: on
 * Windows it emits either a verification line (`acl-applied`) on success or a
 * clear WARNING naming the unprotected file path on failure. It still does NOT
 * throw — a token file left with inherited ACLs is a hardening gap, not a reason
 * to refuse to start — but the gap is now observable in the logs.
 *
 * The exec + platform + logger are injectable so the decision logic is testable
 * without touching the real filesystem or spawning icacls.
 *
 * @param {string} path runtime file/dir to restrict
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{platform?:string, exec?:(cmd:string,args:string[])=>void, log?:(line:object)=>void}} [deps]
 * @returns {{applied:boolean, reason:string}}
 */
export function restrictAcl(path, env = process.env, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const emit = typeof deps.log === 'function' ? deps.log : log;
  const exec =
    typeof deps.exec === 'function'
      ? deps.exec
      : (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });

  if (platform !== 'win32') {
    return { applied: false, reason: 'not-windows' };
  }
  if (env.CLAUDE_OPEN_SKIP_ACL === '1') {
    // tests opt out to allow cleanup
    return { applied: false, reason: 'skipped-by-env' };
  }
  try {
    // Remove inherited access and grant only the current user and SYSTEM.
    // Runtime files contain local bearer/control tokens, so merely adding an
    // ACE while keeping inherited Users access is not sufficient.
    exec('icacls', [path, '/inheritance:r', '/grant:r', `${env.USERNAME}:F`, 'SYSTEM:F']);
    // Verification line: state plainly that the invariant was enforced.
    emit({ evt: 'acl-applied', path, msg: `restricted ACL applied to ${path} (owner + SYSTEM only)` });
    return { applied: true, reason: 'applied' };
  } catch (e) {
    // FAIL-LOUD: name the file that is left with inherited (over-broad) ACLs so
    // an operator can see the token file is not hardened. Do not crash.
    emit({ evt: 'warn', msg: `ACL hardening FAILED for ${path}; token file may be readable by other local users: ${e.message}`, path });
    return { applied: false, reason: 'icacls-failed' };
  }
}

function log(line) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...line }) + '\n');
}

// Run when invoked directly.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === thisPath) {
  start().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(e.firstRun ? 2 : 1);
  });
}
