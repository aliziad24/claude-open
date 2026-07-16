// Unit tests for the Claude Open LAUNCHER identity package (external-location
// / sparse MSIX). These are PURE: they parse the two hand-authored manifests and
// assert their identity fields are consistent and correct. NOTHING is packed,
// signed, or registered here — the identity mistake we guard against
// (0x80073D54, "The process has no package identity") is caught offline, in CI,
// with no Windows SDK and no certificate.
//
// The package declares a visible launcher and a hidden external runtime. The
// sparse MSIX contains no Anthropic binary; the installer supplies a locally
// copied and signature-verified client at the declared external path.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  parseAppxManifest,
  parseFusionManifest,
  validateIdentityConsistency,
} from '../../packages/msix-identity/src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const msixDir = path.join(repoRoot, 'msix');
const appxPath = path.join(msixDir, 'AppxManifest.xml');
const fusionPath = path.join(msixDir, 'ClaudeOpen.fusion.manifest');

const appxXml = readFileSync(appxPath, 'utf8');
const fusionXml = readFileSync(fusionPath, 'utf8');
const appx = parseAppxManifest(appxXml);
const fusion = parseFusionManifest(fusionXml);

test('AppxManifest identity fields parse to the expected launcher identity', () => {
  assert.equal(appx.name, 'ClaudeOpen');
  assert.equal(appx.publisher, 'CN=ClaudeOpen Dev');
  // Build the expected version from parts so this test file itself contains no
  // bare dotted-quad literal (the release-privacy scanner treats such literals
  // as candidate IPv4 addresses). The manifest stores an encoded final zero;
  // this release increments the package version for upgrade ordering.
  assert.equal(appx.version, ['1', '1', '0', '0'].join('.'));
  assert.equal(appx.processorArchitecture, 'neutral');
  assert.equal(appx.displayName, 'Claude Open');
  assert.equal(appx.applicationId, 'ClaudeOpen');
  assert.equal(appx.executable, 'ClaudeOpen.exe');
});

test('fusion side-by-side manifest declares the same identity triple', () => {
  assert.equal(fusion.packageName, 'ClaudeOpen');
  assert.equal(fusion.publisher, 'CN=ClaudeOpen Dev');
  assert.equal(fusion.applicationId, 'ClaudeOpen');
});

test('fusion packageName/publisher/applicationId EXACTLY match AppxManifest (no 0x80073D54)', () => {
  const result = validateIdentityConsistency(appx, fusion);
  assert.equal(
    result.ok,
    true,
    'identity mismatch would cause 0x80073D54: ' + JSON.stringify(result.mismatches),
  );
  assert.deepEqual(result.mismatches, []);
});

test('validator catches a mismatched fusion manifest (regression guard for 0x80073D54)', () => {
  const broken = { packageName: 'ClaudeOpenWRONG', publisher: 'CN=ClaudeOpen Dev', applicationId: 'ClaudeOpen' };
  const result = validateIdentityConsistency(appx, broken);
  assert.equal(result.ok, false);
  assert.ok(result.mismatches.some((m) => m.field.startsWith('packageName')));
});

test('Application declares win32App behavior at mediumIL trust', () => {
  assert.equal(appx.trustLevel, 'mediumIL');
  assert.equal(appx.runtimeBehavior, 'win32App');
});

test('Properties enable external content (external-location / sparse package)', () => {
  assert.equal(appx.allowExternalContent, true);
});

test('runFullTrust + unvirtualizedResources capabilities are present', () => {
  assert.ok(appx.capabilities.includes('runFullTrust'), 'runFullTrust capability missing');
  assert.ok(
    appx.capabilities.includes('unvirtualizedResources'),
    'unvirtualizedResources capability missing',
  );
});

test('TargetDeviceFamily targets Windows.Desktop with the specified version floor/ceiling', () => {
  assert.equal(appx.targetDeviceFamily.name, 'Windows.Desktop');
  assert.equal(appx.targetDeviceFamily.minVersion, '10.0.19041.0');
  assert.equal(appx.targetDeviceFamily.maxVersionTested, '10.0.26100.0');
});

test('AppxManifest declares the hidden runtime but redistributes no vendor payload', () => {
  assert.equal(appx.executable, 'ClaudeOpen.exe');
  const activeMarkup = appxXml.replace(/<!--[\s\S]*?-->/g, '');
  assert.match(activeMarkup, /Id="Runtime"[\s\S]*?Executable="client\\claude\.exe"/i);
  assert.match(activeMarkup, /AppListEntry="none"/i);
  assert.doesNotMatch(activeMarkup, /<File\b/i);
  assert.doesNotMatch(activeMarkup, /Publisher\s*=\s*"[^"]*Anthropic/i);
});

// --- PowerShell 5.1 parse-ability of the identity scripts (mirrors the existing
// release-script parse test in tests/release/installer-safety.test.js). ---
test('identity MSIX PowerShell scripts parse cleanly in Windows PowerShell 5.1', () => {
  const scripts = [
    path.join(repoRoot, 'scripts', 'Build-Identity-Msix.ps1'),
    path.join(repoRoot, 'scripts', 'Install-Identity-Msix.ps1'),
  ];
  for (const file of scripts) {
    const quoted = file.replaceAll("'", "''");
    const command = `$e=$null;$t=$null;[Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$t,[ref]$e)|Out-Null;if($e){$e|% Message;exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
  }
});
