#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='Medium')]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Claude Open'),
  [switch]$RemoveUserData
)

$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if ($target -eq [System.IO.Path]::GetPathRoot($target) -or $target -eq [System.IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')) {
  throw "Refusing unsafe uninstall target: $target"
}
$markerPath = Join-Path $target '.claude-open-install.json'
if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
  throw "Refusing to uninstall because the Claude Open installation marker is absent: $markerPath"
}
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.productId -ne 'ClaudeOpen.Windows' -or -not ([System.IO.Path]::GetFullPath([string]$marker.installDir).TrimEnd('\') -eq $target)) {
  throw 'Refusing to uninstall because the installation marker does not match this directory'
}

function Stop-OwnedProcesses {
  param([string]$Root)
  $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude Open.lnk'
if ($PSCmdlet.ShouldProcess($target,'Uninstall Claude Open application')) {
  Stop-OwnedProcesses -Root $target
  Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
  Get-AppxPackage -Name ClaudeOpen -ErrorAction SilentlyContinue |
    Remove-AppxPackage -ErrorAction SilentlyContinue
  $thumbprint = [string]$marker.sparseIdentity.certificateThumbprint
  if ($thumbprint -match '^[A-Fa-f0-9]{40}$') {
    Remove-Item -LiteralPath ("Cert:\CurrentUser\TrustedPeople\" + $thumbprint) -Force -ErrorAction SilentlyContinue
  }
  $profileOverride = [Environment]::GetEnvironmentVariable('CLAUDE_USER_DATA_DIR', 'User')
  $ownedProfile = Join-Path $env:APPDATA 'ClaudeOpen\User Data\profile'
  if ($profileOverride -and [System.IO.Path]::GetFullPath($profileOverride).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($ownedProfile).TrimEnd('\')) {
    [Environment]::SetEnvironmentVariable('CLAUDE_USER_DATA_DIR', $null, 'User')
  }
  Remove-Item -LiteralPath $target -Recurse -Force
}
if ($RemoveUserData) {
  $allowedRoots = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'ClaudeOpen')).TrimEnd('\'),
    [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ClaudeOpen')).TrimEnd('\')
  )
  foreach ($data in $allowedRoots) {
    if ($data -eq [System.IO.Path]::GetPathRoot($data)) { throw "Unsafe user-data path: $data" }
    if ($PSCmdlet.ShouldProcess($data,'Remove Claude Open user data')) {
      Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  if ($PSCmdlet.ShouldProcess('ClaudeOpen/gateway/current','Remove Claude Open gateway credential')) {
    & cmdkey.exe '/delete:ClaudeOpen/gateway/current' 2>$null | Out-Null
  }
}
Write-Host 'Claude Open uninstalled. The official Claude package and normal Claude user data were not changed.'
