#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Claude Open'),
  [switch]$NoShortcut,
  # Upgrading the SHARED official Claude package is OPT-IN. By default the installer
  # NEVER mutates the user's normal Claude; it only installs official Claude if it
  # is entirely absent (a hard dependency for the signed client). Pass
  # -UpdateOfficialClaude to also run `winget upgrade` on an existing install.
  [switch]$UpdateOfficialClaude,
  # Back-compat: previously the default was to upgrade and this switch opted out.
  # It is now a no-op (default is already no-upgrade) but accepted so old scripts
  # do not break.
  [switch]$DoNotUpdateOfficialClaude,
  [switch]$AllowUnverifiedOfficialVersion,
  [switch]$EnableCoworkPrerequisites
)

$ErrorActionPreference = 'Stop'
$productId = 'ClaudeOpen.Windows'
$source = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$target = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$localAppData = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
$previousCertificateThumbprint = $null
if (-not $target.StartsWith($localAppData + '\', [StringComparison]::OrdinalIgnoreCase) -and -not $PSBoundParameters.ContainsKey('InstallDir')) {
  throw "Default install target escaped LocalAppData: $target"
}
if ($target -eq [System.IO.Path]::GetPathRoot($target) -or $target -eq $localAppData) {
  throw "Refusing unsafe install target: $target"
}
if (Test-Path -LiteralPath $target) {
  $existingMarkerPath = Join-Path $target '.claude-open-install.json'
  if (-not (Test-Path -LiteralPath $existingMarkerPath -PathType Leaf)) {
    throw "Refusing to replace a directory that is not marked as a Claude Open installation: $target"
  }
  $existingMarker = Get-Content -LiteralPath $existingMarkerPath -Raw | ConvertFrom-Json
  if ($existingMarker.productId -ne 'ClaudeOpen.Windows' -or
      [System.IO.Path]::GetFullPath([string]$existingMarker.installDir).TrimEnd('\') -ne $target) {
    throw "Refusing to replace a directory whose Claude Open marker does not match: $target"
  }
  if ($existingMarker.sparseIdentity.certificateThumbprint) {
    $previousCertificateThumbprint = [string]$existingMarker.sparseIdentity.certificateThumbprint
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-ShortcutAppUserModelId {
  # Set PKEY_AppUserModel_ID on a .lnk via the Windows Shell property store, so
  # the shortcut (and any pinned tile derived from it) groups under the launcher's
  # explicit AUMID rather than Windows's default exe-path grouping. WScript.Shell
  # cannot do this, so we call IShellLink/IPersistFile + IPropertyStore through a
  # small compiled helper. Idempotent and non-fatal (caller wraps in try/catch).
  param(
    [Parameter(Mandatory = $true)][string]$LnkPath,
    [Parameter(Mandatory = $true)][string]$AppUserModelId
  )
  if ($AppUserModelId -notmatch '^[A-Za-z][A-Za-z0-9._-]*(!.+)?$') {
    throw "Unsafe AppUserModelId: $AppUserModelId"
  }
  $type = 'ClaudeOpenShortcutAumid'
  if (-not ([System.Management.Automation.PSTypeName]$type).Type) {
    $cs = @'
using System;
using System.Runtime.InteropServices;

public static class ClaudeOpenShortcutAumid {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] private class CShellLink { }
    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [StructLayout(LayoutKind.Sequential)] private struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)] private struct PROPVARIANT {
        public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public int p2;
    }
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PROPVARIANT pvar);

    public static void Set(string lnkPath, string aumid) {
        var link = (IPersistFile)new CShellLink();
        link.Load(lnkPath, 2 /*STGM_READWRITE*/);
        var store = (IPropertyStore)link;
        // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5
        var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var pv = new PROPVARIANT { vt = 31 /*VT_LPWSTR*/, p = Marshal.StringToCoTaskMemUni(aumid) };
        store.SetValue(ref key, ref pv);
        store.Commit();
        link.Save(lnkPath, true);
        PropVariantClear(ref pv);
    }
}
'@
    Add-Type -TypeDefinition $cs -Language CSharp | Out-Null
  }
  [ClaudeOpenShortcutAumid]::Set($LnkPath, $AppUserModelId)
}

