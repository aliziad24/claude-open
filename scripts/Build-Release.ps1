#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputPath,
  [switch]$IncludeLocalOfficialClient
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputPath) { $OutputPath = Join-Path $repo 'dist\ClaudeOpen-bootstrap' }
$out = [System.IO.Path]::GetFullPath($OutputPath)
if (-not $out.StartsWith($repo + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputPath must stay inside the repository for this build: $out"
}
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
New-Item -ItemType Directory -Path (Join-Path $out 'adapter'),(Join-Path $out 'runtime'),(Join-Path $out 'data'),(Join-Path $out 'assets') | Out-Null

$icon = Join-Path $repo 'assets\claude-open.ico'
& (Join-Path $PSScriptRoot 'New-ClaudeOpenIcon.ps1') -Path $icon
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { throw '.NET Framework x64 C# compiler not found' }

# --- Separate-identity wiring (Workstream 1) -------------------------------
# Generate the embeddable Win32 application (fusion) manifest that binds the
# LAUNCHER (ClaudeOpen.exe) to the "ClaudeOpen" MSIX package identity, then
# compile the launcher with csc /win32manifest so it carries that identity.
#
# HONESTY: this re-identifies ONLY the LAUNCHER (its own Start entry, taskbar
# button, icon, and Task Manager name). The genuine child Claude.exe that the
# launcher spawns at runtime is untouched and still reports as Claude.exe --
# it is vendor-locked (renaming it breaks Cowork's Anthropic WinVerifyTrust
# signature gate). See docs/IDENTITY.md.
#
# The sparse identity is required for the packaged runtime activation used by
# Cowork. A release build fails instead of silently producing a partial app.
$identityManifest = Join-Path $repo 'msix\ClaudeOpen.exe.manifest'
try {
  & (Join-Path $PSScriptRoot 'Build-Identity-Msix.ps1')
} catch {
  throw "Identity manifest build failed: $($_.Exception.Message)"
}

$launcherOut = Join-Path $out 'ClaudeOpen.exe'
$launcherSource = Join-Path $repo 'apps\launcher\ClaudeOpen.cs'
if (-not (Test-Path -LiteralPath $identityManifest)) { throw 'Identity manifest was not generated' }
Write-Host "Compiling launcher WITH separate identity (win32manifest: $identityManifest)"
& $csc /nologo /target:winexe "/win32icon:$icon" "/win32manifest:$identityManifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Management.dll "/out:$launcherOut" $launcherSource
if ($LASTEXITCODE -ne 0) { throw "launcher compilation failed: $LASTEXITCODE" }

# Pack and sign the sparse identity after the launcher exists. The generated
# public certificate ships with the release; the private PFX is deleted by the
# identity builder and is never copied or committed.
& (Join-Path $PSScriptRoot 'Build-Identity-Msix.ps1') -LauncherExe $launcherOut -DevSign -Force
if (-not (Test-Path -LiteralPath (Join-Path $repo 'msix\ClaudeOpen.msix'))) { throw 'Sparse identity package was not built' }
if (-not (Test-Path -LiteralPath (Join-Path $repo 'msix\ClaudeOpen-dev.cer'))) { throw 'Sparse identity public certificate was not built' }

$adapterOut = Join-Path $out 'adapter\adapter.mjs'
& (Join-Path $repo 'node_modules\.bin\esbuild.cmd') (Join-Path $repo 'apps\adapter-server\src\main.js') --bundle --platform=node --format=esm --target=node20 "--outfile=$adapterOut"
if ($LASTEXITCODE -ne 0) { throw "adapter bundle failed: $LASTEXITCODE" }

# Bundle the 3P config producer (with its identity-harness import inlined) so
# the Control Center launch path can shell out to it from the packaged dist.
New-Item -ItemType Directory -Path (Join-Path $out 'scripts') | Out-Null
$writeConfigOut = Join-Path $out 'scripts\write-3p-config.mjs'
& (Join-Path $repo 'node_modules\.bin\esbuild.cmd') (Join-Path $repo 'scripts\write-3p-config.mjs') --bundle --platform=node --format=esm --target=node20 "--outfile=$writeConfigOut"
if ($LASTEXITCODE -ne 0) { throw "write-3p-config bundle failed: $LASTEXITCODE" }
$node = (Get-Command node -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $out 'runtime\node.exe')
$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(2[0-9]|[3-9][0-9])\.') { throw "Bundled Node runtime is unsupported: $nodeVersion" }
Copy-Item -LiteralPath (Join-Path $repo 'packages\model-registry\data\registry.json') -Destination (Join-Path $out 'data\registry.json')
Copy-Item -LiteralPath (Join-Path $repo 'assets\z-usage-widget.js') -Destination (Join-Path $out 'assets\z-usage-widget.js')
Copy-Item -LiteralPath $icon -Destination (Join-Path $out 'assets\claude-open.ico')
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $out 'LICENSE')
Copy-Item -LiteralPath (Join-Path $repo 'installer\Install-ClaudeOpen.ps1') -Destination (Join-Path $out 'Install-ClaudeOpen.ps1')
Copy-Item -LiteralPath (Join-Path $repo 'installer\Uninstall-ClaudeOpen.ps1') -Destination (Join-Path $out 'Uninstall-ClaudeOpen.ps1')

