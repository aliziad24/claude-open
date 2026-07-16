[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Claude Open'),
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$installDir = [IO.Path]::GetFullPath($InstallDir)
$profileDir = Join-Path $env:APPDATA 'ClaudeOpen\User Data\profile'
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude Open.lnk'
$official = @(Get-AppxPackage -Name 'Claude' -ErrorAction SilentlyContinue)
$identity = @(Get-AppxPackage -Name 'ClaudeOpen' -ErrorAction SilentlyContinue)
$features = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')

$featureState = [ordered]@{}
foreach ($feature in $features) {
  try {
    $featureState[$feature] = [string](Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction Stop).State
  } catch {
    $featureState[$feature] = 'UnavailableOrRequiresElevation'
  }
}

$report = [ordered]@{
  windows = ($env:OS -eq 'Windows_NT')
  architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  wingetAvailable = [bool](Get-Command winget.exe -ErrorAction SilentlyContinue)
  officialClaudeInstalled = ($official.Count -gt 0)
  claudeOpenIdentityInstalled = ($identity.Count -gt 0)
  claudeOpenLauncherInstalled = (Test-Path -LiteralPath (Join-Path $installDir 'ClaudeOpen.exe'))
  claudeOpenStartShortcutInstalled = (Test-Path -LiteralPath $shortcut)
  isolatedProfileExists = (Test-Path -LiteralPath $profileDir)
  nonSecretConfigurationExists = (Test-Path -LiteralPath (Join-Path (Join-Path $env:APPDATA 'ClaudeOpen') 'config.json'))
  coworkPrerequisites = $featureState
  secretsIncluded = $false
}

if ($Json) { $report | ConvertTo-Json -Depth 4 } else { $report.GetEnumerator() | Format-Table -AutoSize }
