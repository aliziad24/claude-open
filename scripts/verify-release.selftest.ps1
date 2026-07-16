#Requires -Version 5.1
<#
.SYNOPSIS
  Self-tests for verify-release.ps1 (NEXT-INSTRUCTIONS 10.1).

.DESCRIPTION
  Plants a synthetic secret / private path / vendor binary into a temporary
  scan tree and asserts the scanner FAILS (non-zero) on each, then asserts it
  PASSES on a clean tree. This proves the scanner actually detects, rather than
  silently passing. No real secrets are used.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scanner = Join-Path $PSScriptRoot 'verify-release.ps1'
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("co-selftest-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null

$failures = 0
function Check($name, $expectFail, $exit) {
  $got = ($exit -ne 0)
  if ($got -eq $expectFail) {
    Write-Host ("  PASS  {0} (exit={1}, expectedFail={2})" -f $name, $exit, $expectFail) -ForegroundColor Green
  } else {
    Write-Host ("  FAIL  {0} (exit={1}, expectedFail={2})" -f $name, $exit, $expectFail) -ForegroundColor Red
    $script:failures++
  }
}

function RunScan($path) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $scanner -Path $path *> $null
  return $LASTEXITCODE
}

try {
  Write-Host 'verify-release self-tests:'

  # 1. clean tree passes
  $clean = Join-Path $root 'clean'
  New-Item -ItemType Directory -Path $clean -Force | Out-Null
  Set-Content -Path (Join-Path $clean 'ok.md') -Value "# hello`nnothing secret here`nmodel: claude-opus-4-8"
  Check 'clean tree passes' $false (RunScan $clean)

  # 2. planted private key block -> fail
  $k = Join-Path $root 'key'; New-Item -ItemType Directory -Path $k -Force | Out-Null
  Set-Content -Path (Join-Path $k 'leak.txt') -Value "-----BEGIN RSA PRIVATE KEY-----`nMIIEvAITHISISFAKE`n-----END RSA PRIVATE KEY-----"
  Check 'private key detected' $true (RunScan $k)

  # 3. planted bearer token -> fail
  $b = Join-Path $root 'bearer'; New-Item -ItemType Directory -Path $b -Force | Out-Null
  $fake = 'authorization: Bearer ' + ('A1b2C3d4' * 4)
  Set-Content -Path (Join-Path $b 'cfg.json') -Value $fake
  Check 'bearer token detected' $true (RunScan $b)

  # 4. planted anthropic-style key -> fail
  $a = Join-Path $root 'antkey'; New-Item -ItemType Directory -Path $a -Force | Out-Null
  Set-Content -Path (Join-Path $a 'x.txt') -Value ('sk-ant-' + ('X9y8Z7w6' * 3))
  Check 'anthropic key detected' $true (RunScan $a)

  # 5. planted vendor binary extension -> fail
  $v = Join-Path $root 'vendor'; New-Item -ItemType Directory -Path $v -Force | Out-Null
  Set-Content -Path (Join-Path $v 'Claude.exe') -Value 'MZ fake binary'
  Check 'vendor binary detected' $true (RunScan $v)

  # 6. planted current-machine user path -> fail (dynamic identity leak)
  $u = Join-Path $root 'devpath'; New-Item -ItemType Directory -Path $u -Force | Out-Null
  Set-Content -Path (Join-Path $u 'p.md') -Value ("path is " + $env:USERPROFILE + "\secret")
  Check 'dev profile path detected' $true (RunScan $u)

  # 7. model-id with foreign /home path is NOT a secret -> pass
  $m = Join-Path $root 'modelid'; New-Item -ItemType Directory -Path $m -Force | Out-Null
  Set-Content -Path (Join-Path $m 'ids.md') -Value "/home/robocup/.cache/llama.cpp/Qwen_Qwen3-VL-32B-Instruct-GGUF.gguf"
  Check 'foreign model-id path passes (not a leak)' $false (RunScan $m)

  # 8. BLIND-SPOT: a secret planted in dist/build/out/test-results must be found
  #    when the scan root IS that directory (SESSION-3 section 9).
  foreach ($blind in @('dist', 'build', 'out', 'test-results')) {
    $bd = Join-Path $root $blind
    New-Item -ItemType Directory -Path $bd -Force | Out-Null
    Set-Content -Path (Join-Path $bd 'leak.txt') -Value ('sk-ant-' + ('B7c6D5e4' * 3))
    Check "secret in '$blind' root is detected" $true (RunScan $bd)
  }

  # 9. BLIND-SPOT: forbidden binary planted under test-results as scan root -> fail
  $tr = Join-Path $root 'tr2'; New-Item -ItemType Directory -Path $tr -Force | Out-Null
  Set-Content -Path (Join-Path $tr 'evil.dll') -Value 'MZ fake'
  Check 'binary under scanned build dir detected' $true (RunScan $tr)

  # 10. HARDCODED DEV ROOT in a production .js file -> fail
  $hp = Join-Path $root 'hardcode'; New-Item -ItemType Directory -Path $hp -Force | Out-Null
  Set-Content -Path (Join-Path $hp 'run.js') -Value 'const dir = "D:\\Programs\\ClaudeOpen-Data";'
  Check 'hardcoded dev root in production file detected' $true (RunScan $hp)

  # 11. HARDCODED VENDOR HOST in a production .cmd file -> fail
  $hv = Join-Path $root 'vendorhost'; New-Item -ItemType Directory -Path $hv -Force | Out-Null
  Set-Content -Path (Join-Path $hv 'start.cmd') -Value 'set URL=https://private-gateway.invalid'
  Check 'hardcoded vendor host in production file detected' $true (RunScan $hv)

  # 12. GIT-HISTORY self-test: commit then delete a fake secret; -IncludeGitHistory must fail.
  $g = Join-Path $root 'gitrepo'; New-Item -ItemType Directory -Path $g -Force | Out-Null
  Push-Location $g
  try {
    & git init -q 2>$null
    & git config user.email 'selftest@example.com' 2>$null
    & git config user.name 'selftest' 2>$null
    Set-Content -Path (Join-Path $g 'secret.txt') -Value ('sk-ant-' + ('Z9y8X7w6' * 3))
    & git add -A 2>$null; & git commit -qm 'add fake secret' 2>$null
    Remove-Item (Join-Path $g 'secret.txt') -Force
    & git add -A 2>$null; & git commit -qm 'remove fake secret' 2>$null
    & powershell -NoProfile -ExecutionPolicy Bypass -File $scanner -Path $g -IncludeGitHistory *> $null
    Check 'git-history secret detected with -IncludeGitHistory' $true $LASTEXITCODE
  } finally {
    Pop-Location
  }
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -eq 0) {
  Write-Host 'ALL SELF-TESTS PASSED' -ForegroundColor Green
  exit 0
} else {
  Write-Host "$failures SELF-TEST(S) FAILED" -ForegroundColor Red
  exit 1
}
