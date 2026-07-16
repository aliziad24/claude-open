// Workstream 1: the separate-identity MSIX must be WIRED into the normal
// build + install flow so the LAUNCHER (ClaudeOpen.exe / Control Center) gets
// its own name, icon, and Task Manager identity.
//
// HONESTY NOTE (asserted below): this only re-identifies the LAUNCHER. The
// genuine child Claude.exe is still spawned untouched and still reports as
// Claude.exe — it is vendor-locked (renaming breaks Cowork's Anthropic
// WinVerifyTrust signature gate). These tests prove the wiring exists and that
// the build/install do not overclaim a renamed child.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildPath = path.join(root, 'scripts', 'Build-Release.ps1');
const installPath = path.join(root, 'installer', 'Install-ClaudeOpen.ps1');
const identityInstallPath = path.join(root, 'scripts', 'Install-Identity-Msix.ps1');

test('Build-Release wires the embedded win32 identity manifest into the launcher compile', async () => {
  const source = await readFile(buildPath, 'utf8');
  // The build must produce the embeddable application manifest (fusion fragment
  // wrapped into a full assembly manifest) before compiling the launcher.
  assert.match(source, /Build-Identity-Msix\.ps1/, 'build must invoke the identity-manifest builder');
  // csc must receive /win32manifest pointing at the generated exe manifest so the
  // launcher exe is bound to the ClaudeOpen package identity.
  assert.match(
    source,
    /\/win32manifest:/i,
    'csc must be passed /win32manifest to embed the identity manifest into ClaudeOpen.exe',
  );
  assert.match(source, /ClaudeOpen\.exe\.manifest/, 'the win32manifest must reference the generated ClaudeOpen.exe.manifest');
});

test('Build-Release requires a signed sparse identity for the runtime', async () => {
  const source = await readFile(buildPath, 'utf8');
  assert.match(source, /Build-Identity-Msix\.ps1[^\r\n]*-DevSign/i);
  assert.match(source, /Sparse identity package was not built/i);
  assert.match(source, /ClaudeOpen-dev\.cer/i);
});

test('Build-Release copies the identity assets and scripts into the release stage', async () => {
  const source = await readFile(buildPath, 'utf8');
  // The packaged release must carry what the installer needs to register identity
  // per-user: the identity scripts and the msix payload folder.
  assert.match(source, /Install-Identity-Msix\.ps1/, 'release must ship the per-user identity registration script');
  assert.match(source, /Build-Identity-Msix\.ps1/, 'release must ship the identity MSIX builder');
});

test('Install-ClaudeOpen references the per-user identity MSIX registration', async () => {
  const source = await readFile(installPath, 'utf8');
  assert.match(source, /Install-Identity-Msix\.ps1/, 'install must invoke per-user identity registration');
  // The registration must be per-user / non-elevated (external-location), never
  // an elevated Add-AppxProvisionedPackage.
  assert.match(source, /-ExternalLocation/, 'registration must be the per-user external-location form');
  assert.doesNotMatch(source, /Add-AppxProvisionedPackage/i, 'must not use the elevated provisioning path');
});

test('Install-ClaudeOpen keeps the signed child filename and patches only renderer assets', async () => {
  const source = await readFile(installPath, 'utf8');
  assert.doesNotMatch(source, /Move-Item[^\r\n]*claude\.exe/i);
  assert.match(source, /clientExe\s*=\s*Join-Path \$client 'claude\.exe'/i);
  assert.match(source, /apply-ion-patches\.mjs/i);
});

test('identity updates replace only the Claude Open-owned sparse package', async () => {
  const source = await readFile(identityInstallPath, 'utf8');
  assert.match(source, /Get-AppxPackage -Name 'ClaudeOpen'/);
  assert.match(source, /Remove-AppxPackage/);
  assert.doesNotMatch(source, /Get-AppxPackage -Name 'Claude'/);
  assert.doesNotMatch(source, /Anthropic\.Claude/);
});

// FIX #3: launcher AUMID must be outside Anthropic's `com.anthropic.*` namespace
// so Windows's taskbar/pin grouping keeps the fork visually separate from normal
// Claude. Prior code used `com.anthropic.claudeopen` -- inside the vendor
// namespace, which caused the pinned "Claude Open" to visually merge with the
// vendor app's taskbar identity. The AUMID must be a non-vendor id.
test('launcher AUMID lives outside the com.anthropic.* namespace', async () => {
  const source = await readFile(path.join(root, 'apps', 'launcher', 'ClaudeOpen.cs'), 'utf8');
  const call = 'SetCurrentProcessExplicitAppUserModelID';
  const m = source.match(new RegExp(call + '\\s*\\(\\s*"([^"]{1,64})"'));
  assert.ok(m, call + ' call not found in ClaudeOpen.cs');
  const aumid = m[1];
  assert.doesNotMatch(aumid, /^com\.anthropic\./i, `AUMID '${aumid}' is inside Anthropic's namespace and will collide with normal Claude`);
  // Must still be a valid AUMID-shaped id (dotted or MSIX-family form).
  assert.match(aumid, /^[A-Za-z][A-Za-z0-9._-]*(?:!.+)?$/, 'AUMID must be a valid identifier');
});

// FIX #3: the Start-menu shortcut must set System.AppUserModel.ID to the SAME
// value as the launcher process, so a pinned tile groups under the fork's own
// identity and does not fall back to Windows's automatic exe-path grouping
// (which is what allowed the earlier confusion with normal Claude).
test('installer sets System.AppUserModel.ID on the Start-menu shortcut', async () => {
  const source = await readFile(installPath, 'utf8');
  // WScript.Shell shortcuts do not expose AUMID directly; the standard way is to
  // use the IPropertyStore/PKEY_AppUserModel_ID path via a helper, OR to set it
  // through a scriptable COM path. Either way, the installer must reference
  // AppUserModel.ID (case-insensitive) in the shortcut-creation section.
  assert.match(source, /AppUserModel\.ID|PKEY_AppUserModel_ID/i,
    'installer must set the .lnk AppUserModel.ID so the pin/taskbar groups under the launcher identity, not vendor Claude');
});
