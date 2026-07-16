#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [string]$ObservationRoot,
  [switch]$FixtureMode,
  [switch]$LiveSafeProbe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }
$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
New-Item -ItemType Directory -Path $runPath -Force | Out-Null

if ($LiveSafeProbe) {
  if ($FixtureMode -or $ObservationRoot) { throw 'LiveSafeProbe cannot be combined with FixtureMode or ObservationRoot.' }
  & (Join-Path $PSScriptRoot 'Invoke-CorrectivePhase0LiveProbe.ps1') -RunPath $runPath
  $ObservationRoot = Join-Path $runPath 'observations'
}

function Invoke-TextCommand {
  param([string]$File, [string[]]$Arguments)
  try {
    $output = & $File @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
  } catch { return $null }
}

function Get-Sha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Protect-Text {
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $null }
  $text = $Value.ToString()
  $text = [regex]::Replace($text, '(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+', '$1[REDACTED]')
  $text = [regex]::Replace($text, '(?i)((?:api[-_ ]?key|secret|token|credential|password)\s*[:=]\s*)[^\s,;]+', '$1[REDACTED]')
  $text = [regex]::Replace($text, '(?i)(conversation\s*:\s*)[^\r\n]+', '$1[REDACTED]')
  $text = [regex]::Replace($text, '(?i)sk-ant-[A-Za-z0-9_-]{12,}', '[REDACTED]')
  if ($env:USERPROFILE) { $text = $text.Replace($env:USERPROFILE, '%USERPROFILE%') }
  return $text
}

function New-NotRunObservation {
  param([string]$Id, [string]$Reason)
  return [ordered]@{
    id = $Id
    status = 'NOT RUN'
    observed = $false
    actual = $null
    reason = $Reason
    evidence = $null
  }
}

function Read-ObservationFile {
  param([string]$Id)
  if (-not $ObservationRoot) { return $null }
  $candidate = Join-Path $ObservationRoot ($Id + '.json')
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
  try {
    $inputObject = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
    if ($inputObject.id -ne $Id -or $inputObject.observed -ne $true) { return $null }
    return [ordered]@{
      id = $Id
      status = 'OBSERVED'
      observed = $true
      actual = Protect-Text $inputObject.actual
      reason = $null
      evidence = 'provided sanitized observation'
    }
  } catch { return $null }
}

function Get-SourceFacts {
  $commit = Invoke-TextCommand 'git' @('-C', $repositoryRoot, 'rev-parse', 'HEAD')
  $status = Invoke-TextCommand 'git' @('-C', $repositoryRoot, 'status', '--short')
  if (-not $commit) { $commit = 'NOT DISCOVERED' }
  if ($null -eq $status) { $status = 'NOT DISCOVERED' }
  $pathsText = Invoke-TextCommand 'git' @('-C', $repositoryRoot, 'ls-files', '--cached', '--others', '--exclude-standard')
  $entries = @()
  if ($pathsText) {
    foreach ($relativePath in @($pathsText -split "`n" | Sort-Object)) {
      if (-not $relativePath) { continue }
      $fullPath = Join-Path $repositoryRoot ($relativePath.Replace('/', '\'))
      if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        $entries += ($relativePath.Replace('\', '/') + "`t" + (Get-Sha256 $fullPath))
      }
    }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
    $sourceHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  return [ordered]@{
    commit = $commit
    status = Protect-Text $status
    sourceHash = $sourceHash
    sourceHashAlgorithm = 'SHA-256 file manifest'
    sourceFileCount = $entries.Count
  }
}

function Get-BuildFacts {
  $candidates = @(
    (Join-Path $repositoryRoot 'release-manifest.json'),
    (Join-Path $repositoryRoot 'dist\release-manifest.json'),
    (Join-Path $repositoryRoot 'apps\launcher\ClaudeOpen.exe')
  )
  $found = @()
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $found += [ordered]@{ name = Split-Path $candidate -Leaf; sha256 = Get-Sha256 $candidate }
    }
  }
  return [ordered]@{
    discoveryStatus = $(if ($found.Count -gt 0) { 'DISCOVERED' } else { 'NOT DISCOVERED' })
    artifacts = @($found)
  }
}

function Get-SystemFacts {
  $osBuild = [Environment]::OSVersion.Version.ToString()
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $osBuild = $os.Version + ' build ' + $os.BuildNumber
  } catch { }
  $dpi = 96
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap 1, 1
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $dpi = [int][Math]::Round($graphics.DpiX)
    $graphics.Dispose()
    $bitmap.Dispose()
  } catch { }
  return [ordered]@{ osBuild = $osBuild; architecture = $env:PROCESSOR_ARCHITECTURE; dpi = $dpi }
}

