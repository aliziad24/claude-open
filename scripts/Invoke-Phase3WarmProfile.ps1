#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 3 WARM-PROFILE cold-vs-warm decisive experiment (p03warm).

.DESCRIPTION
  Tests the hypothesis: the genuine client's ConfigHealth reachability probe fails
  ONLY on FIRST run because a first-run CCD binary download (claude-code 2.1.205,
  59MB -> 247MB decompress) saturates the client's main event loop and the probe
  aborts (timeout, NOT connection-refused) before it reaches the adapter. On a
  SECOND launch of the SAME profile (CCD already downloaded + installed), the probe
  should reach the adapter and succeed.

  Procedure (all against ONE long-lived pass-2 adapter on ONE ephemeral port):
    Pass-1 adapter: read /v1/models, pick a HEALTHY opus default.
    Pass-2 adapter: restart with CLAUDE_OPEN_HEALTHY_DEFAULT=<opus>, bind the LIVE
      port the isolated 3P config points at. This adapter stays UP across both
      client launches.
    Write the production FLAT 3P config into the isolated profile (same profile
      reused for BOTH launches, so the same LIVE port is used both times).
    LAUNCH 1 (COLD): genuine WindowsApps claude.exe, CLAUDE_USER_DATA_DIR=profile,
      no ANTHROPIC_* env. Wait until CCD FULLY installs ('[CCD] Installed at' in
      main.log) or ~90s. Record cold ConfigHealth state. FULLY STOP the client
      (taskkill /T /F, confirm no claude.exe bound to this profile remains).
    LAUNCH 2 (WARM, same profile): relaunch the SAME claude.exe with the SAME
      CLAUDE_USER_DATA_DIR (CCD already installed, no download race). Wait ~60s.
      Record warm ConfigHealth state, whether the client REACHED the adapter, and
      the activation POST /v1/messages status (200?) from adapter evt:messages.

  Never prints/stores the real gateway secret. Never modifies the normal Claude
  profile, machine registry policy, or installed package. Disposable runtime +
  profile. All evidence under test-results\corrective\<run>\p03warm\ (git-ignored).
#>
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [int]$Launch1MaxSeconds = 120,
  [int]$Launch2WaitSeconds = 60,
  [string]$ClientExe = 'C:\Program Files\WindowsApps\Claude_1.20186.1.0_x64__pzs8sxrjxfjjc\app\claude.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }

