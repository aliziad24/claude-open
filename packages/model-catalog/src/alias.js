// Deterministic, collision-safe model aliasing.
// (Implementation plan sections 1.2, 7.2, 2.3 criterion 5.)
//
// WHY: Claude Desktop's model picker keeps a model only if its id looks
// Anthropic-named (contains claude/opus/sonnet/haiku/...) and is not on a vendor
// denylist. To surface non-Claude gateway models on the UNMODIFIED signed app we
// present them under a picker-safe ALIAS id and translate back on every request.
//
// The old prototype used SEQUENTIAL aliases (claude-3p-001, -002, ...) assigned
// in list order. That is unstable: if the gateway reorders its model list, the
// same alias points at a different real model. This module fixes that:
//
//   alias = "claude-3p-" + <first 10 hex chars of HMAC-SHA256(salt, realId)>
//
// The alias depends ONLY on the real id (and a per-install salt), never on list
// position. A catalog reorder cannot change any mapping. Collisions (two real ids
// hashing to the same alias) are detected and resolved deterministically.

import { createHmac } from 'node:crypto';

const ALIAS_PREFIX = 'claude-3p-';

// The unmodified Claude client hides any model id whose lowercase text matches a
// vendor denylist (observed in its minified A6/s9e gate). Even though a derived
// alias is normally pure hex (`[0-9a-f]`), the hex slice CAN by chance contain a
// hex-representable token (e.g. "dead", "beef"), and future alias schemes may use
// a wider alphabet. To make the picker-safe guarantee independent of the hash
// alphabet, every produced alias is checked against this denylist and re-nonced
// until it is clean. Tokens are matched case-insensitively as substrings.
const ALIAS_DENYLIST = [
  /deepseek/i,
  /gpt/i,
  /gemini/i,
  /qwen/i,
  /llama/i,
  /glm/i,
  /k2\./i,
  /yi-/i,
  /grok/i,
  /mistral/i,
  /mixtral/i,
  /command-r/i,
  /minimax/i,
  /kimi/i,
  /dead/i,
  /beef/i,
];

/**
 * Is `alias` denied by the client's picker gate under `denylist`?
 * Pure and total: non-string / empty inputs return false.
 * @param {string} alias
 * @param {RegExp[]} [denylist] defaults to the built-in vendor denylist
 * @returns {boolean}
 */
export function isAliasDenylisted(alias, denylist = ALIAS_DENYLIST) {
  const t = String(alias || '');
  if (t.length === 0) return false;
  for (const re of denylist) {
    // Match case-insensitively regardless of the regexp's own flags.
    if (new RegExp(re.source, re.flags.includes('i') ? re.flags : `${re.flags}i`).test(t)) {
      return true;
    }
  }
  return false;
}

// ---- FIX B: client effort/thinking-selector recognition (evidence-faithful) ----
//
// The unmodified client shows an effort/thinking selector for a model ONLY when
// `bne(r.id)` returns a control. `bne` reads the RAW model id `r.id` (the
// inferenceModels `name`) — NOT anthropicFamilyTier, NOT any capability field.
// Evidence (read-only extracted app.asar 1.20186.1,
// .vite/build/index.chunk-c42vKsva.js):
//
//   function B6(e){                       // normalize a model id
//     const t = e
//       .replace(/^arn:aws[a-z-]*:bedrock:[^/]+\//, '')      // bedrock ARN prefix
//       .replace(/^(?:[a-z][a-z0-9-]*\.)?anthropic\./, '');   // vendor "…anthropic." prefix
//     const r = t !== e || /^claude-(?:[a-z]+-)?\d/.test(t);
//     return t
//       .replace(/\[[^\]]+\]$/, '')                           // trailing [1m] etc
//       .replace(/-v\d+(?::\d+)?$/, r ? '' : '$&')            // -v<N>[:<N>] suffix
//       .replace(/@\d{8}$/, '')                               // @YYYYMMDD
//       .replace(/-\d{8}$/, '');                              // -YYYYMMDD
//   }
//   function bne(e){ const t=B6(e.toLowerCase()); const r=qMt[t] ?? (WMt.test(t)?HMt:void 0); if(!r) return; ... }
//
// where qMt is a LITERAL allow-list of recognized ids and WMt is the fable/mythos
// family regex. We mirror both here so the alias layer can HONESTLY tell whether
// a given inferenceModels name will surface the native selector. This predicate
// asserts nothing about whether a model *supports* effort — it reports only what
// the client *shows*. The honesty rule (never fake a Claude id on a non-Claude
// model just to force a selector) is enforced by needsAlias/aliasFor below.

// Literal effort-map keys — the exact `qMt` keys from the client bundle.
const EFFORT_SELECTOR_IDS = new Set([
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
]);

// The client's `WMt` fable/mythos family regex, verbatim.
const EFFORT_FAMILY_RE = /^(?:claude-)?(?:fable|mythos)(?:-|$)/;

// Faithful port of the client's `B6` id-normalizer (input already lowercased).
function normalizeModelId(lowerId) {
  const stripped = lowerId
    .replace(/^arn:aws[a-z-]*:bedrock:[^/]+\//, '')
    .replace(/^(?:[a-z][a-z0-9-]*\.)?anthropic\./, '');
  const changedOrClaude = stripped !== lowerId || /^claude-(?:[a-z]+-)?\d/.test(stripped);
  return stripped
    .replace(/\[[^\]]+\]$/, '')
    .replace(/-v\d+(?::\d+)?$/, changedOrClaude ? '' : '$&')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '');
}

