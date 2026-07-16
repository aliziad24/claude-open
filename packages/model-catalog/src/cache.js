// Catalog cache with ETag/TTL and last-known-good retention.
// (Implementation plan section 7.2: "cache with ETag/TTL and keep the last
//  known good catalog during a temporary discovery failure; visibly mark stale
//  catalog state rather than dropping the picker to Default model.")

/**
 * @typedef {Object} CacheState
 * @property {Array<object>|null} models    last-known-good normalized models
 * @property {string|null} etag
 * @property {number|null} fetchedAt        epoch ms of last successful fetch
 * @property {boolean} stale                true when serving last-known-good past TTL or after a failure
 * @property {string|null} lastError        sanitized reason we are stale (never a secret)
 */

export class CatalogCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] freshness window; after this the catalog is "stale but usable"
   * @param {() => number} [opts.now] clock injection for tests
   */
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this._now = now;
    /** @type {CacheState} */
    this.state = { models: null, etag: null, fetchedAt: null, stale: false, lastError: null };
  }

  /** Is the cached catalog within its TTL? */
  isFresh() {
    if (this.state.models == null || this.state.fetchedAt == null) return false;
    return this._now() - this.state.fetchedAt <= this.ttlMs;
  }

  /** Headers to send on a conditional GET (If-None-Match) when we have an etag. */
  conditionalHeaders() {
    return this.state.etag ? { 'if-none-match': this.state.etag } : {};
  }

  /**
   * Record a successful fresh fetch (HTTP 200 with a new body).
   * @param {Array<object>} models normalized models
   * @param {string|null} [etag]
   */
  recordFresh(models, etag = null) {
    this.state = {
      models,
      etag,
      fetchedAt: this._now(),
      stale: false,
      lastError: null,
    };
  }

  /**
   * Record a 304 Not Modified: the last-known-good is still current; refresh TTL.
   */
  recordNotModified() {
    if (this.state.models == null) return; // nothing to refresh
    this.state.fetchedAt = this._now();
    this.state.stale = false;
    this.state.lastError = null;
  }

  /**
   * Record a discovery FAILURE. Keep serving the last-known-good catalog but mark
   * it stale with a sanitized reason. Never drops to an empty/Default picker.
   * @param {string} reason sanitized (no secrets)
   */
  recordFailure(reason) {
    this.state.stale = true;
    this.state.lastError = String(reason || 'discovery failed');
  }

  /**
   * The catalog to serve right now, with an explicit stale flag so the UI can
   * mark it rather than silently degrade.
   * @returns {{models:Array<object>, stale:boolean, reason:string|null, fetchedAt:number|null}}
   */
  serve() {
    const stale = this.state.stale || !this.isFresh();
    return {
      models: this.state.models || [],
      stale: this.state.models == null ? false : stale, // no data yet != stale
      reason: this.state.lastError,
      fetchedAt: this.state.fetchedAt,
    };
  }

  /** Whether we have ever successfully loaded a catalog. */
  hasData() {
    return this.state.models != null;
  }
}