function Get-ClaudeFacts {
  $result = [ordered]@{
    discoveryStatus = 'NOT DISCOVERED'
    packageName = $null
    packageFullName = $null
    packageFamilyName = $null
    packageVersion = $null
    packageIdentityName = $null
    aumids = @()
    executablePath = $null
    executableVersion = $null
    sha256 = $null
    authenticodeStatus = $null
    signer = $null
  }
  try {
    $packages = @(Get-AppxPackage -ErrorAction Stop | Where-Object {
      $_.Name -match 'Claude' -or $_.PackageFamilyName -match 'Claude|pzs8sxrjxfjjc'
    } | Sort-Object Version -Descending)
    if ($packages.Count -eq 0) { return $result }
    $package = $packages[0]
    $result.discoveryStatus = 'DISCOVERED'
    $result.packageName = $package.Name
    $result.packageFullName = $package.PackageFullName
    $result.packageFamilyName = $package.PackageFamilyName
    $result.packageVersion = $package.Version.ToString()
    $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
    if (Test-Path -LiteralPath $manifestPath) {
      [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
      $result.packageIdentityName = $manifest.Package.Identity.Name
      $aumids = @()
      foreach ($application in @($manifest.Package.Applications.Application)) {
        if ($application.Id) { $aumids += ($package.PackageFamilyName + '!' + $application.Id) }
      }
      $result.aumids = @($aumids)
    }
    $executables = @(Get-ChildItem -LiteralPath $package.InstallLocation -Filter 'claude.exe' -File -Recurse -ErrorAction SilentlyContinue)
    if ($executables.Count -gt 0) {
      $executable = $executables[0]
      $result.executablePath = Protect-Text $executable.FullName
      $result.executableVersion = $executable.VersionInfo.FileVersion
      $result.sha256 = Get-Sha256 $executable.FullName
      $signature = Get-AuthenticodeSignature -LiteralPath $executable.FullName
      $result.authenticodeStatus = $signature.Status.ToString()
      if ($signature.SignerCertificate) { $result.signer = $signature.SignerCertificate.Subject }
    }
  } catch {
    $result.discoveryStatus = 'NOT DISCOVERED: ' + (Protect-Text $_.Exception.Message)
  }
  return $result
}

function Find-RuntimeFile {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'ClaudeOpen\runtime\runtime.json') }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'ClaudeOpen\User Data\runtime\runtime.json') }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return $null
}

function Get-AutomaticObservation {
  param([string]$Id)
  switch ($Id) {
    'healthy-adapter-38-chat-models' {
      $runtimeFile = Find-RuntimeFile
      if (-not $runtimeFile) { return New-NotRunObservation $Id 'No Claude Open runtime record was found; the runner did not start the adapter because that could consume gateway traffic.' }
      try {
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        $headers = @{ Authorization = 'Bearer ' + $runtime.clientToken }
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtime.port + '/health/deep') -Headers $headers -TimeoutSec 120
        $models = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtime.port + '/v1/models') -Headers $headers -TimeoutSec 30
        $count = @($models.data).Count
        if ($health.healthy -eq $true -and $count -eq 38) {
          return [ordered]@{ id = $Id; status = 'OBSERVED'; observed = $true; actual = 'Deep health was healthy and /v1/models returned exactly 38 chat models.'; reason = $null; evidence = 'live loopback query; credentials and model IDs omitted' }
        }
        return New-NotRunObservation $Id ('Live adapter did not match the baseline: healthy=' + $health.healthy + ', chatModelCount=' + $count + '.')
      } catch { return New-NotRunObservation $Id ('Live adapter query failed: ' + (Protect-Text $_.Exception.Message)) }
    }
    'light-control-center' {
      # Phase 7 fix: the Control Center now ships one coherent Claude-dark theme
      # (main bg #262624 = ClaudeCream => Color.FromArgb(38, 38, 36)), so the
      # original light/cream failure is no longer reproducible by source
      # inspection. Detect the dark palette and honestly report that the failure
      # is fixed rather than falsely re-observing a light UI that no longer exists.
      $source = Join-Path $repositoryRoot 'apps\launcher\ClaudeOpen.cs'
      if (Test-Path -LiteralPath $source) {
        $text = Get-Content -LiteralPath $source -Raw
        if ($text -match 'ClaudeCream = Color\.FromArgb\(38, 38, 36\)') {
          return New-NotRunObservation $Id 'The light Control Center failure is fixed: the launcher now defines the Claude-dark palette (ClaudeCream = #262624) and paints dark on first paint. This baseline failure is no longer reproducible.'
        }
        if ($text -match 'this\.BackColor = ClaudeCream' -and $text -match 'ClaudeCream = Color\.FromArgb\(247, 246, 242\)') {
          return [ordered]@{ id = $Id; status = 'OBSERVED'; observed = $true; actual = 'Source inspection found the Control Center applies a light cream ClaudeCream background.'; reason = $null; evidence = 'apps/launcher/ClaudeOpen.cs static inspection; no UI launch' }
        }
      }
      return New-NotRunObservation $Id 'The light Control Center markers were not found and no UI was launched.'
    }
    'stale-runtime-record' {
      $runtimeFile = Find-RuntimeFile
      if (-not $runtimeFile) { return New-NotRunObservation $Id 'No runtime.json exists, so a stale live record could not be observed without creating or modifying runtime state.' }
      try {
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
        if ($null -eq $process) {
          return [ordered]@{ id = $Id; status = 'OBSERVED'; observed = $true; actual = 'runtime.json names a PID that is not running.'; reason = $null; evidence = 'read-only PID comparison; paths and tokens omitted' }
        }
        return New-NotRunObservation $Id 'runtime.json currently names a running PID; safe read-only inspection did not reproduce a stale or reused PID.'
      } catch { return New-NotRunObservation $Id ('runtime.json could not be evaluated safely: ' + (Protect-Text $_.Exception.Message)) }
    }
    default {
      return New-NotRunObservation $Id 'No safe observation source was found; reproducing this failure requires launching or inspecting a copied Claude profile, which this runner will not do automatically.'
    }
  }
}

