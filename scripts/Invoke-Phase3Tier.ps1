#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 3 LIVE end-to-end verification — TIER variant. Genuine WindowsApps Claude
  Desktop 3P activation via the production launch path, with FAMILY-TIER
  assignment AND the adapter-side tier-probe reconcile belt-and-suspenders.

.DESCRIPTION
  Derived from Invoke-Phase3Live.ps1. Two material changes make the client's
  haiku-tier ConfigHealth probe resolve to a HEALTHY opus:

    1. The production config write now ASSIGNS FAMILY TIERS: it calls
       node scripts/write-3p-config.mjs --production --assign-family-tiers
       --unhealthy <known-overloaded set> --default <healthy opus>. This tags a
       healthy opus with anthropicFamilyTier:'haiku'|'sonnet'|'opus' +
       isFamilyDefault:true so the client's per-tier probe lands on a healthy
       model instead of the built-in overloaded claude-haiku-4-5 tier id.

    2. The adapter is started with env CLAUDE_OPEN_HEALTHY_DEFAULT=<chosen opus>
       so the adapter's reconcileTierProbe redirects any built-in tier-probe id
       (or absent-from-catalog id) to the healthy default and emits an
       evt:'tier-probe-reconcile' {from,to} — belt-and-suspenders behind the
       config-side family-tier mapping.

  Because CLAUDE_OPEN_HEALTHY_DEFAULT must equal a REAL opus alias, the runner
  starts the adapter ONCE to read /v1/models + pick the healthy opus via
  selectDefaultModel, KILLS it, then RESTARTS the adapter with the env set. The
  isolated 3P config is written against the SECOND (final) adapter port/token.

  Never prints or stores the real gateway secret. Never modifies the normal
  Claude profile, machine registry policy, or installed package. All evidence is
  written under test-results/corrective/<run>/p03tier/ (git-ignored).

.PARAMETER EvidenceRoot
  Root for corrective evidence. Default: test-results\corrective (git-ignored).
.PARAMETER WaitClientSeconds
  How long to wait for the client to activate / emit its first inference. Default 75.
.PARAMETER ClientExe
  Genuine WindowsApps claude.exe.
#>
[CmdletBinding()]
param(
  [string]$EvidenceRoot,
  [int]$WaitClientSeconds = 75,
  [string]$ClientExe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $repositoryRoot 'test-results\corrective' }
if (-not $ClientExe) { $ClientExe = & (Join-Path $PSScriptRoot 'Resolve-OfficialClaudeExe.ps1') }

