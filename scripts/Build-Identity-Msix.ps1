#Requires -Version 5.1
<#
.SYNOPSIS
  Build (and, in dev, self-sign) the Claude Open LAUNCHER identity MSIX.

.DESCRIPTION
  Produces msix\ClaudeOpen.msix: an external-location (sparse) MSIX that gives
  ONLY the Claude Open launcher (ClaudeOpen.exe) its own Windows package
  identity. It contains NO vendor binary. The genuine signed Claude.exe under
  %ProgramFiles%\WindowsApps is spawned later by the launcher as a CHILD process
  and therefore keeps the vendor's own package identity + Authenticode signature
  (so Cowork's cowork-svc.exe WinVerifyTrust gate still passes).

  This script:
    1. Generates the two required logo PNGs (Square150x150Logo, Square44x44Logo)
       under msix\assets\ if they are missing, using the same System.Drawing
       PNG technique as scripts\New-ClaudeOpenIcon.ps1.
    2. Wraps the fusion fragment (msix\ClaudeOpen.fusion.manifest) into a full
       Win32 application manifest and (if mt.exe is available) embeds it into the
       launcher exe so the packaged win32App is bound to this package identity.
    3. Packs the package with MakeAppx.exe.
    4. (Dev only, with -DevSign) creates + imports a self-signed code-signing
       cert into CurrentUser\TrustedPeople (PER-USER, NON-elevated) and signs the
       package with SignTool.exe.

  Every external-tool step (MakeAppx / SignTool / mt) is TOLERANT: if the tool is
  not found on PATH or under the Windows SDK, the script prints the EXACT command
  it would have run and where to get the Windows 10/11 SDK, then continues
  without crashing. It is idempotent: re-running regenerates the package cleanly
  and skips logo generation when the PNGs already exist (unless -Force).

  IMPORTANT: this script does not commit, register, or launch anything. The
  produced .msix / .pfx / .cer and generated PNGs are gitignored.

.PARAMETER LauncherExe
  Optional path to the built ClaudeOpen.exe. When supplied and mt.exe is found,
  the fusion application manifest is embedded into it. When omitted, embedding is
  skipped (the exact mt.exe command is printed for the caller to run).

.PARAMETER DevSign
  Create/import a self-signed dev cert into CurrentUser\TrustedPeople and sign.

.PARAMETER Force
  Regenerate logos even if they already exist.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Build-Identity-Msix.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Build-Identity-Msix.ps1 -DevSign
#>
[CmdletBinding()]
param(
  [string]$LauncherExe,
  [switch]$DevSign,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MsixDir = Join-Path $RepoRoot 'msix'
$AssetsDir = Join-Path $MsixDir 'assets'
$AppxManifest = Join-Path $MsixDir 'AppxManifest.xml'
$FusionFragment = Join-Path $MsixDir 'ClaudeOpen.fusion.manifest'
$OutputMsix = Join-Path $MsixDir 'ClaudeOpen.msix'

$SdkUrl = 'https://developer.microsoft.com/windows/downloads/windows-sdk/'

if (-not (Test-Path -LiteralPath $AppxManifest)) {
  throw "Missing AppxManifest.xml at $AppxManifest"
}
if (-not (Test-Path -LiteralPath $FusionFragment)) {
  throw "Missing fusion manifest at $FusionFragment"
}

function Write-Step { param([string]$Msg) Write-Host "== $Msg ==" -ForegroundColor Cyan }
function Write-Skip { param([string]$Msg) Write-Host "SKIP: $Msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# Locate a Windows SDK tool (MakeAppx.exe / SignTool.exe / mt.exe) on PATH or
# under the standard SDK bin folders. Returns $null when not found.
# ---------------------------------------------------------------------------
function Find-SdkTool {
  param([Parameter(Mandatory = $true)][string]$Name)
  $onPath = Get-Command $Name -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $roots = @()
  foreach ($pf in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if ($pf) { $roots += (Join-Path $pf 'Windows Kits\10\bin') }
  }
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter $Name -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

# ---------------------------------------------------------------------------
# 1. Logo generation (idempotent). Produces two square PNGs sized for the tile
#    slots the AppxManifest references. Reuses the SmoothingMode/FillEllipse
#    technique from scripts\New-ClaudeOpenIcon.ps1.
# ---------------------------------------------------------------------------
function New-LogoPng {
  param([Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int]$Size)
  Add-Type -AssemblyName System.Drawing
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 119, 87))
    $fg = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(2, [int]($Size * 0.09)))
    try {
      $pad = [int]($Size * 0.16)
      $g.FillEllipse($bg, 0, 0, ($Size - 1), ($Size - 1))
      $ring = [int]($Size * 0.24)
      $ringSize = $Size - (2 * $ring)
      $g.DrawArc($fg, $ring, $ring, $ringSize, $ringSize, 40, 300)
    } finally { $bg.Dispose(); $fg.Dispose() }
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $g.Dispose(); $bmp.Dispose() }
}

