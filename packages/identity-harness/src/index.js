// @claude-open/identity-harness
//
// Candidate identity harness for the isolated 3P (third-party) gateway profile.
//
// This module NEVER launches any Claude client, never touches the user's normal
// profile / registry, and never claims P0.1. It only scaffolds a local, isolated
// configLibrary + preferences workspace behind an explicit P0.0 PASS gate.
//
// LOCAL 3P CONFIG-LIBRARY CONTRACT — empirically verified against installed
// Claude Desktop 1.20186.1 by reading the read-only extracted app.asar
// writer/loader (.vite/build/index.chunk-c42vKsva.js). Full redacted evidence,
// with exact function names + line numbers, is in
// tests/fixtures/claude-3p-config/README.md.
//
// The per-config active file configLibrary/<uuid>.json is FLAT:
//   - inferenceProvider            = 'gateway'
//   - inferenceGatewayBaseUrl      = <http loopback base URL>
//   - inferenceGatewayApiKey       = <ephemeral loopback token>
//   - inferenceCredentialKind      = 'static'
//   - inferenceGatewayAuthScheme   = 'bearer'
//   - modelDiscoveryEnabled        = <boolean>
//   - inferenceModels[]            = { name, labelOverride?, supports1m?,
//                                      anthropicFamilyTier?, isFamilyDefault? }
//     (name = exact adapter alias sent; labelOverride = friendly display;
//      first entry is the default.)
//   It is NOT nested inference{}. NOT models.list. NOT inference.models — those
//   are in-memory Zod shapes only, never persisted to disk (writer cB()/UQ()).
//
//   _meta.json = { appliedId:<uuid>, entries:[{ id:<uuid>, name:<string> }] }
//     (writer UE()/self-heal lB(), reader Xnt()). No other keys.
//
//   deploymentMode ("3p"|"1p") lives ONLY in claude_desktop_config.json
//     (writer zh(), key "deploymentMode"), NEVER in the config-library file.
//
//   userData root honours CLAUDE_USER_DATA_DIR (builder W0()); win32 fallback is
//     %LOCALAPPDATA%\Claude-3p. The caller passes an explicit userDataRoot here.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CANDIDATE_IDS = ['A', 'B', 'C', 'D'];

const CANDIDATE_STATUS = {
  A: 'READY_NOT_RUN',
  B: 'READY_NOT_RUN',
  C: 'PLACEHOLDER_NOT_IMPLEMENTED',
  D: 'PLACEHOLDER_NOT_IMPLEMENTED',
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY = /(authorization|apikey|token|secret|credential|password)/i;
const REDACTED = '[REDACTED]';

// Windows reserved device names (case-insensitive), rejected as configurationId.
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Anthropic opus aliases we treat as the preferred healthy default, newest
// first. The version suffix (4-5..4-8) must be present; a bare "claude-opus"
// is NOT preferred over an already-healthy model.
const OPUS_PREFERENCE_ORDER = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
];

/**
 * Choose the healthy DEFAULT model alias for the FLAT 3P config.
 *
 * The client uses the FIRST inferenceModels entry as its default, so the
 * launcher must place a healthy model first. Selection order:
 *   1. The newest available anthropic opus alias (claude-opus-4-8..4-5) that is
 *      NOT in the known-unhealthy set.
 *   2. Else the first model in `modelIds` that is not known-unhealthy.
 *   3. Else the first model (last resort — everything is overloaded).
 *
 * Pure: never mutates its inputs. Matching is case-insensitive.
 *
 * @param {string[]} modelIds       live adapter aliases (order = display order)
 * @param {string[]} [unhealthyIds] known-overloaded/unhealthy aliases to avoid
 * @returns {string|null} preferred default alias, or null for an empty list
 */