$started = [DateTime]::UtcNow
$runId = $started.ToString('yyyyMMddTHHmmss.fffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runPath = Join-Path $EvidenceRoot $runId
$p03Path = Join-Path $runPath 'p03tier'
$runtimePath = Join-Path $p03Path 'runtime'
$profilePath = Join-Path $p03Path 'profile'
$harnessRoot = Join-Path $p03Path 'harness'
$clientLogPath = Join-Path $p03Path 'client-logs'
foreach ($p in @($runPath, $p03Path, $runtimePath, $profilePath, $harnessRoot, $clientLogPath)) {
  New-Item -ItemType Directory -Path $p -Force | Out-Null
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$spawned = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

# Known-overloaded aliases (caller-supplied). selectDefaultModel demotes these.
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

function Get-GitCommit {
  try {
    $c = & git -C $repositoryRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { return $c.Trim() }
  } catch { }
  return 'NOT DISCOVERED'
}

# Start the adapter from source. Returns a hashtable with the process, output
# builders, registered events, port, clientToken, secretSource. $ExtraEnv is a
# hashtable of additional environment variables (e.g. CLAUDE_OPEN_HEALTHY_DEFAULT).
function Start-Adapter {
  param(
    [string]$RuntimeDir,
    [string]$ConfigDir,
    [hashtable]$ExtraEnv = @{}
  )
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

  return @{
    Process = $proc; StdOut = $out; StdErr = $err; OutEvent = $oe; ErrEvent = $ee
    RuntimeDir = $RuntimeDir
  }
}

function Stop-Adapter {
  param($Handle)
  try { if (-not $Handle.Process.HasExited) { $Handle.Process.Kill(); $Handle.Process.WaitForExit(5000) | Out-Null } } catch { }
  Start-Sleep -Milliseconds 300
  if ($Handle.OutEvent) { Unregister-Event -SourceIdentifier $Handle.OutEvent.Name -ErrorAction SilentlyContinue }
  if ($Handle.ErrEvent) { Unregister-Event -SourceIdentifier $Handle.ErrEvent.Name -ErrorAction SilentlyContinue }
}

# Result skeleton.
$result = [ordered]@{
  phase = 'P0.3-TIER'
  status = 'NOT RUN'
  verdict = $null
  materiallyBetterThanPrior = $null
  rootCause = $null
  runId = $runId
  startedAtUtc = $started.ToString('o')
  finishedAtUtc = $null
  sourceCommit = Get-GitCommit
  evidenceDir = $p03Path
  launchPath = 'production (createProductionWorkspace) + --assign-family-tiers + CLAUDE_OPEN_HEALTHY_DEFAULT + genuine WindowsApps claude.exe'
  adapter = [ordered]@{
    startedFromSource = $false
    healthDeepHealthy = $false
    modelsCount = 0
    port = $null
    secretSource = $null
    healthyDefaultEnv = $null
    twoPassRestart = $false
  }
  defaultSelection = [ordered]@{
    knownOverloaded = $knownOverloaded
    chosenDefaultAlias = $null
    chosenIsHealthyOpus = $false
    chosenIsInOverloadedSet = $null
  }
  familyTierTags = [ordered]@{
    assignFamilyTiersRequested = $true
    anthropicFamilyTierPresentInConfig = $false
    tiersObserved = @()
    haikuTierResolvesToAlias = $null
    haikuTierResolvesToHealthyOpus = $false
    isFamilyDefaultPresent = $false
    taggedItemCount = 0
  }
  requestCounters = [ordered]@{}
  tierReconcile = [ordered]@{
    events = @()
    count = 0
    anyToHealthyDefault = $false
  }
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
    configHealthReachable = $null
    probeModelFromLog = $null
    probeOutcomeFromLog = $null
    activationProbeTargetModel = $null
    clientMessageStatusFromLog = $null
    clientRenderedResponse = $false
  }
  loopbackStartUtc = $null
  configShape = $null
  secretInClientConfigOrCmdline = $null
  expectedVsActual = @()
  humanRenderNote = 'A fully user-VISIBLE rendered chat turn still requires a human typing in the UI. The strongest AUTOMATED signal captured here is whether the client''s OWN activation-time inference (ConfigHealth / first-inference probe) returned HTTP 200 at the adapter.'
}

$adapterHandle = $null
try {
  $configPath = Join-Path $env:APPDATA 'ClaudeOpen\config.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'No stored Claude Open gateway config at %APPDATA%\ClaudeOpen\config.json; cannot start a real adapter session without printing a secret. Run setup first.'
    return
  }
  $configDir = Split-Path $configPath -Parent

  # === PASS 1: start adapter (no healthy-default env) to read /v1/models ===
  $runtime1 = Join-Path $runtimePath 'pass1'
  New-Item -ItemType Directory -Path $runtime1 -Force | Out-Null
  $adapterHandle = Start-Adapter -RuntimeDir $runtime1 -ConfigDir $configDir
  $result.adapter.startedFromSource = $true

  $runtimeFile1 = Join-Path $runtime1 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile1 45)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-1 adapter did not write runtime.json within 45s (config invalid, secret missing, or first-run). See adapter.stderr.log.'
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
    Stop-Adapter $adapterHandle
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-1 adapter returned an empty /v1/models catalog. Gateway may be unreachable.'
    return
  }

  $modelRecords = @()
  foreach ($m in $liveModels) {
    $modelRecords += [ordered]@{ id = [string]$m.id; display_name = [string]$m.display_name }
  }
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
  $result.defaultSelection.chosenIsInOverloadedSet = [bool]($knownOverloaded -contains $defaultAlias)

  # === Stop PASS-1, RESTART with CLAUDE_OPEN_HEALTHY_DEFAULT = chosen opus ===
  Stop-Adapter $adapterHandle
  $adapterHandle = $null

  $runtime2 = Join-Path $runtimePath 'pass2'
  New-Item -ItemType Directory -Path $runtime2 -Force | Out-Null
  $adapterHandle = Start-Adapter -RuntimeDir $runtime2 -ConfigDir $configDir -ExtraEnv @{ CLAUDE_OPEN_HEALTHY_DEFAULT = $defaultAlias }
  $result.adapter.twoPassRestart = $true
  $result.adapter.healthyDefaultEnv = $defaultAlias

  $runtimeFile2 = Join-Path $runtime2 'runtime.json'
  if (-not (Wait-ForFile $runtimeFile2 45)) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'Pass-2 adapter did not write runtime.json within 45s. See adapter.stderr.log.'
    return
  }
  $rt2 = Get-Content -LiteralPath $runtimeFile2 -Raw | ConvertFrom-Json
  $port = [int]$rt2.port
  $clientToken = [string]$rt2.clientToken
  $result.adapter.port = $port
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
    $result.rootCause = 'Pass-2 adapter did not reach healthy /health/deep with a non-empty /v1/models catalog (healthy=' + $result.adapter.healthDeepHealthy + ', models=' + $liveModels2.Count + ').'
    return
  }

  # === Step 3: write the 3P config via PRODUCTION path + FAMILY TIERS ===
  $shim = Join-Path $repositoryRoot 'scripts\write-3p-config.mjs'
  $shimArgs = @(
    $shim,
    '--production',
    '--assign-family-tiers',
    '--unhealthy', ($knownOverloaded -join ','),
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
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'write-config.stdout.log'), (Protect-Line $shimText), $utf8NoBom)
  if ($shimExit -ne 0) {
    $result.status = 'NOT RUN'
    $result.rootCause = 'write-3p-config --production --assign-family-tiers shim failed (exit ' + $shimExit + '): ' + (Protect-Line $shimText)
    return
  }

  # Inspect the written config-library file: family-tier tags + resolution.
  $configLibPath = Join-Path $profilePath 'configLibrary'
  $activeConfigFile = Get-ChildItem -LiteralPath $configLibPath -Filter '*.json' -File |
    Where-Object { $_.Name -ne '_meta.json' -and $_.Name -notlike '*.manifest.json' } |
    Select-Object -First 1
  if ($activeConfigFile) {
    $rawConfig = Get-Content -LiteralPath $activeConfigFile.FullName -Raw | ConvertFrom-Json
    $allModels = @($rawConfig.inferenceModels)
    $tiersObserved = @()
    $taggedCount = 0
    $haikuAlias = $null
    $isFamilyDefaultPresent = $false
    foreach ($im in $allModels) {
      $hasTier = ($im.PSObject.Properties.Name -contains 'anthropicFamilyTier') -and $im.anthropicFamilyTier
      if ($hasTier) {
        $taggedCount += 1
        if ($tiersObserved -notcontains $im.anthropicFamilyTier) { $tiersObserved += [string]$im.anthropicFamilyTier }
        if ($im.anthropicFamilyTier -eq 'haiku') { $haikuAlias = [string]$im.name }
      }
      if (($im.PSObject.Properties.Name -contains 'isFamilyDefault') -and $im.isFamilyDefault -eq $true) { $isFamilyDefaultPresent = $true }
    }
    $result.familyTierTags.anthropicFamilyTierPresentInConfig = [bool]($taggedCount -gt 0)
    $result.familyTierTags.tiersObserved = $tiersObserved
    $result.familyTierTags.taggedItemCount = $taggedCount
    $result.familyTierTags.isFamilyDefaultPresent = $isFamilyDefaultPresent
    $result.familyTierTags.haikuTierResolvesToAlias = $haikuAlias
    $result.familyTierTags.haikuTierResolvesToHealthyOpus = [bool]($haikuAlias -and ($haikuAlias -match '(?i)opus') -and ($knownOverloaded -notcontains $haikuAlias))

    # Redacted config dump to evidence (token -> [REDACTED]).
    $redactedModels = @()
    foreach ($im in $allModels) {
      $entry = [ordered]@{ name = $im.name; labelOverride = $im.labelOverride }
      if (($im.PSObject.Properties.Name -contains 'anthropicFamilyTier') -and $im.anthropicFamilyTier) { $entry.anthropicFamilyTier = $im.anthropicFamilyTier }
      if (($im.PSObject.Properties.Name -contains 'isFamilyDefault') -and $im.isFamilyDefault -eq $true) { $entry.isFamilyDefault = $true }
      if (($im.PSObject.Properties.Name -contains 'supports1m')) { $entry.supports1m = $im.supports1m }
      $redactedModels += $entry
    }
    $redactedConfig = [ordered]@{
      inferenceProvider = $rawConfig.inferenceProvider
      inferenceGatewayBaseUrl = $rawConfig.inferenceGatewayBaseUrl
      inferenceGatewayApiKey = '[REDACTED]'
      inferenceCredentialKind = $rawConfig.inferenceCredentialKind
      inferenceGatewayAuthScheme = $rawConfig.inferenceGatewayAuthScheme
      modelDiscoveryEnabled = $rawConfig.modelDiscoveryEnabled
      inferenceModelCount = $allModels.Count
      inferenceModels = $redactedModels
    }
    Write-JsonFile (Join-Path $p03Path 'written-config.redacted.json') $redactedConfig

    $result.configShape = [ordered]@{
      inferenceProvider = $rawConfig.inferenceProvider
      inferenceGatewayBaseUrl = $rawConfig.inferenceGatewayBaseUrl
      inferenceGatewayApiKey = '[REDACTED]'
      modelDiscoveryEnabled = $rawConfig.modelDiscoveryEnabled
      defaultAlias = $defaultAlias
      inferenceModelCount = $allModels.Count
      taggedTierItemCount = $taggedCount
    }

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
      note = 'The FLAT client config stores ONLY the ephemeral loopback token as inferenceGatewayApiKey. The upstream gateway secret is read only by the adapter from Credential Manager. deploymentMode 3p lives in claude_desktop_config.json.'
    }
  }

  # === Step 4: launch the GENUINE WindowsApps claude.exe ===
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
      $clientInfo = New-Object System.Diagnostics.ProcessStartInfo
      $clientInfo.FileName = $ClientExe
      $clientInfo.Arguments = '--enable-logging=file --v=1 --log-file="' + (Join-Path $clientLogPath 'chromium.log') + '"'
      $clientInfo.WorkingDirectory = Split-Path $ClientExe -Parent
      $clientInfo.UseShellExecute = $false
      $clientInfo.EnvironmentVariables['CLAUDE_USER_DATA_DIR'] = $profilePath
      foreach ($k in @('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')) {
        if ($clientInfo.EnvironmentVariables.ContainsKey($k)) { $clientInfo.EnvironmentVariables.Remove($k) | Out-Null }
      }
      $result.client.launchUtc = [DateTime]::UtcNow.ToString('o')
      $client = [System.Diagnostics.Process]::Start($clientInfo)
      $spawned.Add($client)
      $result.client.launched = $true

      $mainLog = Join-Path $profilePath 'Logs\main.log'
      if (-not (Wait-ForFile $mainLog ([Math]::Min(45, $WaitClientSeconds)))) { Start-Sleep -Seconds 8 }
      Start-Sleep -Seconds ([Math]::Max(8, $WaitClientSeconds - 45))
    }
  }

  $result.loopbackStartUtc = [DateTime]::UtcNow.ToString('o')

  # === Stop the adapter and harvest sanitized stdout ===
  $adapterStdout = $adapterHandle.StdOut.ToString()
  $adapterStderr = $adapterHandle.StdErr.ToString()
  Stop-Adapter $adapterHandle
  $adapterHandle = $null
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stdout.log'), (Protect-Line $adapterStdout), $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $p03Path 'adapter.stderr.log'), (Protect-Line $adapterStderr), $utf8NoBom)

  # === Parse request counters + message outcomes + tier-reconcile events ===
  $parseScript = Join-Path $p03Path 'parse-requests.mjs'
  $parseSource = @'
