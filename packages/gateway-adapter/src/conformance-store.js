// Sanitized conformance store. (SESSION-4 phase 3.2.)
//
// Persists live effort-probe results and enforces them at catalog + request
// time. Keyed by:  fingerprint + realId + route + field + value + version
// A stored result gates whether Claude Open advertises / sends an effort field:
//   behavior-observed -> enable ONLY that exact field/value (verified: the
//                        gateway's response proves it changed behavior)
//   schema-accepted   -> recorded as a truth-state, but NEVER flips a selector
//                        to verified/enabled. It only proves the field forwarded
//                        and validated, not that it changed model behavior.
//   rejected          -> disable that field/value
//   silent-ignore     -> disable that field/value (gateway ignores it)
//   unknown/error     -> do NOT advertise support
// Switching gateway fingerprints never reuses another gateway's results.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Only behavioral proof enables a control as verified. `schema-accepted` proves
// forwarding/validation only (Phase 6) and must never enable a selector.
const ENABLING = new Set(['behavior-observed']);

export class ConformanceStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath] persistence file (per fingerprint namespace recommended)
   * @param {string} [opts.version]  registry/probe version stamped on records
   * @param {(line:object)=>void} [opts.log] structured logger. Security-review
   *   defect 2(c): a persist write failure was silently discarded, so a failed
   *   write of verified probe results was invisible. When supplied, _persist()
   *   emits a warn line (never throws) on failure so the loss is observable.
   */
  constructor({ filePath = null, version = 'unversioned', log = () => {} } = {}) {
    this.filePath = filePath;
    this.version = version;
    this.log = typeof log === 'function' ? log : () => {};
    /** @type {Map<string,object>} key -> record */
    this.records = new Map();
    if (filePath && existsSync(filePath)) {
      try {
        const arr = JSON.parse(readFileSync(filePath, 'utf8'));
        for (const raw of arr) {
          // Session-3 called schema validation "accepted". Preserve the data,
          // but migrate the claim to its truthful proof level.
          const r = raw?.result === 'accepted' ? { ...raw, result: 'schema-accepted' } : raw;
          this.records.set(this._key(r), r);
        }
      } catch {
        /* start empty on parse error */
      }
    }
  }

  _key(r) {
    return [r.fingerprint, r.realId, r.route, r.field, typedValue(r.value), r.version].join('||');
  }

  /**
   * Record a probe result.
   * @param {object} r { fingerprint, realId, route, field, value, result, evidence, at }
   */
  record(r) {
    const rec = {
      version: this.version,
      at: new Date().toISOString(),
      ...r,
      result: r.result === 'accepted' ? 'schema-accepted' : r.result,
      // Persist a bounded classification explanation, never an upstream body.
      evidence: sanitizeEvidence(r.evidence),
    };
    this.records.set(this._key(rec), rec);
    this._persist();
    return rec;
  }

  /**
   * Look up the stored result for an exact field/value on a model+gateway.
   * @returns {object|null}
   */
  lookup({ fingerprint, realId, route, field, value }) {
    return (
      this.records.get(this._key({ fingerprint, realId, route, field, value, version: this.version })) || null
    );
  }

  /**
   * Is a specific field/value PROVEN enabled for this gateway+model+route?
   * Only `behavior-observed` at the current version enables. `schema-accepted`
   * is a recorded truth-state but does NOT enable/verify a selector.
   */
  isEnabled({ fingerprint, realId, route, field, value }) {
    const rec = this.lookup({ fingerprint, realId, route, field, value });
    return !!rec && ENABLING.has(rec.result);
  }

  list({ fingerprint, realId, route, field }) {
    return [...this.records.values()].filter(
      (r) =>
        r.version === this.version &&
        r.fingerprint === fingerprint &&
        r.realId === realId &&
        r.route === route &&
        r.field === field,
    );
  }

  /**
   * Given a model's documented reasoning descriptor, return a PROBE-ENFORCED
   * descriptor. If any stored result disables/does-not-prove the documented
   * field, downgrade to a non-advertised control unless an accepted value exists.
   * @param {object} params { fingerprint, realId, route, reasoning }
   * @returns {object|null} probe descriptor to pass to reasoningControl(), or null
   */
  enforce({ fingerprint, realId, route, reasoning }) {
    if (!reasoning || !reasoning.field) return null;
    const field = reasoning.field;
    // Collect every exact probed value for this field. Numeric controls often
    // have no single documented default, so deriving candidates only from the
    // registry made them impossible to enable.
    const results = this.list({ fingerprint, realId, route, field });

    if (results.length === 0) {
      // No probe yet -> documented data is an UNVERIFIED hint. Per Session-4 §7,
      // unknown by default: do not advertise until proven. Return a control that
      // shows no selector but records it is unverified.
      return { controlType: 'unknown', field, reason: 'no conformance probe yet (unverified)' };
    }

    const acceptedRecords = results.filter((r) => ENABLING.has(r.result));
    const accepted = acceptedRecords.map((r) => r.value);
    if (accepted.length) {
      // Enable ONLY the proven values, preserving the documented control type.
      const descriptor = {
        ...reasoning,
        allowedValues: accepted,
        default: accepted.includes(reasoning.default) ? reasoning.default : accepted[0],
        source: 'probe',
        // Only behavior-observed records reach this branch (ENABLING), so an
        // advertised/enabled selector is always behaviorally verified.
        verification: 'behavior-observed',
      };
      if (reasoning.controlType === 'categorical' || reasoning.controlType === 'boolean') {
        descriptor.values = accepted;
      }
      if (reasoning.controlType === 'numeric_budget') {
        // Exact conformance means an accepted number does not imply the whole
        // documented range works through this gateway.
        delete descriptor.min;
        delete descriptor.max;
        descriptor.specialValues = Object.fromEntries(
          Object.entries(reasoning.specialValues || {}).filter(([, v]) => accepted.includes(v)),
        );
      }
      return descriptor;
    }

    // All probed results were rejected / silent-ignore / unknown -> disable.
    const worst = results[0].result;
    return { controlType: 'unknown', field, reason: `probe result '${worst}' — not advertised` };
  }

  _persist() {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify([...this.records.values()], null, 2), { encoding: 'utf8' });
    } catch (e) {
      // Security-review defect 2(c): do NOT silently discard. A silent write
      // failure means verified probe results are lost on the next restart with
      // no trace. Log it (fail-loud) but never throw — persistence is best-effort
      // and must not crash the adapter. The message is sanitized so a path or OS
      // error string can never leak a secret-shaped substring.
      this.log({ evt: 'warn', msg: `conformance persist failed for ${this.filePath}: ${sanitizeEvidence(e.message)}`, path: this.filePath });
    }
  }

  /** Build a per-fingerprint store path under a runtime dir. */
  static pathFor(runtimeDir, fingerprint) {
    return join(runtimeDir, `conformance-${fingerprint}.json`);
  }
}

function sanitizeEvidence(value) {
  return String(value || '')
    .replace(/(authorization|x-api-key|api[_-]?key|bearer)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '<redacted>')
    .slice(0, 240);
}

function typedValue(value) {
  return `${typeof value}:${JSON.stringify(value)}`;
}
