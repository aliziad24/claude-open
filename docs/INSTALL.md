# Installation

## Requirements

- 64-bit Windows 10 or Windows 11
- Windows Package Manager (`winget`)
- network access to the official Claude package source and your gateway
- a compatible gateway URL and, when required, an API key

Users do not need Claude Desktop, Node.js, npm, Visual Studio, or the Windows SDK installed beforehand.

## Standard installation

Extract the release and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeOpen.ps1
```

The default location is `%LOCALAPPDATA%\Programs\Claude Open`. Setup creates a **Claude Open** Start-menu shortcut, obtains official Claude if absent, copies its current application runtime, verifies the Anthropic signature, applies version-checked loose-renderer patches, and registers the per-user sparse Windows identity.

The sparse package uses a release-specific self-signed public certificate in `CurrentUser\TrustedPeople`. Setup records the exact thumbprint. The package contains only Claude Open identity metadata and icons; the official runtime remains in the external install directory.

## Options

```powershell
# Custom location on any fixed local drive; spaces are supported
.\Install-ClaudeOpen.ps1 -InstallDir 'X:\Apps\Claude Open'

# No extra Start-menu shortcut
.\Install-ClaudeOpen.ps1 -NoShortcut

# Opt in to upgrading an already-installed official Claude package
.\Install-ClaudeOpen.ps1 -UpdateOfficialClaude

# Elevated: enable/check local Cowork prerequisites
.\Install-ClaudeOpen.ps1 -EnableCoworkPrerequisites
```

By default an existing official Claude package is left unchanged. If Claude is absent, acquiring it is required because Claude Open does not redistribute Anthropic binaries.

## What setup changes

- Creates the selected Claude Open application directory.
- Creates `%APPDATA%\ClaudeOpen` for isolated configuration/profile/runtime data.
- Stores the gateway secret in Windows Credential Manager after the user saves it.
- Registers only the `ClaudeOpen` sparse package for the current user.
- Creates a Start-menu shortcut unless disabled.
- Installs official Claude only when it was absent, or updates it when explicitly requested.

It does not import normal Claude conversations or settings. During packaged runtime activation, Windows requires `CLAUDE_USER_DATA_DIR` to be briefly placed in the current user's environment. The launcher restores the previous value in a `finally` block immediately after activation and refuses to overwrite an unrelated pre-existing value.

## Update and rollback

Rerun a newer installer. It verifies every release-manifest entry before staging, checks the copied official signature, validates every renderer patch signature, swaps the application directory atomically, and registers the new identity. If registration fails, it restores both the prior directory and prior identity when available.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\Programs\Claude Open\Uninstall-ClaudeOpen.ps1"
```

Use `-RemoveUserData` for a complete removal of Claude Open-owned settings, credential, profile, and runtime state. The uninstaller removes only the `ClaudeOpen` sparse package and recorded public certificate. It never uninstalls official Claude.
