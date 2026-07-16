---
name: install-claude-open
description: Install, update, configure, verify, diagnose, or uninstall Claude Open on Windows. Use when an AI agent must set up the separate Claude Open desktop app, connect a user-supplied Anthropic- or OpenAI-compatible gateway, discover models and reasoning efforts, verify Cowork or SSH, preserve isolation from normal Claude, or troubleshoot installation and launch problems without exposing credentials.
---

# Install Claude Open

Install and operate Claude Open as a separate Windows app while preserving the user's normal Claude installation and secrets.

## Safety rules

- Support Windows 10/11 x64 only. Stop with a clear explanation on another platform.
- Never ask the user to paste an API key into chat, a command line, a script parameter, a log, or a screenshot. Have the user enter it directly in Claude Open Control Center.
- Never collect or print conversation data, gateway credentials, SSH private keys, SSH host details, usernames, or the contents of either Claude profile.
- Use only a release from the repository configured in `scripts/install-latest.ps1`, or a local release archive the user explicitly supplies.
- Do not modify, move, update, uninstall, or read the normal Claude profile. Updating an existing official Claude package requires the user's explicit approval.
- Treat a successful prerequisite check as necessary but insufficient: verify gateway, model, Cowork, and SSH behavior with harmless functional tests.

## Choose the workflow

1. For a new installation or update from GitHub, run `scripts/install-latest.ps1 -Inspect`, report the release and checksum, then run it normally after confirming the inspected repository is expected.
2. For a user-supplied extracted release, run its `Install-ClaudeOpen.ps1` directly.
3. For diagnosis, run `scripts/diagnose.ps1 -Json`. It reports only secret-free state.
4. For configuration and feature verification, follow `references/install-and-use.md`.
5. For Cowork or SSH, additionally follow `references/cowork-and-ssh.md`.
6. For failures or uninstall, follow `references/troubleshooting.md`.

## Install or update

Run from this skill directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-latest.ps1 -Inspect
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-latest.ps1
```

Pass `-InstallDir 'X:\Apps\Claude Open'` when the user requests a custom location. The installer supports any fixed local drive and paths containing spaces. Pass `-EnableCoworkPrerequisites` only from an elevated PowerShell after explaining that it may enable Windows virtualization features and may require a reboot. Pass `-UpdateOfficialClaude` only when the user explicitly asks to update the shared official package.

After installation, launch **Claude Open**, not normal Claude. Ask the user to enter the gateway root URL and API key directly in Control Center, save, and select **Verify Gateway**. Confirm the verification result shows at least one compatible chat model before launching.

## Verify completion

Do not call the setup complete until all requested items pass:

- Claude Open has its own Start-menu icon and opens its own isolated profile.
- Normal Claude still opens separately with its existing profile unchanged.
- Gateway verification succeeds without revealing the credential.
- Live model discovery shows the gateway's compatible chat models.
- Reasoning effort choices appear only where the gateway verification supports them.
- A short disposable chat succeeds with the selected model.
- If requested, Cowork creates a harmless file in a temporary folder.
- If requested, SSH connects to a user-approved test host without collecting its details.
- The usage widget updates after a successful request.

Report which checks passed, failed, or require a reboot/user interaction. Never claim a feature works solely because installation completed.

## Resources

- `scripts/install-latest.ps1`: inspect, download, verify, and invoke the latest bootstrap release.
- `scripts/diagnose.ps1`: emit a secret-free installation and prerequisite report.
- `references/install-and-use.md`: complete install, configuration, model, effort, usage, update, and isolation workflow.
- `references/cowork-and-ssh.md`: safe functional checks for Cowork and SSH.
- `references/troubleshooting.md`: failure isolation and uninstall guidance.
