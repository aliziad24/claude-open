// Unit tests for the pure loopback-exemption helpers used by the Control Center
// launch path and the installer before launching the genuine WindowsApps client.
//
// CONFIRMED ROOT CAUSE: the genuine WindowsApps Claude client (package family
// Claude_pzs8sxrjxfjjc) runs in an AppContainer sandbox that BLOCKS loopback
// (127.0.0.1) connections to our adapter unless a loopback exemption is
// registered for the package. `CheckNetIsolation LoopbackExempt -s` shows no
// Claude entry, so the client's 3P fetch to the adapter times out.
//
// These helpers are PURE and never require elevation. They only:
//   1. parse captured `CheckNetIsolation LoopbackExempt -s` output and decide
//      whether a given package family name is already exempt, and
//   2. build the exact `CheckNetIsolation LoopbackExempt -a -n=<family>` add
//      argument string used to register a missing exemption.
// The captured sample output below mirrors the real tool's format; no live
// registration and no elevation happen in these tests.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isFamilyLoopbackExempt,
  buildLoopbackExemptAddArgs,
} from '../../packages/identity-harness/src/index.js';

// Real `CheckNetIsolation LoopbackExempt -s` output when NO app container is
// exempted (the state that causes the Claude client's loopback timeout).
const EMPTY_OUTPUT = `
List Loopback Exempted AppContainers 

OK.
`;

// Real output shape with several exempted entries. The `Name:` line carries the
// package family name for entries added by `-n=<family>`; other entries may show
// an AppContainer moniker. The exact family we care about is present here.
const OUTPUT_WITH_CLAUDE = `
List Loopback Exempted AppContainers 

[1] -----------------------------------------------------------------
    Name: microsoft.windowscommunicationsapps_8wekyb3d8bbwe
    SID:  s-1-15-2-1000000000-2000000000-3000000000-4000000000-5000000000-6000000000-7000000000

[2] -----------------------------------------------------------------
    Name: Claude_pzs8sxrjxfjjc
    SID:  s-1-15-2-1111111111-2222222222-3333333333-4444444444-5555555555-6666666666-7777777777

OK.
`;

// Output with entries present but NOT the Claude family (missing -> must add).
const OUTPUT_WITHOUT_CLAUDE = `
List Loopback Exempted AppContainers 

[1] -----------------------------------------------------------------
    Name: microsoft.windowscommunicationsapps_8wekyb3d8bbwe
    SID:  s-1-15-2-1000000000-2000000000-3000000000-4000000000-5000000000-6000000000-7000000000

OK.
`;

const CLAUDE_FAMILY = 'Claude_pzs8sxrjxfjjc';

test('isFamilyLoopbackExempt: reports absent for empty tool output', () => {
  assert.equal(isFamilyLoopbackExempt(EMPTY_OUTPUT, CLAUDE_FAMILY), false);
});

test('isFamilyLoopbackExempt: reports present when the family Name line is listed', () => {
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, CLAUDE_FAMILY), true);
});

test('isFamilyLoopbackExempt: reports absent when other entries exist but not the family', () => {
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITHOUT_CLAUDE, CLAUDE_FAMILY), false);
});

test('isFamilyLoopbackExempt: match is case-insensitive on the family name', () => {
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, 'claude_PZS8SXRJXFJJC'), true);
});

test('isFamilyLoopbackExempt: does not match on a substring/prefix collision', () => {
  // A different family whose name merely starts with "Claude" must NOT count as
  // the exempt Claude family. Whole-token equality only.
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, 'Claude'), false);
  assert.equal(
    isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, 'Claude_pzs8sxrjxfjjcX'),
    false,
  );
});

test('isFamilyLoopbackExempt: tolerates surrounding whitespace / CRLF line endings', () => {
  const crlf = OUTPUT_WITH_CLAUDE.replace(/\n/g, '\r\n');
  assert.equal(isFamilyLoopbackExempt(crlf, CLAUDE_FAMILY), true);
});

test('isFamilyLoopbackExempt: null / empty inputs are treated as absent, never throw', () => {
  assert.equal(isFamilyLoopbackExempt(null, CLAUDE_FAMILY), false);
  assert.equal(isFamilyLoopbackExempt('', CLAUDE_FAMILY), false);
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, ''), false);
  assert.equal(isFamilyLoopbackExempt(OUTPUT_WITH_CLAUDE, null), false);
});

test('buildLoopbackExemptAddArgs: builds the exact -a -n=<family> argument list', () => {
  assert.deepEqual(buildLoopbackExemptAddArgs(CLAUDE_FAMILY), [
    'LoopbackExempt',
    '-a',
    `-n=${CLAUDE_FAMILY}`,
  ]);
});

test('buildLoopbackExemptAddArgs: trims incidental whitespace around the family name', () => {
  assert.deepEqual(buildLoopbackExemptAddArgs(`  ${CLAUDE_FAMILY}  `), [
    'LoopbackExempt',
    '-a',
    `-n=${CLAUDE_FAMILY}`,
  ]);
});

test('buildLoopbackExemptAddArgs: rejects empty or non-string family names', () => {
  assert.throws(() => buildLoopbackExemptAddArgs(''), /family name/i);
  assert.throws(() => buildLoopbackExemptAddArgs('   '), /family name/i);
  assert.throws(() => buildLoopbackExemptAddArgs(null), /family name/i);
  assert.throws(() => buildLoopbackExemptAddArgs(undefined), /family name/i);
});

test('buildLoopbackExemptAddArgs: rejects a family name containing shell/arg metacharacters', () => {
  // Defence-in-depth: the family name is interpolated into a native command
  // argument, so refuse whitespace or quote/ampersand injection attempts.
  assert.throws(() => buildLoopbackExemptAddArgs('Claude foo'), /invalid/i);
  assert.throws(() => buildLoopbackExemptAddArgs('Claude&calc'), /invalid/i);
  assert.throws(() => buildLoopbackExemptAddArgs('Claude"x'), /invalid/i);
});