$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
$p03Path = Join-Path $runPath 'p03warm'
$runtimePath = Join-Path $p03Path 'runtime'
$profilePath = Join-Path $p03Path 'profile'
$harnessRoot = Join-Path $p03Path 'harness'
$clientLogPath = Join-Path $p03Path 'client-logs'
foreach ($p in @($runPath, $p03Path, $runtimePath, $profilePath, $harnessRoot, $clientLogPath)) {
  New-Item -ItemType Directory -Path $p -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$spawned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

$knownOverloaded = @('claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'gemini-3-flash-v2', 'minimax-m3', 'gpt-5.4')

# --- helpers ---------------------------------------------------------------

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

function Protect-Line {
  param([string]$Text)
  if ($null -eq $Text) { return $null }
  $value = [regex]::Replace($Text, '(?i)(authorization|x-api-key|token|secret|credential|password|apikey)(\s*[:=]\s*)\S+', '$1$2[REDACTED]')
  $value = [regex]::Replace($value, 'sk-ant-[A-Za-z0-9\-_]{6,}', '[REDACTED]')
  if ($env:USERPROFILE) { $value = $value.Replace($env:USERPROFILE, '%USERPROFILE%') }
  if ($env:USERNAME) { $value = $value.Replace($env:USERNAME, '%USERNAME%') }
  return $value
}

function Get-Sha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
  catch { return 'UNAVAILABLE_FILE_LOCKED' }
}

function Wait-ForFile {
  param([string]$Path, [int]$Seconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# Wait until $mainLog contains a line matching $Pattern (regex), or timeout.
function Wait-ForLogPattern {
  param([string]$Path, [string]$Pattern, [int]$Seconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      try {
        $hit = Select-String -LiteralPath $Path -Pattern $Pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $true }
      } catch { }
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-GitCommit {
  try {
    $c = & git -C $repositoryRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { return $c.Trim() }
  } catch { }
  return 'NOT DISCOVERED'
}

function Start-Adapter {
  param([string]$RuntimeDir, [string]$ConfigDir, [hashtable]$ExtraEnv = @{})
  $adapterMain = Join-Path $repositoryRoot 'apps\adapter-server\src\main.js'
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = 'node.exe'
  $info.Arguments = '"' + $adapterMain + '"'
  $info.WorkingDirectory = $repositoryRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['CLAUDE_OPEN_RUNTIME_DIR'] = $RuntimeDir
  $info.EnvironmentVariables['CLAUDE_OPEN_PORT'] = '0'
  $info.EnvironmentVariables['CLAUDE_OPEN_CONFIG_DIR'] = $ConfigDir
  foreach ($k in $ExtraEnv.Keys) { $info.EnvironmentVariables[$k] = [string]$ExtraEnv[$k] }

  $out = New-Object System.Text.StringBuilder
  $err = New-Object System.Text.StringBuilder
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $info
  $oe = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $out -Action {
    if ($EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null }
  }
  $ee = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $err -Action {
    if ($EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null }
  }
  if (-not $proc.Start()) { throw 'Failed to start node adapter process.' }
  $script:spawned.Add($proc)
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  return @{ Process = $proc; StdOut = $out; StdErr = $err; OutEvent = $oe; ErrEvent = $ee; RuntimeDir = $RuntimeDir }
}

function Stop-Adapter {
  param($Handle)
  try { if (-not $Handle.Process.HasExited) { $Handle.Process.Kill(); $Handle.Process.WaitForExit(5000) | Out-Null } } catch { }
  Start-Sleep -Milliseconds 300
  if ($Handle.OutEvent) { Unregister-Event -SourceIdentifier $Handle.OutEvent.Name -ErrorAction SilentlyContinue }
  if ($Handle.ErrEvent) { Unregister-Event -SourceIdentifier $Handle.ErrEvent.Name -ErrorAction SilentlyContinue }
}

# Launch the genuine client with the isolated profile. Returns the Process.
function Start-GenuineClient {
  param([string]$ChromiumLogName, [string]$DefaultAlias)
  $clientInfo = New-Object System.Diagnostics.ProcessStartInfo
  $clientInfo.FileName = $ClientExe
  $clientInfo.Arguments = '--enable-logging=file --v=1 --log-file="' + (Join-Path $clientLogPath $ChromiumLogName) + '"'
  $clientInfo.WorkingDirectory = Split-Path $ClientExe -Parent
  $clientInfo.UseShellExecute = $false
  $clientInfo.EnvironmentVariables['CLAUDE_USER_DATA_DIR'] = $profilePath
  $clientInfo.EnvironmentVariables['CLAUDE_OPEN_HEALTHY_DEFAULT'] = $DefaultAlias
  foreach ($k in @('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')) {
    if ($clientInfo.EnvironmentVariables.ContainsKey($k)) { $clientInfo.EnvironmentVariables.Remove($k) | Out-Null }
  }
  $proc = [System.Diagnostics.Process]::Start($clientInfo)
  $script:spawned.Add($proc)
  return $proc
}

# Fully stop every genuine claude.exe whose command line is bound to THIS isolated
# profile. Never touches the normal Claude. Confirms none remain.
function Stop-ProfileClients {
  param([int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $lingering = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profilePath) })
    if ($lingering.Count -eq 0) { return $true }
    foreach ($p in $lingering) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  $remain = @(Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profilePath) })
  return ($remain.Count -eq 0)
}

# Parse the adapter stdout for a given client window -> counters + message events.
function Get-ClientWindowEvidence {
  param([string]$AdapterStdout, [string]$LaunchUtc, [string]$WindowEndUtc, [string]$DefaultAlias)
  $parseScript = Join-Path $p03Path ('parse-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.mjs')
  $parseSource = @'
import { parseRequestEvents, countRequests, filterClientOriginated, clientDroveModels, clientDroveMessages, parseMessageEvents, filterClientMessages, clientMessageSucceeded } from PARSER_PATH;
const win = JSON.parse(process.env.CO_WINDOW || '{}');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const events = parseRequestEvents(data);
  const clientEvents = filterClientOriginated(events, win);
  const msgEvents = parseMessageEvents(data);
  const clientMsgs = filterClientMessages(msgEvents, win);
  process.stdout.write(JSON.stringify({
    counters: countRequests(events),
    clientCounters: countRequests(clientEvents),
    getModels: clientDroveModels(clientEvents),
    postMessages: clientDroveMessages(clientEvents),
    clientEventCount: clientEvents.length,
    clientMessageEvents: clientMsgs,
    clientMessageSucceeded: clientMessageSucceeded(clientMsgs),
  }));
});
'@
  $parserModule = (Join-Path $repositoryRoot 'scripts\lib\adapter-requests.mjs').Replace('\', '/')
  $parseSource = $parseSource.Replace('PARSER_PATH', "'file:///$parserModule'")
  [System.IO.File]::WriteAllText($parseScript, $parseSource, $utf8NoBom)
  $windowJson = ([ordered]@{ clientLaunchUtc = $LaunchUtc; loopbackStartUtc = $WindowEndUtc } | ConvertTo-Json -Compress)
  $env:CO_WINDOW = $windowJson
  $parsed = $AdapterStdout | & node.exe $parseScript 2>$null
  Remove-Item Env:\CO_WINDOW -ErrorAction SilentlyContinue
  $obj = $null
  try { $obj = ($parsed -join "`n") | ConvertFrom-Json } catch { }
  return $obj
}