export function selectDefaultModel(modelIds, unhealthyIds = []) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) return null;
  const unhealthy = new Set(
    (Array.isArray(unhealthyIds) ? unhealthyIds : []).map((id) => String(id).toLowerCase()),
  );
  const isHealthy = (id) => !unhealthy.has(String(id).toLowerCase());

  // 1. Newest available healthy opus alias.
  for (const preferred of OPUS_PREFERENCE_ORDER) {
    const match = modelIds.find(
      (id) => String(id).toLowerCase() === preferred && isHealthy(id),
    );
    if (match) return match;
  }

  // 2. First healthy model.
  const firstHealthy = modelIds.find((id) => isHealthy(id));
  if (firstHealthy) return firstHealthy;

  // 3. Last resort: everything is unhealthy; keep the first model.
  return modelIds[0];
}

// Detect the Anthropic family tier of a model by its real display name / alias.
// The client's ConfigHealth / first-inference probe resolves by
// anthropicFamilyTier (haiku|sonnet|opus|...), so we key detection off the REAL
// family name (in either the alias id or the friendly display name). Opus is
// version-gated to claude-opus-4-5..4-8 (a bare "claude-opus" is not opus-family,
// matching selectDefaultModel's OPUS_PREFERENCE_ORDER contract).
const OPUS_VERSIONED = /claude[\s._-]*opus[\s._-]*4[\s._-]*[5-8]\b/i;
const SONNET_FAMILY = /claude[\s_-]*sonnet/i;
const HAIKU_FAMILY = /claude[\s_-]*haiku/i;

function detectFamily(model) {
  const hay = `${model?.id ?? ''} ${model?.display_name ?? ''}`;
  if (OPUS_VERSIONED.test(hay)) return 'opus';
  if (SONNET_FAMILY.test(hay)) return 'sonnet';
  if (HAIKU_FAMILY.test(hay)) return 'haiku';
  return null;
}

/**
 * Tag healthy models with anthropicFamilyTier + isFamilyDefault so the Claude
 * client's ConfigHealth / first-inference tier probe resolves to a HEALTHY model.
 *
 * ROOT CAUSE (confirmed live): the client resolves the probe by
 * anthropicFamilyTier, NOT by inferenceModels ordering. With no tier tags it
 * falls back to the built-in claude-haiku-4-5 tier id, which the gateway is
 * 503-overloading -> ConfigHealth: unreachable.
 *
 * FAMILY-TIER EVIDENCE — tests/fixtures/claude-3p-config/README.md:99-101:
 *   supports1m (99), anthropicFamilyTier haiku|sonnet|opus|fable|mythos (100),
 *   isFamilyDefault (101). The documented lever: a family tier maps a bare tier
 *   alias to YOUR chosen model. So if the only healthy Anthropic models are
 *   opus, tagging a healthy OPUS as anthropicFamilyTier:'haiku' isFamilyDefault
 *   makes the client's haiku-tier probe resolve to that healthy opus.
 *
 * Behaviour, per tier in {haiku, sonnet, opus}:
 *   - Prefer a HEALTHY model whose real family IS that tier.
 *   - Else fall back to a healthy OPUS representative (the documented lever).
 *   - Never tag an overloaded/unhealthy model. If no healthy Anthropic model
 *     exists at all, assign nothing (nothing safe to borrow).
 * Exactly one isFamilyDefault:true is marked per tier. A single healthy opus may
 * carry multiple tiers (it is the representative for each), so tier tagging is
 * tracked per-tier via a parallel list rather than a single field on the record.
 *
 * Pure: returns NEW records; never mutates inputs. The returned record keeps
 * anthropicFamilyTier as the LAST tier it represents for back-compat with the
 * flat single-field serializer, and additionally carries familyTiers[] (all
 * tiers it is the default for) which the serializer expands into per-tier items.
 *
 * @param {Array<{id:string,display_name?:string}>} models
 * @param {{unhealthyIds?:string[]}} [options]
 * @returns {Array<object>} new model records, some tagged with tier metadata
 */
