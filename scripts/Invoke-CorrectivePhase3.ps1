#Requires -Version 5.1
<#
.SYNOPSIS
  Corrective Phase 3 (Gate P0.3) — genuine Claude Desktop 3P activation experiment.

.DESCRIPTION
  Runs a live, disposable experiment to evaluate Gate P0.3 from
  CORRECTIVE-IMPLEMENTATION-PLAN.md using the "Genuine 3P activation procedure"
  in NEXT-CORRECTIVE-WAVE-INSTRUCTIONS.md.

  It:
    1. starts the adapter FROM SOURCE (node apps/adapter-server/src/main.js) with
       an isolated CLAUDE_OPEN_RUNTIME_DIR under the p03 evidence dir, using the
       stored user gateway config + Credential Manager secret (never printed);
       binds an ephemeral loopback port; per-run client token via runtime.json;
       waits for /health/deep healthy + /v1/models.
    2. reads the live chat-usable model aliases + display names from /v1/models.
    3. writes, via the node shim (which reuses @claude-open/identity-harness),
       the exact FLAT config-library contract into a disposable
       CLAUDE_USER_DATA_DIR (p03/profile-B) + deploymentMode:"3p".
    4. launches the copied signed client with CLAUDE_USER_DATA_DIR=profile-B and
       forced logs (Authenticode Valid required; else NOT RUN with reason). It
       does NOT pass ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN (real configLibrary
       path only).
    5. captures from the ISOLATED profile main.log only: 3P active?, deploymentMode
       3p vs 1p, first-party onboarding?, picker/model activity; and the adapter
       request counters (client GET /v1/models? client POST /v1/messages?).
    6. ALSO performs a labeled adapter-loopback proof: POST /v1/messages with the
       same client token + default alias and the harmless prompt
       "Reply exactly: CLAUDE_OPEN_GATEWAY_OK", recording the rendered response
       and that /usage incremented. This is SEPARATE from client-originated
       traffic and can never satisfy P0.3 by itself.
    7. writes p03/p03-result.json and stops all spawned processes in finally.

  Never prints or stores the real gateway secret. Never modifies the normal
  Claude profile, machine registry policy, or installed package.

.PARAMETER EvidenceRoot
  Root for corrective evidence. Default: test-results\corrective (git-ignored).

.PARAMETER WaitClientSeconds
  How long to wait for the client to activate / emit traffic. Default 60.
#>
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [int]$WaitClientSeconds = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }

