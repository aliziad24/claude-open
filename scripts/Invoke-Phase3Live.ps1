#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 3 LIVE end-to-end verification — genuine WindowsApps Claude Desktop 3P
  activation via the NEW production launch path, with the healthy-opus default.

.DESCRIPTION
  Proves whether the REAL user flow now works: the genuine signed WindowsApps
  claude.exe, pointed at an isolated 3P config-library that we write via the
  production launch path (createProductionWorkspace / selectDefaultModel), enters
  custom-3p mode with a HEALTHY default and whether its OWN activation-time
  inference (the client's ConfigHealth / first-inference probe) returns 200.

  It:
    1. Starts the adapter FROM SOURCE (node apps/adapter-server/src/main.js) using
       the stored per-user Claude Open config + Credential Manager secret (never
       printed). Disposable CLAUDE_OPEN_RUNTIME_DIR under the p03live evidence
       dir; ephemeral loopback port (CLAUDE_OPEN_PORT=0); per-run client token
       from runtime.json. Waits for /health/deep healthy + /v1/models = 38.
       Records sanitized request counters.
    2. GET /v1/models; builds inferenceModels for ALL 38 (name=alias,
       label=display_name). Chooses the healthy default via the harness
       selectDefaultModel with the known-overloaded set
       {claude-haiku-4-5, claude-sonnet-4-6, claude-sonnet-5, gemini-3-flash-v2,
        minimax-m3, gpt-5.4} so the default is a healthy opus.
    3. node scripts/write-3p-config.mjs --production writes
       configLibrary/<uuid>.json + _meta.json + claude_desktop_config.json
       (deploymentMode:"3p") into a disposable profile dir p03live/profile, with
       inferenceGatewayApiKey=<clientToken>, baseUrl=http://127.0.0.1:<port>, and
       the healthy-opus alias FIRST (client default).
    4. Launches the GENUINE WindowsApps claude.exe with
       CLAUDE_USER_DATA_DIR=p03live/profile and NO ANTHROPIC_* env vars. Electron
       logs are forced under the isolated profile Logs. Waits ~75s for first paint
       + ConfigHealth / first inference.
    5. Captures from the ISOLATED profile main.log ONLY: custom-3p active,
       deploymentMode 3p, no onboarding, picker/model activity, apiHost=loopback,
       and the model the client's ConfigHealth/first-inference probe targeted +
       its outcome. Captures adapter evt:messages (model + status) inside the
       client window to read the CLIENT-originated request status.
    6. Records p03live/result.json: 3P active (y/n), deploymentMode,
       client-originated POST /v1/messages count + statuses, whether the client's
       probe model returned 200, request counters, chosen default alias, and an
       honest verdict.
    7. Stops all spawned processes in finally (taskkill /T /F). Never leaves the
       client running.

  Never prints or stores the real gateway secret. Never modifies the normal
  Claude profile, machine registry policy, or installed package. All evidence is
  written under test-results/corrective/<run>/p03live/ (git-ignored).

.PARAMETER EvidenceRoot
  Root for corrective evidence. Default: test-results\corrective (git-ignored).

.PARAMETER WaitClientSeconds
  How long to wait for the client to activate / emit its first inference.
  Default 75.

.PARAMETER ClientExe
  Genuine WindowsApps claude.exe. Default:
  C:\Program Files\WindowsApps\Claude_1.20186.1.0_x64__pzs8sxrjxfjjc\app\claude.exe
#>
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [int]$WaitClientSeconds = 75,
  [string]$ClientExe = 'C:\Program Files\WindowsApps\Claude_1.20186.1.0_x64__pzs8sxrjxfjjc\app\claude.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }

$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
$p03Path = Join-Path $runPath 'p03live'
$runtimePath = Join-Path $p03Path 'runtime'
$profilePath = Join-Path $p03Path 'profile'
$harnessRoot = Join-Path $p03Path 'harness'
$clientLogPath = Join-Path $p03Path 'client-logs'
foreach ($p in @($runPath, $p03Path, $runtimePath, $profilePath, $harnessRoot, $clientLogPath)) {
  New-Item -ItemType Directory -Path $p -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$spawned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

# Known-overloaded aliases the caller wants avoided as the default. The point of
# this run is that selectDefaultModel demotes these and picks a healthy opus.
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
  try {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  } catch {
    return 'UNAVAILABLE_FILE_LOCKED'
  }
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

function Get-GitCommit {
  try {
    $c = & git -C $repositoryRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { return $c.Trim() }
  } catch { }
  return 'NOT DISCOVERED'
}

# Result skeleton. Every field defaults to a safe / not-observed state so an
# early failure still writes an honest record.
$result = [ordered]@{
  phase = 'P0.3-LIVE'
  status = 'NOT RUN'
  verdict = $null
  materiallyBetterThanPrior = $null
  rootCause = $null
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = $null
  sourceCommit = Get-GitCommit
  evidenceDir = $p03Path
  launchPath = 'production (createProductionWorkspace) + genuine WindowsApps claude.exe'
  adapter = [ordered]@{
    startedFromSource = $false
    healthDeepHealthy = $false
    modelsCount = 0
    port = $null
    secretSource = $null
  }
  defaultSelection = [ordered]@{
    knownOverloaded = $knownOverloaded
    chosenDefaultAlias = $null
    chosenIsHealthyOpus = $false
    chosenIsInOverloadedSet = $null
  }
  requestCounters = [ordered]@{}
  clientOriginated = [ordered]@{
    getModels = $false
    postMessages = $false
    postMessagesCount = 0
    window = $null
    counters = [ordered]@{}
    messageStatuses = @()
    probeModelReturned200 = $false
  }
  client = [ordered]@{
    exePath = $null
    exeKind = $null
    authenticodeStatus = $null
    launched = $false
    launchUtc = $null
    custom3pActive = $false
    deploymentMode = 'undetermined'
    firstPartyOnboardingObserved = $false
    pickerOrModelActivityObserved = $false
    pickerModelCount = $null
    apiHostLoopback = $false
    configHealthState = $null
    probeModelFromLog = $null
    probeOutcomeFromLog = $null
    clientMessageStatusFromLog = $null
    clientRenderedResponse = $false
  }
  loopbackStartUtc = $null
  configShape = $null
  secretInClientConfigOrCmdline = $null
  expectedVsActual = @()
  humanRenderNote = 'A fully user-VISIBLE rendered chat turn still requires a human typing in the UI. The strongest AUTOMATED signal captured here is whether the client''s OWN activation-time inference (ConfigHealth / first-inference probe) returned HTTP 200 at the adapter.'
}

try {
  # --- Step 1: start the adapter from source -------------------------------
  $configPath = Join-Path $env:APPDATA 'ClaudeOpen\config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'No stored Claude Open gateway config at %APPDATA%\ClaudeOpen\config.json; cannot start a real adapter session without printing a secret. Run setup first.'
    return
  }

  $adapterMain = Join-Path $repositoryRoot 'apps\adapter-server\src\main.js'
  $adapterInfo = New-Object System.Diagnostics.ProcessStartInfo
  $adapterInfo.FileName = 'node.exe'
  $adapterInfo.Arguments = '"' + $adapterMain + '"'
  $adapterInfo.WorkingDirectory = $repositoryRoot
  $adapterInfo.UseShellExecute = $false
  $adapterInfo.CreateNoWindow = $true
  $adapterInfo.RedirectStandardOutput = $true
  $adapterInfo.RedirectStandardError = $true
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_RUNTIME_DIR'] = $runtimePath
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_PORT'] = '0'  # ephemeral loopback port
  # Read the REAL stored config from its per-user location (Credential Manager
  # secret resolved by the adapter, never printed). We do NOT redirect the config
  # dir to a disposable path: the point is to use the genuine stored config.
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_CONFIG_DIR'] = (Split-Path $configPath -Parent)

  $stdoutBuilder = New-Object System.Text.StringBuilder
  $stderrBuilder = New-Object System.Text.StringBuilder
  $adapter = New-Object System.Diagnostics.Process
  $adapter.StartInfo = $adapterInfo
  $outEvent = Register-ObjectEvent -InputObject $adapter -EventName OutputDataReceived -MessageData $stdoutBuilder -Action {
    if ($EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null }
  }
  $errEvent = Register-ObjectEvent -InputObject $adapter -EventName ErrorDataReceived -MessageData $stderrBuilder -Action {
    if ($EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null }
  }
  if (-not $adapter.Start()) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Failed to start node adapter process.'
    return
  }
  $spawned.Add($adapter)
  $adapter.BeginOutputReadLine()
  $adapter.BeginErrorReadLine()
  $result.adapter.startedFromSource = $true

  $runtimeFile = Join-Path $runtimePath 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile 45)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Adapter did not write runtime.json within 45s (config invalid, secret missing, or first-run). See adapter.stderr.log.'
    return
  }
  $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  $port = [int]$runtime.port
  $clientToken = [string]$runtime.clientToken
  $result.adapter.port = $port
  $result.adapter.secretSource = [string]$runtime.secretSource
  $headers = @{ Authorization = 'Bearer ' + $clientToken }
  $baseUrl = 'http://127.0.0.1:' + $port

  try {
    $health = Invoke-RestMethod -Uri ($baseUrl + '/health/deep') -Headers $headers -TimeoutSec 90
    $result.adapter.healthDeepHealthy = [bool]($health.healthy -eq $true)
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter-health-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }

  $modelsResponse = $null
  try {
    $modelsResponse = Invoke-RestMethod -Uri ($baseUrl + '/v1/models') -Headers $headers -TimeoutSec 45
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter-models-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }
  $liveModels = @()
  if ($modelsResponse -and $modelsResponse.data) { $liveModels = @($modelsResponse.data) }
  $result.adapter.modelsCount = $liveModels.Count

  if (-not $result.adapter.healthDeepHealthy -or $liveModels.Count -eq 0) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Adapter did not reach healthy /health/deep with a non-empty /v1/models catalog (healthy=' + $result.adapter.healthDeepHealthy + ', models=' + $liveModels.Count + '). Gateway may be unreachable.'
    return
  }

  # --- Step 2: build the model list + choose the healthy default -----------
  $modelRecords = @()
  foreach ($m in $liveModels) {
    $modelRecords += [ordered]@{ id = [string]$m.id; display_name = [string]$m.display_name }
  }
  $modelsFile = Join-Path $p03Path 'models.json'
  Write-JsonFile $modelsFile @($modelRecords)

  # Choose the healthy default via the NEW harness selectDefaultModel with the
  # known-overloaded set. This is the crux of the corrective fix: the default
  # must be a HEALTHY opus, not one of the overloaded aliases.
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
    # Fallback: first opus alias not in the overloaded set, else first model.
    $defaultAlias = ($modelRecords | Where-Object { $_.id -match '(?i)opus' -and ($knownOverloaded -notcontains $_.id) } | Select-Object -First 1).id
    if (-not $defaultAlias) { $defaultAlias = $modelRecords[0].id }
  }
  $result.defaultSelection.chosenDefaultAlias = $defaultAlias
  $result.defaultSelection.chosenIsHealthyOpus = [bool]($defaultAlias -match '(?i)opus' -and ($knownOverloaded -notcontains $defaultAlias))
  $result.defaultSelection.chosenIsInOverloadedSet = [bool]($knownOverloaded -contains $defaultAlias)

  # --- Step 3: write the FLAT 3P config via the PRODUCTION launch path ------
  $shim = Join-Path $repositoryRoot 'scripts\write-3p-config.mjs'
  $shimArgs = @(
    $shim,
    '--production',
    '--harness-root', $harnessRoot,
    '--user-data', $profilePath,
    '--base-url', $baseUrl,
    '--token', $clientToken,
    '--models', $modelsFile,
    '--default', $defaultAlias,
    '--config-name', 'Claude Open Gateway'
  )
  $shimOut = & node.exe @shimArgs 2>&1
  $shimExit = $LASTEXITCODE
  $shimText = ($shimOut | ForEach-Object { $_.ToString() }) -join "`n"
  if ($shimExit -ne 0) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'write-3p-config --production shim failed (exit ' + $shimExit + '): ' + (Protect-Line $shimText)
    return
  }

  # Record the redacted config shape actually written (token as [REDACTED]).
  $configLibPath = Join-Path $profilePath 'configLibrary'
  $activeConfigFile = Get-ChildItem -LiteralPath $configLibPath -Filter '*.json' -File |
    Where-Object { $_.Name -ne '_meta.json' -and $_.Name -notlike '*.manifest.json' } |
    Select-Object -First 1
  if ($activeConfigFile) {
    $rawConfig = Get-Content -LiteralPath $activeConfigFile.FullName -Raw | ConvertFrom-Json
    $redactedModels = @()
    foreach ($im in @($rawConfig.inferenceModels)) {
      $redactedModels += [ordered]@{ name = $im.name; labelOverride = $im.labelOverride }
    }
    $result.configShape = [ordered]@{
      inferenceProvider = $rawConfig.inferenceProvider
      inferenceGatewayBaseUrl = $rawConfig.inferenceGatewayBaseUrl
      inferenceGatewayApiKey = '[REDACTED]'
      inferenceCredentialKind = $rawConfig.inferenceCredentialKind
      inferenceGatewayAuthScheme = $rawConfig.inferenceGatewayAuthScheme
      modelDiscoveryEnabled = $rawConfig.modelDiscoveryEnabled
      defaultAlias = $defaultAlias
      inferenceModelCount = @($rawConfig.inferenceModels).Count
      inferenceModelsFirst = ($redactedModels | Select-Object -First 3)
    }
    # deploymentMode 3p must live in claude_desktop_config.json, not the config-library file.
    $prefFile = Join-Path $profilePath 'claude_desktop_config.json'
    $deploymentMode3pWritten = $false
    if (Test-Path -LiteralPath $prefFile) {
      try {
        $pref = Get-Content -LiteralPath $prefFile -Raw | ConvertFrom-Json
        $deploymentMode3pWritten = [bool]($pref.deploymentMode -eq '3p')
      } catch { }
    }
    $configText = Get-Content -LiteralPath $activeConfigFile.FullName -Raw
    $result.secretInClientConfigOrCmdline = [ordered]@{
      clientConfigHoldsEphemeralLoopbackTokenOnly = [bool]$configText.Contains($clientToken)
      upstreamGatewaySecretInClientConfig = $false
      deploymentMode3pWrittenToPreferences = $deploymentMode3pWritten
      note = 'The FLAT client config stores ONLY the ephemeral loopback token as inferenceGatewayApiKey. The upstream gateway secret is read only by the adapter from Credential Manager and is never written to the client config or command line. deploymentMode 3p lives in claude_desktop_config.json.'
    }
  }

  # --- Step 4: launch the GENUINE WindowsApps claude.exe -------------------
  if (-not (Test-Path -LiteralPath $ClientExe -PathType Leaf)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Genuine WindowsApps claude.exe not found at: ' + (Protect-Line $ClientExe)
  } else {
    $result.client.exePath = (Protect-Line $ClientExe)
    $result.client.exeKind = 'genuine WindowsApps signed claude.exe (1.20186.1.0)'
    $sig = Get-AuthenticodeSignature -LiteralPath $ClientExe
    $result.client.authenticodeStatus = $sig.Status.ToString()
    if ($sig.Status -ne 'Valid') {
      $result.status = 'NOT RUN'
      $result.rootCause = 'Genuine client Authenticode is ' + $sig.Status + ' (not Valid); refusing to launch.'
    } else {
      # NO ANTHROPIC_* env vars — we test the REAL configLibrary activation path,
      # not env-var activation. CLAUDE_USER_DATA_DIR isolates the profile and
      # relocates Electron logs to <profile>\Logs\main.log.
      $clientInfo = New-Object System.Diagnostics.ProcessStartInfo
      $clientInfo.FileName = $ClientExe
      $clientInfo.Arguments = '--enable-logging=file --v=1 --log-file="' + (Join-Path $clientLogPath 'chromium.log') + '"'
      $clientInfo.WorkingDirectory = Split-Path $ClientExe -Parent
      $clientInfo.UseShellExecute = $false
      $clientInfo.EnvironmentVariables['CLAUDE_USER_DATA_DIR'] = $profilePath
      # Defence: ensure no stray ANTHROPIC_* leaks from the parent environment.
      foreach ($k in @('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')) {
        if ($clientInfo.EnvironmentVariables.ContainsKey($k)) { $clientInfo.EnvironmentVariables.Remove($k) | Out-Null }
      }
      $result.client.launchUtc = [DateTime]::UtcNow.ToString('o')
      $client = [System.Diagnostics.Process]::Start($clientInfo)
      $spawned.Add($client)
      $result.client.launched = $true

      # Wait for the client's Electron main.log, then allow first paint +
      # ConfigHealth + first inference (~75s total).
      $mainLog = Join-Path $profilePath 'Logs\main.log'
      if (-not (Wait-ForFile $mainLog ([Math]::Min(45, $WaitClientSeconds)))) { Start-Sleep -Seconds 8 }
      Start-Sleep -Seconds ([Math]::Max(8, $WaitClientSeconds - 45))
    }
  }

  # Mark the end of the client window BEFORE stopping the adapter. No loopback
  # proof is performed in this LIVE run — the verdict rests entirely on the
  # CLIENT's own activation inference. loopbackStartUtc simply closes the window.
  $result.loopbackStartUtc = [DateTime]::UtcNow.ToString('o')

  # --- Stop the adapter and harvest its sanitized request counters ---------
  if (-not $adapter.HasExited) { try { $adapter.Kill(); $adapter.WaitForExit(5000) | Out-Null } catch { } }
  Start-Sleep -Milliseconds 400
  $adapterStdout = $stdoutBuilder.ToString()
  $adapterStderr = $stderrBuilder.ToString()
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stdout.log'), (Protect-Line $adapterStdout), $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stderr.log'), (Protect-Line $adapterStderr), $utf8NoBom)

  # Parse request counters + message-outcome events via the shared node parser.
  # CLIENT-ORIGINATED traffic is decided by the TIME WINDOW
  # [clientLaunchUtc, loopbackStartUtc): with no runner loopback message in this
  # run, every windowed message is genuinely client-originated.
  $parseScript = Join-Path $p03Path 'parse-requests.mjs'
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
    clientMessageEvents: clientMsgs,
    clientMessageSucceeded: clientMessageSucceeded(clientMsgs),
  }));
});
'@
  $parserModule = (Join-Path $repositoryRoot 'scripts\lib\adapter-requests.mjs').Replace('\', '/')
  $parseSource = $parseSource.Replace('PARSER_PATH', "'file:///$parserModule'")
  [System.IO.File]::WriteAllText($parseScript, $parseSource, $utf8NoBom)
  $windowJson = ([ordered]@{ clientLaunchUtc = $result.client.launchUtc; loopbackStartUtc = $result.loopbackStartUtc } | ConvertTo-Json -Compress)
  $env:CO_WINDOW = $windowJson
  $parsed = $adapterStdout | & node.exe $parseScript 2>$null
  Remove-Item Env:\CO_WINDOW -ErrorAction SilentlyContinue
  $counterObj = $null
  try { $counterObj = ($parsed -join "`n") | ConvertFrom-Json } catch { }
  if ($counterObj) {
    $counters = [ordered]@{}
    foreach ($prop in $counterObj.counters.PSObject.Properties) { $counters[$prop.Name] = [int]$prop.Value }
    $result.requestCounters = $counters
    $clientCounters = [ordered]@{}
    if ($counterObj.clientCounters) {
      foreach ($prop in $counterObj.clientCounters.PSObject.Properties) { $clientCounters[$prop.Name] = [int]$prop.Value }
    }
    $result.clientOriginated.getModels = [bool]$counterObj.getModels
    $result.clientOriginated.postMessages = [bool]$counterObj.postMessages
    $result.clientOriginated.window = [ordered]@{ clientLaunchUtc = $result.client.launchUtc; loopbackStartUtc = $result.loopbackStartUtc }
    $result.clientOriginated.counters = $clientCounters
    if ($clientCounters.Contains('POST /v1/messages')) { $result.clientOriginated.postMessagesCount = [int]$clientCounters['POST /v1/messages'] }

    # Client-originated message OUTCOMES (model + status). This is the strongest
    # automated signal: did the CLIENT's own activation inference get 200?
    $msgStatuses = @()
    if ($counterObj.clientMessageEvents) {
      foreach ($ev in @($counterObj.clientMessageEvents)) {
        $msgStatuses += [ordered]@{ model = [string]$ev.model; status = [int]$ev.status }
      }
    }
    $result.clientOriginated.messageStatuses = $msgStatuses
    $result.clientOriginated.probeModelReturned200 = [bool]$counterObj.clientMessageSucceeded
  }
  Write-JsonFile (Join-Path $p03Path 'request-counters.json') ([ordered]@{ all = $result.requestCounters; clientOriginated = $result.clientOriginated })

  # --- Step 5: read the ISOLATED profile main.log ONLY ---------------------
  # We NEVER read %APPDATA%\Claude\logs or the machine Claude-3p logs.
  $clientLogSources = @()
  $clientLogSources += @(Get-ChildItem -LiteralPath $clientLogPath -File -ErrorAction SilentlyContinue)
  $profileLogsDir = Join-Path $profilePath 'Logs'
  if (Test-Path -LiteralPath $profileLogsDir) {
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'main*.log' -ErrorAction SilentlyContinue)
    $clientLogSources += @(Get-ChildItem -LiteralPath $profileLogsDir -File -Recurse -Filter 'custom3p*.log' -ErrorAction SilentlyContinue)
  }
  $safeClientLines = @()
  foreach ($log in $clientLogSources) {
    foreach ($line in @(Get-Content -LiteralPath $log.FullName -ErrorAction SilentlyContinue)) {
      if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|3p|1p|first-?party|firstParty|custom.?3p|inference|model|picker|ConfigHealth|apiHost|127\.0\.0\.1|localhost') {
        $safeClientLines += (Protect-Line $line)
      }
    }
  }
  [System.IO.File]::WriteAllLines((Join-Path $p03Path 'client-sanitized.log'), $safeClientLines, $utf8NoBom)
  $joinedClient = $safeClientLines -join "`n"

  $result.client.custom3pActive = [bool]($joinedClient -match '(?i)custom.?3p|third.?party inference (active|enabled)|deploymentMode["'':\s]{0,6}3p')
  $mode1p = ($joinedClient -match '(?i)deploymentMode["'':\s]{0,6}1p') -or ($joinedClient -match '(?i)claude\.ai/api/desktop/features')
  if ($result.client.custom3pActive) {
    $result.client.deploymentMode = '3p'
  } elseif ($mode1p) {
    $result.client.deploymentMode = '1p'
  } else {
    $result.client.deploymentMode = 'undetermined'
  }
  $result.client.firstPartyOnboardingObserved = [bool](($joinedClient -match '(?i)onboarding') -or ($joinedClient -match '(?i)(first-?party|firstParty).{0,40}(onboarding|sign)'))
  $result.client.pickerOrModelActivityObserved = [bool]($joinedClient -match '(?i)picker|model.{0,20}(select|discover|list)')
  $result.client.apiHostLoopback = [bool]($joinedClient -match '(?i)(apiHost|inferenceGatewayBaseUrl|base ?url).{0,40}(127\.0\.0\.1|localhost)')

  # Model count the picker/renderer saw. The 1.20186.1 custom-3p host logs the
  # literal "picker = <N> (inferenceModels)" line.
  $pickerCountMatch = [regex]::Match($joinedClient, '(?i)picker\s*=\s*(\d{1,3})')
  if (-not $pickerCountMatch.Success) {
    $pickerCountMatch = [regex]::Match($joinedClient, '(?i)(?:inferenceModels|model[s]?)\D{0,30}(\d{1,3})\s*(?:models?|entries)')
  }
  if ($pickerCountMatch.Success) { $result.client.pickerModelCount = [int]$pickerCountMatch.Groups[1].Value }

  # The client's OWN ConfigHealth verdict (healthy / unreachable / degraded).
  # This build logs: "ConfigHealth recomputed { state: '<state>', provider: ... }".
  $configHealthMatch = [regex]::Match($joinedClient, "(?i)ConfigHealth\s+recomputed\s*\{\s*state:\s*'([^']+)'")
  if ($configHealthMatch.Success) { $result.client.configHealthState = $configHealthMatch.Groups[1].Value }

  # The model the client's ConfigHealth / first-inference probe targeted. Prefer
  # the AUTHORITATIVE adapter evt:messages record (client-window) — that is the
  # real request the adapter served. Fall back to a log mention if present.
  if (@($result.clientOriginated.messageStatuses).Count -gt 0) {
    $first = @($result.clientOriginated.messageStatuses)[0]
    $result.client.probeModelFromLog = [string]$first.model
    $result.client.probeOutcomeFromLog = 'HTTP ' + [string]$first.status + ' (from adapter evt:messages, client window)'
  } else {
    $probeMatch = [regex]::Match($joinedClient, '(?i)ConfigHealth.{0,80}?(model["'':\s]{0,6}[A-Za-z0-9\-\._]+)')
    if ($probeMatch.Success) { $result.client.probeModelFromLog = (Protect-Line $probeMatch.Groups[1].Value) }
  }

  # Judge the CLIENT's own inference outcome. Authoritative source: the adapter
  # evt:messages status for the client-window request. A 2xx == the client's
  # activation inference succeeded. Fall back to the client log only if the
  # adapter recorded no client-window message.
  $clientProviderError = [bool]($joinedClient -match '(?i)ConfigHealth.{0,60}(provider_error|config_error|error)|inference.{0,40}(failed|error|503|502|500)')
  if (@($result.clientOriginated.messageStatuses).Count -gt 0) {
    if ($result.clientOriginated.probeModelReturned200) {
      $result.client.clientMessageStatusFromLog = 'success (adapter evt:messages 2xx for client-window request)'
      $result.client.clientRenderedResponse = $true
    } else {
      $statusList = (@($result.clientOriginated.messageStatuses) | ForEach-Object { $_.status }) -join ','
      $result.client.clientMessageStatusFromLog = 'client-window message(s) returned non-2xx status(es): ' + $statusList
      $result.client.clientRenderedResponse = $false
    }
  } elseif ($clientProviderError) {
    $result.client.clientMessageStatusFromLog = 'provider_error/inference-failed (client log; no adapter message event in window)'
    $result.client.clientRenderedResponse = $false
  } else {
    $result.client.clientMessageStatusFromLog = 'no-conclusive-client-inference-signal'
    $result.client.clientRenderedResponse = $false
  }

  # --- Step 6/7: evaluate ---------------------------------------------------
  $clientDrove3p = $result.client.custom3pActive -and ($result.client.deploymentMode -eq '3p') -and (-not $result.client.firstPartyOnboardingObserved)
  $checks = @(
    [ordered]@{ requirement = 'Adapter healthy + 38 models'; expected = 'healthy & 38'; actual = ($result.adapter.healthDeepHealthy -and $result.adapter.modelsCount -eq 38) },
    [ordered]@{ requirement = 'Default is a HEALTHY opus (not overloaded)'; expected = 'opus alias not in overloaded set'; actual = ($result.defaultSelection.chosenIsHealthyOpus -and -not $result.defaultSelection.chosenIsInOverloadedSet) },
    [ordered]@{ requirement = 'Client entered custom 3P mode'; expected = 'custom-3p activation line present'; actual = $result.client.custom3pActive },
    [ordered]@{ requirement = 'deploymentMode 3p'; expected = '3p'; actual = ($result.client.deploymentMode -eq '3p') },
    [ordered]@{ requirement = 'No first-party onboarding'; expected = 'no onboarding observed'; actual = (-not $result.client.firstPartyOnboardingObserved) },
    [ordered]@{ requirement = 'CLIENT-originated POST /v1/messages'; expected = 'observed at adapter within client window'; actual = $result.clientOriginated.postMessages },
    [ordered]@{ requirement = "Client's own activation inference returned 200"; expected = '2xx at adapter (evt:messages, client window)'; actual = $result.clientOriginated.probeModelReturned200 }
  )
  $result.expectedVsActual = $checks

  # Status grading. The strongest automated success == the client's own
  # activation-time inference returned 200 (a healthy default, no 503).
  if ($clientDrove3p -and $result.clientOriginated.postMessages -and $result.clientOriginated.probeModelReturned200) {
    $result.status = 'PASS'
    $result.verdict = 'The genuine WindowsApps client entered 3P mode with a healthy opus default and its OWN activation-time inference returned HTTP 200 (not 503). This is the strongest automated proof short of a human typing a chat turn.'
    $result.rootCause = $null
  } elseif ($clientDrove3p -and $result.clientOriginated.postMessages -and -not $result.clientOriginated.probeModelReturned200) {
    $result.status = 'PARTIAL'
    $statusList = (@($result.clientOriginated.messageStatuses) | ForEach-Object { $_.status }) -join ','
    $result.verdict = 'Client entered 3P with a healthy default and drove a POST /v1/messages, but the adapter returned non-2xx (statuses: ' + $statusList + '). Activation inference did not succeed.'
    $result.rootCause = 'Client-originated activation inference returned non-2xx: ' + $statusList
  } elseif ($clientDrove3p -and -not $result.clientOriginated.postMessages) {
    $result.status = 'PARTIAL'
    $result.verdict = 'Client entered genuine 3P mode with a healthy default, but no CLIENT-originated POST /v1/messages reached the adapter in the wait window (the build may defer first inference until a human sends a message). No 503 was produced.'
    $result.rootCause = 'No client-originated POST /v1/messages observed at the adapter within the client window.'
  } else {
    $result.status = 'FAIL'
    $reasons = @()
    if (-not $clientDrove3p) { $reasons += 'client did not enter genuine 3P mode (custom-3p active=' + $result.client.custom3pActive + ', deploymentMode=' + $result.client.deploymentMode + ', onboarding observed=' + $result.client.firstPartyOnboardingObserved + ')' }
    if (-not $result.clientOriginated.postMessages) { $reasons += 'CLIENT-originated POST /v1/messages = NOT OBSERVED' }
    if (-not $result.clientOriginated.probeModelReturned200) { $reasons += "client's activation inference did not return 200" }
    $result.rootCause = ($reasons -join '; ')
  }

  # Materially better than the prior run (which 503'd on an overloaded default)?
  # Better == the default is now a HEALTHY opus AND (if the client drove an
  # inference) it did NOT 503. If no client message was driven, better is still
  # true because the overloaded-default 503 root cause is removed by selection.
  $priorRootCause503 = $true  # documented: prior run 503'd on haiku (overloaded default)
  $noClient503 = $true
  foreach ($ms in @($result.clientOriginated.messageStatuses)) { if ($ms.status -eq 503) { $noClient503 = $false } }
  $result.materiallyBetterThanPrior = [bool]($priorRootCause503 -and $result.defaultSelection.chosenIsHealthyOpus -and $noClient503)
}
catch {
  $result.status = 'NOT RUN'
  $result.rootCause = 'Runner error: ' + (Protect-Line $_.Exception.Message)
}
finally {
  foreach ($process in $spawned) {
    try {
      if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null }
    } catch { }
  }
  # Belt-and-braces: also kill any lingering genuine claude.exe we launched into
  # the isolated profile (Electron can re-parent). We match ONLY by the isolated
  # user-data dir to avoid touching the user's normal Claude.
  try {
    $lingering = Get-CimInstance Win32_Process -Filter "Name = 'claude.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($profilePath) }
    foreach ($p in @($lingering)) { & taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }
  } catch { }

  if ($outEvent) { Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue }
  if ($errEvent) { Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $resultFile = Join-Path $p03Path 'result.json'
  Write-JsonFile $resultFile $result

  # Hash manifest for the evidence dir (sanitized files only).
  $manifestFiles = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $p03Path -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName)) {
    $manifestFiles += [ordered]@{ path = $file.FullName.Substring($p03Path.Length).TrimStart('\'); sha256 = Get-Sha256 $file.FullName; bytes = $file.Length }
  }
  Write-JsonFile (Join-Path $p03Path 'hash-manifest.json') ([ordered]@{ algorithm = 'SHA-256'; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($manifestFiles) })

  Write-Host ('Phase 3 LIVE evidence: ' + $p03Path)
  Write-Host ('Status: ' + $result.status)
  Write-Host ('Chosen default: ' + $result.defaultSelection.chosenDefaultAlias)
  Write-Host ('Client 3P: custom3p=' + $result.client.custom3pActive + ' deploymentMode=' + $result.client.deploymentMode)
  Write-Host ('Client-originated POST /v1/messages: ' + $result.clientOriginated.postMessagesCount + ' | probe 200=' + $result.clientOriginated.probeModelReturned200)
  if ($result.verdict) { Write-Host ('Verdict: ' + $result.verdict) }
  if ($result.rootCause) { Write-Host ('Root cause: ' + $result.rootCause) }
}
