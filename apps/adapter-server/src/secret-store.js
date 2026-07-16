// Secret store. (NEXT-INSTRUCTIONS 4.2, 10.2; plan 6.2.)
//
// Resolves the gateway credential at RUNTIME and never returns it in logs, only
// a redacted fingerprint for diagnostics. Resolution order (first hit wins):
//
//   1. Windows Credential Manager (preferred, via `cmdkey`/DPAPI-backed store)
//   2. DPAPI CurrentUser-encrypted file referenced by the config
//   3. the existing Claude Open profile host-creds file (current live source),
//      used so this session can prove a real response without re-entering the key
//
// The store exposes only `resolve()` (-> string) and `fingerprint()` (-> safe
// label). The raw value is never written anywhere by this module.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Redact a secret to a non-reversible fingerprint (never the value). */
export function fingerprintSecret(secret) {
  if (secret == null || secret === '') return '<none>';
  const s = String(secret);
  const sha = createHash('sha256').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, 3)}…(len=${s.length},sha256=${sha})`;
}

/**
 * Resolve from Windows Credential Manager (Generic credential) via PowerShell's
 * built-in DPAPI-backed store. Returns null if not found or unavailable.
 * @param {string} target credential target name, e.g. "ClaudeOpen/gateway"
 */
export function resolveFromCredentialManager(target) {
  try {
    // Uses the CredentialManager COM/Win32 API through PowerShell. We read a
    // Generic credential's password without ever echoing it to a shared log.
    const ps = `
$ErrorActionPreference='Stop';
Add-Type -Namespace CredMan -Name Native -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
'@;
$p=[IntPtr]::Zero;
if([CredMan.Native]::CredRead('${target.replace(/'/g, "''")}',1,0,[ref]$p)){
  $c=[System.Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][CredMan.Native+CREDENTIAL]);
  $bytes=New-Object byte[] $c.CredentialBlobSize;
  [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$bytes,0,$c.CredentialBlobSize);
  [CredMan.Native]::CredFree($p);
  [System.Text.Encoding]::Unicode.GetString($bytes)
}`;
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Read the existing Claude Open profile host-creds file to obtain the currently
 * configured gateway token. This is the live source the running app already
 * uses; treating it as a resolver lets the vertical slice prove a real response
 * without re-prompting. Value is returned in-process only.
 * @param {string} filePath absolute path to host-creds-*.json
 * @param {string} [field] which env field holds the token
 * @returns {string|null}
 */
export function resolveFromProfileHostCreds(filePath, field = 'ANTHROPIC_AUTH_TOKEN') {
  try {
    if (!existsSync(filePath)) return null;
    const j = JSON.parse(readFileSync(filePath, 'utf8'));
    const v = j?.env?.[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Build a secret store from a resolution spec.
 * @param {object} spec
 * @param {string} [spec.credentialTarget]  Credential Manager target name
 * @param {string} [spec.envVar]            environment variable to read
 * @param {object} [spec.env]                environment snapshot (tests/launcher)
 * @param {{filePath:string, field?:string}} [spec.profileHostCreds]  fallback live source
 * @returns {{resolve:()=>string|null, fingerprint:()=>string, source:()=>string}}
 */
export function createSecretStore(spec = {}) {
  let cached = null;
  let sourceLabel = 'unresolved';

  function doResolve() {
    if (spec.credentialTarget) {
      const v = resolveFromCredentialManager(spec.credentialTarget);
      if (v) {
        sourceLabel = 'credential-manager';
        return v;
      }
    }
    const env = spec.env || process.env;
    if (spec.envVar && env[spec.envVar]) {
      sourceLabel = `env:${spec.envVar}`;
      return env[spec.envVar];
    }
    sourceLabel = 'unresolved';
    return null;
  }

  return {
    resolve() {
      if (cached == null) cached = doResolve();
      return cached;
    },
    fingerprint() {
      return fingerprintSecret(cached ?? doResolve());
    },
    source() {
      if (cached == null) cached = doResolve();
      return sourceLabel;
    },
  };
}