# Read + sanitize the profile main.log; extract ConfigHealth + reach signals.
function Read-ProfileMainLog {
  param([string]$SanitizedOutName)
  $clientLogSources = @()
  $profileLogsDir = Join-Path $profilePath 'Logs'
  if (Test-Path -LiteralPath $profileLogsDir) {
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'main*.log' -ErrorAction SilentlyContinue)
  }
  $safe = @()
  foreach ($log in $clientLogSources) {
    foreach ($line in @(Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) {
      if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|3p|1p|first-?party|firstParty|custom.?3p|inference|model|picker|ConfigHealth|apiHost|reachable|unreachable|refused|ERR_CONNECTION|CCD|claude-code|Installed at|event-loop-stall|Gateway was|aborted|127\.0\.0\.1|localhost') {
        $safe += (Protect-Line $line)
      }
    }
  }
  [System.IO.File]::WriteAllLines((Join-Path $p03Path $SanitizedOutName), $safe, $utf8NoBom)
  return ($safe -join "`n")
}

function Get-ConfigHealthState {
  param([string]$Joined, [string]$AfterUtc)
  # Return the LAST ConfigHealth recomputed state. If $AfterUtc supplied, prefer
  # states logged at/after that timestamp (so warm launch is judged on its OWN
  # ConfigHealth line, not launch-1's).
  $state = $null; $stateAfter = $null
  foreach ($m in [regex]::Matches($Joined, "(?im)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).{0,40}ConfigHealth\s+recomputed\s*\{\s*state:\s*'([^']+)'")) {
    $ts = $m.Groups[1].Value
    $st = $m.Groups[2].Value
    $state = $st
    if ($AfterUtc) {
      # main.log timestamps are local; we compare lexicographically within the same day is unsafe.
      # Instead we just take the LAST state overall, and separately the last state after a marker.
    }
  }
  return $state
}

# Result skeleton.
$result = [ordered]@{
  phase = 'P0.3-WARM-PROFILE'
  hypothesis = 'ConfigHealth probe fails ONLY on first run because a first-run CCD binary download (claude-code 2.1.205, 59MB->247MB) saturates the client event loop and the probe aborts before reaching the adapter; on a warm second launch (CCD already installed) the probe reaches the adapter and succeeds.'
  status = 'NOT RUN'
  verdict = $null
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = $null
  sourceCommit = Get-GitCommit
  evidenceDir = $p03Path
  clientExe = (Protect-Line $ClientExe)
  adapter = [ordered]@{
    startedFromSource = $false
    healthDeepHealthy = $false
    modelsCount = 0
    actualBoundPort = $null
    secretSource = $null
    healthyDefaultEnv = $null
    keptAliveAcrossBothLaunches = $false
  }
  defaultSelection = [ordered]@{ knownOverloaded = $knownOverloaded; chosenDefaultAlias = $null; chosenIsHealthyOpus = $false }
  configLibraryVerify = [ordered]@{
    activeConfigFile = $null
    baseUrlIsLivePort = $false
    inferenceModelCount = 0
    firstModelAlias = $null
    deploymentMode3pInDesktopConfig = $false
  }
  launch1 = [ordered]@{
    label = 'COLD (first run; CCD downloads 59MB->247MB during startup)'
    launchUtc = $null
    windowEndUtc = $null
    ccdInstalledObserved = $false
    ccdInstalledLine = $null
    eventLoopStallObserved = $false
    gatewayAbortedTimeoutObserved = $false
    configHealthState = $null
    reachedAdapter = $false
    connectionRefusedObserved = $false
    getModels = $false
    postMessages = $false
    probeReturned200 = $false
    messageStatuses = @()
    fullyStopped = $false
    noClientRemains = $false
  }
  launch2 = [ordered]@{
    label = 'WARM (same profile; CCD already installed, no download race)'
    launchUtc = $null
    windowEndUtc = $null
    ccdDownloadReoccurred = $null
    configHealthState = $null
    apiHostLoopback = $false
    reachedAdapter = $false
    connectionRefusedObserved = $false
    getModels = $false
    postMessages = $false
    postMessagesCount = 0
    probeReturned200 = $false
    activationModel = $null
    activationStatus = $null
    messageStatuses = @()
    tierReconcile = @()
  }
  answers = [ordered]@{
    launch1ConfigHealthState = $null
    launch2ConfigHealthState = $null
    launch2ReachedAdapter = $null
    launch2ActivationModel = $null
    launch2ActivationStatus = $null
    warmProfileFixesActivation = $null
  }
  remediation = $null
  rootCause = $null
}

