#Requires -Version 5.1
<#
.SYNOPSIS
  Release-privacy verifier for Claude Open (implementation-plan section 5.3 / 10.5).

.DESCRIPTION
  Scans a directory tree (source checkout OR extracted release archive) and FAILS
  (non-zero exit) when it finds anything that must never ship publicly:

    - high-entropy tokens, bearer tokens, api keys, private keys
    - absolute developer paths and the current user name
    - email / account / org / session identifiers
    - IP addresses not in an explicit allowlist
    - vendor binaries (exe/dll/msix/asar/node) not built from this project
    - files larger than a size threshold unless allowlisted

  It NEVER prints the matched secret value; it prints file + line + a redacted
  fingerprint only. Designed to run in CI against the release archive, not only
  tracked source.

.PARAMETER Path
  Root to scan. Defaults to the repository root (parent of this script's folder).

.PARAMETER MaxFileSizeMB
  Files larger than this fail unless in the size allowlist. Default 5 MB.

.EXAMPLE
  pwsh -File scripts/verify-release.ps1
  pwsh -File scripts/verify-release.ps1 -Path .\dist\ClaudeOpen-release
#>
[CmdletBinding()]
param(
  [string]$Path,
  [double]$MaxFileSizeMB = 5.0,
  [switch]$IncludeGitHistory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $Path) {
  $Path = Split-Path -Parent $PSScriptRoot
}
$Path = (Resolve-Path -LiteralPath $Path).Path

# A built release may contain exactly two project/runtime executables. They are
# allowed only at fixed relative paths and only when their SHA-256 matches the
# build-generated manifest. Source-tree binaries and filename-only allowlists
# remain forbidden.
$releaseManifest = @{}
$manifestPath = Join-Path $Path 'release-manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
  try {
    foreach ($entry in (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json)) {
      $releaseManifest[[string]$entry.Path] = [string]$entry.SHA256
    }
  } catch { Write-Host 'WARNING: release-manifest.json is invalid; no binaries will be allowlisted.' }
}

