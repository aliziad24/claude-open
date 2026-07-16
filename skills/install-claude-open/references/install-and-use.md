# Install and use

## Preconditions

- Windows 10/11 x64 with internet access and enough disk space for the official Claude package.
- A user-supplied HTTPS gateway root URL and API key. Loopback HTTP is allowed for local development only.
- The gateway must expose `/v1/models` plus Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses.

The user does not need Claude, Node.js, npm, Git, or developer tools installed. Setup obtains the official signed Claude package when it is absent and Claude Open bundles its runtime.

## Configuration

1. Launch **Claude Open** from its dedicated Start-menu icon.
2. In Control Center, enter the gateway root URL, authentication style, and API key. Do not put `/v1/messages`, `/v1/chat/completions`, or `/v1/responses` in the root URL unless the gateway documentation explicitly requires it.
3. Save configuration. The credential is stored in Windows Credential Manager, not in the repository or normal Claude profile.
4. Select **Verify Gateway**. Read the result without copying secrets into chat.
5. Select a model from the live list. The repository does not hardcode a user-specific catalog.
6. Select reasoning effort only if shown for that model. Hidden options are unverified, not missing.
7. Launch Claude Open and run a short disposable chat.
8. Confirm the local usage widget updates. Its counters describe the current local session; the gateway remains authoritative for billing.

## Isolation check

Open normal Claude and Claude Open independently. Confirm each has a separate window and conversation list. Claude Open uses its own package identity, Start shortcut, installation directory, credential target, and profile. It does not migrate normal Claude data.

## Update

Inspect and rerun `scripts/install-latest.ps1`. Configuration and the isolated profile are preserved. The normal Claude package is not upgraded unless the user explicitly approves `-UpdateOfficialClaude`.

## Custom location

Use `-InstallDir 'X:\Apps\Claude Open'`. Do not assume `C:` or a particular username. The profile and credential remain per-user under Windows-managed locations even when application files use another fixed drive.