export function assignFamilyTiers(models, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const unhealthy = new Set(
    (Array.isArray(options.unhealthyIds) ? options.unhealthyIds : []).map((id) =>
      String(id).toLowerCase(),
    ),
  );
  const isHealthy = (m) => !unhealthy.has(String(m.id).toLowerCase());

  // Clone (pure): never mutate caller records.
  const out = models.map((m) => ({ ...m }));

  // Index healthy models by detected family.
  const healthyByFamily = { opus: [], sonnet: [], haiku: [] };
  for (const m of out) {
    if (!isHealthy(m)) continue;
    const fam = detectFamily(m);
    if (fam && healthyByFamily[fam]) healthyByFamily[fam].push(m);
  }

  // Preferred healthy opus (newest-first) — the fallback representative for any
  // tier that lacks a real healthy model of its own.
  const opusFallback = OPUS_PREFERENCE_ORDER.map((pref) =>
    healthyByFamily.opus.find((m) => String(m.id).toLowerCase() === pref),
  ).find(Boolean) || healthyByFamily.opus[0] || null;

  // If there is no healthy Anthropic model at all, there is nothing to borrow.
  const anyHealthyAnthropic =
    healthyByFamily.opus.length || healthyByFamily.sonnet.length || healthyByFamily.haiku.length;
  if (!anyHealthyAnthropic) return out;

  // Track, per record, which tiers it is the family default for.
  const tierOf = new Map(); // record -> Set<tier>
  const markDefault = (record, tier) => {
    if (!record) return;
    if (!tierOf.has(record)) tierOf.set(record, new Set());
    tierOf.get(record).add(tier);
  };

  for (const tier of ['opus', 'sonnet', 'haiku']) {
    const real = healthyByFamily[tier][0];
    const rep = real || opusFallback; // borrow a healthy opus when no real one
    if (rep) markDefault(rep, tier);
  }

  // Materialize the tier metadata onto the cloned records. A record may own
  // multiple tiers (the healthy-opus fallback case); familyTiers[] lists all,
  // and anthropicFamilyTier reflects the record's own real family when present,
  // else the first borrowed tier — but the serializer expands per-tier items.
  for (const record of out) {
    const tiers = tierOf.get(record);
    if (!tiers || tiers.size === 0) continue;
    record.familyTiers = [...tiers];
    // Prefer the record's own real family for the single-field back-compat slot.
    const ownFamily = detectFamily(record);
    record.anthropicFamilyTier = tiers.has(ownFamily) ? ownFamily : record.familyTiers[0];
    record.isFamilyDefault = true;
  }

  return out;
}

// A well-formed package family name is `<Name>_<publisherIdHash>` — letters,
// digits, dots, and a single underscore-joined publisher hash. We reject any
// value carrying whitespace or shell/argument metacharacters because it is
// interpolated into a native `CheckNetIsolation` command argument.
const SAFE_FAMILY_NAME = /^[A-Za-z0-9.]+_[A-Za-z0-9]+$/;

/**
 * Decide whether a package family name already has a loopback exemption, given
 * captured `CheckNetIsolation LoopbackExempt -s` output.
 *
 * The tool prints one block per exempted AppContainer; the `Name:` line carries
 * the package family name for entries added via `-n=<family>`. Matching is:
 *   - case-insensitive (Windows package family names are case-insensitive), and
 *   - whole-token (a `Name:` value must equal the family exactly; a prefix or
 *     substring collision must NOT count).
 *
 * Pure and total: null / empty inputs return false and never throw.
 *
 * @param {string} cnisOutput   captured stdout of `CheckNetIsolation LoopbackExempt -s`
 * @param {string} familyName   package family name to look for (e.g. Claude_pzs8sxrjxfjjc)
 * @returns {boolean} true iff the family is already exempt
 */