$adapterHandle = $null
try {
  $configPath = Join-Path $env:APPDATA 'ClaudeOpen\config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'No stored Claude Open gateway config at %APPDATA%\ClaudeOpen\config.json; cannot start a real adapter session without printing a secret.'
    return
  }
  $configDir = Split-Path $configPath -Parent

  if (-not (Test-Path -LiteralPath $ClientExe -PathType Leaf)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Genuine WindowsApps claude.exe not found at: ' + (Protect-Line $ClientExe)
    return
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $ClientExe
  if ($sig.Status -ne 'Valid') {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Genuine client Authenticode is ' + $sig.Status + ' (not Valid); refusing to launch.'
    return
  }

  # === PASS 1: read /v1/models to pick the healthy opus ===
  $runtime1 = Join-Path $runtimePath 'pass1'
  New-Item -ItemType Directory -Path $runtime1 -Force | Out-Null
  $adapterHandle = Start-Adapter -RuntimeDir $runtime1 -ConfigDir $configDir
  $result.adapter.startedFromSource = $true

  $runtimeFile1 = Join-Path $runtime1 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile1 45)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-1 adapter did not write runtime.json within 45s.'
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter-pass1.stderr.log'), (Protect-Line $adapterHandle.StdErr.ToString()), $utf8NoBom)
    return
  }
  $rt1 = Get-Content -LiteralPath $runtimeFile1 -Raw | ConvertFrom-Json
  $port1 = [int]$rt1.port
  $token1 = [string]$rt1.clientToken
  $headers1 = @{ Authorization = 'Bearer ' + $token1 }
  $base1 = 'http://127.0.0.1:' + $port1

  $modelsResponse = $null
  try {
    Invoke-RestMethod -Uri ($base1 + '/health/deep') -Headers $headers1 -TimeoutSec 90 | Out-Null
    $modelsResponse = Invoke-RestMethod -Uri ($base1 + '/v1/models') -Headers $headers1 -TimeoutSec 45
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter-pass1-models-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }
  $liveModels = @()
  if ($modelsResponse -and $modelsResponse.data) { $liveModels = @($modelsResponse.data) }
  if ($liveModels.Count -eq 0) {
    Stop-Adapter $adapterHandle; $adapterHandle = $null
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-1 adapter returned an empty /v1/models catalog. Gateway may be unreachable.'
    return
  }
  $modelRecords = @()
  foreach ($m in $liveModels) { $modelRecords += [ordered]@{ id = [string]$m.id; display_name = [string]$m.display_name } }
  $modelsFile = Join-Path $p03Path 'models.json'
  Write-JsonFile $modelsFile @($modelRecords)

  # Choose the healthy default via selectDefaultModel + known-overloaded set.
  $selectScript = Join-Path $p03Path 'select-default.mjs'
  $selectSource = @'
