// FIX 1(a) + FIX 1(c) source guards for apps/launcher/ClaudeOpen.cs.
//
// These are lightweight structural assertions over the launcher source (the C#
// behaviour itself is exercised by LauncherSmokeTest via csc). They pin the
// ordering + no-loopback-reliance invariants so a future edit cannot silently
// regress them:
//   1. LaunchClaudeClient writes the 3P config (WriteThirdPartyConfig) BEFORE it
//      starts the client process (Process.Start of the client psi).
//   2. The 3P config base-url is built from the live activePort, never a literal.
//   3. The launch path does NOT register a loopback exemption (the client is
//      full-trust and reaches 127.0.0.1 without one; registering would mutate the
//      shared normal-Claude package registry).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(join(repoRoot, 'apps', 'launcher', 'ClaudeOpen.cs'), 'utf8');

// Extract the body of a method by brace-matching from its signature.
function methodBody(src, signatureMarker) {
  const start = src.indexOf(signatureMarker);
  assert.ok(start >= 0, `method not found: ${signatureMarker}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${signatureMarker}`);
}

test('WriteThirdPartyConfig is called before packaged runtime activation', () => {
  const body = methodBody(source, 'private bool LaunchClaudeClient(');
  const writeIdx = body.indexOf('WriteThirdPartyConfig(');
  const startIdx = body.indexOf('clientProcess = ActivatePackagedRuntime(');
  assert.ok(writeIdx >= 0, 'WriteThirdPartyConfig invoked in LaunchClaudeClient');
  assert.ok(startIdx >= 0, 'packaged runtime activation present in LaunchClaudeClient');
  assert.ok(writeIdx < startIdx, 'config must be written BEFORE the client launches');
});

test('the 3P config base-url is built from the live activePort (no fixed literal)', () => {
  const body = methodBody(source, 'internal static List<string> BuildWrite3pArgs(');
  assert.ok(
    body.includes('"http://127.0.0.1:" + activePort'),
    'base-url must interpolate the live activePort',
  );
  // No retired fixed port literal anywhere in the builder.
  assert.ok(!/\b8788\b/.test(body), 'no retired 8788 literal in the argv builder');
});

test('BuildWrite3pArgs always emits --assign-family-tiers and --unhealthy', () => {
  const body = methodBody(source, 'internal static List<string> BuildWrite3pArgs(');
  assert.ok(body.includes('"--assign-family-tiers"'), 'family-tier flag always written');
  assert.ok(body.includes('"--unhealthy"'), 'unhealthy flag always written');
  assert.ok(body.includes('"--model-discovery"'), 'native discovery flag always written');
});

test('the launch path does not register a loopback exemption', () => {
  const body = methodBody(source, 'private bool LaunchClaudeClient(');
  assert.ok(
    !body.includes('EnsureLoopbackExemption('),
    'full-trust client must not rely on / register a loopback exemption',
  );
});

// FIX #5: StopProcesses must not rely solely on the tracked clientProcess handle.
// MSIX/Electron activation can return a short-lived wrapper whose PID exits while
// the real client keeps running under a different PID. Stop must therefore also
// resolve and terminate the actual client scoped to OUR isolated profile, so it
// never (a) leaves the real client running or (b) kills normal Claude.
test('StopProcesses resolves the real client by isolated profile, not just the tracked PID', () => {
  const body = methodBody(source, 'private void StopProcesses(');
  assert.ok(
    body.includes('KillClientByProfile('),
    'StopProcesses must call KillClientByProfile to terminate the real profile-scoped client',
  );
});

test('KillClientByProfile is profile-scoped so it never kills normal Claude', () => {
  const body = methodBody(source, 'private void KillClientByProfile(');
  // Must match on our isolated profile path (so normal Claude, which uses a
  // different user-data dir, is never targeted).
  assert.ok(body.includes('profilePath'), 'must scope termination to our profilePath');
  // Must look at process command line / environment (WMI Win32_Process) to find
  // the child, not just an image-name match (which would also hit normal Claude).
  assert.ok(
    /CommandLine|Win32_Process|CLAUDE_USER_DATA_DIR/.test(body),
    'must scope by command line / user-data dir, not bare image name',
  );
});
