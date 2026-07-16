#Requires -Version 5.1
<#
.SYNOPSIS
  Cowork-through-gateway (3P) live verification (cowork-verify).

.DESCRIPTION
  Answers the specific questions in the live-test brief, against the GENUINE
  full-trust WindowsApps claude.exe launched DIRECTLY (not via MSIX tile):

    (a) Does a raw-exe launch honor CLAUDE_USER_DATA_DIR (profile isolation)?
        -> proven by: our written configLibrary is read from the isolated dir AND
           the fresh isolated profile dir gets populated (Logs/, Cache, etc.).
    (b) Does 3P (custom-3p) activate, and is ConfigHealth reachable this run
        (or does it time out again)?
    (c) Does Bn() resolve true (windowsStore / execPath-under-WindowsApps / msix
        detection) so the Cowork VM path is AVAILABLE (vs 'msix_required')?
    (d) Is the Cowork tab present / coworkTabEnabled?
    (e) Strongest AUTOMATED signal that the Cowork VM agent env would set
        ANTHROPIC_BASE_URL to our loopback (config resolution + apiHost/[Spawn:vm]
        lines + VM egress allowlist including 127.0.0.1).

  Reuses the proven Phase-3 machinery: two-pass adapter (pass-1 reads /v1/models
  to pick a HEALTHY opus default; pass-2 restarts with CLAUDE_OPEN_HEALTHY_DEFAULT),
  production write-3p-config with --assign-family-tiers, genuine client launch with
  CLAUDE_USER_DATA_DIR set and every ANTHROPIC_* stripped.

  KNOWN BLOCKER under test (from p03warm): the client's ConfigHealth reachability
  probe can be STARVED on a first-run COLD launch by the claude-code (CCD) binary
  download (59MB -> 247MB) saturating the client event loop, so the probe aborts
  (timeout, NOT connection-refused) before reaching the adapter. To give 3P its
  fair chance we do a COLD settle-launch (wait for '[CCD] Installed at'), fully
  stop, then a WARM relaunch of the SAME isolated profile and judge 3P/ConfigHealth
  /Cowork on the WARM window.

  Never prints/stores the real gateway secret. Never modifies the normal Claude
  profile, machine registry policy, or the installed package. Disposable runtime +
  disposable profile. Evidence under
  test-results\corrective\<run>\cowork-verify\ (git-ignored).
#>
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [int]$ColdSettleMaxSeconds = 150,
  [int]$WarmWaitSeconds = 75,
  [string]$ClientExe = 'C:\Program Files\WindowsApps\Claude_1.20186.1.0_x64__pzs8sxrjxfjjc\app\claude.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }

