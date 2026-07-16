#Requires -Version 5.1
<#
.SYNOPSIS
  Register the Claude Open sparse identity MSIX for the CURRENT USER.

.DESCRIPTION
  Registers msix\ClaudeOpen.msix as an external-location package pointing at the
  Claude Open install directory (where ClaudeOpen.exe actually lives). This is:

    * PER-USER  - Add-AppxPackage installs for the current user only.
    * NON-ELEVATED - no admin rights are required (the included public
      certificate is trusted in CurrentUser\TrustedPeople during install).
    * NON-DESTRUCTIVE - it never changes the official Claude package or normal
      Claude data. It registers the visible launcher and the hidden packaged
      runtime used by the copied signed client.

  The genuine signed Claude.exe is NOT part of this package; it is external
  content activated by the hidden Runtime application.

.PARAMETER Package
  Path to ClaudeOpen.msix. Default: msix\ClaudeOpen.msix under the repo root.

.PARAMETER ExternalLocation
  Absolute path to the launcher install directory (the folder that contains
  ClaudeOpen.exe). This is the external content root for the sparse package.

.PARAMETER Register
  Use the loose-files -Register form (register the AppxManifest.xml directly)
  instead of installing a packed .msix. Useful for local iteration.

.EXAMPLE
  # Typical per-user install (no elevation):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Install-Identity-Msix.ps1 -ExternalLocation "$env:LOCALAPPDATA\Programs\ClaudeOpen"
#>
[CmdletBinding()]
param(
  [string]$Package,
  [Parameter(Mandatory = $true)][string]$ExternalLocation,
  [switch]$Register
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MsixDir = Join-Path $RepoRoot 'msix'
if (-not $Package) { $Package = Join-Path $MsixDir 'ClaudeOpen.msix' }
$AppxManifest = Join-Path $MsixDir 'AppxManifest.xml'
$PublicCertificate = Join-Path $MsixDir 'ClaudeOpen-dev.cer'

# Resolve the external content location to an ABSOLUTE path (Add-AppxPackage
# requires an absolute -ExternalLocation).
if (-not (Test-Path -LiteralPath $ExternalLocation)) {
  throw "ExternalLocation does not exist: $ExternalLocation (it must be the folder containing ClaudeOpen.exe)"
}
$ExternalAbs = (Resolve-Path -LiteralPath $ExternalLocation).Path
$LauncherExe = Join-Path $ExternalAbs 'ClaudeOpen.exe'
if (-not (Test-Path -LiteralPath $LauncherExe)) {
  Write-Host "WARNING: $LauncherExe not found under the external location." -ForegroundColor Yellow
  Write-Host '         The package will register but has no launcher exe to run.'
}
$RuntimeExe = Join-Path $ExternalAbs 'client\claude.exe'
if (-not (Test-Path -LiteralPath $RuntimeExe)) {
  throw "Sparse runtime executable is missing: $RuntimeExe"
}

Write-Host '== Registering the Claude Open identity package (per-user, non-elevated) ==' -ForegroundColor Cyan

try {
  # A sparse package cannot be replaced in place when the release uses the same
  # package version with a newly generated signing certificate. Remove only the
  # Claude Open-owned package first; the outer installer restores the previous
  # package if a transactional update fails.
  $existing = Get-AppxPackage -Name 'ClaudeOpen' -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host '  removing the previous Claude Open identity registration'
    $existing | Remove-AppxPackage -ErrorAction Stop
  }
  if ($Register) {
    if (-not (Test-Path -LiteralPath $AppxManifest)) { throw "Missing AppxManifest.xml at $AppxManifest" }
    Write-Host "  Add-AppxPackage -Register `"$AppxManifest`" -ExternalLocation `"$ExternalAbs`""
    Add-AppxPackage -Register $AppxManifest -ExternalLocation $ExternalAbs
  } else {
    if (-not (Test-Path -LiteralPath $Package)) {
      throw "Package not found: $Package. Run scripts\Build-Identity-Msix.ps1 first (with -DevSign to trust it)."
    }
    $PackageAbs = (Resolve-Path -LiteralPath $Package).Path
    if (-not (Test-Path -LiteralPath $PublicCertificate)) {
      throw "Public package certificate is missing: $PublicCertificate"
    }
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PublicCertificate)
    if ($certificate.Subject -ne 'CN=ClaudeOpen Dev') {
      throw "Unexpected sparse-package certificate subject: $($certificate.Subject)"
    }
    $trusted = Get-ChildItem -Path 'Cert:\CurrentUser\TrustedPeople' -ErrorAction SilentlyContinue |
      Where-Object { $_.Thumbprint -eq $certificate.Thumbprint } | Select-Object -First 1
    if (-not $trusted) {
      Import-Certificate -FilePath $PublicCertificate -CertStoreLocation 'Cert:\CurrentUser\TrustedPeople' | Out-Null
      Write-Host "  trusted release certificate for this user: $($certificate.Thumbprint)"
    }
    Write-Host "  Add-AppxPackage -Path `"$PackageAbs`" -ExternalLocation `"$ExternalAbs`""
    Add-AppxPackage -Path $PackageAbs -ExternalLocation $ExternalAbs
  }
} catch {
  Write-Host "FAILED to register the identity package: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Write-Host 'Common causes:' -ForegroundColor Yellow
  Write-Host '  * 0x800B0109 / untrusted: run Build-Identity-Msix.ps1 -DevSign first so the'
  Write-Host '    self-signed cert is imported into CurrentUser\TrustedPeople (per-user).'
  Write-Host '  * 0x80073CF0 / external content: ensure -ExternalLocation is an ABSOLUTE path'
  Write-Host '    to the folder that contains ClaudeOpen.exe.'
  exit 1
}

# ---------------------------------------------------------------------------
# Verify the package family name (PFN) is now registered for this user.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '== Verifying registration ==' -ForegroundColor Cyan
$pkg = Get-AppxPackage -Name 'ClaudeOpen' -ErrorAction SilentlyContinue
if (-not $pkg) {
  Write-Host 'VERIFY FAILED: Get-AppxPackage ClaudeOpen returned nothing.' -ForegroundColor Red
  exit 1
}
Write-Host "  PackageFullName   : $($pkg.PackageFullName)"
Write-Host "  PackageFamilyName : $($pkg.PackageFamilyName)"
Write-Host "  InstallLocation   : $($pkg.InstallLocation)"
Write-Host ''
Write-Host 'Registered. "Claude Open" now has its own identity in Start / taskbar / Task Manager.' -ForegroundColor Green
Write-Host 'This registration is per-user and required NO elevation. Official Claude was not touched.'