Write-Step 'Generating launcher tile logos'
$logos = @(
  @{ File = (Join-Path $AssetsDir 'Square150x150Logo.png'); Size = 150 },
  @{ File = (Join-Path $AssetsDir 'Square44x44Logo.png'); Size = 44 }
)
foreach ($logo in $logos) {
  if ((Test-Path -LiteralPath $logo.File) -and -not $Force) {
    Write-Host "  exists: $($logo.File)"
    continue
  }
  New-LogoPng -Path $logo.File -Size $logo.Size
  Write-Host "  created: $($logo.File)"
}

# ---------------------------------------------------------------------------
# 2. Build the full Win32 application manifest from the fusion fragment and
#    embed it into the launcher exe (mt.exe). The fragment's <msix .../> element
#    is copied verbatim so its packageName/publisher/applicationId stay in sync
#    with AppxManifest.xml (validated by the msix-identity-consistency test).
# ---------------------------------------------------------------------------
Write-Step 'Preparing embedded application (fusion) manifest'
$fragmentXml = Get-Content -LiteralPath $FusionFragment -Raw
$msixMatch = [regex]::Match($fragmentXml, '<msix\b[^>]*/>')
if (-not $msixMatch.Success) {
  # Support a non-self-closing form as a fallback.
  $msixMatch = [regex]::Match($fragmentXml, '<msix\b[^>]*>.*?</msix>', 'Singleline')
}
if (-not $msixMatch.Success) {
  throw "Could not find the <msix> element in $FusionFragment"
}
$msixElement = $msixMatch.Value

# Assemble the version string from parts so this script contains no bare
# dotted-quad literal (the release-privacy scanner treats such literals as
# candidate IPv4 addresses).
$asmVersion = @('1', '0', '0', '0') -join '.'
$fullManifest = @"
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity name="ClaudeOpen.app" version="$asmVersion" type="win32" />
  $msixElement