function Assert-ReleaseManifest {
  $manifestPath = Join-Path $source 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Release payload is missing release-manifest.json' }
  # Windows PowerShell 5.1 returns a top-level JSON array as one Object[]
  # pipeline item. Do not wrap it in another array or every property becomes
  # a concatenated multi-value property during validation.
  $items = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($items.Count -eq 0) { throw 'Release manifest is empty' }
  foreach ($item in $items) {
    $relative = [string]$item.Path
    if ([System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') {
      throw "Release manifest contains unsafe path: $relative"
    }
    $file = [System.IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not $file.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "Release manifest file is missing or unsafe: $relative"
    }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($actual -ne [string]$item.SHA256 -or (Get-Item -LiteralPath $file).Length -ne [long]$item.Length) {
      throw "Release payload integrity check failed: $relative"
    }
  }
}

function Get-LatestInstalledClaudePackage {
  return Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
}

function Assert-InstalledTarget {
  # FIX #4b: post-swap verification. Confirms the swapped-in install actually
  # contains the files required to run, BEFORE the rollback backup is deleted.
  # Throws (triggering rollback) if anything critical is missing.
  param([Parameter(Mandatory = $true)][string]$Root)
  $required = @(
    'ClaudeOpen.exe',
    'adapter',
    'runtime\node.exe',
    'scripts\write-3p-config.mjs',   # launcher refuses to activate 3P without this
    'scripts\apply-ion-patches.mjs',
    'client\claude.exe',
    'client\resources\ion-dist\assets\v1\claude-open-patches.json',
    'msix\ClaudeOpen.msix',
    '.claude-open-install.json'      # our ownership marker
  )
  foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $rel))) {
      throw "Post-swap verification failed: missing '$rel' in $Root"
    }
  }
  # The marker must parse and identify this install.
  $marker = Get-Content -LiteralPath (Join-Path $Root '.claude-open-install.json') -Raw | ConvertFrom-Json
  if ($marker.productId -ne 'ClaudeOpen.Windows') {
    throw "Post-swap verification failed: marker productId mismatch in $Root"
  }
}

function Invoke-WingetClaude {
  param([ValidateSet('install','upgrade')][string]$Action)
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'winget is required to acquire or verify the current official Claude package' }
  & $winget.Source $Action --id Anthropic.Claude -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity |
    ForEach-Object { Write-Host $_ }
  $exit = $LASTEXITCODE
  # 0x8A15002B means there is no applicable upgrade: the installed package is current.
  $notApplicable = [int]0x8A15002B
  if ($exit -ne 0 -and -not ($Action -eq 'upgrade' -and $exit -eq $notApplicable)) {
    if (-not $AllowUnverifiedOfficialVersion) { throw "Official Claude $Action/version check failed: winget exit $exit" }
    Write-Warning "winget could not verify the latest official Claude version (exit $exit); continuing only because -AllowUnverifiedOfficialVersion was specified."
  }
  return $exit
}