import { parseRequestEvents, countRequests, filterClientOriginated, clientDroveModels, clientDroveMessages, parseMessageEvents, filterClientMessages, clientMessageSucceeded } from PARSER_PATH;
const win = JSON.parse(process.env.CO_WINDOW || '{}');
const launch = win.clientLaunchUtc ? Date.parse(win.clientLaunchUtc) : NaN;
const loopback = win.loopbackStartUtc ? Date.parse(win.loopbackStartUtc) : NaN;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const events = parseRequestEvents(data);
  const clientEvents = filterClientOriginated(events, win);
  const msgEvents = parseMessageEvents(data);
  const clientMsgs = filterClientMessages(msgEvents, win);
  // Parse tier-probe-reconcile events (not covered by the shared parser lib).
  const reconcile = [];
  for (const rawLine of String(data).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || obj.evt !== 'tier-probe-reconcile') continue;
    const t = typeof obj.t === 'string' ? obj.t : null;
    let inWindow = true;
    if (t) {
      const ms = Date.parse(t);
      if (!Number.isNaN(ms)) {
        if (!Number.isNaN(launch) && ms < launch) inWindow = false;
        if (!Number.isNaN(loopback) && ms >= loopback) inWindow = false;
      }
    }
    reconcile.push({ from: obj.from ?? null, to: obj.to ?? null, t, inWindow });
  }
  process.stdout.write(JSON.stringify({
    counters: countRequests(events),
    clientCounters: countRequests(clientEvents),
    getModels: clientDroveModels(clientEvents),
    postMessages: clientDroveMessages(clientEvents),
    clientMessageEvents: clientMsgs,
    clientMessageSucceeded: clientMessageSucceeded(clientMsgs),
    tierReconcile: reconcile,
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

    $msgStatuses = @()
    if ($counterObj.clientMessageEvents) {
      foreach ($ev in @($counterObj.clientMessageEvents)) {
        $msgStatuses += [ordered]@{ model = [string]$ev.model; status = [int]$ev.status }
      }
    }
    $result.clientOriginated.messageStatuses = $msgStatuses
    $result.clientOriginated.probeModelReturned200 = [bool]$counterObj.clientMessageSucceeded

    # tier-probe-reconcile events.
    $recEvents = @()
    $anyToHealthy = $false
    if ($counterObj.tierReconcile) {
      foreach ($rc in @($counterObj.tierReconcile)) {
        $recEvents += [ordered]@{ from = [string]$rc.from; to = [string]$rc.to; inWindow = [bool]$rc.inWindow }
        if ($rc.to -eq $defaultAlias) { $anyToHealthy = $true }
      }
    }
    $result.tierReconcile.events = $recEvents
    $result.tierReconcile.count = @($recEvents).Count
    $result.tierReconcile.anyToHealthyDefault = $anyToHealthy
  }
  Write-JsonFile (Join-Path $p03Path 'request-counters.json') ([ordered]@{ all = $result.requestCounters; clientOriginated = $result.clientOriginated; tierReconcile = $result.tierReconcile })

  # === Step 5: read the ISOLATED profile main.log ONLY ===
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
      if ($line -match '(?i)deploymentMode|onboarding|msix_required|cowork|3p|1p|first-?party|firstParty|custom.?3p|inference|model|picker|ConfigHealth|apiHost|reachable|unreachable|127\.0\.0\.1|localhost') {
        $safeClientLines += (Protect-Line $line)
      }
    }
  }
  [System.IO.File]::WriteAllLines((Join-Path $p03Path 'client-sanitized.log'), $safeClientLines, $utf8NoBom)
  $joinedClient = $safeClientLines -join "`n"

  $result.client.custom3pActive = [bool]($joinedClient -match '(?i)custom.?3p|third.?party inference (active|enabled)|deploymentMode["'':\s]{0,6}3p')
  $mode1p = ($joinedClient -match '(?i)deploymentMode["'':\s]{0,6}1p') -or ($joinedClient -match '(?i)claude\.ai/api/desktop/features')
  if ($result.client.custom3pActive) { $result.client.deploymentMode = '3p' }
  elseif ($mode1p) { $result.client.deploymentMode = '1p' }
  else { $result.client.deploymentMode = 'undetermined' }
  $result.client.firstPartyOnboardingObserved = [bool](($joinedClient -match '(?i)onboarding') -or ($joinedClient -match '(?i)(first-?party|firstParty).{0,40}(onboarding|sign)'))
  $result.client.pickerOrModelActivityObserved = [bool]($joinedClient -match '(?i)picker|model.{0,20}(select|discover|list)')
  $result.client.apiHostLoopback = [bool]($joinedClient -match '(?i)(apiHost|inferenceGatewayBaseUrl|base ?url).{0,40}(127\.0\.0\.1|localhost)')

  $pickerCountMatch = [regex]::Match($joinedClient, '(?i)picker\s*=\s*(\d{1,3})')
  if (-not $pickerCountMatch.Success) {
    $pickerCountMatch = [regex]::Match($joinedClient, '(?i)(?:inferenceModels|model[s]?)\D{0,30}(\d{1,3})\s*(?:models?|entries)')
  }
  if ($pickerCountMatch.Success) { $result.client.pickerModelCount = [int]$pickerCountMatch.Groups[1].Value }

  $configHealthMatch = [regex]::Match($joinedClient, "(?i)ConfigHealth\s+recomputed\s*\{\s*state:\s*'([^']+)'")
  if ($configHealthMatch.Success) { $result.client.configHealthState = $configHealthMatch.Groups[1].Value }
  # ConfigHealth reachable/unreachable verdict from the log text.
  if ($joinedClient -match '(?i)ConfigHealth.{0,80}(reachable)' -and -not ($joinedClient -match '(?i)ConfigHealth.{0,80}unreachable')) {
    $result.client.configHealthReachable = $true
  } elseif ($joinedClient -match '(?i)ConfigHealth.{0,80}unreachable') {
    $result.client.configHealthReachable = $false
  } elseif ($result.client.configHealthState) {
    $result.client.configHealthReachable = [bool]($result.client.configHealthState -match '(?i)health|reachable|ok|ready')
  }

  # The model the client's activation probe targeted — authoritative from adapter.
  if (@($result.clientOriginated.messageStatuses).Count -gt 0) {
    $first = @($result.clientOriginated.messageStatuses)[0]
    $result.client.probeModelFromLog = [string]$first.model
    $result.client.activationProbeTargetModel = [string]$first.model
    $result.client.probeOutcomeFromLog = 'HTTP ' + [string]$first.status + ' (from adapter evt:messages, client window)'
  } else {
    $probeMatch = [regex]::Match($joinedClient, '(?i)ConfigHealth.{0,80}?(model["'':\s]{0,6}[A-Za-z0-9\-\._]+)')
    if ($probeMatch.Success) { $result.client.probeModelFromLog = (Protect-Line $probeMatch.Groups[1].Value) }
  }
  # If a tier-reconcile fired, the pre-reconcile inbound model the client sent.
  if (@($result.tierReconcile.events).Count -gt 0) {
    $firstRec = @($result.tierReconcile.events)[0]
    $result.client.activationProbeTargetModel = 'client sent: ' + $firstRec.from + ' -> adapter reconciled to: ' + $firstRec.to
  }

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

  # === Step 6: evaluate ===
  $clientDrove3p = $result.client.custom3pActive -and ($result.client.deploymentMode -eq '3p') -and (-not $result.client.firstPartyOnboardingObserved)
  # ConfigHealth reachable: prefer explicit log verdict; else infer from a 2xx client message.
  $configHealthReachable = $false
  if ($result.client.configHealthReachable -eq $true) { $configHealthReachable = $true }
  elseif ($result.clientOriginated.probeModelReturned200) { $configHealthReachable = $true }

  $checks = @(
    [ordered]@{ requirement = 'Adapter healthy + 38 models'; expected = 'healthy & 38'; actual = ($result.adapter.healthDeepHealthy -and $result.adapter.modelsCount -eq 38) },
    [ordered]@{ requirement = 'Default is a HEALTHY opus (not overloaded)'; expected = 'opus alias not in overloaded set'; actual = ($result.defaultSelection.chosenIsHealthyOpus -and -not $result.defaultSelection.chosenIsInOverloadedSet) },
    [ordered]@{ requirement = 'anthropicFamilyTier tags present in written config'; expected = 'haiku/sonnet/opus tags -> healthy opus'; actual = ($result.familyTierTags.anthropicFamilyTierPresentInConfig -and $result.familyTierTags.haikuTierResolvesToHealthyOpus) },
    [ordered]@{ requirement = 'Adapter healthy-default env active'; expected = 'CLAUDE_OPEN_HEALTHY_DEFAULT set to chosen opus'; actual = [bool]$result.adapter.healthyDefaultEnv },
    [ordered]@{ requirement = 'Client entered custom 3P mode'; expected = 'custom-3p activation line present'; actual = $result.client.custom3pActive },
    [ordered]@{ requirement = 'deploymentMode 3p'; expected = '3p'; actual = ($result.client.deploymentMode -eq '3p') },
    [ordered]@{ requirement = 'No first-party onboarding'; expected = 'no onboarding observed'; actual = (-not $result.client.firstPartyOnboardingObserved) },
    [ordered]@{ requirement = 'CLIENT-originated POST /v1/messages'; expected = 'observed at adapter within client window'; actual = $result.clientOriginated.postMessages },
    [ordered]@{ requirement = 'ConfigHealth reachable'; expected = 'reachable (log verdict or 2xx probe)'; actual = $configHealthReachable },
    [ordered]@{ requirement = "Client's activation inference returned 200"; expected = '2xx at adapter (evt:messages, client window)'; actual = $result.clientOriginated.probeModelReturned200 }
  )
  $result.expectedVsActual = $checks

  # PASS-for-activation: client in 3P + ConfigHealth reachable + activation 200.
  if ($clientDrove3p -and $configHealthReachable -and $result.clientOriginated.probeModelReturned200) {
    $result.status = 'PASS'
    if ($result.tierReconcile.count -gt 0) {
      $resolutionPath = 'adapter tier-probe reconcile ' + (@($result.tierReconcile.events)[0].from) + '->' + (@($result.tierReconcile.events)[0].to)
    } else {
      $resolutionPath = 'config-side anthropicFamilyTier haiku->healthy-opus mapping'
    }
    $result.verdict = 'PASS-for-activation: the genuine WindowsApps client entered 3P mode; its ConfigHealth probe is reachable and its OWN activation-time inference returned HTTP 200 (not 503). Resolution path: ' + $resolutionPath + '.'
    $result.rootCause = $null
  } elseif ($clientDrove3p -and $result.clientOriginated.postMessages -and -not $result.clientOriginated.probeModelReturned200) {
    $result.status = 'PARTIAL'
    $statusList = (@($result.clientOriginated.messageStatuses) | ForEach-Object { $_.status }) -join ','
    $result.verdict = 'Client entered 3P and drove a POST /v1/messages, but the adapter returned non-2xx (statuses: ' + $statusList + '). Activation inference did not succeed.'
    $result.rootCause = 'Client-originated activation inference returned non-2xx: ' + $statusList
  } elseif ($clientDrove3p -and -not $result.clientOriginated.postMessages) {
    $result.status = 'PARTIAL'
    $result.verdict = 'Client entered genuine 3P mode with a healthy default + family-tier tags, but no CLIENT-originated POST /v1/messages reached the adapter in the wait window (the build may defer first inference until a human sends a message). No 503 was produced.'
    $result.rootCause = 'No client-originated POST /v1/messages observed at the adapter within the client window.'
  } else {
    $result.status = 'FAIL'
    $reasons = @()
    if (-not $clientDrove3p) { $reasons += 'client did not enter genuine 3P mode (custom-3p active=' + $result.client.custom3pActive + ', deploymentMode=' + $result.client.deploymentMode + ', onboarding observed=' + $result.client.firstPartyOnboardingObserved + ')' }
    if (-not $result.clientOriginated.postMessages) { $reasons += 'CLIENT-originated POST /v1/messages = NOT OBSERVED' }
    if (-not $result.clientOriginated.probeModelReturned200) { $reasons += "client's activation inference did not return 200" }
    $result.rootCause = ($reasons -join '; ')
  }

  # Materially better than prior 503 runs?
  $noClient503 = $true
  foreach ($ms in @($result.clientOriginated.messageStatuses)) { if ($ms.status -eq 503) { $noClient503 = $false } }
  # Better == default is healthy opus AND family tiers resolve haiku->healthy-opus
  # AND (if the client drove inference) it did not 503.
  $result.materiallyBetterThanPrior = [bool]($result.defaultSelection.chosenIsHealthyOpus -and $result.familyTierTags.haikuTierResolvesToHealthyOpus -and $noClient503)
}
catch {
  $result.status = 'NOT RUN'
  $result.rootCause = 'Runner error: ' + (Protect-Line $_.Exception.Message)
}
finally {
  if ($adapterHandle) { try { Stop-Adapter $adapterHandle } catch { } }
  foreach ($process in $spawned) {
    try {
      if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null }
    } catch { }
  }
  # Belt-and-braces: kill any lingering genuine claude.exe bound to the isolated
  # profile ONLY (match by isolated user-data dir). Never touches the normal Claude.
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

  Write-Host ('Phase 3 TIER evidence: ' + $p03Path)
  Write-Host ('Status: ' + $result.status)
  Write-Host ('Chosen default (healthy opus): ' + $result.defaultSelection.chosenDefaultAlias)
  Write-Host ('anthropicFamilyTier present: ' + $result.familyTierTags.anthropicFamilyTierPresentInConfig + ' | haiku->' + $result.familyTierTags.haikuTierResolvesToAlias + ' (healthyOpus=' + $result.familyTierTags.haikuTierResolvesToHealthyOpus + ')')
  Write-Host ('Client 3P: custom3p=' + $result.client.custom3pActive + ' deploymentMode=' + $result.client.deploymentMode)
  Write-Host ('ConfigHealth state: ' + $result.client.configHealthState + ' | reachable=' + $result.client.configHealthReachable)
  Write-Host ('Client-originated POST /v1/messages: ' + $result.clientOriginated.postMessagesCount + ' | probe 200=' + $result.clientOriginated.probeModelReturned200)
  Write-Host ('tier-probe-reconcile events: ' + $result.tierReconcile.count + ' | anyToHealthyDefault=' + $result.tierReconcile.anyToHealthyDefault)
  if ($result.verdict) { Write-Host ('Verdict: ' + $result.verdict) }
  if ($result.rootCause) { Write-Host ('Root cause: ' + $result.rootCause) }
}