function Test-AllowedReleaseBinary {
  param([string]$Rel,[System.IO.FileInfo]$File)
  $normalized = $Rel.Replace('/','\')
  if ($normalized -notin @('ClaudeOpen.exe','runtime\node.exe','msix\ClaudeOpen.msix','msix\ClaudeOpen-dev.cer')) { return $false }
  if (-not $releaseManifest.ContainsKey($normalized)) { return $false }
  $actual = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash
  if ($actual -ne $releaseManifest[$normalized]) { return $false }
  if ($normalized -in @('msix\ClaudeOpen.msix','msix\ClaudeOpen-dev.cer')) { return $true }
  if ($normalized -eq 'ClaudeOpen.exe' -and $File.VersionInfo.ProductName -ne 'Claude Open') { return $false }
  if ($normalized -eq 'runtime\node.exe' -and $File.VersionInfo.ProductName -notmatch 'Node') { return $false }
  return $true
}

Write-Host "== Claude Open release-privacy scan =="
Write-Host "Scanning: $Path"

# ---------------------------------------------------------------------------
# What to skip. IMPORTANT (SESSION-3 defect 2.8 / section 9): build/output and
# evidence dirs are skipped ONLY when they appear BELOW the scan root — never
# when the requested scan root IS (or is inside) such a directory. Otherwise the
# scanner would skip the exact release artifact / evidence tree it must inspect.
# We therefore match these names only when they occur strictly deeper than $Path.
# `.git` and `node_modules` are always skipped as file-walk (git history is
# handled separately by -IncludeGitHistory).
$alwaysSkipRegex = '(\\|/)(\.git|node_modules)(\\|/|$)'
$rootLower = $Path.ToLower().TrimEnd('\', '/')
$rootIsBuildish = $rootLower -match '(\\|/)(dist|build|out|coverage|test-results)$' -or
  $rootLower -match '(\\|/)(dist|build|out|coverage|test-results)(\\|/)'
# When the root is NOT itself buildish, skip these names below the root.
$buildishSkipRegex = '(\\|/)(dist|build|out|coverage|test-results)(\\|/|$)'

# Binary / vendor artifacts that must not appear in the release tree.
$forbiddenBinaryExt = @('.exe', '.dll', '.node', '.asar', '.msix', '.msixbundle',
  '.appx', '.appxbundle', '.pfx', '.p12', '.pem', '.key', '.dmp', '.dump')

# Files whose contents we scan (text). Anything else is treated as opaque.
$textExt = @('.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.jsonc',
  '.ps1', '.psm1', '.psd1', '.cmd', '.bat', '.vbs', '.yml', '.yaml', '.xml',
  '.html', '.css', '.py', '.sh', '.cfg', '.ini', '.env', '.example', '.gitignore')

# Explicit public IP/host allowlist (loopback + doc-range only).
$ipAllowlist = @('127.0.0.1', '0.0.0.0', '::1', 'localhost')

# ---------------------------------------------------------------------------
# Dynamic developer-identity leak detection (NOT hard-coded per plan rule 6).
# We compute *this machine's* identity and flag it if it leaked into files.
# ---------------------------------------------------------------------------
$devUser = $env:USERNAME
$devUserProfile = $env:USERPROFILE   # current user's profile directory
$devHome = $env:HOME

# ---------------------------------------------------------------------------
# Secret / identifier patterns. Each: name + regex. Value is never printed.
# ---------------------------------------------------------------------------
$patterns = @(
  @{ Name = 'PrivateKeyBlock'; Rx = '-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----' }
  @{ Name = 'BearerToken'; Rx = '(?i)authorization\s*[:=]\s*["'']?bearer\s+[A-Za-z0-9._\-]{16,}' }
  @{ Name = 'ApiKeyHeader'; Rx = '(?i)(x-api-key|api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*["'']?[A-Za-z0-9._\-]{16,}' }
  @{ Name = 'AnthropicKey'; Rx = 'sk-ant-[A-Za-z0-9\-_]{16,}' }
  @{ Name = 'OpenAIKey'; Rx = 'sk-(proj-)?[A-Za-z0-9]{20,}' }
  @{ Name = 'CloudflareToken'; Rx = 'cfut_[A-Za-z0-9]{20,}' }
  @{ Name = 'GitHubToken'; Rx = 'gh[pousr]_[A-Za-z0-9]{20,}' }
  @{ Name = 'SlackToken'; Rx = 'xox[baprs]-[A-Za-z0-9\-]{10,}' }
  @{ Name = 'AwsAccessKey'; Rx = 'AKIA[0-9A-Z]{16}' }
  @{ Name = 'GoogleApiKey'; Rx = 'AIza[0-9A-Za-z\-_]{35}' }
  @{ Name = 'EmailAddress'; Rx = '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}' }
  @{ Name = 'JwtToken'; Rx = 'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}' }
  @{ Name = 'AbsoluteUserPath'; Rx = '(?i)[A-Z]:\\Users\\[^\\/:*?"<>|\r\n]+' }
)

# Production-source-only patterns (SESSION-3 section 9): a hardcoded developer
# install root or the retired vendor host must never appear in shippable source
# / scripts / config. Docs, tests, and evidence MAY reference them descriptively.
$productionOnlyPatterns = @(
  @{ Name = 'HardcodedDevRoot'; Rx = '(?i)[A-Z]:\\{1,2}Programs\\{1,2}' }
  @{ Name = 'HardcodedPrivateGateway'; Rx = '(?i)private-gateway\.invalid' }
)
# A file is "production" if it is shippable code/config (not a doc/test/evidence).
function Test-IsProductionFile {
  param([string]$Rel, [string]$Name)
  if ($Name -like '*.md') { return $false }
  if ($Name -like '*.test.js' -or $Name -like '*.selftest.ps1') { return $false }
  if ($Rel -match '(^|\\|/)(test|tests|test-results|fixtures)(\\|/)') { return $false }
  if ($Name -eq 'verify-release.ps1') { return $false }
  $ext = [System.IO.Path]::GetExtension($Name).ToLower()
  return @('.js', '.mjs', '.cjs', '.ts', '.json', '.cmd', '.bat', '.ps1', '.vbs', '.psm1') -contains $ext
}
# NOTE: a bare foreign Unix home like /home/<x>/ is NOT treated as a secret here:
# gateway-published model IDs can legitimately contain such paths, and the real
# risk — THIS machine's identity leaking — is caught precisely by the dynamic
# DevUserNameLeak / DevProfilePathLeak checks below.

# A generic high-entropy token heuristic (long base64-ish runs).
$highEntropyRx = '(?<![A-Za-z0-9+/=_\-])[A-Za-z0-9+/=_\-]{40,}(?![A-Za-z0-9+/=_\-])'

# IPv4 (we allowlist loopback / doc ranges below).
$ipv4Rx = '\b(?:\d{1,3}\.){3}\d{1,3}\b'

$findings = New-Object System.Collections.Generic.List[object]

function Add-Finding {
  param($File, $Line, $Kind, $Fingerprint)
  $script:findings.Add([pscustomobject]@{
      File        = $File
      Line        = $Line
      Kind        = $Kind
      Fingerprint = $Fingerprint
    })
}

function Get-Fingerprint {
  param([string]$Value)
  if (-not $Value) { return '<empty>' }
  $len = $Value.Length
  $head = $Value.Substring(0, [Math]::Min(4, $len))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
  return "$head...(len=$len,sha256=$($hash.Substring(0,8)))"
}

function Test-DecorativeOrLowEntropy {
  param([string]$Value)
  # Reject runs dominated by a single repeated char (---- ==== ____ ....).
  $distinct = @($Value.ToCharArray() | Sort-Object -Unique).Count
  if ($distinct -le 4) { return $true }
  # Reject hyphen/slash/underscore/dot-joined WORD sequences (model IDs, vendor
  # lists, file paths) — real credentials are not word-delimited. If splitting on
  # [-/_.] yields multiple alphabetic-ish segments, it is not a secret token.
  $segments = @($Value -split '[-/_.]' | Where-Object { $_ -ne '' })
  if ($segments.Count -ge 3) {
    $wordish = @($segments | Where-Object { $_ -match '^[A-Za-z][A-Za-z0-9]*$' }).Count
    if ($wordish -ge ([Math]::Ceiling($segments.Count / 2))) { return $true }
  }
  # A real credential mixes classes. Require >=3 of: lower, UPPER, digit, symbol.
  $classes = 0
  if ($Value -cmatch '[a-z]') { $classes++ }
  if ($Value -cmatch '[A-Z]') { $classes++ }
  if ($Value -match '[0-9]') { $classes++ }
  if ($Value -match '[+/=_\-]') { $classes++ }
  if ($classes -lt 3) { return $true }
  # Shannon entropy per char — genuine tokens are dense; prose/identifiers are not.
  $freq = @{}
  foreach ($ch in $Value.ToCharArray()) {
    if ($freq.ContainsKey($ch)) { $freq[$ch] = $freq[$ch] + 1 } else { $freq[$ch] = 1 }
  }
  $len = $Value.Length
  $entropy = 0.0
  foreach ($count in $freq.Values) {
    $p = $count / $len
    $entropy -= $p * [Math]::Log($p, 2)
  }
  # Base64/hex secrets sit well above 3.5 bits/char; repetitive art is far lower.
  if ($entropy -lt 3.2) { return $true }
  return $false
}

function Test-DocIp {
  param([string]$Ip)
  if ($ipAllowlist -contains $Ip) { return $true }
  # RFC5737 documentation ranges + RFC1918 private + link-local are allowed.
  if ($Ip -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') { return $true }
  if ($Ip -match '^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)') { return $true }
  if ($Ip -match '^(169\.254\.|224\.|0\.)') { return $true }
  # Also skip obvious version-number false positives (e.g. 1.20186.1 is not IPv4-shaped
  # because a segment > 255) — the regex already only matches 4 dotted groups.
  foreach ($seg in $Ip.Split('.')) { if ([int]$seg -gt 255) { return $true } }
  return $false
}

# ---------------------------------------------------------------------------
# Walk the tree.
# ---------------------------------------------------------------------------
$allFiles = Get-ChildItem -LiteralPath $Path -Recurse -File -Force |
  Where-Object {
    if ($_.FullName -match $alwaysSkipRegex) { return $false }
    # Only skip buildish dirs when the scan root is NOT itself buildish.
    if (-not $rootIsBuildish -and $_.FullName -match $buildishSkipRegex) { return $false }
    return $true
  }

foreach ($f in $allFiles) {
  $rel = $f.FullName.Substring($Path.Length).TrimStart('\', '/')

  # 1. Oversized files.
  $allowedReleaseBinary = Test-AllowedReleaseBinary $rel $f
  if ($f.Length -gt ($MaxFileSizeMB * 1MB) -and -not $allowedReleaseBinary) {
    Add-Finding -File $rel -Line 0 -Kind 'OversizedFile' -Fingerprint ("{0:N2} MB" -f ($f.Length / 1MB))
  }

  # 2. Forbidden binary / vendor extensions.
  if ($forbiddenBinaryExt -contains $f.Extension.ToLower()) {
    if ($allowedReleaseBinary) { continue }
    Add-Finding -File $rel -Line 0 -Kind ('VendorBinary(' + $f.Extension + ')') -Fingerprint '<binary>'
    continue
  }

  # 3. Text-content scans only for known text extensions.
  if (($textExt -contains $f.Extension.ToLower()) -or ($f.Name -eq '.gitignore')) {
    # The scanner and its self-test legitimately contain secret-shaped strings
    # (the pattern table; the planted fixtures). Do not self-flag those pattern
    # scans. Dev-identity / IP / size checks still apply to them.
    $isScannerSelf = ($f.Name -eq 'verify-release.ps1' -or $f.Name -eq 'verify-release.selftest.ps1')
    $isProd = Test-IsProductionFile $rel $f.Name
    $lineNo = 0
    foreach ($line in [System.IO.File]::ReadLines($f.FullName)) {
      $lineNo++

      # Production-only: hardcoded dev root / vendor host in shippable source.
      if ($isProd) {
        foreach ($pp in $productionOnlyPatterns) {
          foreach ($match in [regex]::Matches($line, $pp.Rx)) {
            Add-Finding -File $rel -Line $lineNo -Kind $pp.Name -Fingerprint (Get-Fingerprint $match.Value)
          }
        }
      }

      if (-not $isScannerSelf) {
      foreach ($p in $patterns) {
        $m = [regex]::Matches($line, $p.Rx)
        foreach ($match in $m) {
          if ($p.Name -eq 'EmailAddress' -and $match.Value -match '(example\.(com|org)|noreply|@schema\.org|@types)') { continue }
          Add-Finding -File $rel -Line $lineNo -Kind $p.Name -Fingerprint (Get-Fingerprint $match.Value)
        }
      }

      # High-entropy blobs (skip sha256 hashes + decorative separators).
      foreach ($match in [regex]::Matches($line, $highEntropyRx)) {
        $v = $match.Value
        # npm lockfiles contain public Subresource Integrity digests, not secrets.
        if ($f.Name -eq 'package-lock.json' -and $line -match '"integrity"\s*:\s*"sha(256|384|512)-') { continue }
        if ($v -match '^[0-9a-f]{40,64}$') { continue }        # hex hash — allowed as evidence
        if (Test-DecorativeOrLowEntropy $v) { continue }       # ---- ==== ____ separators, comment art
        Add-Finding -File $rel -Line $lineNo -Kind 'HighEntropyToken' -Fingerprint (Get-Fingerprint $v)
      }
      } # end -not isScannerSelf

      # IPs not allowlisted.
      foreach ($match in [regex]::Matches($line, $ipv4Rx)) {
        if (-not (Test-DocIp $match.Value)) {
          Add-Finding -File $rel -Line $lineNo -Kind 'PublicIpAddress' -Fingerprint $match.Value
        }
      }

      # Dynamic dev-identity leaks.
      if ($devUser -and $line -match [regex]::Escape($devUser)) {
        Add-Finding -File $rel -Line $lineNo -Kind 'DevUserNameLeak' -Fingerprint (Get-Fingerprint $devUser)
      }
      if ($devUserProfile -and $line -match [regex]::Escape($devUserProfile)) {
        Add-Finding -File $rel -Line $lineNo -Kind 'DevProfilePathLeak' -Fingerprint (Get-Fingerprint $devUserProfile)
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Optional: scan git history (NEXT-INSTRUCTIONS 10.1). Greps every blob in
# history for the highest-signal secret patterns. Reports commit + redacted hit.
# ---------------------------------------------------------------------------
if ($IncludeGitHistory) {
  Write-Host ''
  Write-Host 'Scanning git history for high-signal secrets...'
  $gitPatterns = @(
    'sk-ant-[A-Za-z0-9_-]{16,}', 'sk-proj-[A-Za-z0-9_-]{16,}',
    'cfut_[A-Za-z0-9]{20,}', 'gh[pousr]_[A-Za-z0-9]{20,}',
    'AKIA[0-9A-Z]{16}', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----'
  )
  Push-Location $Path
  try {
    $inRepo = (git rev-parse --is-inside-work-tree 2>$null)
    if ($inRepo -eq 'true') {
      foreach ($gp in $gitPatterns) {
        $hits = git grep -I -n -E -e $gp $(git rev-list --all 2>$null) 2>$null
        foreach ($h in $hits) {
          $parts = $h -split ':', 4
          # The scanner self-test intentionally contains planted secret-shaped
          # fixtures. They prove the detector works and are not repository data.
          if ($parts.Count -ge 2 -and $parts[1] -in @('scripts/verify-release.ps1','scripts/verify-release.selftest.ps1')) { continue }
          Add-Finding -File "git:$($parts[0])" -Line 0 -Kind 'GitHistorySecret' -Fingerprint (Get-Fingerprint $gp)
        }
      }
    } else {
      Write-Host '  (not a git repo; skipped)'
    }
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------------------
# Report.
# ---------------------------------------------------------------------------
Write-Host ''
if ($findings.Count -eq 0) {
  Write-Host 'PASS: no secrets, private paths, vendor binaries, or oversized files found.' -ForegroundColor Green
  exit 0
}

Write-Host "FAIL: $($findings.Count) finding(s). Values are redacted (fingerprints only)." -ForegroundColor Red
$findings |
  Sort-Object File, Line |
  Format-Table -AutoSize File, Line, Kind, Fingerprint |
  Out-String -Width 200 |
  Write-Host

# Summary by kind.
Write-Host 'Summary by kind:'
$findings | Group-Object Kind | Sort-Object Count -Descending |
  ForEach-Object { Write-Host ("  {0,-24} {1}" -f $_.Name, $_.Count) }

exit 1