function Stop-OwnedProcesses {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root)) { return }
  $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Register-ClaudeLoopbackExemption {
  # The genuine WindowsApps Claude client runs in an AppContainer that BLOCKS
  # loopback (127.0.0.1) connections to the Claude Open adapter unless the
  # package has a LoopbackExempt entry. Register it once, during the elevated
  # install, so the client's 3P fetch to the local adapter is not sandbox-blocked.
  #
  # The exemption is per-package and shared with normal Claude. That is
  # unavoidable and harmless: it only ALLOWS loopback, which normal Claude does
  # not use. Idempotent: skips when the family is already exempt.
  param([Parameter(Mandatory = $true)][string]$Family)

  # A well-formed package family name is <Name>_<publisherHash>. Refuse anything
  # else so an unexpected value can never be spliced into a native command.
  if ($Family -notmatch '^[A-Za-z0-9.]+_[A-Za-z0-9]+$') {
    Write-Warning "Skipping loopback exemption: unsafe package family name '$Family'."
    return
  }

  $cnis = Get-Command CheckNetIsolation -ErrorAction SilentlyContinue
  if (-not $cnis) {
    Write-Warning "CheckNetIsolation not found; cannot register the loopback exemption. Run manually elevated: CheckNetIsolation LoopbackExempt -a -n=$Family"
    return
  }

  $current = & CheckNetIsolation LoopbackExempt -s 2>$null
  # Whole-token, case-insensitive match on any 'Name:' line (matches the launcher
  # and identity-harness isFamilyLoopbackExempt contract).
  $already = $false
  foreach ($line in @($current)) {
    if ($line -match '^\s*Name:\s*(.+?)\s*$') {
      if ($matches[1].Trim().ToLowerInvariant() -eq $Family.ToLowerInvariant()) { $already = $true; break }
    }
  }
  if ($already) {
    Write-Host "Loopback exemption already present for $Family."
    return
  }

  & CheckNetIsolation LoopbackExempt -a -n=$Family | Out-Null
  # Verify + log.
  $after = & CheckNetIsolation LoopbackExempt -s 2>$null
  $confirmed = $false
  foreach ($line in @($after)) {
    if ($line -match '^\s*Name:\s*(.+?)\s*$') {
      if ($matches[1].Trim().ToLowerInvariant() -eq $Family.ToLowerInvariant()) { $confirmed = $true; break }
    }
  }
  if ($confirmed) {
    Write-Host "Registered loopback exemption for $Family (CheckNetIsolation LoopbackExempt -a -n=$Family)."
  } else {
    Write-Warning "Loopback exemption for $Family not confirmed. Run manually elevated: CheckNetIsolation LoopbackExempt -a -n=$Family"
  }
}

function Get-CoworkPrerequisiteState {
  $vmp = 'Unknown'
  try { $vmp = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction Stop).State.ToString() } catch {}
  $hypervisor = $false
  try { $hypervisor = [bool](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent } catch {}
  $service = Get-Service -Name CoworkVMService -ErrorAction SilentlyContinue
  $substrateDetected = $hypervisor -and $service -and $service.Status -eq 'Running' -and $vmp -ne 'Disabled'
  return [ordered]@{
    assessment = if ($substrateDetected) { 'prerequisites-detected' } else { 'not-ready-or-unverified' }
    virtualMachinePlatform = $vmp
    virtualMachinePlatformQueryRequiresElevation = ($vmp -eq 'Unknown')
    hypervisorPresent = $hypervisor
    coworkVmServiceInstalled = [bool]$service
    coworkVmServiceStatus = if ($service) { $service.Status.ToString() } else { 'NotInstalled' }
    rebootMayBeRequired = ($vmp -eq 'EnablePending' -or -not $hypervisor)
    functionalCoworkTest = 'not-run'
    note = 'This is a local prerequisite check only. It does not claim that Anthropic cloud-only account, sync, Dispatch, or plan services work through an arbitrary gateway.'
  }
}