/**
 * Does the UNMODIFIED client render an effort/thinking selector for this
 * inferenceModels name? Mirrors the client's `bne` -> `qMt`/`WMt` recognition
 * over the normalized (`B6`) id. Pure and total: non-string / empty -> false.
 *
 * This is a display-recognition predicate, NOT a capability claim.
 * @param {string} id the inferenceModels `name` (the id the client sends)
 * @returns {boolean}
 */
export function clientShowsEffortSelector(id) {
  const t = String(id || '').toLowerCase();
  if (t.length === 0) return false;
  const normalized = normalizeModelId(t);
  return EFFORT_SELECTOR_IDS.has(normalized) || EFFORT_FAMILY_RE.test(normalized);
}

/**
 * A real Anthropic-named id already passes the picker gate; it needs no alias.
 * @param {string} id
 * @returns {boolean}
 */
export function needsAlias(id) {
  const t = String(id || '').toLowerCase();
  if (t.startsWith(ALIAS_PREFIX)) return false; // already an alias
  return !(
    t.includes('claude') ||
    /^(sonnet|opus|haiku)(-.*)?$/.test(t)
  );
}

/**
 * Deterministically derive an alias for a real id under a salt.
 * @param {string} realId
 * @param {string} salt
 * @param {number} [nonce] disambiguation counter for collision resolution
 * @returns {string}
 */
export function deriveAlias(realId, salt, nonce = 0) {
  const input = nonce === 0 ? realId : `${realId}#${nonce}`;
  const hex = createHmac('sha256', String(salt)).update(String(input)).digest('hex');
  return ALIAS_PREFIX + hex.slice(0, 10);
}

/**
 * A stable, collision-safe bidirectional alias map for one install.
 *
 * Persistence: pass a prior `entries` array (from `toJSON`) to restore mappings.
 * An alias is NEVER reassigned to a different real id across the object's life.
 */
export class AliasMap {
  /**
   * @param {object} [opts]
   * @param {string} [opts.salt] per-install salt (persist it with the mapping)
   * @param {Array<{realId:string, alias:string}>} [opts.entries] restored mappings
   * @param {RegExp[]} [opts.denylist] picker-denied token patterns (defaults to
   *   the built-in vendor denylist); a produced alias is re-nonced until clean.
   */
  constructor({ salt, entries, denylist } = {}) {
    if (!salt || typeof salt !== 'string') {
      throw new Error('AliasMap requires a non-empty string salt');
    }
    this.salt = salt;
    this.denylist = Array.isArray(denylist) ? denylist : ALIAS_DENYLIST;
    /** @type {Map<string,string>} realId -> alias */
    this.realToAlias = new Map();
    /** @type {Map<string,string>} alias -> realId */
    this.aliasToReal = new Map();

    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (!e || typeof e.realId !== 'string' || typeof e.alias !== 'string') continue;
        this._bind(e.realId, e.alias);
      }
    }
  }

  _bind(realId, alias) {
    this.realToAlias.set(realId, alias);
    this.aliasToReal.set(alias, realId);
  }

  /**
   * Get (or deterministically create) the alias for a real id.
   * Real Anthropic-named ids are returned unchanged (they pass the picker gate).
   * Collision (same alias, different real id) is resolved by incrementing a nonce.
   * @param {string} realId
   * @returns {string}
   */
  aliasFor(realId) {
    if (!needsAlias(realId)) return realId;
    const existing = this.realToAlias.get(realId);
    if (existing) return existing;

    let nonce = 0;
    let alias = deriveAlias(realId, this.salt, nonce);
    // Resolve two hazards deterministically by bumping the nonce:
    //   1. COLLISION — the derived alias is already owned by a DIFFERENT real id.
    //   2. DENYLIST — the derived alias contains a picker-denied vendor token,
    //      which would make the client HIDE the model from its selector.
    // Re-nonce until the alias is both free and denylist-clean. Deterministic:
    // the same (realId, salt, denylist) always yields the same safe alias.
    while (
      (this.aliasToReal.has(alias) && this.aliasToReal.get(alias) !== realId) ||
      isAliasDenylisted(alias, this.denylist)
    ) {
      nonce += 1;
      alias = deriveAlias(realId, this.salt, nonce);
    }
    this._bind(realId, alias);
    return alias;
  }

  /**
   * Unwrap an alias back to its real id. Idempotent for non-alias ids.
   * @param {string} id
   * @returns {string}
   */
  realFor(id) {
    if (id && this.aliasToReal.has(id)) return this.aliasToReal.get(id);
    return id;
  }

  /** @returns {boolean} whether this id is a known alias */
  isAlias(id) {
    return this.aliasToReal.has(id);
  }

  /**
   * Serialize mappings for persistence.
   * @returns {{salt:string, entries:Array<{realId:string, alias:string}>}}
   */
  toJSON() {
    const entries = [];
    for (const [realId, alias] of this.realToAlias) entries.push({ realId, alias });
    return { salt: this.salt, entries };
  }

  /**
   * Restore an AliasMap from serialized JSON.
   * @param {{salt:string, entries:Array<{realId:string, alias:string}>}} json
   * @returns {AliasMap}
   */
  static fromJSON(json) {
    return new AliasMap({ salt: json.salt, entries: json.entries });
  }
}

export { ALIAS_PREFIX, ALIAS_DENYLIST };
