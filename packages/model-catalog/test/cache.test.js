import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogCache } from '../src/cache.js';

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('serve() with no data yet is not marked stale', () => {
  const c = new CatalogCache();
  const s = c.serve();
  assert.deepEqual(s.models, []);
  assert.equal(s.stale, false);
  assert.equal(c.hasData(), false);
});

test('recordFresh stores models and is fresh within TTL', () => {
  const clk = fakeClock();
  const c = new CatalogCache({ ttlMs: 1000, now: clk.now });
  c.recordFresh([{ realId: 'a' }], 'etag-1');
  assert.equal(c.isFresh(), true);
  assert.equal(c.serve().stale, false);
  assert.equal(c.serve().models.length, 1);
});

test('conditionalHeaders emits If-None-Match once we have an etag', () => {
  const c = new CatalogCache();
  assert.deepEqual(c.conditionalHeaders(), {});
  c.recordFresh([{ realId: 'a' }], 'W/"abc"');
  assert.deepEqual(c.conditionalHeaders(), { 'if-none-match': 'W/"abc"' });
});

test('past TTL the last-known-good is served but marked stale', () => {
  const clk = fakeClock();
  const c = new CatalogCache({ ttlMs: 1000, now: clk.now });
  c.recordFresh([{ realId: 'a' }], 'e');
  clk.advance(1500);
  const s = c.serve();
  assert.equal(s.models.length, 1, 'still serves last-known-good');
  assert.equal(s.stale, true, 'marked stale, not dropped');
});

test('recordNotModified refreshes TTL without changing models', () => {
  const clk = fakeClock();
  const c = new CatalogCache({ ttlMs: 1000, now: clk.now });
  c.recordFresh([{ realId: 'a' }], 'e');
  clk.advance(1500);
  assert.equal(c.serve().stale, true);
  c.recordNotModified();
  assert.equal(c.serve().stale, false);
  assert.equal(c.serve().models.length, 1);
});

test('recordFailure keeps last-known-good and marks stale with a reason', () => {
  const c = new CatalogCache();
  c.recordFresh([{ realId: 'a' }, { realId: 'b' }], 'e');
  c.recordFailure('gateway 503 during discovery');
  const s = c.serve();
  assert.equal(s.models.length, 2, 'does not drop to empty picker');
  assert.equal(s.stale, true);
  assert.equal(s.reason, 'gateway 503 during discovery');
});

test('failure reason is a plain string (no secret leakage vector)', () => {
  const c = new CatalogCache();
  c.recordFresh([{ realId: 'a' }], 'e');
  c.recordFailure(undefined);
  assert.equal(typeof c.serve().reason, 'string');
});
