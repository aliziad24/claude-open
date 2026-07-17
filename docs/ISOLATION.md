# Isolation and coexistence

Claude Open is designed to install and run separately from normal Claude. Both may be present and open at the same time.

| Boundary | Normal Claude | Claude Open |
|---|---|---|
| Windows package identity | Official Claude identity | `ClaudeOpen` sparse identity |
| Start-menu identity | Official shortcut/AUMID | One dedicated Claude Open shortcut, shared by its launcher and hidden packaged runtime |
| Application directory | Official package location | User-selected Claude Open-owned directory |
| Browser/profile data | Normal Claude profile | `%APPDATA%\ClaudeOpen\User Data\profile` |
| Gateway credential | Not used by Claude Open | `ClaudeOpen/gateway/current` in Windows Credential Manager |
| Runtime adapter | None | Random loopback port and per-run tokens |
| Uninstall scope | Unchanged | Claude Open identity, files, recorded certificate, and optional user data only |

Setup obtains the official signed runtime locally. The copied `claude.exe` and `app.asar` remain unchanged. Claude Open applies version-checked changes only to copied loose renderer files inside its owned directory.

Packaged activation requires the launcher to set `CLAUDE_USER_DATA_DIR` briefly at the current-user level. The value points only to Claude Open's isolated profile, is restored in a `finally` block immediately after activation, and is not allowed to replace an unrelated pre-existing value.

By default, setup neither upgrades nor uninstalls an existing official Claude package. It does not read, import, migrate, copy, or delete normal Claude conversations, settings, account state, skills, plugins, or credentials.

## Verification

1. Install Claude Open and launch it from its dedicated icon.
2. Launch normal Claude from its own icon.
3. Confirm both windows can remain open and show their respective profiles.
4. Change a harmless setting in Claude Open and confirm it does not appear in normal Claude.
5. Uninstall Claude Open and confirm normal Claude still launches unchanged.

Automated tests enforce distinct normal/Open package identities, one unified Claude Open shortcut/runtime AUMID, hidden implementation-only package entries, profile-scoped launch/stop behavior, environment restoration, and an uninstaller that never removes the official package.