export function isFamilyLoopbackExempt(cnisOutput, familyName) {
  if (typeof cnisOutput !== 'string' || cnisOutput.length === 0) return false;
  if (typeof familyName !== 'string') return false;
  const target = familyName.trim().toLowerCase();
  if (target.length === 0) return false;

  // Normalize CRLF and scan each `Name:` line for a whole-token match.
  const lines = cnisOutput.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const match = /^\s*Name:\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Build the exact `CheckNetIsolation LoopbackExempt -a -n=<family>` argument
 * list used to register a missing exemption. Returns the argv AFTER the
 * executable name (the caller invokes `CheckNetIsolation` with these args).
 *
 * This does NOT run anything and does NOT require elevation; it only produces
 * the argument vector. Registration itself is elevated and performed by the
 * launcher / installer.
 *
 * @param {string} familyName package family name (validated + trimmed)
 * @returns {string[]} ['LoopbackExempt', '-a', '-n=<family>']
 * @throws if the family name is empty or contains unsafe characters
 */
export function buildLoopbackExemptAddArgs(familyName) {
  if (typeof familyName !== 'string' || familyName.trim().length === 0) {
    throw new Error('a non-empty package family name is required');
  }
  const trimmed = familyName.trim();
  if (!SAFE_FAMILY_NAME.test(trimmed)) {
    throw new Error(`invalid package family name: ${JSON.stringify(familyName)}`);
  }
  return ['LoopbackExempt', '-a', `-n=${trimmed}`];
}

/**
 * Read the P0.0 evidence gate. Only an explicit PASS permits an experiment.
 * The repaired gate id is `p0_0` with status `PASS`.
 */
export async function readP0Gate(evidenceFile) {
  const raw = await readFile(evidenceFile, 'utf8');
  const parsed = JSON.parse(raw);
  const status = parsed?.p0_0?.status;
  return { status, permitsExperiment: status === 'PASS' };
}

/**
 * Deep-redact any key matching sensitive naming to '[REDACTED]'.
 */
export function redactHarnessValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactHarnessValue(entry));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactHarnessValue(inner);
    }
    return out;
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Deep-merge `source` over `target`, returning a new object; unrelated keys preserved.
function deepMerge(target, source) {
  const base = isPlainObject(target) ? { ...target } : {};
  if (!isPlainObject(source)) {
    return isPlainObject(source) ? source : base;
  }
  for (const [key, value] of Object.entries(source)) {
    base[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return base;
}

async function readBytesIfExists(file) {
  try {
    return { existed: true, bytes: await readFile(file) };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { existed: false, bytes: null };
    }
    throw err;
  }
}

function parseJsonBytes(bytes) {
  if (!bytes) return undefined;
  return JSON.parse(bytes.toString('utf8'));
}

function assertLoopbackHttp(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('base URL must be an HTTP loopback URL');
  }
  const host = url.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (url.protocol !== 'http:' || !isLoopback) {
    throw new Error('base URL must be an HTTP loopback URL');
  }
}

// Validate a supplied configurationId. Reject non-UUID values, and independently
// reject anything that could escape the configLibrary directory or hit a
// reserved device name (defence-in-depth even though UUIDs already exclude these).
function assertSafeConfigurationId(id) {
  if (id === '..' || id === '.' || id.includes('/') || id.includes('\\') ||
      id.includes('\0') || path.basename(id) !== id ||
      RESERVED_NAMES.has(id.toLowerCase())) {
    throw new Error('configurationId is unsafe (path traversal or reserved name)');
  }
  if (!UUID_V4.test(id)) {
    throw new Error('configurationId must be a valid UUID');
  }
}