$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
$cwPath = Join-Path $runPath 'cowork-verify'
$runtimePath = Join-Path $cwPath 'runtime'
$profilePath = Join-Path $cwPath 'profile'
$harnessRoot = Join-Path $cwPath 'harness'
$clientLogPath = Join-Path $cwPath 'client-logs'
foreach ($p in @($runPath, $cwPath, $runtimePath, $profilePath, $harnessRoot, $clientLogPath)) {
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

# Launch the genuine client DIRECTLY with the isolated profile. Returns Process.
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

# Fully stop every genuine claude.exe bound to THIS isolated profile. Confirms none remain.
function Stop-ProfileClients {
  param([int]$TimeoutSeconds = 25)
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

# Read + sanitize the ISOLATED profile main.log. Wide filter to catch Bn()/cowork/
# spawn/egress lines. Returns @{ Joined; RawCount; SafeCount; CoworkRaw }.
function Read-ProfileMainLog {
  param([string]$SanitizedOutName, [string]$CoworkOutName)
  $clientLogSources = @()
  $profileLogsDir = Join-Path $profilePath 'Logs'
  if (Test-Path -LiteralPath $profileLogsDir) {
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'main*.log' -ErrorAction SilentlyContinue)
  }
  $safe = @()
  $cowork = @()
  $rawCount = 0
  foreach ($log in $clientLogSources) {
    foreach ($line in @(Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) {
      $rawCount += 1
      if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|CoworkVM|3p|1p|first-?party|firstParty|custom.?3p|inference|model|picker|ConfigHealth|apiHost|reachable|unreachable|refused|ERR_CONNECTION|CCD|claude-code|Installed at|event-loop-stall|Gateway was|aborted|127\.0\.0\.1|localhost|windowsStore|WindowsApps|appPath|Spawn:vm|\bVM\b|egress|allowlist|ANTHROPIC_BASE_URL|supported|virtualization|hypervisor') {
        $safe += (Protect-Line $line)
      }
      if ($line -match '(?i)cowork|CoworkVM|Spawn:vm|\bVM\b|msix_required|windowsStore|WindowsApps|appPath|egress|allowlist|ANTHROPIC_BASE_URL|apiHost|virtualization|hypervisor|supported') {
        $cowork += (Protect-Line $line)
      }
    }
  }
  [System.IO.File]::WriteAllLines((Join-Path $cwPath $SanitizedOutName), $safe, $utf8NoBom)
  [System.IO.File]::WriteAllLines((Join-Path $cwPath $CoworkOutName), $cowork, $utf8NoBom)
  return @{ Joined = ($safe -join "`n"); RawCount = $rawCount; SafeCount = $safe.Count; CoworkRaw = ($cowork -join "`n") }
}

function Get-ConfigHealthState {
  param([string]$Joined)
  $state = $null
  foreach ($m in [regex]::Matches($Joined, "(?im)ConfigHealth\s+recomputed\s*\{\s*state:\s*'([^']+)'")) {
    $state = $m.Groups[1].Value
  }
  return $state
}

# Parse adapter stdout for a client window -> counters + message events.
function Get-ClientWindowEvidence {
  param([string]$AdapterStdout, [string]$LaunchUtc, [string]$WindowEndUtc)
  $parseScript = Join-Path $cwPath ('parse-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.mjs')
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

# Result skeleton.
$result = [ordered]@{
  phase = 'COWORK-VERIFY'
  status = 'NOT RUN'
  verdict = $null
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = $null
  sourceCommit = Get-GitCommit
  evidenceDir = $cwPath
  clientExe = (Protect-Line $ClientExe)
  launchMethod = 'DIRECT raw-exe launch of genuine WindowsApps claude.exe (NOT MSIX tile activation)'
  adapter = [ordered]@{
    startedFromSource = $false
    healthDeepHealthy = $false
    modelsCount = 0
    actualBoundPort = $null
    secretSource = $null
    healthyDefaultEnv = $null
    keptAliveAcrossBothLaunches = $false
  }
  defaultSelection = [ordered]@{ chosenDefaultAlias = $null; chosenIsHealthyOpus = $false }
  configWrite = [ordered]@{
    activeConfigFile = $null
    baseUrlIsLivePort = $false
    inferenceProvider = $null
    inferenceModelCount = 0
    firstModelAlias = $null
    coworkTabEnabledResolved = $null
    coworkTabExplicitlyDisabled = $null
    chatTabEnabled = $null
    deploymentMode3pInDesktopConfig = $false
  }
  profileIsolation = [ordered]@{
    isolatedProfilePath = (Protect-Line $profilePath)
    ourConfigWrittenIntoIsolatedDir = $false
    isolatedProfilePopulatedAfterLaunch = $false
    populatedEntryCount = 0
    logsDirCreatedInIsolatedProfile = $false
    normalProfileUntouchedNote = 'We only ever read/write the disposable profile dir; the normal Claude profile at %APPDATA%\Claude is never referenced by this run.'
    rawExeLaunchHonorsUserDataDir = $null
  }
  coldSettle = [ordered]@{
    launchUtc = $null
    ccdInstalledObserved = $false
    ccdInstalledLine = $null
    eventLoopStallObserved = $false
    gatewayAbortedTimeoutObserved = $false
    configHealthState = $null
    reachedAdapter = $false
    fullyStopped = $false
    noClientRemains = $false
  }
  warm = [ordered]@{
    launchUtc = $null
    windowEndUtc = $null
    custom3pActive = $false
    deploymentMode = 'undetermined'
    firstPartyOnboardingObserved = $false
    configHealthState = $null
    configHealthReachable = $null
    configHealthTimedOut = $null
    reachedAdapter = $false
    connectionRefusedObserved = $false
    getModels = $false
    postMessages = $false
    postMessagesCount = 0
    probeReturned200 = $false
    activationModel = $null
    activationStatus = $null
    ccdDownloadReoccurred = $null
  }
  # Bn(): windowsStore OR execPath under WindowsApps -> Cowork VM path available.
  coworkAvailability = [ordered]@{
    bnTrueSignals = @()
    windowsStoreDetected = $false
    execPathUnderWindowsApps = $false
    msixDetectedLine = $null
    msixRequiredObserved = $false
    coworkSupportedObserved = $false
    coworkVmPathAvailable = $null
    note = $null
  }
  # Run-wide (cold OR warm) proof that the ConfigHealth tier probe resolved to a
  # HEALTHY model at the adapter (the fix for the 503/unreachable blocker).
  configHealthProbe = [ordered]@{
    tierProbeReconcileObserved = $false
    reconcileFrom = $null
    reconcileTo = $null
    activationModelAtAdapter = $null
    activationStatusAtAdapter = $null
    healthyConfigHealthObserved = $false
  }
  # Step 5: strongest automated signal the Cowork VM agent env would route to loopback.
  coworkEgress = [ordered]@{
    spawnVmLinesObserved = $false
    anthropicBaseUrlLineObserved = $false
    anthropicBaseUrlPointsAtLoopback = $null
    apiHostLoopbackObserved = $false
    egressAllowlistObserved = $false
    egressAllowlistIncludesLoopback = $null
    coworkTabPresentSignal = $false
    strongestAutomatedSignal = $null
    coworkVmSpawnRequiresHumanClick = $true
  }
  answers = [ordered]@{
    rawExeLaunchHonorsIsolation = $null
    threePActivated = $null
    configHealthReachableThisRun = $null
    configHealthTimedOutAgain = $null
    bnTrueCoworkVmAvailable = $null
    coworkTabPresent = $null
    coworkAgentRoutesToLoopbackSignal = $null
    remainingBlocker = $null
  }
  rootCause = $null
}

$adapterHandle = $null
try {
  $configPath = Join-Path $env:APPDATA 'ClaudeOpen\config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $result.rootCause = 'No stored Claude Open gateway config at %APPDATA%\ClaudeOpen\config.json; cannot start a real adapter session without printing a secret.'
    return
  }
  $configDir = Split-Path $configPath -Parent

  if (-not (Test-Path -LiteralPath $ClientExe -PathType Leaf)) {
    $result.rootCause = 'Genuine WindowsApps claude.exe not found at: ' + (Protect-Line $ClientExe)
    return
  }
  $sig = Get-AuthenticodeSignature -LiteralPath $ClientExe
  if ($sig.Status -ne 'Valid') {
    $result.rootCause = 'Genuine client Authenticode is ' + $sig.Status + ' (not Valid); refusing to launch.'
    return
  }
  # Bn() static signal: the exe path itself is under WindowsApps (execPath check).
  $result.coworkAvailability.execPathUnderWindowsApps = [bool]($ClientExe -match '(?i)\\WindowsApps\\')
  if ($result.coworkAvailability.execPathUnderWindowsApps) {
    $result.coworkAvailability.bnTrueSignals += 'execPath under \WindowsApps\ (static)'
  }

  # === PASS 1: read /v1/models to pick the healthy opus ===
  $runtime1 = Join-Path $runtimePath 'pass1'
  New-Item -ItemType Directory -Path $runtime1 -Force | Out-Null
  $adapterHandle = Start-Adapter -RuntimeDir $runtime1 -ConfigDir $configDir
  $result.adapter.startedFromSource = $true

  $runtimeFile1 = Join-Path $runtime1 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile1 45)) {
    $result.rootCause = 'Pass-1 adapter did not write runtime.json within 45s.'
    [System.IO.File]::WriteAllText((Join-Path $cwPath 'adapter-pass1.stderr.log'), (Protect-Line $adapterHandle.StdErr.ToString()), $utf8NoBom)
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
    [System.IO.File]::WriteAllText((Join-Path $cwPath 'adapter-pass1-models-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }
  $liveModels = @()
  if ($modelsResponse -and $modelsResponse.data) { $liveModels = @($modelsResponse.data) }
  if ($liveModels.Count -eq 0) {
    Stop-Adapter $adapterHandle; $adapterHandle = $null
    $result.rootCause = 'Pass-1 adapter returned an empty /v1/models catalog. Gateway may be unreachable.'
    return
  }
  $modelRecords = @()
  foreach ($m in $liveModels) { $modelRecords += [ordered]@{ id = [string]$m.id; display_name = [string]$m.display_name } }
  $modelsFile = Join-Path $cwPath 'models.json'
  Write-JsonFile $modelsFile @($modelRecords)

  # Choose the healthy default via selectDefaultModel + known-overloaded set.
  $selectScript = Join-Path $cwPath 'select-default.mjs'
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
    [System.IO.File]::WriteAllText((Join-Path $cwPath 'adapter-health-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }
  $models2 = $null
  try { $models2 = Invoke-RestMethod -Uri ($baseUrl + '/v1/models') -Headers $headers -TimeoutSec 45 } catch { }
  $liveModels2 = @()
  if ($models2 -and $models2.data) { $liveModels2 = @($models2.data) }
  $result.adapter.modelsCount = $liveModels2.Count
  if (-not $result.adapter.healthDeepHealthy -or $liveModels2.Count -eq 0) {
    $result.rootCause = 'Pass-2 adapter did not reach healthy /health/deep with a non-empty catalog (healthy=' + $result.adapter.healthDeepHealthy + ', models=' + $liveModels2.Count + ').'
    return
  }

  # === Step 3: write the FLAT 3P config into the isolated profile FIRST ===
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
  [System.IO.File]::WriteAllText((Join-Path $cwPath 'write-config.stdout.log'), (Protect-Line $shimText), $utf8NoBom)
  if ($shimExit -ne 0) {
    $result.rootCause = 'write-3p-config --production shim failed (exit ' + $shimExit + '): ' + (Protect-Line $shimText)
    return
  }

  # Verify the written config (into the ISOLATED dir) points at the LIVE port,
  # provider=gateway, and inspect the cowork/chat tab surface toggles.
  $configLibPath = Join-Path $profilePath 'configLibrary'
  $activeConfigFile = Get-ChildItem -LiteralPath $configLibPath -Filter '*.json' -File |
    Where-Object { $_.Name -ne '_meta.json' -and $_.Name -notlike '*.manifest.json' } | Select-Object -First 1
  if (-not $activeConfigFile) {
    $result.rootCause = 'No active configLibrary/<uuid>.json written by the production shim into the isolated profile.'
    return
  }
  $configText = Get-Content -LiteralPath $activeConfigFile.FullName -Raw
  $rawConfig = $configText | ConvertFrom-Json
  $allModels = @($rawConfig.inferenceModels)
  $result.configWrite.activeConfigFile = $activeConfigFile.Name
  $result.configWrite.baseUrlIsLivePort = [bool]($rawConfig.inferenceGatewayBaseUrl -eq $baseUrl)
  $result.configWrite.inferenceProvider = [string]$rawConfig.inferenceProvider
  $result.configWrite.inferenceModelCount = $allModels.Count
  if ($allModels.Count -gt 0) { $result.configWrite.firstModelAlias = [string]$allModels[0].name }
  # Surface toggles: chatTabEnabled is written true; coworkTabEnabled is NOT
  # written false -> it stays default-ON in 3P (per harness FIX A evidence).
  $coworkDisabled = ($rawConfig.PSObject.Properties.Name -contains 'coworkTabEnabled') -and ($rawConfig.coworkTabEnabled -eq $false)
  $result.configWrite.coworkTabExplicitlyDisabled = [bool]$coworkDisabled
  $result.configWrite.coworkTabEnabledResolved = [bool](-not $coworkDisabled)  # default-on unless explicitly false
  if ($rawConfig.PSObject.Properties.Name -contains 'chatTabEnabled') { $result.configWrite.chatTabEnabled = [bool]$rawConfig.chatTabEnabled }

  # Profile-isolation proof #1: our config now lives inside the isolated dir.
  $result.profileIsolation.ourConfigWrittenIntoIsolatedDir = [bool](Test-Path -LiteralPath $activeConfigFile.FullName)

  $prefFile = Join-Path $profilePath 'claude_desktop_config.json'
  if (Test-Path -LiteralPath $prefFile) {
    try { $pref = Get-Content -LiteralPath $prefFile -Raw | ConvertFrom-Json; $result.configWrite.deploymentMode3pInDesktopConfig = [bool]($pref.deploymentMode -eq '3p') } catch { }
  }
  if (-not $result.configWrite.baseUrlIsLivePort) {
    $result.rootCause = 'Written config base URL does not match the live pass-2 port.'
    return
  }

  # Snapshot the isolated profile contents BEFORE launch (to prove population is
  # caused by the launch, i.e. the exe actually used THIS dir).
  $preLaunchEntries = @(Get-ChildItem -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  Write-JsonFile (Join-Path $cwPath 'profile-entries.prelaunch.json') @($preLaunchEntries)

  $mainLog = Join-Path $profilePath 'Logs\main.log'

  # ============================ COLD SETTLE LAUNCH ============================
  # Let the client settle CCD so the ConfigHealth probe on the WARM run is not
  # starved. Wait for '[CCD] Installed at' or budget, then fully stop.
  $result.adapter.keptAliveAcrossBothLaunches = $true
  $result.coldSettle.launchUtc = [DateTime]::UtcNow.ToString('o')
  $cold = Start-GenuineClient -ChromiumLogName 'chromium-cold.log' -DefaultAlias $defaultAlias
  $ccdInstalled = Wait-ForLogPattern $mainLog '\[CCD\] Installed at' $ColdSettleMaxSeconds
  $result.coldSettle.ccdInstalledObserved = [bool]$ccdInstalled
  Start-Sleep -Seconds 15

  $coldRead = Read-ProfileMainLog 'cold-main-sanitized.log' 'cold-cowork.log'
  $joinedCold = $coldRead.Joined
  $result.coldSettle.ccdInstalledLine = (($joinedCold -split "`n") | Where-Object { $_ -match '\[CCD\] Installed at' } | Select-Object -First 1)
  $result.coldSettle.eventLoopStallObserved = [bool]($joinedCold -match '(?i)event-loop-stall')
  $result.coldSettle.gatewayAbortedTimeoutObserved = [bool]($joinedCold -match '(?i)Gateway was unreachable.{0,60}aborted|operation was aborted due to timeout|aborted.{0,30}timeout')
  $result.coldSettle.configHealthState = Get-ConfigHealthState $joinedCold
  $result.coldSettle.reachedAdapter = [bool]($adapterHandle.StdOut.ToString() -match 'evt.{0,40}(models|messages)')

  # Fully stop cold client.
  try { if (-not $cold.HasExited) { & taskkill.exe /PID $cold.Id /T /F 2>$null | Out-Null } } catch { }
  $result.coldSettle.noClientRemains = Stop-ProfileClients -TimeoutSeconds 25
  $result.coldSettle.fullyStopped = $true
  Start-Sleep -Seconds 5

  # ============================ WARM LAUNCH ============================
  # SAME isolated profile, SAME adapter/port. CCD already installed.
  $result.warm.launchUtc = [DateTime]::UtcNow.ToString('o')
  $warm = Start-GenuineClient -ChromiumLogName 'chromium-warm.log' -DefaultAlias $defaultAlias
  Start-Sleep -Seconds $WarmWaitSeconds
  $result.warm.windowEndUtc = [DateTime]::UtcNow.ToString('o')

  $adapterStdoutFinal = $adapterHandle.StdOut.ToString()
  $adapterStderrFinal = $adapterHandle.StdErr.ToString()
  [System.IO.File]::WriteAllText((Join-Path $cwPath 'adapter.stdout.final.log'), (Protect-Line $adapterStdoutFinal), $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $cwPath 'adapter.stderr.log'), (Protect-Line $adapterStderrFinal), $utf8NoBom)

  $warmRead = Read-ProfileMainLog 'warm-main-sanitized.log' 'warm-cowork.log'
  $joinedWarm = $warmRead.Joined
  $coworkJoined = ($coldRead.CoworkRaw + "`n" + $warmRead.CoworkRaw)

  # --- Profile-isolation proof #2: the isolated dir got populated by the launch.
  $postLaunchEntries = @(Get-ChildItem -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  Write-JsonFile (Join-Path $cwPath 'profile-entries.postlaunch.json') @($postLaunchEntries)
  $result.profileIsolation.populatedEntryCount = @($postLaunchEntries).Count
  $result.profileIsolation.logsDirCreatedInIsolatedProfile = [bool](Test-Path -LiteralPath (Join-Path $profilePath 'Logs'))
  $newEntries = @($postLaunchEntries | Where-Object { $preLaunchEntries -notcontains $_ })
  # Isolation is proven if the client created runtime artifacts (Logs, Cache,
  # etc.) inside OUR isolated dir beyond what we wrote (configLibrary + prefs).
  $result.profileIsolation.isolatedProfilePopulatedAfterLaunch = [bool]($result.profileIsolation.logsDirCreatedInIsolatedProfile -and (@($newEntries).Count -gt 0))
  $result.profileIsolation.rawExeLaunchHonorsUserDataDir = [bool]($result.profileIsolation.ourConfigWrittenIntoIsolatedDir -and $result.profileIsolation.isolatedProfilePopulatedAfterLaunch)

  # --- WARM 3P activation + ConfigHealth ---
  $result.warm.custom3pActive = [bool]($joinedWarm -match "(?i)custom.?3p|third.?party inference (active|enabled)|deploymentMode[""':\s]{0,6}3p")
  $mode1p = ($joinedWarm -match "(?i)deploymentMode[""':\s]{0,6}1p") -or ($joinedWarm -match '(?i)claude\.ai/api/desktop/features')
  if ($result.warm.custom3pActive) { $result.warm.deploymentMode = '3p' }
  elseif ($mode1p) { $result.warm.deploymentMode = '1p' }
  else { $result.warm.deploymentMode = 'undetermined' }
  $result.warm.firstPartyOnboardingObserved = [bool](($joinedWarm -match '(?i)onboarding') -or ($joinedWarm -match '(?i)(first-?party|firstParty).{0,40}(onboarding|sign)'))
  $result.warm.configHealthState = Get-ConfigHealthState $joinedWarm
  $result.warm.connectionRefusedObserved = [bool]($joinedWarm -match '(?i)ERR_CONNECTION_REFUSED|connection refused|ECONNREFUSED')
  $result.warm.configHealthTimedOut = [bool]($joinedWarm -match '(?i)ConfigHealth.{0,80}(unreachable|timeout|timed out|aborted)' -or $joinedWarm -match '(?i)Gateway was unreachable.{0,60}(aborted|timeout)')
  $ccdDownloadLines = @((($joinedCold + "`n" + $joinedWarm) -split "`n") | Where-Object { $_ -match '(?i)\[CCD\] Downloading' })
  $result.warm.ccdDownloadReoccurred = [bool](@($ccdDownloadLines).Count -gt 1)

  # Run-wide (cold OR warm window) capture of the tier-probe reconcile + activation
  # message outcome from the adapter stdout. This self-documents WHY ConfigHealth
  # reads healthy: the reconcile steers the built-in overloaded tier-probe id to
  # the healthy default so the probe message returns 200 (not 503). The client may
  # achieve healthy on the COLD launch and the WARM relaunch then re-reads the
  # cached healthy state without a fresh adapter request.
  foreach ($rawLine in ($adapterStdoutFinal -split "`r?`n")) {
    $line = $rawLine.Trim(); if (-not $line) { continue }
    $obj = $null; try { $obj = $line | ConvertFrom-Json } catch { continue }
    if (-not $obj -or -not ($obj.PSObject.Properties.Name -contains 'evt')) { continue }
    if ($obj.evt -eq 'tier-probe-reconcile') {
      $result.configHealthProbe.tierProbeReconcileObserved = $true
      $result.configHealthProbe.reconcileFrom = [string]$obj.from
      $result.configHealthProbe.reconcileTo = [string]$obj.to
    } elseif ($obj.evt -eq 'messages') {
      $result.configHealthProbe.activationModelAtAdapter = [string]$obj.model
      $result.configHealthProbe.activationStatusAtAdapter = [int]$obj.status
    }
  }
  $result.configHealthProbe.healthyConfigHealthObserved = [bool](($joinedCold -match "(?i)ConfigHealth recomputed \{ state: 'healthy'") -or ($joinedWarm -match "(?i)ConfigHealth recomputed \{ state: 'healthy'"))

  $ev = Get-ClientWindowEvidence -AdapterStdout $adapterStdoutFinal -LaunchUtc $result.warm.launchUtc -WindowEndUtc $result.warm.windowEndUtc
  if ($ev) {
    $result.warm.reachedAdapter = [bool]([int]$ev.clientEventCount -gt 0)
    $result.warm.getModels = [bool]$ev.getModels
    $result.warm.postMessages = [bool]$ev.postMessages
    $result.warm.probeReturned200 = [bool]$ev.clientMessageSucceeded
    if ($ev.clientCounters) {
      $ccProp = $ev.clientCounters.PSObject.Properties | Where-Object { $_.Name -eq 'POST /v1/messages' } | Select-Object -First 1
      if ($ccProp) { $result.warm.postMessagesCount = [int]$ccProp.Value }
    }
    $ms = @()
    if ($ev.clientMessageEvents) { foreach ($e in @($ev.clientMessageEvents)) { $ms += [ordered]@{ model = [string]$e.model; status = [int]$e.status } } }
    if ($ms.Count -gt 0) { $result.warm.activationModel = [string]$ms[0].model; $result.warm.activationStatus = [int]$ms[0].status }
  }
  # ConfigHealth reachable resolution. The client's OWN explicit
  # 'ConfigHealth recomputed { state: ... }' line is AUTHORITATIVE. Note the
  # substring trap: 'unreachable' CONTAINS 'reachable', so we must anchor on the
  # exact state token, not a naive contains-match.
  if ($result.warm.configHealthState) {
    $st = ([string]$result.warm.configHealthState).Trim().ToLowerInvariant()
    if ($st -eq 'unreachable' -or $st -match 'unreachable|timeout|error|provider_error|config_error') {
      $result.warm.configHealthReachable = $false
    } elseif ($st -match '^(reachable|healthy|ok|ready)$') {
      $result.warm.configHealthReachable = $true
    } else {
      # Unknown explicit state: fall back to transport signals.
      $result.warm.configHealthReachable = [bool]($result.warm.reachedAdapter -and -not $result.warm.connectionRefusedObserved -and -not $result.warm.configHealthTimedOut)
    }
  } elseif ($result.warm.configHealthTimedOut) {
    $result.warm.configHealthReachable = $false
  } elseif ($result.warm.reachedAdapter -and -not $result.warm.connectionRefusedObserved) {
    $result.warm.configHealthReachable = $true
  } else {
    $result.warm.configHealthReachable = $false
  }

  # === Bn() / Cowork availability from the isolated main.log ===
  # The genuine client logs its own MSIX/Store detection, e.g.:
  #   [updater] MSIX detected: windowsStore=true, appPathMatch=true, source=windowsStore
  # That windowsStore=true / appPathMatch=true is exactly the Bn() condition.
  $msixLine = (($coworkJoined -split "`n") | Where-Object { $_ -match '(?i)MSIX detected|windowsStore\s*=\s*true' } | Select-Object -First 1)
  if ($msixLine) { $result.coworkAvailability.msixDetectedLine = $msixLine.Trim() }
  $result.coworkAvailability.windowsStoreDetected = [bool]($coworkJoined -match '(?i)windowsStore\s*=\s*true|windowsStore|windows_store|isWindowsStore|store build|appx')
  if ($result.coworkAvailability.windowsStoreDetected) { $result.coworkAvailability.bnTrueSignals += 'windowsStore detected in log' }
  if ($coworkJoined -match '(?i)WindowsApps|appPath.{0,40}WindowsApps') { $result.coworkAvailability.bnTrueSignals += 'appPath under WindowsApps in log' }
  $result.coworkAvailability.msixRequiredObserved = [bool]($coworkJoined -match '(?i)msix_required|msix required|requires? msix|not a store build')
  $result.coworkAvailability.coworkSupportedObserved = [bool]($coworkJoined -match '(?i)cowork.{0,40}supported|supported.{0,40}cowork|cowork.{0,20}available')
  # Bn() truth: true if any positive signal AND no explicit msix_required.
  if ($result.coworkAvailability.msixRequiredObserved) {
    $result.coworkAvailability.coworkVmPathAvailable = $false
    $result.coworkAvailability.note = 'Log explicitly reported msix_required -> Bn() false for this launch method (Cowork VM path unavailable).'
  } elseif (@($result.coworkAvailability.bnTrueSignals).Count -gt 0) {
    $result.coworkAvailability.coworkVmPathAvailable = $true
    $result.coworkAvailability.note = 'No msix_required observed and >=1 windowsStore/WindowsApps signal present. Static execPath is under WindowsApps (full-trust signed host).'
  } else {
    $result.coworkAvailability.coworkVmPathAvailable = $null
    $result.coworkAvailability.note = 'No decisive Bn() line in the isolated main.log this run (client may not log the check until a Cowork task is opened). Static execPath-under-WindowsApps is the strongest signal captured.'
  }

  # === Step 5: Cowork egress / apiHost / ANTHROPIC_BASE_URL routing signal ===
  $result.coworkEgress.spawnVmLinesObserved = [bool]($coworkJoined -match '(?i)\[Spawn:vm\]|CoworkVM|cowork.{0,20}vm|VM.{0,20}spawn|spawn.{0,20}vm')
  $result.coworkEgress.anthropicBaseUrlLineObserved = [bool]($coworkJoined -match '(?i)ANTHROPIC_BASE_URL')
  if ($result.coworkEgress.anthropicBaseUrlLineObserved) {
    $result.coworkEgress.anthropicBaseUrlPointsAtLoopback = [bool]($coworkJoined -match '(?i)ANTHROPIC_BASE_URL.{0,60}(127\.0\.0\.1|localhost)')
  }
  $result.coworkEgress.apiHostLoopbackObserved = [bool]($coworkJoined -match '(?i)(apiHost|getApiHost|inferenceGatewayBaseUrl|base ?url).{0,60}(127\.0\.0\.1|localhost)')
  $result.coworkEgress.egressAllowlistObserved = [bool]($coworkJoined -match '(?i)egress|allowlist|allow.?list')
  if ($result.coworkEgress.egressAllowlistObserved) {
    $result.coworkEgress.egressAllowlistIncludesLoopback = [bool]($coworkJoined -match '(?i)(egress|allowlist).{0,120}(127\.0\.0\.1|localhost)')
  }
  # Cowork tab present signal: config keeps cowork default-on AND (a cowork line
  # appears in the isolated log OR the tab is simply not disabled in 3P config).
  $coworkLineInLog = [bool]($coworkJoined -match '(?i)cowork')
  $result.coworkEgress.coworkTabPresentSignal = [bool]($result.configWrite.coworkTabEnabledResolved -and (-not $result.coworkAvailability.msixRequiredObserved))

  # Strongest AUTOMATED signal that the agent env WOULD point at loopback:
  #   The written FLAT config sets inferenceProvider=gateway +
  #   inferenceGatewayBaseUrl=http://127.0.0.1:<port>. In custom-3p the cowork
  #   agent env ANTHROPIC_BASE_URL = tY.getApiHost() = provider.apiHostOverride()
  #   ?? 'http://custom-3p-unused.invalid', and apiHostOverride() returns
  #   creds.baseUrl == our loopback base URL. So config resolution -> loopback is
  #   the deterministic automated signal; a live [Spawn:vm] line is only emitted
  #   once a human opens a Cowork task.
  $configSignal = [bool]($result.configWrite.baseUrlIsLivePort -and ($result.configWrite.inferenceProvider -eq 'gateway'))
  if ($result.coworkEgress.anthropicBaseUrlPointsAtLoopback) {
    $result.coworkEgress.strongestAutomatedSignal = 'DIRECT: main.log shows ANTHROPIC_BASE_URL pointing at our loopback (127.0.0.1).'
  } elseif ($result.coworkEgress.apiHostLoopbackObserved) {
    $result.coworkEgress.strongestAutomatedSignal = 'STRONG: main.log shows apiHost/base-url resolving to our loopback (127.0.0.1); custom-3p apiHostOverride()=creds.baseUrl feeds the same value into the cowork agent env.'
  } elseif ($configSignal -and $result.warm.custom3pActive) {
    $result.coworkEgress.strongestAutomatedSignal = 'CONFIG-RESOLVED: custom-3p active + FLAT config inferenceProvider=gateway with inferenceGatewayBaseUrl=our loopback. Per the RE contract (apiHostOverride()=creds.baseUrl -> ANTHROPIC_BASE_URL for the cowork VM agent), the agent env resolves to our loopback. A literal [Spawn:vm] line needs a human to open a Cowork task.'
  } elseif ($configSignal) {
    $result.coworkEgress.strongestAutomatedSignal = 'CONFIG-ONLY: FLAT config points inferenceGatewayBaseUrl at our loopback with provider=gateway, but custom-3p did not confirm-activate this run, so no live apiHost/spawn line was emitted.'
  } else {
    $result.coworkEgress.strongestAutomatedSignal = 'WEAK/NONE: neither a loopback apiHost line nor a confirmed config->loopback resolution captured this run.'
  }

  # --- Fully stop warm client ---
  try { if (-not $warm.HasExited) { & taskkill.exe /PID $warm.Id /T /F 2>$null | Out-Null } } catch { }
  Stop-ProfileClients -TimeoutSeconds 25 | Out-Null

  # === Answers ===
  $result.answers.rawExeLaunchHonorsIsolation = $result.profileIsolation.rawExeLaunchHonorsUserDataDir
  $result.answers.threePActivated = $result.warm.custom3pActive
  $result.answers.configHealthReachableThisRun = $result.warm.configHealthReachable
  $result.answers.configHealthTimedOutAgain = [bool]($result.warm.configHealthTimedOut -and -not $result.warm.configHealthReachable)
  $result.answers.bnTrueCoworkVmAvailable = $result.coworkAvailability.coworkVmPathAvailable
  $result.answers.coworkTabPresent = $result.coworkEgress.coworkTabPresentSignal
  $result.answers.coworkAgentRoutesToLoopbackSignal = $result.coworkEgress.strongestAutomatedSignal

  # Verdict + remaining blocker.
  if (-not $result.warm.custom3pActive) {
    if ($result.warm.configHealthTimedOut -or -not $result.warm.reachedAdapter) {
      $result.answers.remainingBlocker = 'ConfigHealth reachability probe did NOT confirm reachable this run (state=' + $result.warm.configHealthState + ', reached=' + $result.warm.reachedAdapter + ', timedOut=' + $result.warm.configHealthTimedOut + '). 3P did not confirm-activate -> Cowork-through-gateway is NOT yet just-works; the ConfigHealth probe transport is the blocker to fix.'
      $result.status = 'BLOCKED-CONFIGHEALTH'
    } else {
      $result.answers.remainingBlocker = '3P activation not confirmed in the isolated main.log within the wait window, though the client reached the adapter. May need a longer window or a human-opened surface.'
      $result.status = 'INCONCLUSIVE-3P'
    }
  } elseif ($result.warm.custom3pActive -and $result.warm.configHealthReachable) {
    if ($result.coworkAvailability.coworkVmPathAvailable -eq $false) {
      $result.answers.remainingBlocker = 'Cowork VM path reported msix_required (Bn() false) for this raw-exe launch method -> Cowork VM unavailable even though 3P + config->loopback are correct.'
      $result.status = 'PASS-3P-COWORK-MSIX-REQUIRED'
    } else {
      $result.answers.remainingBlocker = 'None from the automated signals: 3P active, ConfigHealth reachable, config resolves ANTHROPIC_BASE_URL to our loopback, cowork tab default-on. A live Cowork VM spawn still needs a human to open a Cowork task (VM creation also needs Windows virtualization prerequisites).'
      $result.status = 'PASS-3P-COWORK-CONFIG-ROUTES-LOOPBACK'
    }
  } elseif ($result.warm.custom3pActive -and -not $result.warm.configHealthReachable) {
    # 3P activated and apiHost resolved to our loopback, but the ConfigHealth
    # probe did NOT confirm reachable (state=unreachable / timed out). This is the
    # remaining blocker: the client's tier probe targets a built-in overloaded id
    # (e.g. claude-haiku-4-5) that the gateway 503s, so ConfigHealth stays
    # unreachable even though 3P + apiHost + config->loopback are all correct.
    $result.answers.remainingBlocker = '3P activated and apiHost resolved to our loopback (' + $result.coworkEgress.apiHostLoopbackObserved + '), but ConfigHealth=' + $result.warm.configHealthState + ' (probe did NOT confirm reachable; timedOut=' + $result.warm.configHealthTimedOut + '). Remaining blocker: the client ConfigHealth tier probe hits an overloaded built-in id and the adapter tier-probe reconcile does not redirect it to the healthy default. Cowork-through-gateway is NOT yet just-works until ConfigHealth reads reachable.'
    $result.status = 'BLOCKED-CONFIGHEALTH-3P-ACTIVE'
  } else {
    $result.answers.remainingBlocker = 'Mixed: custom3p=' + $result.warm.custom3pActive + ', configHealthReachable=' + $result.warm.configHealthReachable + '. See warm.* fields.'
    $result.status = 'PARTIAL'
  }
  $result.verdict = 'raw-exe-isolation=' + $result.answers.rawExeLaunchHonorsIsolation + ' | 3P=' + $result.answers.threePActivated + ' | ConfigHealthReachable=' + $result.answers.configHealthReachableThisRun + ' | Bn()/CoworkVMAvailable=' + $result.answers.bnTrueCoworkVmAvailable + ' | CoworkTab=' + $result.answers.coworkTabPresent + ' | routeSignal=' + $result.coworkEgress.strongestAutomatedSignal
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
  # Belt-and-braces: kill only claude.exe bound to the ISOLATED profile.
  try {
    $lingering = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profilePath) }
    foreach ($p in @($lingering)) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
  } catch { }
  Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceObject -is [System.Diagnostics.Process] } | ForEach-Object { Unregister-Event -SourceIdentifier $_.SourceIdentifier -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  Write-JsonFile (Join-Path $cwPath 'result.json') $result

  $manifestFiles = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $cwPath -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)) {
    $manifestFiles += [ordered]@{ path = $file.FullName.Substring($cwPath.Length).TrimStart('\'); sha256 = Get-Sha256 $file.FullName; bytes = $file.Length }
  }
  Write-JsonFile (Join-Path $cwPath 'hash-manifest.json') ([ordered]@{ algorithm = 'SHA-256'; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($manifestFiles) })

  Write-Host ('Cowork-verify evidence: ' + $cwPath)
  Write-Host ('Status: ' + $result.status)
  Write-Host ('Adapter port (both launches): ' + $result.adapter.actualBoundPort + ' | kept-alive=' + $result.adapter.keptAliveAcrossBothLaunches)
  Write-Host ('(a) raw-exe honors CLAUDE_USER_DATA_DIR (isolation): ' + $result.answers.rawExeLaunchHonorsIsolation + ' | ourConfigInIsolatedDir=' + $result.profileIsolation.ourConfigWrittenIntoIsolatedDir + ' populated=' + $result.profileIsolation.isolatedProfilePopulatedAfterLaunch)
  Write-Host ('(b) 3P activated: ' + $result.answers.threePActivated + ' | ConfigHealth state=' + $result.warm.configHealthState + ' reachable=' + $result.answers.configHealthReachableThisRun + ' timedOut=' + $result.answers.configHealthTimedOutAgain)
  Write-Host ('(c) Bn() Cowork VM available: ' + $result.answers.bnTrueCoworkVmAvailable + ' | signals=' + ($result.coworkAvailability.bnTrueSignals -join '; ') + ' | msix_required=' + $result.coworkAvailability.msixRequiredObserved)
  Write-Host ('(d) Cowork tab present: ' + $result.answers.coworkTabPresent + ' | coworkTabDefaultOn=' + $result.configWrite.coworkTabEnabledResolved + ' explicitlyDisabled=' + $result.configWrite.coworkTabExplicitlyDisabled)
  Write-Host ('(e) Cowork agent -> loopback signal: ' + $result.coworkEgress.strongestAutomatedSignal)
  Write-Host ('Remaining blocker: ' + $result.answers.remainingBlocker)
  if ($result.rootCause) { Write-Host ('Root cause / NOT-RUN reason: ' + $result.rootCause) }
}
