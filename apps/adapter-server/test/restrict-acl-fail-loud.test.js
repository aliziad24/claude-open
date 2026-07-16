// Security-review defect 2(d): restrictAcl() caught+suppressed ACL failures on
// runtime.json (which holds the bearer/control tokens) with an empty catch, so
// the hardening was silently fail-OPEN even though docs describe it as an
// invariant. restrictAcl is now extractable and returns a structured decision,
// and emits an observable log line for BOTH outcomes:
//   - applied  -> a verification log line stating ACL was applied
//   - failed   -> a clear WARNING naming the file path (does not crash)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restrictAcl } from '../src/main.js';

test('restrictAcl is a no-op with an explicit "skipped" decision off Windows', () => {
  const events = [];
  const result = restrictAcl('C:/whatever/runtime.json', { }, {
    platform: 'linux',
    log: (l) => events.push(l),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'not-windows');
});

test('restrictAcl respects the CLAUDE_OPEN_SKIP_ACL=1 test opt-out', () => {
  const events = [];
  const result = restrictAcl('C:/whatever/runtime.json', { CLAUDE_OPEN_SKIP_ACL: '1', USERNAME: 'me' }, {
    platform: 'win32',
    log: (l) => events.push(l),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'skipped-by-env');
});

test('restrictAcl logs a verification line stating ACL was applied on success', () => {
  const events = [];
  const result = restrictAcl('C:/runtime/runtime.json', { USERNAME: 'me' }, {
    platform: 'win32',
    // Injected exec that succeeds.
    exec: () => {},
    log: (l) => events.push(l),
  });
  assert.equal(result.applied, true);
  const applied = events.find((e) => e.evt === 'acl-applied');
  assert.ok(applied, 'success must emit an acl-applied verification line');
  assert.equal(applied.path, 'C:/runtime/runtime.json');
});

test('restrictAcl fails LOUD (warning naming the path) but does NOT throw when icacls fails', () => {
  const events = [];
  let result;
  assert.doesNotThrow(() => {
    result = restrictAcl('C:/runtime/runtime.json', { USERNAME: 'me' }, {
      platform: 'win32',
      exec: () => { throw new Error('icacls exit 1332'); },
      log: (l) => events.push(l),
    });
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'icacls-failed');
  const warn = events.find((e) => e.evt === 'warn' && /ACL/.test(e.msg));
  assert.ok(warn, 'an ACL failure must emit an observable WARNING (fail-loud, not fail-silent)');
  assert.ok(warn.msg.includes('C:/runtime/runtime.json'), 'the warning must name the unprotected file path');
});
