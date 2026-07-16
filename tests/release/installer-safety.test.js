import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const installPath = path.join(root, 'installer', 'Install-ClaudeOpen.ps1');
const uninstallPath = path.join(root, 'installer', 'Uninstall-ClaudeOpen.ps1');
const buildPath = path.join(root, 'scripts', 'Build-Release.ps1');

test('release PowerShell scripts parse cleanly', () => {
  for (const file of [installPath, uninstallPath, buildPath]) {
    const quoted = file.replaceAll("'", "''");
    const command = `$e=$null;$t=$null;[Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$t,[ref]$e)|Out-Null;if($e){$e|% Message;exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
  }
});

test('installer verifies owned payload, official signature, and records truthful Cowork state', async () => {
  const source = await readFile(installPath, 'utf8');
  assert.match(source, /Assert-ReleaseManifest/);
  assert.match(source, /Refusing to replace a directory that is not marked as a Claude Open installation/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /SignerCertificate\.Subject -notmatch 'Anthropic'/);
  assert.match(source, /functionalCoworkTest = 'not-run'/);
  assert.match(source, /VirtualMachinePlatform/);
  assert.match(source, /HypervisorPresent/);
  assert.match(source, /CoworkVMService/);
  assert.match(source, /cloud-only account, sync, Dispatch, or plan services/);
  assert.doesNotMatch(source, /private-gateway\.invalid|[A-Z]:\\Programs\\/i);
  assert.doesNotMatch(source, /Register-ScheduledTask|schtasks(?:\.exe)?/i);
  assert.doesNotMatch(source, /\[unchecked\]/);
});

test('uninstaller requires its exact marker and never removes official Claude', async () => {
  const source = await readFile(uninstallPath, 'utf8');
  assert.match(source, /\.claude-open-install\.json/);
  assert.match(source, /productId -ne 'ClaudeOpen\.Windows'/);
  assert.match(source, /Get-AppxPackage -Name ClaudeOpen/);
  assert.match(source, /Remove-AppxPackage/);
  assert.doesNotMatch(source, /Get-AppxPackage -Name Claude(?:\s|['"])/);
  assert.doesNotMatch(source, /winget[^\r\n]*uninstall|Anthropic\.Claude/);
  assert.match(source, /cmdkey\.exe '\/delete:ClaudeOpen\/gateway\/current'/);
  assert.match(source, /official Claude package and normal Claude user data were not changed/);
});

test('release manifest and test-client provenance are written without a BOM', async () => {
  const source = await readFile(buildPath, 'utf8');
  assert.match(source, /Text\.UTF8Encoding\(\$false\)/);
  assert.match(source, /official-package\.json/);
  assert.match(source, /functionalCoworkTest = 'not-run'/);
});

// FIX #4a: upgrading the SHARED official Claude package must be OPT-IN, not the
// default. A fork installer must not silently mutate the user's normal Claude.
test('installer does not upgrade shared official Claude by default (opt-in only)', async () => {
  const source = await readFile(installPath, 'utf8');
  // There must be an explicit opt-in switch to update official Claude.
  assert.match(source, /\[switch\]\$UpdateOfficialClaude/, 'must expose an opt-in -UpdateOfficialClaude switch');
  // The upgrade action must be gated on that opt-in being present (not merely the
  // absence of a do-not-update flag).
  assert.match(source, /if\s*\(\s*\$UpdateOfficialClaude\s*\)/, 'winget upgrade must be gated on the opt-in switch');
});

// FIX #4b: the prior install backup must be verified-before-delete. The new
// install must pass a post-swap check before the previous backup is removed, so a
// failed swap always leaves a working rollback.
test('installer verifies the swapped-in install before deleting the prior backup', async () => {
  const source = await readFile(installPath, 'utf8');
  // A post-swap verification of the new target must exist and precede Remove-Item $backup.
  const swapIdx = source.indexOf('Move-Item -LiteralPath $staging -Destination $target');
  const removeIdx = source.indexOf('Remove-Item -LiteralPath $backup');
  assert.ok(swapIdx > 0 && removeIdx > swapIdx, 'expected swap then backup removal order');
  const between = source.slice(swapIdx, removeIdx);
  assert.match(between, /Assert-InstalledTarget|post-swap|verify/i,
    'a post-swap verification must run before the prior backup is deleted');
});

// FIX #1: the installer MUST copy scripts/ (containing write-3p-config.mjs, needed
// by the launcher for every 3P activation) AND msix/ (containing ClaudeOpen.msix,
// AppxManifest.xml, logos -- needed by the identity registration step at line ~298).
// Prior installer omitted both, so packaged installs failed at first launch with
// "Producer Missing" and silently skipped identity registration.
test('installer copies scripts/ and msix/ into the install target', async () => {
  const source = await readFile(installPath, 'utf8');
  // The required-payload guard (line ~168) must include scripts + msix so a missing
  // release payload is caught before staging begins.
  const payloadListMatch = source.match(/foreach \(\$name in @\(([^)]+)\)\) \{\s*if \(-not \(Test-Path[^}]+throw "Release payload is missing/);
  assert.ok(payloadListMatch, 'required-payload guard block not found');
  assert.match(payloadListMatch[1], /'scripts'/, 'required-payload guard must include scripts');
  assert.match(payloadListMatch[1], /'msix'/, 'required-payload guard must include msix');
  // The staging copy loop (line ~216) must also copy scripts + msix into $staging so
  // they end up in $target after the atomic swap.
  const copyListMatch = source.match(/foreach \(\$name in @\(([^)]+)\)\) \{\s*Copy-Item[^}]+Destination \$staging/);
  assert.ok(copyListMatch, 'staging copy loop not found');
  assert.match(copyListMatch[1], /'scripts'/, 'staging copy loop must include scripts');
  assert.match(copyListMatch[1], /'msix'/, 'staging copy loop must include msix');
});