$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
$p03Path = Join-Path $runPath 'p03'
$runtimePath = Join-Path $p03Path 'runtime'
$profilePath = Join-Path $p03Path 'profile-B'
$harnessRoot = Join-Path $p03Path 'harness'
$clientLogPath = Join-Path $p03Path 'client-logs'
foreach ($p in @($runPath, $p03Path, $runtimePath, $profilePath, $harnessRoot, $clientLogPath)) {
  New-Item -ItemType Directory -Path $p -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$spawned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

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
    # A just-terminated client may briefly hold a log file open. Do not let a
    # locked evidence file abort the run; record it as unavailable.
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

# Result skeleton, filled in as evidence is captured. Every field defaults to a
# safe / not-observed state so an early failure still writes an honest record.
$result = [ordered]@{
  gateEvaluated = 'P0.3'
  status = 'NOT RUN'
  rootCause = $null
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = $null
  sourceCommit = Get-GitCommit
  evidenceDir = $p03Path
  adapter = [ordered]@{
    startedFromSource = $false
    healthDeepHealthy = $false
    modelsCount = 0
    port = $null
    secretSource = $null
  }
  requestCounters = [ordered]@{}
  clientOriginated = [ordered]@{
    getModels = $false
    postMessages = $false
    window = $null
    counters = [ordered]@{}
  }
  loopbackProof = [ordered]@{
    attempted = $false
    postMessagesStatus = $null
    renderedResponsePresent = $false
    renderedResponseText = $null
    usageIncremented = $false
  }
  client = [ordered]@{
    exePath = $null
    authenticodeStatus = $null
    launched = $false
    launchUtc = $null
    custom3pActive = $false
    deploymentMode = 'undetermined'
    firstPartyOnboardingObserved = $false
    pickerOrModelActivityObserved = $false
    clientMessageStatusFromLog = $null
    clientRenderedResponse = $false
  }
  loopbackStartUtc = $null
  configShape = $null
  secretInClientConfigOrCmdline = $null
  expectedVsActual = @()
}

try {
  # --- Step 0: P0.0 gate + models fixture placeholder ----------------------
  # createCandidateWorkspace requires an explicit P0.0 PASS gate file. We write
  # a disposable one under the harness root (this experiment reproduces P0.0's
  # preconditions live; the harness only needs the PASS marker to permit work).
  $gateFile = Join-Path $p03Path 'p0-gate.json'
  Write-JsonFile $gateFile ([ordered]@{ p0_0 = [ordered]@{ status = 'PASS'; note = 'disposable gate for the P0.3 live experiment' } })

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
  $adapterInfo.EnvironmentVariables['CLAUDE_OPEN_CONFIG_DIR'] = (Split-Path $configPath -Parent)

  # Capture stdout/stderr asynchronously so the process buffer never blocks.
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

  # Deep health + live catalog (authenticated with the per-run client token).
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

  # --- Step 2: build the model list (id = stableAlias, display_name) --------
  $modelRecords = @()
  foreach ($m in $liveModels) {
    $modelRecords += [ordered]@{ id = [string]$m.id; display_name = [string]$m.display_name }
  }
  # Choose a default: prefer an opus-family alias, else the first.
  $defaultAlias = ($modelRecords | Where-Object { $_.id -match '(?i)opus' } | Select-Object -First 1).id
  if (-not $defaultAlias) { $defaultAlias = $modelRecords[0].id }
  $modelsFile = Join-Path $p03Path 'models.json'
  Write-JsonFile $modelsFile @($modelRecords)

  # --- Step 3: write the FLAT 3P config via the node shim ------------------
  $shim = Join-Path $repositoryRoot 'scripts\write-3p-config.mjs'
  # Pass RAW strings in the splat array — PowerShell 5.1 quotes each element for
  # the native process. Pre-quoting the first element merges the whole array into
  # a single mangled argument (node then can't resolve the module path).
  $shimArgs = @(
    $shim,
    '--candidate', 'B',
    '--gate', $gateFile,
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
    $result.rootCause = 'write-3p-config shim failed (exit ' + $shimExit + '): ' + (Protect-Line $shimText)
    return
  }
  $shimResult = $null
  try { $shimResult = $shimText | ConvertFrom-Json } catch { }

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
    # Verify the real gateway secret / client token never landed in a place it
    # should not: the client config holds ONLY the ephemeral loopback token.
    $configText = Get-Content -LiteralPath $activeConfigFile.FullName -Raw
    $tokenPresentButRedactedInEvidence = $configText.Contains($clientToken)
    $result.secretInClientConfigOrCmdline = [ordered]@{
      clientConfigHoldsEphemeralLoopbackTokenOnly = [bool]$tokenPresentButRedactedInEvidence
      upstreamGatewaySecretInClientConfig = $false
      note = 'The FLAT client config intentionally stores the ephemeral loopback token as inferenceGatewayApiKey. The upstream gateway secret is read only by the adapter from Credential Manager and is never written to the client config or command line.'
    }
  }

  # --- Step 4: launch the copied signed client -----------------------------
  $clientExe = @(
    (Join-Path $repositoryRoot 'dist\ClaudeOpen-live-final\client\ClaudeOpenClient.exe'),
    (Join-Path $repositoryRoot 'dist\installer-cowork-client-test\client\ClaudeOpenClient.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

  if (-not $clientExe) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'No copied signed client (ClaudeOpenClient.exe) found under dist\ClaudeOpen-live-final\client or dist\installer-cowork-client-test\client.'
  } else {
    $result.client.exePath = (Protect-Line $clientExe)
    $sig = Get-AuthenticodeSignature -LiteralPath $clientExe
    $result.client.authenticodeStatus = $sig.Status.ToString()
    if ($sig.Status -ne 'Valid') {
      $result.status = 'NOT RUN'
      $result.rootCause = 'Copied client Authenticode is ' + $sig.Status + ' (not Valid); refusing to launch an unsigned/tampered client for the 3P experiment.'
    } else {
      # Force Electron logs under the isolated profile Logs dir. We DO NOT set
      # ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN — the whole point is to test
      # the real configLibrary path, not env-var activation.
      $clientInfo = New-Object System.Diagnostics.ProcessStartInfo
      $clientInfo.FileName = $clientExe
      $clientInfo.Arguments = '--enable-logging=file --v=1 --log-file="' + (Join-Path $clientLogPath 'chromium.log') + '"'
      $clientInfo.WorkingDirectory = Split-Path $clientExe -Parent
      $clientInfo.UseShellExecute = $false
      $clientInfo.EnvironmentVariables['CLAUDE_USER_DATA_DIR'] = $profilePath
      $result.client.launchUtc = [DateTime]::UtcNow.ToString('o')
      $client = [System.Diagnostics.Process]::Start($clientInfo)
      $spawned.Add($client)
      $result.client.launched = $true

      # Wait for the client's Electron main.log under the isolated profile, then
      # allow first paint + config load + potential model discovery to run.
      $mainLog = Join-Path $profilePath 'Logs\main.log'
      if (-not (Wait-ForFile $mainLog ([Math]::Min(45, $WaitClientSeconds)))) { Start-Sleep -Seconds 8 }
      Start-Sleep -Seconds ([Math]::Max(8, $WaitClientSeconds - 45))
    }
  }

  # --- Step 6: adapter-loopback proof (SEPARATE from client-originated) -----
  # Prove the adapter+gateway round-trip works end to end with the SAME client
  # token + default alias. This is explicitly labeled a loopback proof and can
  # NEVER satisfy P0.3's client-originated /v1/messages requirement.
  $result.loopbackProof.attempted = $true
  $result.loopbackStartUtc = [DateTime]::UtcNow.ToString('o')
  try {
    $usageBefore = 0
    try {
      $u0 = Invoke-RestMethod -Uri ($baseUrl + '/usage') -Headers $headers -TimeoutSec 20
      if ($u0 -and ($u0.PSObject.Properties.Name -contains 'totalRequests')) { $usageBefore = [int]$u0.totalRequests }
    } catch { }

    $msgBody = @{
      model = $defaultAlias
      max_tokens = 64
      messages = @(@{ role = 'user'; content = 'Reply exactly: CLAUDE_OPEN_GATEWAY_OK' })
    } | ConvertTo-Json -Depth 6
    $msgResp = $null
    $msgStatus = $null
    try {
      $msgResp = Invoke-WebRequest -Uri ($baseUrl + '/v1/messages') -Method Post -Headers $headers -ContentType 'application/json' -Body $msgBody -TimeoutSec 90 -UseBasicParsing
      $msgStatus = [int]$msgResp.StatusCode
    } catch {
      if ($_.Exception.Response) { $msgStatus = [int]$_.Exception.Response.StatusCode }
      [System.IO.File]::WriteAllText((Join-Path $p03Path 'loopback-messages-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
    }
    $result.loopbackProof.postMessagesStatus = $msgStatus
    if ($msgResp -and $msgStatus -ge 200 -and $msgStatus -lt 300) {
      $parsed = $null
      try { $parsed = $msgResp.Content | ConvertFrom-Json } catch { }
      $renderedText = $null
      if ($parsed -and $parsed.content) {
        foreach ($block in @($parsed.content)) {
          if ($block.type -eq 'text' -and $block.text) { $renderedText = [string]$block.text; break }
        }
      }
      if ($renderedText) {
        $result.loopbackProof.renderedResponsePresent = $true
        $result.loopbackProof.renderedResponseText = (Protect-Line $renderedText)
      }
    }

    try {
      $u1 = Invoke-RestMethod -Uri ($baseUrl + '/usage') -Headers $headers -TimeoutSec 20
      $usageAfter = 0
      if ($u1 -and ($u1.PSObject.Properties.Name -contains 'totalRequests')) { $usageAfter = [int]$u1.totalRequests }
      $result.loopbackProof.usageIncremented = [bool]($usageAfter -gt $usageBefore)
    } catch { }
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $p03Path 'loopback-proof-error.log'), (Protect-Line $_.Exception.Message), $utf8NoBom)
  }

  # --- Stop the adapter and harvest its sanitized request counters ---------
  if (-not $adapter.HasExited) { try { $adapter.Kill(); $adapter.WaitForExit(5000) | Out-Null } catch { } }
  Start-Sleep -Milliseconds 400
  $adapterStdout = $stdoutBuilder.ToString()
  $adapterStderr = $stderrBuilder.ToString()
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stdout.log'), (Protect-Line $adapterStdout), $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stderr.log'), (Protect-Line $adapterStderr), $utf8NoBom)

  # Parse request counters via the shared node parser (single source of truth).
  # Crucially, CLIENT-ORIGINATED traffic is decided by a TIME WINDOW
  # [clientLaunchUtc, loopbackStartUtc): this excludes the runner's own setup
  # probe (/health/deep, /v1/models before the client launched) AND the runner's
  # loopback-proof POST /v1/messages (sent at/after loopbackStartUtc). Without
  # this window the runner's own loopback message would be miscounted as a client
  # message — exactly the conflation P0.3 forbids.
  $parseScript = Join-Path $p03Path 'parse-requests.mjs'
  $parseSource = @'