// Build the FLAT active-config object exactly as the 1.20186.1 writer persists it.
// The upstream gateway secret (if any) is never placed here; only the ephemeral
// loopback token is used as inferenceGatewayApiKey.
function buildFlatActiveConfig({ baseUrl, ephemeralToken, models, modelDiscoveryEnabled }) {
  // FLAT inferenceModels serialization. anthropicFamilyTier + isFamilyDefault are
  // OPTIONAL per-item fields (tests/fixtures/claude-3p-config/README.md:99-101)
  // and are emitted ONLY when set. A single healthy representative may be the
  // family default for MULTIPLE tiers (familyTiers[] — the documented lever where
  // a healthy opus stands in as the haiku/sonnet tier so the client's overloaded
  // haiku-4-5 probe resolves to a HEALTHY model). Such a record expands into:
  //   1 base item (the plain alias, client default candidate), plus
  //   1 additional item PER TIER carrying { anthropicFamilyTier, isFamilyDefault }
  // so the client sees a distinct healthy entry for each tier probe. The
  // internal familyTiers marker is NEVER serialized.
  const inferenceModels = [];
  for (const model of models) {
    const base = { name: model.id, labelOverride: model.display_name };
    if (typeof model.supports1m === 'boolean') base.supports1m = model.supports1m;

    const tiers = Array.isArray(model.familyTiers) && model.familyTiers.length
      ? model.familyTiers
      : model.anthropicFamilyTier
        ? [model.anthropicFamilyTier]
        : [];

    // Base (untagged) item first — preserves ordering / client default at [0].
    inferenceModels.push(base);

    // One tagged item per tier this model is the family default for.
    for (const tier of tiers) {
      const tierItem = { name: model.id, labelOverride: model.display_name };
      if (typeof model.supports1m === 'boolean') tierItem.supports1m = model.supports1m;
      tierItem.anthropicFamilyTier = tier;
      if (model.isFamilyDefault === true) tierItem.isFamilyDefault = true;
      inferenceModels.push(tierItem);
    }
  }
  const active = {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: ephemeralToken,
    inferenceCredentialKind: 'static',
    inferenceGatewayAuthScheme: 'bearer',
    modelDiscoveryEnabled: Boolean(modelDiscoveryEnabled),
    // A copied client can keep itself from repeatedly offering an in-place
    // vendor update that would overwrite Claude Open's verified UI assets.
    // Updating is performed by rerunning the Claude Open installer, which
    // copies the newest signed official client and reapplies the checked patch
    // set transactionally.
    disableAutoUpdates: true,
    // FIX A — enable the Chat tab surface in 3P.
    //
    // EVIDENCE (read-only extracted app.asar 1.20186.1,
    // .vite/build/index.chunk-c42vKsva.js): the three surface toggles are FLAT
    // config-library keys on the same flat schema (`ml.shape`, read via the flat
    // allow-list `Vf`) that this object populates — NOT claude_desktop_config.json:
    //   - flatKey:"chatTabEnabled"                support scopes:["3p"] availableInVersion:"1.13576.0", betaFeatureKey:"chatTab"
    //   - flatKey:"coworkTabEnabled"              support scopes:["3p"] availableInVersion:"1.9659.0"
    //   - flatKey:"isClaudeCodeForDesktopEnabled" support scopes:["3p","1p"] availableInVersion:"1.2581.0"
    // The client's surface-normalizer reads them off THIS flat object `r`:
    //   r.coworkTabEnabled===false && r.isClaudeCodeForDesktopEnabled===false && r.chatTabEnabled!==true
    //     -> "At least one surface must remain enabled; the Cowork tab has been re-enabled."
    // => Cowork + Code are default-ENABLED (only off when explicitly false);
    //    Chat is default-DISABLED unless explicitly ===true. Setting it true here
    //    yields Chat + Cowork + Code (we deliberately DO NOT set cowork/code so
    //    their default-on state is preserved).
    //
    // HONEST LIMIT: the new unified "Home" layout is a FIRST-PARTY claude.ai
    // REMOTE feature the offline 3P bundle cannot render (nor is SSH remote, which
    // is likewise first-party-only). Chat + Cowork + Code is the best achievable
    // surface set for the gateway/3P path.
    chatTabEnabled: true,
  };

  // Native discovery is the production path. Omitting inferenceModels avoids a
  // stale, giant static list in Settings; the client asks the authenticated
  // loopback adapter for the current catalog on every launch. Candidate tests
  // can still exercise the older static contract by disabling discovery.
  if (!modelDiscoveryEnabled) active.inferenceModels = inferenceModels;
  return active;
}

