#Requires -Version 5.1
<#
.SYNOPSIS
  Creates a privacy-scanned, source-only Claude Open repository export.

.DESCRIPTION
  Copies an explicit allowlist. It never copies the working tree wholesale and
  never copies implementation/session reports, test evidence, user data, build
  output, dependencies, or binary files. The destination must not exist.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($destinationFull -eq [System.IO.Path]::GetPathRoot($destinationFull)) {
  throw "Refusing filesystem-root destination: $destinationFull"
}
if ($destinationFull.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($destinationFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Destination and source must not contain one another'
}
if (Test-Path -LiteralPath $destinationFull) {
  throw "Destination already exists; choose a new empty path: $destinationFull"
}

$rootFiles = @(
  '.gitignore', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'LICENSE', 'package.json', 'package-lock.json'
)
$roots = @('apps', 'packages', 'scripts', 'tests', 'installer', 'docs', 'assets', 'msix', '.github')
$allowedExtensions = @(
  '.cs', '.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.yml', '.yaml',
  '.txt', '.xml', '.manifest', '.gitignore'
)
$forbiddenNames = @(
  'IMPLEMENTATION-OUTCOMES.md', 'IMPLEMENTATION-PLAN.md',
  'NEXT-IMPLEMENTATION-INSTRUCTIONS.md', 'PROGRAMS-ORGANIZATION-MANIFEST.md'
)
$forbiddenSegments = @(
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'test-results',
  'profile', 'user data', 'cache', 'logs', 'spike'
)
$binaryExtensions = @(
  '.exe', '.dll', '.node', '.asar', '.msix', '.msixbundle', '.appx',
  '.appxbundle', '.ico', '.png', '.jpg', '.jpeg', '.db', '.sqlite', '.zip'
)

function Test-ExportableFile {
  param([System.IO.FileInfo]$File)
  $relative = $File.FullName.Substring($source.Length).TrimStart('\','/')
  # This project-owned launcher icon is the sole binary source asset. Vendor
  # binaries and generated packages remain forbidden.
  if ($relative.Replace('/','\') -eq 'assets\claude-open.ico') { return $true }
  $segments = $relative -split '[\\/]'
  foreach ($segment in $segments) {
    if ($forbiddenSegments -contains $segment.ToLowerInvariant()) { return $false }
  }
  if ($forbiddenNames -contains $File.Name) { return $false }
  if ($File.Name -match '^(SESSION-|IMPLEMENTATION-|NEXT-|PROGRAMS-)') { return $false }
  if ($binaryExtensions -contains $File.Extension.ToLowerInvariant()) { return $false }
  return $allowedExtensions -contains $File.Extension.ToLowerInvariant()
}

New-Item -ItemType Directory -Path $destinationFull | Out-Null
try {
  foreach ($name in $rootFiles) {
    $file = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required source file is missing: $name" }
    Copy-Item -LiteralPath $file -Destination (Join-Path $destinationFull $name)
  }

  foreach ($root in $roots) {
    $rootPath = Join-Path $source $root
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $rootPath -Recurse -File -Force) {
      if (-not (Test-ExportableFile $file)) { continue }
      $relative = $file.FullName.Substring($source.Length).TrimStart('\','/')
      $target = Join-Path $destinationFull $relative
      $parent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $file.FullName -Destination $target
    }
  }

  $scanner = Join-Path $destinationFull 'scripts\verify-release.ps1'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $scanner -Path $destinationFull
  if ($LASTEXITCODE -ne 0) { throw "Clean-export privacy scan failed: $LASTEXITCODE" }

  $forbidden = Get-ChildItem -LiteralPath $destinationFull -Recurse -File -Force | Where-Object {
    $_.Name -match '^(SESSION-|IMPLEMENTATION-|NEXT-|PROGRAMS-)' -or
    (($binaryExtensions -contains $_.Extension.ToLowerInvariant()) -and
      $_.FullName.Substring($destinationFull.Length).TrimStart('\','/').Replace('/','\') -ne 'assets\claude-open.ico')
  }
  if ($forbidden) { throw 'Export contains a forbidden internal or binary file' }
  Write-Host "Clean, privacy-scanned source export created: $destinationFull"
} catch {
  # Only remove the exact new directory created by this invocation.
  if (Test-Path -LiteralPath $destinationFull) {
    $resolved = [System.IO.Path]::GetFullPath($destinationFull).TrimEnd('\')
    if ($resolved -eq $destinationFull -and $resolved -ne [System.IO.Path]::GetPathRoot($resolved)) {
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
  throw
}
