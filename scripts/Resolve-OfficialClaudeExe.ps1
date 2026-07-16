#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$packages = @(Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)
foreach ($package in $packages) {
  $candidate = Join-Path ([string]$package.InstallLocation) 'app\claude.exe'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    [IO.Path]::GetFullPath($candidate)
    return
  }
}

throw 'The official Claude MSIX package is not installed, or its signed app\claude.exe could not be located.'
