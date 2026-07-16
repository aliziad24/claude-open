[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Inspect')]
  [switch]$Inspect,
  [string]$Repository = 'aliziad24/claude-open',
  [string]$InstallDir,
  [switch]$EnableCoworkPrerequisites,
  [switch]$UpdateOfficialClaude
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($env:OS -ne 'Windows_NT') { throw 'Claude Open supports Windows 10/11 x64 only.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository must be in owner/name form.' }

$headers = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'ClaudeOpen-Installer-Skill'
}
$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/latest"
$assets = @($release.assets | Where-Object { $_.name -eq 'ClaudeOpen-bootstrap.zip' })
if ($assets.Count -ne 1) { throw "Expected exactly one ClaudeOpen-bootstrap.zip asset in release $($release.tag_name)." }
$asset = $assets[0]
$digest = [string]$asset.digest
if ($digest -and $digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw 'The release asset has an unsupported digest format.' }

$summary = [ordered]@{
  repository = $Repository
  release = [string]$release.tag_name
  publishedAt = [string]$release.published_at
  asset = [string]$asset.name
  bytes = [long]$asset.size
  sha256 = if ($digest) { $digest.Substring(7).ToUpperInvariant() } else { $null }
  installDir = if ($InstallDir) { [IO.Path]::GetFullPath($InstallDir) } else { '(default per-user location)' }
  updatesExistingOfficialClaude = [bool]$UpdateOfficialClaude
  enablesCoworkPrerequisites = [bool]$EnableCoworkPrerequisites
}
$summary | ConvertTo-Json
if ($Inspect) { return }

$work = Join-Path ([IO.Path]::GetTempPath()) ('ClaudeOpen-Skill-' + [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $work $asset.name
$expanded = Join-Path $work 'expanded'
try {
  New-Item -ItemType Directory -Path $work, $expanded -Force | Out-Null
  Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $archive
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($digest -and $actual -ne $digest.Substring(7).ToUpperInvariant()) {
    throw "Release checksum mismatch. Expected $($digest.Substring(7)); received $actual."
  }
  if (-not $digest) {
    Write-Warning "GitHub did not publish an asset digest. Downloaded SHA-256: $actual"
  } else {
    Write-Host "Verified release SHA-256: $actual"
  }

  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $installers = @(Get-ChildItem -LiteralPath $expanded -Filter 'Install-ClaudeOpen.ps1' -File -Recurse)
  if ($installers.Count -ne 1) { throw 'The release must contain exactly one Install-ClaudeOpen.ps1.' }

  $invoke = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installers[0].FullName)
  if ($InstallDir) { $invoke += @('-InstallDir', [IO.Path]::GetFullPath($InstallDir)) }
  if ($EnableCoworkPrerequisites) { $invoke += '-EnableCoworkPrerequisites' }
  if ($UpdateOfficialClaude) { $invoke += '-UpdateOfficialClaude' }
  & powershell.exe @invoke
  if ($LASTEXITCODE -ne 0) { throw "Claude Open installer exited with code $LASTEXITCODE." }
} finally {
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