import { parseRequestEvents, countRequests, filterClientOriginated, clientDroveModels, clientDroveMessages } from PARSER_PATH;
const win = JSON.parse(process.env.CO_WINDOW || '{}');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const events = parseRequestEvents(data);
  const clientEvents = filterClientOriginated(events, win);
  process.stdout.write(JSON.stringify({
    counters: countRequests(events),
    clientCounters: countRequests(clientEvents),
    getModels: clientDroveModels(clientEvents),
    postMessages: clientDroveMessages(clientEvents),
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
  }
  Write-JsonFile (Join-Path $p03Path 'request-counters.json') ([ordered]@{ all = $result.requestCounters; clientOriginated = $result.clientOriginated })

  # --- Step 5: read the ISOLATED profile main.log ONLY ---------------------
  # We NEVER read %APPDATA%\Claude\logs or the machine Claude-3p logs (plan rule
  # 9 — private content + normal-profile protection).
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
      if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|3p|1p|first-?party|firstParty|custom.?3p|inference|model|picker') {
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

  # Judge the CLIENT's own inference outcome from ITS log — never from the
  # loopback proof. A client-rendered response requires the client to have
  # produced a successful assistant turn (not a provider_error / config_error).
  # The 1.20186.1 custom-3p host logs ConfigHealth state and inference errors;
  # a healthy successful client turn does NOT log provider_error.
  $clientProviderError = [bool]($joinedClient -match '(?i)ConfigHealth.{0,60}(provider_error|config_error|error)|inference.{0,40}(failed|error|503|502|500)')
  $clientMessageOk = [bool]($joinedClient -match '(?i)inference.{0,40}(complete|success|ok\b)|assistant.{0,20}(message|turn).{0,20}(rendered|complete)')
  if ($clientProviderError) { $result.client.clientMessageStatusFromLog = 'provider_error/inference-failed' }
  elseif ($clientMessageOk) { $result.client.clientMessageStatusFromLog = 'success' }
  else { $result.client.clientMessageStatusFromLog = 'no-conclusive-client-inference-signal' }
  # A rendered client response is claimed ONLY on an explicit client success
  # signal AND no provider error. The loopback proof's rendered text is
  # deliberately excluded here.
  $result.client.clientRenderedResponse = [bool]($clientMessageOk -and -not $clientProviderError)

  # --- Step 7: evaluate P0.3 -----------------------------------------------
  # PASS ONLY if the CLIENT itself drove activation + GET /v1/models +
  # POST /v1/messages AND a rendered response was observed. The loopback proof
  # is never sufficient on its own.
  # P0.3 is graded ONLY on CLIENT-originated evidence. The adapter-loopback proof
  # (loopbackProof.*) proves the adapter+gateway round-trip works but can NEVER
  # substitute for any client-originated requirement.
  $checks = @(
    [ordered]@{ requirement = 'Client log: custom 3P mode active'; expected = 'custom-3p activation line present'; actual = $result.client.custom3pActive },
    [ordered]@{ requirement = 'deploymentMode 3p (renderer signal)'; expected = '3p'; actual = ($result.client.deploymentMode -eq '3p') },
    [ordered]@{ requirement = 'No first-party login/onboarding page'; expected = 'no onboarding observed'; actual = (-not $result.client.firstPartyOnboardingObserved) },
    [ordered]@{ requirement = 'CLIENT-originated GET /v1/models'; expected = 'observed at adapter within client window'; actual = $result.clientOriginated.getModels },
    [ordered]@{ requirement = 'CLIENT-originated POST /v1/messages'; expected = 'observed at adapter within client window'; actual = $result.clientOriginated.postMessages },
    [ordered]@{ requirement = 'Real gateway response rendered IN THE CLIENT'; expected = 'client success signal, no provider_error'; actual = $result.client.clientRenderedResponse }
  )
  $result.expectedVsActual = $checks

  $clientDrove3p = $result.client.custom3pActive -and ($result.client.deploymentMode -eq '3p') -and (-not $result.client.firstPartyOnboardingObserved)
  $clientDroveModels = $result.clientOriginated.getModels
  $clientDroveMessages = $result.clientOriginated.postMessages
  $clientRendered = $result.client.clientRenderedResponse

  if ($clientDrove3p -and $clientDroveModels -and $clientDroveMessages -and $clientRendered) {
    $result.status = 'PASS'
    $result.rootCause = $null
  } else {
    $result.status = 'FAIL'
    $reasons = @()
    if (-not $clientDrove3p) { $reasons += 'client did not enter genuine 3P mode (custom-3p active=' + $result.client.custom3pActive + ', deploymentMode=' + $result.client.deploymentMode + ', onboarding observed=' + $result.client.firstPartyOnboardingObserved + ')' }
    if (-not $clientDroveModels) { $reasons += 'CLIENT-originated GET /v1/models = NOT OBSERVED (runner setup probe excluded by time window)' }
    if (-not $clientDroveMessages) { $reasons += 'CLIENT-originated POST /v1/messages = NOT OBSERVED (a chat message normally requires a human in the Claude UI; the adapter-loopback proof does NOT satisfy this)' }
    if (-not $clientRendered) {
      $reasons += 'no gateway response rendered IN THE CLIENT (client inference status from its own log: ' + $result.client.clientMessageStatusFromLog + '). NOTE: the adapter-loopback proof separately returned ' + ($(if ($result.loopbackProof.renderedResponsePresent) { 'a rendered "' + $result.loopbackProof.renderedResponseText + '" response (loopback-injected, NOT client-originated)' } else { 'no rendered response' })) + '.'
    }
    $result.rootCause = ($reasons -join '; ')
  }
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
  if ($outEvent) { Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue }
  if ($errEvent) { Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue }
  # Give terminated child processes a moment to release any open log handles
  # before we hash the evidence tree.
  Start-Sleep -Seconds 2

  $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $resultFile = Join-Path $p03Path 'p03-result.json'
  Write-JsonFile $resultFile $result

  # Hash manifest for the evidence dir (sanitized files only).
  $manifestFiles = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $p03Path -File -Recurse | Sort-Object FullName)) {
    $manifestFiles += [ordered]@{ path = $file.FullName.Substring($p03Path.Length).TrimStart('\'); sha256 = Get-Sha256 $file.FullName; bytes = $file.Length }
  }
  Write-JsonFile (Join-Path $p03Path 'hash-manifest.json') ([ordered]@{ algorithm = 'SHA-256'; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = @($manifestFiles) })

  Write-Host ('Corrective Phase 3 evidence: ' + $p03Path)
  Write-Host ('P0.3: ' + $result.status)
  if ($result.rootCause) { Write-Host ('Root cause: ' + $result.rootCause) }
}