# --- Ship the per-user identity payload (Workstream 1) ---------------------
# Stage the identity scripts and the msix package folder (AppxManifest, fusion
# fragment, generated logos, and -- when the SDK was present -- the packed
# ClaudeOpen.msix) so Install-ClaudeOpen.ps1 can offer the PER-USER, NON-elevated
# identity registration (Add-AppxPackage -ExternalLocation) after install. If the
# identity build produced nothing packable, the launcher still works (it just
# shares the taskbar) and the registration step becomes a no-op.
Copy-Item -LiteralPath (Join-Path $repo 'scripts\Build-Identity-Msix.ps1') -Destination (Join-Path $out 'scripts\Build-Identity-Msix.ps1')
Copy-Item -LiteralPath (Join-Path $repo 'scripts\Install-Identity-Msix.ps1') -Destination (Join-Path $out 'scripts\Install-Identity-Msix.ps1')
Copy-Item -LiteralPath (Join-Path $repo 'scripts\New-ClaudeOpenIcon.ps1') -Destination (Join-Path $out 'scripts\New-ClaudeOpenIcon.ps1')
Copy-Item -LiteralPath (Join-Path $repo 'scripts\apply-ion-patches.mjs') -Destination (Join-Path $out 'scripts\apply-ion-patches.mjs')
$msixStage = Join-Path $out 'msix'
# Copy the package and its PUBLIC signing certificate, but never a private PFX.
robocopy (Join-Path $repo 'msix') $msixStage /E /XF *.pfx /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw "identity msix payload copy failed: robocopy $LASTEXITCODE" }
# robocopy uses non-zero success codes; reset so a later '-ne 0' check is not tripped.
$global:LASTEXITCODE = 0

if ($IncludeLocalOfficialClient) {
  $pkg = Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1
  if (-not $pkg) { throw 'Official Claude is not installed; cannot create local client test stage' }
  $source = Join-Path $pkg.InstallLocation 'app'
  $client = Join-Path $out 'client'
  New-Item -ItemType Directory -Path $client | Out-Null
  $copy = Start-Process -FilePath robocopy.exe -ArgumentList @("`"$source`"","`"$client`"",'/E','/COPY:DAT','/R:2','/W:1','/NFL','/NDL','/NJH','/NJS') -Wait -PassThru -NoNewWindow
  $copyExit = $copy.ExitCode
  if ($copyExit -gt 7) { throw "official client copy failed: robocopy $copyExit" }
  $sig = Get-AuthenticodeSignature -LiteralPath (Join-Path $client 'claude.exe')
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Anthropic') { throw "copied client signature invalid: $($sig.Status)" }
  & (Join-Path $out 'runtime\node.exe') (Join-Path $out 'scripts\apply-ion-patches.mjs') $client (Join-Path $out 'assets\z-usage-widget.js')
  if ($LASTEXITCODE -ne 0) { throw "client UI patch failed: $LASTEXITCODE" }
  [System.IO.File]::WriteAllText(
    (Join-Path $client 'official-package.json'),
    ([ordered]@{
      packageName = $pkg.Name
      packageVersion = $pkg.Version.ToString()
      source = 'locally-installed-official-package-for-testing-only'
      signatureStatus = $sig.Status.ToString()
      signer = $sig.SignerCertificate.Subject
      functionalCoworkTest = 'not-run'
    } | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
  )
}

Get-ChildItem -LiteralPath $out -Recurse -File | ForEach-Object {
  [pscustomobject]@{ Path=$_.FullName.Substring($out.Length).TrimStart('\'); Length=$_.Length; SHA256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
} | ConvertTo-Json -Depth 4 | ForEach-Object {
  [System.IO.File]::WriteAllText((Join-Path $out 'release-manifest.json'), $_, (New-Object Text.UTF8Encoding($false)))
}
Write-Host "Built Claude Open stage: $out"

# The signed package and public certificate are release outputs, not source
# files. Keep the source tree binary-free after they have been copied and
# hashed into the finished stage.
Remove-Item -LiteralPath (Join-Path $repo 'msix\ClaudeOpen.msix') -Force
Remove-Item -LiteralPath (Join-Path $repo 'msix\ClaudeOpen-dev.cer') -Force