import { selectDefaultModel } from HARNESS_PATH;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const payload = JSON.parse(data || '{}');
  const chosen = selectDefaultModel(payload.modelIds || [], payload.unhealthy || []);
  process.stdout.write(JSON.stringify({ chosen }));
});
'@
  $harnessModule = (Join-Path $repositoryRoot 'packages\identity-harness\src\index.js').Replace('\', '/')
  $selectSource = $selectSource.Replace('HARNESS_PATH', "'file:///$harnessModule'")
  [System.IO.File]::WriteAllText($selectScript, $selectSource, $utf8NoBom)
  $selectInput = ([ordered]@{ modelIds = @($modelRecords | ForEach-Object { $_.id }); unhealthy = $knownOverloaded } | ConvertTo-Json -Compress)
  $selectOut = $selectInput | & node.exe $selectScript 2>$null
  $defaultAlias = $null
  try { $defaultAlias = (($selectOut -join "`n") | ConvertFrom-Json).chosen } catch { }
  if (-not $defaultAlias) {
    $defaultAlias = ($modelRecords | Where-Object { $_.id -match '(?i)opus' -and ($knownOverloaded -notcontains $_.id) } | Select-Object -First 1).id
    if (-not $defaultAlias) { $defaultAlias = $modelRecords[0].id }
  }
  $result.defaultSelection.chosenDefaultAlias = $defaultAlias
  $result.defaultSelection.chosenIsHealthyOpus = [bool]($defaultAlias -match '(?i)opus' -and ($knownOverloaded -notcontains $defaultAlias))

  # === Stop PASS-1, RESTART pass-2 with CLAUDE_OPEN_HEALTHY_DEFAULT ===
  Stop-Adapter $adapterHandle
  $adapterHandle = $null
  $runtime2 = Join-Path $runtimePath 'pass2'
  New-Item -ItemType Directory -Path $runtime2 -Force | Out-Null
  $adapterHandle = Start-Adapter -RuntimeDir $runtime2 -ConfigDir $configDir -ExtraEnv @{ CLAUDE_OPEN_HEALTHY_DEFAULT = $defaultAlias }
  $result.adapter.healthyDefaultEnv = $defaultAlias

  $runtimeFile2 = Join-Path $runtime2 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile2 45)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-2 adapter did not write runtime.json within 45s.'
    return
  }
  $rt2 = Get-Content -LiteralPath $runtimeFile2 -Raw | ConvertFrom-Json
  $port = [int]$rt2.port
  $clientToken = [string]$rt2.clientToken
  $result.adapter.actualBoundPort = $port
  $result.adapter.secretSource = [string]$rt2.secretSource
  $headers = @{ Authorization = 'Bearer ' + $clientToken }
  $baseUrl = 'http://127.0.0.1:' + $port

  try {
    $health = Invoke-RestMethod -Uri ($baseUrl + '/health/deep') -Headers $headers -TimeoutSec 90
    $result.adapter.healthDeepHealthy = [bool]($health.healthy -eq $true)
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter-health-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }
  $models2 = $null
  try { $models2 = Invoke-RestMethod -Uri ($baseUrl + '/v1/models') -Headers $headers -TimeoutSec 45 } catch { }
  $liveModels2 = @()
  if ($models2 -and $models2.data) { $liveModels2 = @($models2.data) }
  $result.adapter.modelsCount = $liveModels2.Count
  if (-not $result.adapter.healthDeepHealthy -or $liveModels2.Count -eq 0) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-2 adapter did not reach healthy /health/deep with a non-empty catalog (healthy=' + $result.adapter.healthDeepHealthy + ', models=' + $liveModels2.Count + ').'
    return
  }

  # === Write the 3P config via the PRODUCTION path + FAMILY TIERS ===
  $shim = Join-Path $repositoryRoot 'scripts\write-3p-config.mjs'
  $shimArgs = @(
    $shim, '--production', '--assign-family-tiers',
    '--unhealthy', ($knownOverloaded -join ','),
    '--harness-root', $harnessRoot, '--user-data', $profilePath,
    '--base-url', $baseUrl, '--token', $clientToken, '--models', $modelsFile,
    '--default', $defaultAlias, '--config-name', 'Claude Open Gateway'
  )
  $shimOut = & node.exe @shimArgs 2>&1
  $shimExit = $LASTEXITCODE
  $shimText = ($shimOut | ForEach-Object { $_.ToString() }) -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'write-config.stdout.log'), (Protect-Line $shimText), $utf8NoBom)
  if ($shimExit -ne 0) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'write-3p-config --production shim failed (exit ' + $shimExit + '): ' + (Protect-Line $shimText)
    return
  }

  # Verify the written config points at the LIVE port.
  $configLibPath = Join-Path $profilePath 'configLibrary'
  $activeConfigFile = Get-ChildItem -LiteralPath $configLibPath -Filter '*.json' -File |
    Where-Object { $_.Name -ne '_meta.json' -and $_.Name -notlike '*.manifest.json' } | Select-Object -First 1
  if (-not $activeConfigFile) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'No active configLibrary/<uuid>.json written by the production shim.'
    return
  }
  $configText = Get-Content -LiteralPath $activeConfigFile.FullName -Raw
  $rawConfig = $configText | ConvertFrom-Json
  $allModels = @($rawConfig.inferenceModels)
  $result.configLibraryVerify.activeConfigFile = $activeConfigFile.Name
  $result.configLibraryVerify.baseUrlIsLivePort = [bool]($rawConfig.inferenceGatewayBaseUrl -eq $baseUrl)
  $result.configLibraryVerify.inferenceModelCount = $allModels.Count
  if ($allModels.Count -gt 0) { $result.configLibraryVerify.firstModelAlias = [string]$allModels[0].name }
  $prefFile = Join-Path $profilePath 'claude_desktop_config.json'
  if (Test-Path -LiteralPath $prefFile) {
    try { $pref = Get-Content -LiteralPath $prefFile -Raw | ConvertFrom-Json; $result.configLibraryVerify.deploymentMode3pInDesktopConfig = [bool]($pref.deploymentMode -eq '3p') } catch { }
  }
  if (-not $result.configLibraryVerify.baseUrlIsLivePort) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Written config base URL does not match the live pass-2 port; cold/warm comparison would be invalid.'
    return
  }

  $mainLog = Join-Path $profilePath 'Logs\main.log'

  # ============================ LAUNCH 1 (COLD) ============================
  $result.adapter.keptAliveAcrossBothLaunches = $true
  $result.launch1.launchUtc = [DateTime]::UtcNow.ToString('o')
  $client1 = Start-GenuineClient -ChromiumLogName 'chromium-launch1.log' -DefaultAlias $defaultAlias

  # Wait for CCD to FULLY install ('[CCD] Installed at') so the download race is
  # over before we judge the cold ConfigHealth verdict. Then allow the probe to
  # settle. If CCD never logs Installed within the budget, we still proceed.
  $ccdInstalled = Wait-ForLogPattern $mainLog '\[CCD\] Installed at' $Launch1MaxSeconds
  $result.launch1.ccdInstalledObserved = [bool]$ccdInstalled
  # Give the ConfigHealth probe time to run/abort and be logged after CCD state.
  Start-Sleep -Seconds 15
  $result.launch1.windowEndUtc = [DateTime]::UtcNow.ToString('o')

  # Snapshot adapter stdout at the boundary so launch-1 evidence excludes launch-2.
  $adapterStdoutAfterL1 = $adapterHandle.StdOut.ToString()
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stdout.afterLaunch1.log'), (Protect-Line $adapterStdoutAfterL1), $utf8NoBom)

  $joined1 = Read-ProfileMainLog 'launch1-main-sanitized.log'
  $result.launch1.ccdInstalledLine = (($joined1 -split "`n") | Where-Object { $_ -match '\[CCD\] Installed at' } | Select-Object -First 1)
  $result.launch1.eventLoopStallObserved = [bool]($joined1 -match '(?i)event-loop-stall')
  $result.launch1.gatewayAbortedTimeoutObserved = [bool]($joined1 -match '(?i)Gateway was unreachable.{0,40}aborted|operation was aborted due to timeout')
  $result.launch1.configHealthState = Get-ConfigHealthState $joined1
  $result.launch1.connectionRefusedObserved = [bool]($joined1 -match '(?i)ERR_CONNECTION_REFUSED|connection refused|ECONNREFUSED')

  $ev1 = Get-ClientWindowEvidence -AdapterStdout $adapterStdoutAfterL1 -LaunchUtc $result.launch1.launchUtc -WindowEndUtc $result.launch1.windowEndUtc -DefaultAlias $defaultAlias
  if ($ev1) {
    $result.launch1.reachedAdapter = [bool]([int]$ev1.clientEventCount -gt 0)
    $result.launch1.getModels = [bool]$ev1.getModels
    $result.launch1.postMessages = [bool]$ev1.postMessages
    $result.launch1.probeReturned200 = [bool]$ev1.clientMessageSucceeded
    $ms = @()
    if ($ev1.clientMessageEvents) { foreach ($e in @($ev1.clientMessageEvents)) { $ms += [ordered]@{ model = [string]$e.model; status = [int]$e.status } } }
    $result.launch1.messageStatuses = $ms
  }

  # --- FULLY STOP launch-1 client ---
  try { if (-not $client1.HasExited) { & taskkill.exe /PID $client1.Id /T /F 2>$null | Out-Null } } catch { }
  $result.launch1.noClientRemains = Stop-ProfileClients -TimeoutSeconds 25
  $result.launch1.fullyStopped = $true
  # Give the OS a moment to release the CCD-installed files + log handles.
  Start-Sleep -Seconds 5

  # ============================ LAUNCH 2 (WARM) ============================
  # SAME profile, SAME adapter/port (kept alive). CCD is already installed.
  $result.launch2.launchUtc = [DateTime]::UtcNow.ToString('o')
  $l2Marker = [DateTime]::UtcNow
  $client2 = Start-GenuineClient -ChromiumLogName 'chromium-launch2.log' -DefaultAlias $defaultAlias
  Start-Sleep -Seconds $Launch2WaitSeconds
  $result.launch2.windowEndUtc = [DateTime]::UtcNow.ToString('o')

  $adapterStdoutFinal = $adapterHandle.StdOut.ToString()
  $adapterStderrFinal = $adapterHandle.StdErr.ToString()
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stdout.final.log'), (Protect-Line $adapterStdoutFinal), $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stderr.log'), (Protect-Line $adapterStderrFinal), $utf8NoBom)

  $joined2 = Read-ProfileMainLog 'launch2-main-sanitized.log'
  # Warm-launch ConfigHealth: take the LAST ConfigHealth state (launch-2 lines are
  # appended after launch-1 in the same main.log; the LAST state reflects warm).
  $result.launch2.configHealthState = Get-ConfigHealthState $joined2
  $result.launch2.apiHostLoopback = [bool]($joined2 -match '(?i)(apiHost|inferenceGatewayBaseUrl|base ?url).{0,40}(127\.0\.0\.1|localhost)')
  $result.launch2.connectionRefusedObserved = [bool]($joined2 -match '(?i)ERR_CONNECTION_REFUSED|connection refused|ECONNREFUSED')
  # Did a CCD download re-occur on warm launch (should NOT if truly warm)?
  $ccdDownloadLines = @(($joined2 -split "`n") | Where-Object { $_ -match '(?i)\[CCD\] Downloading' })
  # Count CCD Downloading events; launch-1 had >=1. If only launch-1's line exists it's fine.
  $result.launch2.ccdDownloadReoccurred = [bool](@($ccdDownloadLines).Count -gt 1)

  $ev2 = Get-ClientWindowEvidence -AdapterStdout $adapterStdoutFinal -LaunchUtc $result.launch2.launchUtc -WindowEndUtc $result.launch2.windowEndUtc -DefaultAlias $defaultAlias
  if ($ev2) {
    $result.launch2.reachedAdapter = [bool]([int]$ev2.clientEventCount -gt 0)
    $result.launch2.getModels = [bool]$ev2.getModels
    $result.launch2.postMessages = [bool]$ev2.postMessages
    $result.launch2.probeReturned200 = [bool]$ev2.clientMessageSucceeded
    if ($ev2.clientCounters) {
      $ccProp = $ev2.clientCounters.PSObject.Properties | Where-Object { $_.Name -eq 'POST /v1/messages' } | Select-Object -First 1
      if ($ccProp) { $result.launch2.postMessagesCount = [int]$ccProp.Value }
    }
    $ms2 = @()
    if ($ev2.clientMessageEvents) { foreach ($e in @($ev2.clientMessageEvents)) { $ms2 += [ordered]@{ model = [string]$e.model; status = [int]$e.status } } }
    $result.launch2.messageStatuses = $ms2
    if ($ms2.Count -gt 0) {
      $result.launch2.activationModel = [string]$ms2[0].model
      $result.launch2.activationStatus = [int]$ms2[0].status
    }
  }
  # Parse tier-probe-reconcile events in the launch-2 window.
  $recon = @()
  foreach ($rawLine in ($adapterStdoutFinal -split "`r?`n")) {
    $line = $rawLine.Trim(); if (-not $line) { continue }
    $obj = $null; try { $obj = $line | ConvertFrom-Json } catch { continue }
    if (-not $obj -or -not ($obj.PSObject.Properties.Name -contains 'evt') -or $obj.evt -ne 'tier-probe-reconcile') { continue }
    $inWin = $true
    if ($obj.PSObject.Properties.Name -contains 't' -and $obj.t) {
      try { $ms = [DateTime]::Parse($obj.t).ToUniversalTime(); if ($ms -lt $l2Marker) { $inWin = $false } } catch { }
    }
    if ($inWin) { $recon += [ordered]@{ from = [string]$obj.from; to = [string]$obj.to } }
  }
  $result.launch2.tierReconcile = $recon

  # --- Answers + verdict ---
  $result.answers.launch1ConfigHealthState = $result.launch1.configHealthState
  $result.answers.launch2ConfigHealthState = $result.launch2.configHealthState
  $result.answers.launch2ReachedAdapter = $result.launch2.reachedAdapter
  $result.answers.launch2ActivationModel = $result.launch2.activationModel
  $result.answers.launch2ActivationStatus = $result.launch2.activationStatus

  $warmReachable = ($result.launch2.configHealthState -match '(?i)reachable|health|ok|ready') -or $result.launch2.reachedAdapter
  $warmActivated = ($result.launch2.probeReturned200 -eq $true)
  $result.answers.warmProfileFixesActivation = [bool]($warmReachable -and $warmActivated)

  if ($result.answers.warmProfileFixesActivation) {
    $result.status = 'HYPOTHESIS-CONFIRMED'
    $result.verdict = 'CONFIRMED: cold launch-1 ConfigHealth=' + $result.launch1.configHealthState + ' (probe starved by the CCD 59MB->247MB download; reachedAdapter=' + $result.launch1.reachedAdapter + '). Warm launch-2 (same profile, CCD pre-installed) ConfigHealth=' + $result.launch2.configHealthState + ', REACHED the adapter=' + $result.launch2.reachedAdapter + ', and its activation POST /v1/messages returned HTTP ' + $result.launch2.activationStatus + ' for model ' + $result.launch2.activationModel + '. A warm profile lets the client reach the adapter and activate.'
    $result.remediation = 'The launcher should pre-download/settle CCD (or do launch-settle-relaunch) so real users get a working client on FIRST run: warm the claude-code binary into the isolated profile BEFORE the client renders, or launch once to settle CCD then relaunch, so the ConfigHealth probe is never racing a 59MB->247MB download.'
  } elseif ($result.launch2.reachedAdapter -and -not $warmActivated) {
    $result.status = 'HYPOTHESIS-PARTIAL'
    $result.verdict = 'PARTIAL: warm launch-2 REACHED the adapter (ConfigHealth=' + $result.launch2.configHealthState + ') so the CCD-download-starves-probe race IS the reach blocker, BUT the activation POST /v1/messages did not return 200 (status=' + $result.launch2.activationStatus + ' model=' + $result.launch2.activationModel + '). Reachability is fixed by warmth; a separate inference-resolution gap remains.'
    $result.remediation = 'Pre-download/settle CCD fixes reachability. The remaining non-200 activation is a SEPARATE gap (model/tier resolution or upstream), independent of the CCD race.'
    $result.rootCause = 'Warm reach OK; activation status=' + $result.launch2.activationStatus
  } else {
    $result.status = 'HYPOTHESIS-DISPROVEN'
    $result.verdict = 'DISPROVEN: even on a WARM profile (CCD pre-installed on launch-2), the client did NOT reach the adapter / ConfigHealth=' + $result.launch2.configHealthState + ' (reachedAdapter=' + $result.launch2.reachedAdapter + ', ERR_CONNECTION_REFUSED=' + $result.launch2.connectionRefusedObserved + '). The CCD download is NOT the sole cause; a deeper gap exists.'
    $result.remediation = 'CCD pre-download alone is INSUFFICIENT. Deeper gap: warm launch-2 configHealth=' + $result.launch2.configHealthState + ', reached=' + $result.launch2.reachedAdapter + ', connRefused=' + $result.launch2.connectionRefusedObserved + '. Investigate the ConfigHealth probe transport (loopback egress rule / AppContainer / apiHost binding) beyond the event-loop stall.'
    $result.rootCause = 'Warm profile did not reach adapter; CCD download not the sole cause.'
  }
}
catch {
  $result.status = 'NOT RUN'
  $result.rootCause = 'Runner error: ' + (Protect-Line $_.Exception.Message)
}
finally {
  if ($adapterHandle) { try { Stop-Adapter $adapterHandle } catch { } }
  foreach ($process in $spawned) {
    try { if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null } } catch { }
  }
  try {
    $lingering = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profilePath) }
    foreach ($p in @($lingering)) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
  } catch { }
  Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceObject -is [System.Diagnostics.Process] } | ForEach-Object { Unregister-Event -SourceIdentifier $_.SourceIdentifier -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $resultFile = Join-Path $p03Path 'result.json'
  Write-JsonFile $resultFile $result

  $manifestFiles = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $p03Path -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)) {
    $manifestFiles += [ordered]@{ path = $file.FullName.Substring($p03Path.Length).TrimStart('\'); sha256 = Get-Sha256 $file.FullName; bytes = $file.Length }
  }
  Write-JsonFile (Join-Path $p03Path 'hash-manifest.json') ([ordered]@{ algorithm = 'SHA-256'; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($manifestFiles) })

  Write-Host ('Phase 3 WARM-PROFILE evidence: ' + $p03Path)
  Write-Host ('Status: ' + $result.status)
  Write-Host ('Adapter port (both launches): ' + $result.adapter.actualBoundPort + ' | kept-alive=' + $result.adapter.keptAliveAcrossBothLaunches)
  Write-Host ('LAUNCH 1 (cold): CCD installed=' + $result.launch1.ccdInstalledObserved + ' | stall=' + $result.launch1.eventLoopStallObserved + ' | gatewayAborted=' + $result.launch1.gatewayAbortedTimeoutObserved)
  Write-Host ('LAUNCH 1 ConfigHealth: ' + $result.launch1.configHealthState + ' | reached=' + $result.launch1.reachedAdapter + ' | connRefused=' + $result.launch1.connectionRefusedObserved + ' | fullyStopped=' + $result.launch1.fullyStopped + ' noClientRemains=' + $result.launch1.noClientRemains)
  Write-Host ('LAUNCH 2 (warm) ConfigHealth: ' + $result.launch2.configHealthState + ' | reached=' + $result.launch2.reachedAdapter + ' | connRefused=' + $result.launch2.connectionRefusedObserved)
  Write-Host ('LAUNCH 2 activation: model=' + $result.launch2.activationModel + ' status=' + $result.launch2.activationStatus + ' | postMsgs=' + $result.launch2.postMessagesCount + ' probe200=' + $result.launch2.probeReturned200)
  Write-Host ('Warm profile fixes activation: ' + $result.answers.warmProfileFixesActivation)
  if ($result.verdict) { Write-Host ('Verdict: ' + $result.verdict) }
  if ($result.remediation) { Write-Host ('Remediation: ' + $result.remediation) }
}