function serialize(value) {
  // UTF-8, no BOM. A Buffer from a JSON string is inherently BOM-free.
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Remove every config-library config file (and its sibling manifest) EXCEPT the
// one about to be written for `keepId`, and drop _meta.json so it is fully
// rewritten with the fresh appliedId. This guarantees no stale config carrying a
// retired fixed gateway port survives a relaunch. Directory-scoped: only files
// directly under `library` are touched. Tolerant of a missing directory.
async function purgeConfigLibrary(library, keepId) {
  const { readdir } = await import('node:fs/promises');
  let names;
  try {
    names = await readdir(library);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  const keepConfig = `${keepId}.json`;
  const keepManifest = `${keepId}.manifest.json`;
  for (const name of names) {
    if (name === keepConfig || name === keepManifest) continue;
    // Purge any other config JSON, any manifest, and the stale _meta.json.
    const isConfigJson = name.endsWith('.json') && name !== '_meta.json' && !name.endsWith('.manifest.json');
    const isManifest = name.endsWith('.manifest.json');
    const isMeta = name === '_meta.json';
    if (isConfigJson || isManifest || isMeta) {
      await rm(path.join(library, name), { force: true });
    }
  }
}

/**
 * Create an isolated candidate workspace. Never launches a client.
 *
 * @param {object} opts
 * @param {'A'|'B'|'C'|'D'} opts.candidateId
 * @param {string} opts.evidenceFile      P0.0 gate JSON path
 * @param {string} opts.harnessRoot       harness working root (holds .rollback/)
 * @param {string} [opts.userDataRoot]    isolated userData root (CLAUDE_USER_DATA_DIR-style)
 * @param {string} [opts.configurationId] supplied UUID (validated) else generated
 * @param {string} opts.loopbackBaseUrl   http://127.0.0.1:<port>
 * @param {string} opts.ephemeralToken    per-run loopback token
 * @param {Array<{id:string,display_name:string}>} opts.models
 * @param {object} [opts.preferences]     merged into claude_desktop_config.json
 * @param {string} [opts.configName]      _meta entry display name
 * @param {boolean}[opts.modelDiscoveryEnabled]
 * @param {number} [opts.failAfterReplace] test-only injected failure after N replacements
 */
export async function createCandidateWorkspace(opts = {}) {
  const {
    candidateId,
    evidenceFile,
    harnessRoot,
    userDataRoot,
    configurationId: suppliedConfigurationId,
    loopbackBaseUrl,
    ephemeralToken,
    models = [],
    preferences: suppliedPreferences = {},
    configName = 'Claude Open Gateway',
    modelDiscoveryEnabled = false,
    failAfterReplace,
    // requireExperimentGate: when true (default), a P0.0 PASS gate file is
    // mandatory. The production entrypoint sets it false — the gate guards
    // candidate EXPERIMENTS, not the production launch path.
    requireExperimentGate = true,
    // purgeStaleConfigs: when true, remove any OTHER config-library configs (and
    // their sibling manifests) before writing the fresh one, so a stale launch's
    // config — carrying a retired fixed gateway port — can never linger. The
    // production launch path sets this true; the experiment path leaves it false
    // so multi-candidate experiment artifacts are preserved.
    purgeStaleConfigs = false,
  } = opts;

  if (requireExperimentGate) {
    const gate = await readP0Gate(evidenceFile);
    if (!gate.permitsExperiment) {
      throw new Error('P0.0 is FAIL; client experiments are blocked');
    }
  }

  assertLoopbackHttp(loopbackBaseUrl);

  const ids = models.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('model IDs must be unique');
  }

  // configurationId: validate a supplied one; otherwise generate a v4 UUID.
  let configurationId;
  if (suppliedConfigurationId === undefined || suppliedConfigurationId === null) {
    configurationId = randomUUID();
  } else {
    assertSafeConfigurationId(suppliedConfigurationId);
    configurationId = suppliedConfigurationId;
  }

  const baseRoot = userDataRoot ?? path.join(harnessRoot, 'userData');
  const library = path.join(baseRoot, 'configLibrary');
  await mkdir(library, { recursive: true });

  const configurationPath = path.join(library, `${configurationId}.json`);
  const metaPath = path.join(library, '_meta.json');
  const preferencesPath = path.join(baseRoot, 'claude_desktop_config.json');

  // FIX 1(b): purge stale config-library configs (and their sibling manifests)
  // BEFORE writing the fresh one, so a prior launch's config carrying a retired
  // fixed gateway port can never linger. _meta.json is always fully rewritten
  // below with appliedId pointing at the fresh config, so it is not deleted here.
  // Only other *.json config entries + *.manifest.json are removed; the fresh
  // configuration (a brand-new UUID) does not yet exist so it is never a target.
  if (purgeStaleConfigs) {
    await purgeConfigLibrary(library, configurationId);
  }

  // Read prior bytes (for backup + preferences deep-merge).
  const priorConfig = await readBytesIfExists(configurationPath);
  const priorMeta = await readBytesIfExists(metaPath);
  const priorPreferences = await readBytesIfExists(preferencesPath);

  // FLAT active config — fully owned by the harness (no prior-key preservation:
  // the active config-library file is the exact flat contract, nothing else).
  const configData = buildFlatActiveConfig({
    baseUrl: loopbackBaseUrl,
    ephemeralToken,
    models,
    modelDiscoveryEnabled,
  });

  // Preferences: deep-merge supplied over existing, preserving unrelated keys.
  // deploymentMode ("3p"/"1p") lives ONLY here.
  const preferencesData = deepMerge(
    isPlainObject(parseJsonBytes(priorPreferences.bytes)) ? parseJsonBytes(priorPreferences.bytes) : {},
    suppliedPreferences,
  );

  // _meta.json — exact { appliedId, entries:[{id,name}] } contract.
  const metaData = { appliedId: configurationId, entries: [{ id: configurationId, name: configName }] };

  // Targets to write atomically. Order matters for failAfterReplace injection.
  const targets = [
    { role: 'configuration', target: 'configuration', finalPath: configurationPath, buffer: serialize(configData), prior: priorConfig },
    { role: 'preferences', target: 'preferences', finalPath: preferencesPath, buffer: serialize(preferencesData), prior: priorPreferences },
    { role: 'meta', target: 'meta', finalPath: metaPath, buffer: serialize(metaData), prior: priorMeta },
  ];

  // ---- C4: REAL backup BEFORE any replacement. ----
  // Capture ORIGINAL bytes, hash them, and persist private rollback artifacts
  // under a private dir (harnessRoot/.rollback) that is outside any public export.
  const rollbackDir = path.join(harnessRoot, '.rollback', configurationId);
  await mkdir(rollbackDir, { recursive: true });

  for (const target of targets) {
    if (target.prior.existed) {
      // Original bytes already read; hash them as the pre-change fingerprint.
      target.originalBytes = target.prior.bytes;
      target.originalHash = sha256Hex(target.originalBytes);
      // Write a private rollback backup file and verify its hash before mutating.
      const backupPath = path.join(rollbackDir, `${target.target}.bak`);
      await writeFile(backupPath, target.originalBytes);
      const verifyHash = sha256Hex(await readFile(backupPath));
      if (verifyHash !== target.originalHash) {
        throw new Error('backup hash verification failed before mutation');
      }
      target.backupPath = backupPath;
    } else {
      target.originalBytes = null;
      target.originalHash = sha256Hex(Buffer.alloc(0));
      target.backupPath = null;
    }
  }

  const tmpSuffix = `.tmp-${configurationId}`;
  const written = []; // targets whose final path has been replaced

  try {
    let replacements = 0;
    for (const target of targets) {
      const tmpPath = `${target.finalPath}${tmpSuffix}`;
      await writeFile(tmpPath, target.buffer);
      target.tmpPath = tmpPath;
      await rename(tmpPath, target.finalPath); // atomic replace
      target.tmpPath = undefined;
      written.push(target);
      replacements += 1;
      if (typeof failAfterReplace === 'number' && replacements >= failAfterReplace) {
        throw new Error('injected atomic write failure');
      }
    }
  } catch (err) {
    // Clean any dangling temp files.
    for (const target of targets) {
      if (target.tmpPath) {
        await rm(target.tmpPath, { force: true });
      }
    }
    // Roll back every replaced target to its original bytes (restore + verify).
    for (const target of written) {
      if (target.originalBytes === null) {
        await rm(target.finalPath, { force: true });
      } else {
        await writeFile(target.finalPath, target.originalBytes);
        const restoredHash = sha256Hex(await readFile(target.finalPath));
        if (restoredHash !== target.originalHash) {
          throw new Error('rollback hash verification failed');
        }
      }
    }
    // Remove the private rollback artifacts we created for this failed run.
    await rm(rollbackDir, { recursive: true, force: true });
    throw err;
  }

  // ---- Hash manifest. NEVER includes the ephemeral loopback token. ----
  // Written-file entries hash the NEW bytes; backup entries hash the ORIGINAL
  // (pre-change) bytes and name the private rollback artifact.
  const manifestFiles = [];
  for (const target of targets) {
    manifestFiles.push({
      target: target.target,
      role: target.role,
      path: target.finalPath,
      sha256: sha256Hex(target.buffer),
    });
    manifestFiles.push({
      target: target.target,
      role: 'backup',
      existed: target.prior.existed,
      sha256: target.originalHash, // hash of ORIGINAL bytes (empty-buffer hash if absent)
      backupPath: target.backupPath,
    });
  }

  const manifest = {
    configurationId,
    candidateId,
    files: manifestFiles,
  };

  // Guard: the loopback token must never appear anywhere in the manifest.
  const manifestBuffer = serialize(manifest);
  if (manifestBuffer.includes(ephemeralToken)) {
    throw new Error('refusing to write manifest: loopback token would leak');
  }

  const manifestPath = path.join(library, `${configurationId}.manifest.json`);
  const manifestTmp = `${manifestPath}${tmpSuffix}`;
  await writeFile(manifestTmp, manifestBuffer);
  await rename(manifestTmp, manifestPath);

  return {
    status: CANDIDATE_STATUS[candidateId],
    experimentRan: false,
    configurationId,
    paths: {
      configuration: configurationPath,
      meta: metaPath,
      preferences: preferencesPath,
      manifest: manifestPath,
      rollbackDir,
    },
  };
}

/**
 * Production launch entrypoint. Writes the SAME FLAT 3P config-library contract
 * as createCandidateWorkspace, but does NOT require a P0.0 experiment gate — the
 * gate guards candidate experiments, not the production Control Center launch.
 *
 * All other safety invariants (loopback-only base URL, unique model IDs,
 * atomic writes + rollback, no-token-leak manifest) still hold. The default
 * candidateId is 'C' (the genuine WindowsApps host per the verified facts).
 *
 * @param {object} opts  same shape as createCandidateWorkspace, minus the gate;
 *                       evidenceFile is ignored.
 */
export async function createProductionWorkspace(opts = {}) {
  return createCandidateWorkspace({
    candidateId: 'C',
    ...opts,
    // Force the production flag on regardless of caller input; the gate is
    // never consulted on this path.
    requireExperimentGate: false,
    // Purge any stale config-library configs so a prior launch's retired fixed
    // gateway port can never linger and be re-applied by the client.
    purgeStaleConfigs: true,
  });
}