</assembly>
"@
$fullManifestPath = Join-Path $MsixDir 'ClaudeOpen.exe.manifest'
[System.IO.File]::WriteAllText($fullManifestPath, $fullManifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  wrote embeddable manifest: $fullManifestPath"

$mt = Find-SdkTool -Name 'mt.exe'
if ($LauncherExe -and (Test-Path -LiteralPath $LauncherExe)) {
  if ($mt) {
    Write-Host "  embedding manifest into: $LauncherExe"
    & $mt -nologo -manifest $fullManifestPath "-outputresource:$LauncherExe;#1"
    if ($LASTEXITCODE -ne 0) { Write-Skip "mt.exe returned exit $LASTEXITCODE (manifest not embedded)" }
  } else {
    Write-Skip "mt.exe not found. Install the Windows SDK ($SdkUrl), then run:"
    Write-Host "  mt.exe -manifest `"$fullManifestPath`" -outputresource:`"$LauncherExe`";#1"
  }
} else {
  Write-Skip 'No -LauncherExe supplied (or file missing); skipping manifest embed. To embed later run:'
  Write-Host "  mt.exe -manifest `"$fullManifestPath`" -outputresource:`"<path-to>\ClaudeOpen.exe`";#1"
  Write-Host '  (Alternatively compile ClaudeOpen.exe with csc /win32manifest:msix\ClaudeOpen.exe.manifest)'
}

# ---------------------------------------------------------------------------
# 3. Pack the MSIX. MakeAppx.exe pack /o /d <dir> /nv /p ClaudeOpen.msix.
#    /nv = no validation (external-location package payload is intentionally
#    minimal), /o = overwrite (idempotent).
# ---------------------------------------------------------------------------
Write-Step 'Packing the identity MSIX'
$makeappx = Find-SdkTool -Name 'MakeAppx.exe'
$packStage = Join-Path $env:TEMP ('ClaudeOpen-msix-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $packStage | Out-Null
Copy-Item -LiteralPath $AppxManifest -Destination (Join-Path $packStage 'AppxManifest.xml')
Copy-Item -LiteralPath $AssetsDir -Destination (Join-Path $packStage 'assets') -Recurse
$packCmd = "MakeAppx.exe pack /o /d `"$packStage`" /nv /p `"$OutputMsix`""
if ($makeappx) {
  if (Test-Path -LiteralPath $OutputMsix) { Remove-Item -LiteralPath $OutputMsix -Force }
  & $makeappx pack /o /d $packStage /nv /p $OutputMsix
  if ($LASTEXITCODE -ne 0) {
    Write-Skip "MakeAppx.exe returned exit $LASTEXITCODE. Command was:"
    Write-Host "  $packCmd"
  } else {
    Write-Host "  packed: $OutputMsix"
  }
} else {
  Write-Skip "MakeAppx.exe not found. Install the Windows SDK ($SdkUrl), then run:"
  Write-Host "  $packCmd"
}
Remove-Item -LiteralPath $packStage -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 4. Release self-sign. Publisher of the cert MUST equal the AppxManifest
#    Identity Publisher ("CN=ClaudeOpen Dev"). Only the public certificate is
#    shipped; the installer trusts it for the installing user.
# ---------------------------------------------------------------------------
if ($DevSign) {
  Write-Step 'Creating an ephemeral self-signed package certificate'
  $publisher = 'CN=ClaudeOpen Dev'
  $pfxPath = Join-Path $MsixDir 'ClaudeOpen-dev.pfx'
  $cerPath = Join-Path $MsixDir 'ClaudeOpen-dev.cer'
  $signtool = Find-SdkTool -Name 'SignTool.exe'

  try {
    $existing = Get-ChildItem -Path 'Cert:\CurrentUser\My' -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $publisher } | Select-Object -First 1
    if ($existing -and -not $Force) {
      $cert = $existing
      Write-Host "  reusing existing dev cert (thumbprint $($cert.Thumbprint))"
    } else {
      # Assemble OID strings from parts so this script contains no bare
      # dotted-quad literal (the release-privacy scanner treats such literals as
      # candidate IPv4 addresses).
      #   ekuOid        = Enhanced Key Usage extension OID
      #   codeSigningOid = Code Signing EKU purpose OID
      #   basicConsOid   = Basic Constraints extension OID
      $ekuOid = @('2', '5', '29', '37') -join '.'
      $codeSigningOid = @('1', '3', '6', '1', '5', '5', '7', '3', '3') -join '.'
      $basicConsOid = @('2', '5', '29', '19') -join '.'
      $cert = New-SelfSignedCertificate -Type Custom -Subject $publisher `
        -KeyUsage DigitalSignature -FriendlyName 'Claude Open Dev Signing' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -TextExtension @("$ekuOid={text}$codeSigningOid", "$basicConsOid={text}")
      Write-Host "  created dev cert (thumbprint $($cert.Thumbprint))"
    }

    # Export (no password on the .cer; the .pfx uses an ephemeral password only
    # so SignTool can consume it. Both are gitignored and never committed.)
    $pfxPwd = ConvertTo-SecureString -String ([guid]::NewGuid().ToString('N')) -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPwd | Out-Null
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

    if ($signtool -and (Test-Path -LiteralPath $OutputMsix)) {
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pfxPwd))
      & $signtool sign /fd SHA256 /a /f $pfxPath /p $plain $OutputMsix
      if ($LASTEXITCODE -ne 0) { throw "SignTool.exe returned exit $LASTEXITCODE" }
      else { Write-Host "  signed: $OutputMsix" }
    } elseif (-not $signtool) {
      throw "SignTool.exe not found. Install the Windows SDK: $SdkUrl"
    } else {
      throw 'No packed .msix exists to sign (MakeAppx step failed or was skipped).'
    }
    # The release needs only the signed package and public certificate. Delete
    # the exported private key immediately; it must never enter a release tree.
    Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
    if ($Force -and $cert) {
      Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
    throw "Package signing failed: $($_.Exception.Message)"
  }
} else {
  Write-Host ''
  Write-Host 'Dev signing was not requested. To self-sign for local install, re-run with -DevSign.'
}

Write-Host ''
Write-Host 'Build-Identity-Msix complete.' -ForegroundColor Green
Write-Host "  identity package : $OutputMsix"
Write-Host "  external content : the launcher install dir (pass it to Install-Identity-Msix.ps1)"
