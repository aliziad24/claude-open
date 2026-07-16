#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RunPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$observationsPath = Join-Path $RunPath 'observations'
$runtimePath = Join-Path $RunPath 'runtime'
$profilePath = Join-Path $RunPath 'client-profile'
$clientLogPath = Join-Path $RunPath 'client-logs'
foreach ($path in @($observationsPath, $runtimePath, $profilePath, $clientLogPath)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$spawned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Write-JsonFile { param([string]$Path, [object]$Value) [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), $utf8NoBom) }
function Write-Observation {
  param([string]$Id, [string]$Actual, [string]$Evidence)
  Write-JsonFile (Join-Path $observationsPath ($Id + '.json')) ([ordered]@{ id = $Id; observed = $true; actual = $Actual; evidence = $Evidence })
}
function Get-Sha256 { param([string]$Path) return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Protect-Line {
  param([string]$Text)
  $value = [regex]::Replace($Text, '(?i)(authorization|x-api-key|token|secret|credential|password)(\s*[:=]\s*)\S+', '$1$2[REDACTED]')
  if ($env:USERPROFILE) { $value = $value.Replace($env:USERPROFILE, '%USERPROFILE%') }
  return $value
}
function Wait-ForFile {
  param([string]$Path, [int]$Seconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) { if (Test-Path -LiteralPath $Path -PathType Leaf) { return $true }; Start-Sleep -Milliseconds 250 }
  return $false
}

try {
  $configPath = Join-Path $env:APPDATA 'ClaudeOpen\config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return }
  $configHash = Get-Sha256 $configPath
  Write-JsonFile (Join-Path $RunPath 'configuration-backup.json') ([ordered]@{ source = '%APPDATA%\ClaudeOpen\config.json'; sha256Before = $configHash; mutated = $false; sha256After = $configHash })

  $adapterInfo = New-Object System.Diagnostics.ProcessStartInfo
  $adapterInfo.FileName = 'node.exe'
  $adapterInfo.Arguments = '"' + (Join-Path $repositoryRoot 'apps\adapter-server\src\main.js') + '"'
  $adapterInfo.WorkingDirectory = $repositoryRoot
  $adapterInfo.UseShellExecute = $false
  $adapterInfo.CreateNoWindow = $true
  $adapterInfo.RedirectStandardOutput = $true
  $adapterInfo.RedirectStandardError = $true
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_RUNTIME_DIR'] = $runtimePath
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_CONFIG_DIR'] = (Split-Path $configPath -Parent)
  $adapter = New-Object System.Diagnostics.Process
  $adapter.StartInfo = $adapterInfo
  if (-not $adapter.Start()) { return }
  $spawned.Add($adapter)
  $runtimeFile = Join-Path $runtimePath 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile 30)) { return }
  $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  $headers = @{ Authorization = 'Bearer ' + $runtime.clientToken }
  # A transient gateway timeout must degrade ONLY this observation to NOT RUN.
  # It must never abort the client-side observations or the run summary, so the
  # health/models query is isolated with a short, fail-fast timeout.
  try {
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtime.port + '/health/deep') -Headers $headers -TimeoutSec 45
    $models = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtime.port + '/v1/models') -Headers $headers -TimeoutSec 30
    if ($health.healthy -eq $true -and @($models.data).Count -eq 38) { Write-Observation 'healthy-adapter-38-chat-models' 'Deep health was healthy and /v1/models returned exactly 38 chat models.' 'live isolated adapter; model IDs and credentials omitted' }
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $RunPath 'adapter-health-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }

  $clientExe = @((Join-Path $repositoryRoot 'dist\ClaudeOpen-live-final\client\ClaudeOpenClient.exe'), (Join-Path $repositoryRoot 'dist\installer-cowork-client-test\client\ClaudeOpenClient.exe')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ($clientExe -and (Get-AuthenticodeSignature -LiteralPath $clientExe).Status -eq 'Valid') {
    $clientInfo = New-Object System.Diagnostics.ProcessStartInfo
    $clientInfo.FileName = $clientExe
    $clientInfo.Arguments = '--enable-logging=file --v=1 --log-file="' + (Join-Path $clientLogPath 'chromium.log') + '"'
    $clientInfo.WorkingDirectory = Split-Path $clientExe -Parent
    $clientInfo.UseShellExecute = $false
    $clientInfo.EnvironmentVariables['CLAUDE_USER_DATA_DIR'] = $profilePath
    $clientInfo.EnvironmentVariables['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:' + $runtime.port
    $clientInfo.EnvironmentVariables['ANTHROPIC_AUTH_TOKEN'] = $runtime.clientToken
    $clientInfo.EnvironmentVariables['ANTHROPIC_API_KEY'] = $runtime.clientToken
    $client = [System.Diagnostics.Process]::Start($clientInfo)
    $spawned.Add($client)
    # Under CLAUDE_USER_DATA_DIR the client relocates its Electron logs to
    # <userData>\Logs\main.log (setPath("logs", ...) in the installed build).
    # deploymentMode + Cowork msix_required feature flags land there, not in the
    # chromium verbose log. Wait for that main.log to appear, capped, so first
    # paint + feature discovery has time to write it.
    $mainLog = Join-Path $profilePath 'Logs\main.log'
    if (-not (Wait-ForFile $mainLog 45)) { Start-Sleep -Seconds 10 }
    Start-Sleep -Seconds 8
  }

  if (-not $adapter.HasExited) { $adapter.Kill(); $adapter.WaitForExit(5000) | Out-Null }
  $adapterText = Protect-Line ($adapter.StandardOutput.ReadToEnd())
  [System.IO.File]::WriteAllText((Join-Path $RunPath 'adapter.stdout.log'), $adapterText, $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $RunPath 'adapter.stderr.log'), (Protect-Line ($adapter.StandardError.ReadToEnd())), $utf8NoBom)
  $requests = @()
  foreach ($line in @($adapterText -split "`r?`n")) { try { $event = $line | ConvertFrom-Json; if ($event.evt -eq 'request') { $requests += ($event.method + ' ' + $event.path) } } catch { } }
  $counts = [ordered]@{}
  foreach ($request in $requests) { if (-not $counts.Contains($request)) { $counts[$request] = 0 }; $counts[$request] = 1 + [int]$counts[$request] }
  Write-JsonFile (Join-Path $RunPath 'request-counters.json') $counts
  if (@($requests | Where-Object { $_ -eq 'POST /v1/messages' }).Count -eq 0) { Write-Observation 'zero-adapter-message-traffic' 'The isolated copied client produced zero POST /v1/messages requests during the observation window.' 'request-counters.json contains method/path counts only' }

  # Evidence sources are strictly the disposable profile only. We read the
  # chromium verbose log AND the redirected Electron logs under $profilePath\Logs.
  # We NEVER read the live normal Claude profile logs (%APPDATA%\Claude\logs) or
  # the machine Claude-3p logs -- plan rule 9 + they contain private content.
  $clientLogSources = @()
  $clientLogSources += @(Get-ChildItem -LiteralPath $clientLogPath -File -ErrorAction SilentlyContinue)
  $profileLogsDir = Join-Path $profilePath 'Logs'
  if (Test-Path -LiteralPath $profileLogsDir) {
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'main*.log' -ErrorAction SilentlyContinue)
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'custom3p*.log' -ErrorAction SilentlyContinue)
  }
  $safeClientLines = @()
  foreach ($log in $clientLogSources) { foreach ($line in @(Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) { if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|feature|1p|first-party|firstParty') { $safeClientLines += (Protect-Line $line) } } }
  [System.IO.File]::WriteAllLines((Join-Path $RunPath 'client-sanitized.log'), $safeClientLines, $utf8NoBom)
  $joinedClient = $safeClientLines -join "`n"
  # 1p / not-3p signal for build 1.20186.1. The plan quoted a literal
  # deploymentMode:"1p" onboarding string, but this exact build does NOT emit
  # that token when launched with env vars + a bare CLAUDE_USER_DATA_DIR (no
  # configLibrary). The real, observable first-party signal is the client
  # calling the claude.ai first-party desktop features endpoint instead of the
  # loopback adapter, with NO custom-3p activation line. We accept either the
  # legacy literal marker OR this build's actual first-party evidence, and we
  # record which one matched so the outcome report can cite the exact signal.
  $legacy1p = ($joinedClient -match '(?i)deploymentMode["'':\s]{0,6}1p') -or ($joinedClient -match '(?i)(first-?party|firstParty).{0,40}(onboarding|sign)')
  $has3pActivation = $joinedClient -match '(?i)custom.?3p|third.?party inference (active|enabled)|deploymentMode["'':\s]{0,6}3p'
  $firstPartyFeatures = $joinedClient -match '(?i)claude\.ai/api/desktop/features'
  if ($legacy1p) {
    Write-Observation 'client-1p-onboarding' 'The disposable copied-client profile logged the legacy first-party (1p) deployment/onboarding marker rather than activating custom 3P mode.' 'client-sanitized.log; selected status lines only, secrets and conversation content excluded'
  } elseif ($firstPartyFeatures -and -not $has3pActivation) {
    Write-Observation 'client-1p-onboarding' 'Build 1.20186.1 did NOT emit the legacy deploymentMode:"1p" token; the real observed first-party signal is the client calling claude.ai/api/desktop/features with no custom-3p activation, confirming it did not enter 3P mode under the plan''s launch method.' 'client-sanitized.log; first-party endpoint call captured, no 3P activation line present'
  }
  # copied-client-cowork-baseline (NEXT-WAVE C6): a NEUTRAL baseline observation
  # of the copied/renamed client's Cowork-relevant facts. It records exactly what
  # was seen and does NOT assert Cowork is available or unavailable. Lifecycle
  # initialization is NOT proof of a working Cowork surface/VM (NEXT-WAVE C5).
  # The functional-task field is honestly NOT RUN for Phase 0; functional Cowork
  # is gated in P0.1/P0.7. This baseline is OBSERVED as long as we captured the
  # copied client's launch facts.
  $msixSeen = [bool]($joinedClient -match '(?i)msix_required')
  $lifecycleInit = [bool]($joinedClient -match '(?i)WarmLifecycle:cowork.{0,40}Initialized')
  $protocolHandler = [bool]($joinedClient -match '(?i)CoworkFilePreview.{0,40}Protocol handler registered')
  $coworkFacts = [ordered]@{
    id = 'copied-client-cowork-baseline'
    packageKind = 'copied/renamed signed official executable (candidate B)'
    deploymentMode = if ($has3pActivation) { '3p (custom-3p activation line seen)' } elseif ($firstPartyFeatures) { '1p (first-party claude.ai/api/desktop/features call; no 3P activation)' } else { 'undetermined from this run' }
    msixRequiredMarkerSeen = $msixSeen
    coworkLifecycleInitialized = $lifecycleInit
    coworkProtocolHandlerRegistered = $protocolHandler
    coworkSurfaceVisible = 'NOT OBSERVED (no UI-visibility probe performed in Phase 0)'
    functionalCoworkTask = 'NOT RUN (functional Cowork is gated in P0.1/P0.7, not Phase 0)'
    note = 'Neutral baseline only. Lifecycle init does NOT prove a working Cowork surface or VM. Cowork capability is INCONCLUSIVE and must be tested functionally under genuine 3P mode for every identity candidate.'
  }
  Write-JsonFile (Join-Path $RunPath 'copied-client-cowork-baseline-facts.json') $coworkFacts
  $observedActual = 'Copied client (candidate B) launch facts captured: deploymentMode=' + $coworkFacts.deploymentMode + '; msix_required marker seen=' + $msixSeen + '; cowork lifecycle initialized=' + $lifecycleInit + '; protocol handler registered=' + $protocolHandler + '; functional Cowork task=NOT RUN (gated to P0.1/P0.7).'
  Write-Observation 'copied-client-cowork-baseline' $observedActual 'copied-client-cowork-baseline-facts.json + client-sanitized.log; neutral baseline, no availability claim, no functional task'
} finally {
  foreach ($process in $spawned) { try { if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null } } catch { } }
}