$observationIds = @(
  'healthy-adapter-38-chat-models',
  'client-1p-onboarding',
  'zero-adapter-message-traffic',
  'light-control-center',
  'stale-runtime-record',
  'copied-client-cowork-baseline'
)

$observations = @()
foreach ($id in $observationIds) {
  $observation = Read-ObservationFile $id
  if ($null -eq $observation) {
    if ($FixtureMode) {
      $observation = New-NotRunObservation $id 'No safe observation source was found in the supplied fixture observation root.'
    } else {
      $observation = Get-AutomaticObservation $id
    }
  }
  $observations += $observation
}

$nonPass = @($observations | Where-Object { $_.status -ne 'OBSERVED' })
$p0Status = if ($nonPass.Count -eq 0) { 'PASS' } else { 'FAIL' }
$p0Reason = if ($nonPass.Count -eq 0) {
  'All six required Phase 0 baseline observations were captured and sanitized (five audited failures reproduced; the copied-client Cowork row is a neutral baseline with functional Cowork gated to P0.1/P0.7).'
} else {
  (($nonPass | ForEach-Object { $_.id + ': ' + $_.status + ' - ' + $_.reason }) -join '; ')
}

$run = [ordered]@{
  schemaVersion = 1
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  source = Get-SourceFacts
  build = Get-BuildFacts
  system = Get-SystemFacts
  installedClaude = Get-ClaudeFacts
  configurationBackup = [ordered]@{ status = 'NOT REQUIRED'; reason = 'Phase 0 runner is read-only and did not mutate any profile or configuration.' }
  observations = @($observations)
  p0_0 = [ordered]@{ status = $p0Status; reason = Protect-Text $p0Reason }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$runFile = Join-Path $runPath 'run.json'
[System.IO.File]::WriteAllText($runFile, ($run | ConvertTo-Json -Depth 12), $utf8NoBom)

$scanPatterns = @(
  '(?i)authorization\s*:\s*bearer\s+(?!\[REDACTED\])\S+',
  '(?i)sk-ant-[A-Za-z0-9_-]{12,}',
  '(?i)PRIVATE-CONTENT-DO-NOT-KEEP',
  '(?i)conversation\s*:\s*(?!\[REDACTED\])\S+'
)
$findings = @()
foreach ($file in @(Get-ChildItem -LiteralPath $runPath -File -ErrorAction SilentlyContinue)) {
  $content = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($pattern in $scanPatterns) {
    if ($content -match $pattern) { $findings += [ordered]@{ file = $file.Name; pattern = $pattern } }
  }
}
$scan = [ordered]@{
  status = $(if ($findings.Count -eq 0) { 'PASS' } else { 'FAIL' })
  scannedAtUtc = [DateTime]::UtcNow.ToString('o')
  remainingFindings = @($findings)
}
$scanFile = Join-Path $runPath 'redaction-scan.json'
[System.IO.File]::WriteAllText($scanFile, ($scan | ConvertTo-Json -Depth 8), $utf8NoBom)

$manifestFiles = @()
foreach ($file in @(Get-ChildItem -LiteralPath $runPath -File | Sort-Object Name)) {
  $manifestFiles += [ordered]@{ path = $file.Name; sha256 = Get-Sha256 $file.FullName; bytes = $file.Length }
}
$manifest = [ordered]@{ algorithm = 'SHA-256'; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($manifestFiles) }
[System.IO.File]::WriteAllText((Join-Path $runPath 'hash-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8NoBom)

Write-Host ('Corrective Phase 0 evidence: ' + $runPath)
Write-Host ('P0.0: ' + $p0Status)
if ($scan.status -ne 'PASS') { exit 3 }
if ($p0Status -ne 'PASS') { exit 2 }
exit 0