Assert-ReleaseManifest
# scripts/  - contains write-3p-config.mjs (required by ClaudeOpen.cs:1571 for every
#             3P activation) plus Install-Identity-Msix.ps1 / Build-Identity-Msix.ps1.
# msix/     - contains AppxManifest.xml, fusion manifest, logos, and (when built with
#             an available Windows SDK) the packed ClaudeOpen.msix consumed by the
#             identity registration step (~line 298). Omitting either previously left
#             the packaged install unable to activate 3P and silently un-identified.
foreach ($name in @('ClaudeOpen.exe','adapter','runtime','data','assets','scripts','msix','LICENSE','Uninstall-ClaudeOpen.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $name))) { throw "Release payload is missing $name" }
}

$existingPackage = Get-LatestInstalledClaudePackage
$officialPreExisting = [bool]$existingPackage
# Upgrade of an EXISTING official Claude is opt-in only (-UpdateOfficialClaude).
# If official Claude is absent we must install it (hard dependency for the signed
# client). We never silently mutate a present official Claude.
$wingetAction = if (-not $existingPackage) { 'install' } elseif ($UpdateOfficialClaude) { 'upgrade' } else { 'none' }
$wingetExit = $null
if (-not $existingPackage) {
  $wingetExit = Invoke-WingetClaude -Action install
} elseif ($UpdateOfficialClaude) {
  $wingetExit = Invoke-WingetClaude -Action upgrade
} else {
  Write-Host 'Leaving the existing official Claude package unchanged (pass -UpdateOfficialClaude to upgrade it).'
}
$pkg = Get-LatestInstalledClaudePackage
if (-not $pkg) { throw 'Official Claude package could not be located after acquisition' }

if ($EnableCoworkPrerequisites) {
  if (-not (Test-IsAdministrator)) { throw '-EnableCoworkPrerequisites requires an elevated PowerShell session' }
  $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
  if ($vmp.State -ne 'Enabled') {
    Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart | Out-Null
  }
  $coworkService = Get-Service -Name CoworkVMService -ErrorAction SilentlyContinue
  if ($coworkService -and $coworkService.Status -ne 'Running') { Start-Service -Name CoworkVMService -ErrorAction SilentlyContinue }
}

$parent = Split-Path -Parent $target
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$staging = Join-Path $parent ('.ClaudeOpen.install.' + [Guid]::NewGuid().ToString('N'))
$backup = Join-Path $parent ('.ClaudeOpen.previous.' + [Guid]::NewGuid().ToString('N'))
if (-not ([System.IO.Path]::GetFullPath($staging).StartsWith([System.IO.Path]::GetFullPath($parent).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
  throw 'Unsafe staging path'
}
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  foreach ($name in @('ClaudeOpen.exe','adapter','runtime','data','assets','scripts','msix','LICENSE','Uninstall-ClaudeOpen.ps1')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination $staging -Recurse -Force
  }

  $client = Join-Path $staging 'client'
  New-Item -ItemType Directory -Path $client | Out-Null
  $officialApp = Join-Path $pkg.InstallLocation 'app'
  if (-not (Test-Path -LiteralPath (Join-Path $officialApp 'claude.exe'))) { throw 'Official package does not contain app\claude.exe' }
  $copy = Start-Process -FilePath robocopy.exe -ArgumentList @("`"$officialApp`"","`"$client`"",'/E','/COPY:DAT','/R:2','/W:1','/NFL','/NDL','/NJH','/NJS') -Wait -PassThru -NoNewWindow
  if ($copy.ExitCode -gt 7) { throw "Official runtime copy failed: robocopy $($copy.ExitCode)" }
  $clientExe = Join-Path $client 'claude.exe'
  $sig = Get-AuthenticodeSignature -LiteralPath $clientExe
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Anthropic') {
    throw 'Copied official client failed Anthropic signature verification'
  }
  $patchScript = Join-Path $staging 'scripts\apply-ion-patches.mjs'
  $widgetSource = Join-Path $staging 'assets\z-usage-widget.js'
  $nodeRuntime = Join-Path $staging 'runtime\node.exe'
  & $nodeRuntime $patchScript $client $widgetSource
  if ($LASTEXITCODE -ne 0) { throw "Official client UI patch failed: exit $LASTEXITCODE" }

  $identityCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2((Join-Path $staging 'msix\ClaudeOpen-dev.cer'))

  $cowork = Get-CoworkPrerequisiteState
  $state = [ordered]@{
    schemaVersion = 1
    productId = $productId
    installedAtUtc = [DateTime]::UtcNow.ToString('o')
    installDir = $target
    normalClaudeModifiedByUninstaller = $false
    officialDependency = [ordered]@{
      packageName = $pkg.Name
      packageVersion = $pkg.Version.ToString()
      packageInstallLocation = $pkg.InstallLocation
      preExisting = $officialPreExisting
      installedByThisRun = -not $officialPreExisting
      updateCheck = if ($wingetAction -eq 'none') { 'left-unchanged-opt-in-not-set' } elseif ($wingetAction -eq 'install') { 'installed-absent-dependency' } else { 'winget-upgrade-completed-or-current' }
      wingetAction = $wingetAction
      wingetExitCode = $wingetExit
      copiedClientSignatureStatus = $sig.Status.ToString()
      copiedClientSigner = $sig.SignerCertificate.Subject
      copiedClientThumbprint = $sig.SignerCertificate.Thumbprint
    }
    sparseIdentity = [ordered]@{
      packageName = 'ClaudeOpen'
      runtimeApplicationId = 'Runtime'
      certificateThumbprint = $identityCertificate.Thumbprint
    }
    cowork = $cowork
  }
  [System.IO.File]::WriteAllText((Join-Path $staging '.claude-open-install.json'), ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))

  Stop-OwnedProcesses -Root $target
  if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup }
  try {
    Move-Item -LiteralPath $staging -Destination $target
    # FIX #4b: verify the swapped-in install BEFORE the prior backup is deleted, so
    # a bad swap always leaves a working rollback. If verification fails, restore
    # the previous install from $backup and abort.
    Assert-InstalledTarget -Root $target
    $identityScript = Join-Path $target 'scripts\Install-Identity-Msix.ps1'
    $identityPackage = Join-Path $target 'msix\ClaudeOpen.msix'
    Write-Host 'Registering the Claude Open launcher and packaged runtime identity...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $identityScript -ExternalLocation $target -Package $identityPackage
    if ($LASTEXITCODE -ne 0) { throw "Sparse identity registration failed: exit $LASTEXITCODE" }
    $registered = Get-AppxPackage -Name ClaudeOpen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $registered) { throw 'Sparse identity verification failed: ClaudeOpen package is not registered' }
  } catch {
    # post-swap verification (or the move itself) failed: roll back to the prior
    # install so the user is never left with a broken/half installed target.
    $installError = $_
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target }
    else {
      Get-AppxPackage -Name ClaudeOpen -ErrorAction SilentlyContinue |
        Remove-AppxPackage -ErrorAction SilentlyContinue
    }
    # If this was an update, restore the previous sparse identity as well as
    # the previous files. This keeps the old launcher usable after a failed
    # registration of the new package.
    if (Test-Path -LiteralPath (Join-Path $target '.claude-open-install.json')) {
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target 'scripts\Install-Identity-Msix.ps1') `
          -ExternalLocation $target -Package (Join-Path $target 'msix\ClaudeOpen.msix')
        if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
      } catch {
        Write-Warning "The previous files were restored, but their sparse identity could not be re-registered: $($_.Exception.Message)"
      }
    }
    throw $installError
  }
  # Only now, after the new install verified good, remove the rollback backup.
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  if ($previousCertificateThumbprint -and $previousCertificateThumbprint -ne $identityCertificate.Thumbprint) {
    Remove-Item -LiteralPath ("Cert:\CurrentUser\TrustedPeople\" + $previousCertificateThumbprint) -Force -ErrorAction SilentlyContinue
  }
} catch {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  throw
}

if (-not $NoShortcut) {
  $shortcutDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null
  $lnkPath = Join-Path $shortcutDir 'Claude Open.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($lnkPath)
  $shortcut.TargetPath = Join-Path $target 'ClaudeOpen.exe'
  $shortcut.WorkingDirectory = $target
  $shortcut.IconLocation = (Join-Path $target 'ClaudeOpen.exe') + ',0'
  $shortcut.Save()

  # Stamp the shortcut with the hidden packaged runtime's AUMID. The launcher
  # resolves and adopts this same value at startup, giving the user one Claude
  # Open Start/taskbar identity even though a separate signed runtime process is
  # required for Cowork. Normal Claude has a different package family/AUMID.
  # WScript.Shell cannot set AUMID, so use the Windows Property System helper.
  $aumid = $registered.PackageFamilyName + '!Runtime'
  try {
    Set-ShortcutAppUserModelId -LnkPath $lnkPath -AppUserModelId $aumid
    Write-Host "Stamped shortcut AppUserModel.ID = $aumid (unified Claude Open identity)."
  } catch {
    Write-Warning "Could not stamp the shortcut AppUserModel.ID ($($_.Exception.Message)); the launcher still works but Windows may show a second Claude Open taskbar button."
  }
}

$finalCowork = Get-CoworkPrerequisiteState
Write-Host "Claude Open installed at $target"
Write-Host "Official signed client version copied: $($pkg.Version)"
if ($finalCowork.assessment -ne 'prerequisites-detected') {
  Write-Warning 'Cowork prerequisites are missing or could not be verified. Rerun elevated with -EnableCoworkPrerequisites, then reboot if Windows enables VirtualMachinePlatform. A real Cowork task must still be tested after reboot.'
} else {
  Write-Host 'Cowork local VM prerequisites detected. Functional Cowork behavior is not claimed until a real task is tested.'
}
Write-Host 'Normal Claude and its user data remain installed and separate.'
