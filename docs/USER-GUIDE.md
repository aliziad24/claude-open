# User guide

Claude Open has its own Start-menu icon, profile, credential, and application identity. It can be used at the same time as normal Claude. Always launch it through **Claude Open**; launching the copied client executable directly bypasses isolation setup.

## Before you start

You need Windows 10/11 x64 and a compatible gateway root URL. The gateway may require an API key, but never paste that key into an AI conversation, command line, issue, log, or screenshot. Enter it only in Claude Open Control Center, where it is saved through Windows Credential Manager.

## First launch

Open **Claude Open** from Start. In the Control Center:

1. Enter the gateway root URL, such as `https://gateway.example`.
2. Choose `bearer`, `x-api-key`, `custom-header`, or `none`.
3. Enter the credential when the selected mode needs one.
4. Select **Save Configuration**.
5. Select **Verify Gateway**. Fix any configuration, transport, authentication, discovery, or inference error it reports.
6. Select **Launch Claude Open**.

Do not add `/v1/models` or `/v1/messages` to the base URL. Do not put the key in the URL.

## Models and effort

The model selector is filled from the gateway's live `/v1/models` response. The adapter rechecks the catalog after a short cache interval, so gateway additions and removals appear without editing source or configuration. Opening the selector also requests a fresh snapshot. Models are grouped Claude, GPT, Grok, Kimi, MiniMax, Qwen, then other families; each family is sorted predictably. Claude Open keeps stable local aliases, while the gateway's actual model IDs remain visible in model details.

Reasoning effort is deliberately conservative. A selector is available only when the adapter knows the exact wire field and the current gateway has behaviorally verified it. **Verify & apply** performs real gateway requests and may incur normal usage charges.

The usage pill refreshes from the local adapter every 10 seconds. It always shows observed session tokens. If your gateway exposes account plan/usage endpoints, configure the optional mapped usage block described in [Usage and context](USAGE-CONTEXT.md); Claude Open then reads those endpoints with the same saved base URL and Credential Manager key, without placing the key in renderer files.

## Usage widget

The floating widget inside Claude Open shows requests and tokens observed by the current local adapter session, plus available-model and context information. It reads secret-free files generated locally by the adapter. Its **Refresh** button waits for a newer gateway snapshot instead of merely repainting cached data.

This is not provider billing or subscription quota. It resets when the adapter restarts and does not count requests made outside Claude Open.

## Mobile companion

The opt-in Remote Companion provides mobile chat, models, verified effort controls, usage, streaming cancellation, and reconnect catch-up. Enable it in Control Center, save, launch, then select **Mobile setup**.

The service stays on loopback. For a phone, use the copied Tailscale Serve command to create a private HTTPS route; do not expose the port directly. Pair with the temporary code shown in Control Center. Companion sessions remain in PC memory only and do not import desktop or normal Claude history.

See [Remote Companion](REMOTE-COMPANION.md) for setup and limitations.

## Cowork

Select Cowork from the Claude Open interface and start with a harmless task in a temporary folder. Local Cowork may require Virtual Machine Platform, hardware virtualization, a reboot, and the official `CoworkVMService`.

To let setup enable/check the Windows feature, rerun the installer from an elevated PowerShell:

```powershell
.\Install-ClaudeOpen.ps1 -EnableCoworkPrerequisites
```

Claude Open supplies the official signed client with a separate Windows runtime identity. This enables the local client/VM path; it cannot reproduce Anthropic account entitlements, cloud history sync, remote Dispatch, or other Anthropic-hosted services through an arbitrary gateway.

## SSH connections

First verify that Windows OpenSSH can connect outside the app:

```powershell
ssh user@example-host
```

For repeatable connections, add a normal entry to `%USERPROFILE%\.ssh\config`:

```text
Host development-box
    HostName example-host
    User user
    IdentityFile ~/.ssh/id_ed25519
```

Keep private keys only in your `.ssh` directory and protect them with normal Windows permissions/passphrases. Claude Open never copies SSH keys or host details into its repository or release.

Launch Claude Open, open its environment/computer connection picker, choose the SSH connection, and select the configured host. If it is missing, close Claude Open, confirm `ssh development-box` works in PowerShell, and relaunch through the **Claude Open** icon—not by running `client\claude.exe` directly.

For remote Code sessions, Claude Open automatically starts an OpenSSH reverse forward for a host you have already approved. The forward binds only the remote host's `127.0.0.1` adapter port back to the PC's loopback adapter; it does not expose the gateway adapter to the LAN or tailnet and it does not copy credentials or private keys. The bridge stops with Claude Open.

Run only commands you understand on hosts you are authorized to access. Do not share hostnames, usernames, passwords, private keys, or SSH history in support reports or AI conversations.

## Updating

Download the new bootstrap and rerun its installer. Configuration, credential reference, and the isolated profile are preserved. Existing normal Claude is not upgraded unless you explicitly add `-UpdateOfficialClaude`.

Rerun setup after an official Claude update if you want Claude Open to copy and validate that newer client. Renderer patch compatibility is checked transactionally; an incompatible official build does not replace the working Claude Open install.

## Uninstalling

```powershell
& "$env:LOCALAPPDATA\Programs\Claude Open\Uninstall-ClaudeOpen.ps1"
```

Add `-RemoveUserData` to delete Claude Open's saved configuration, credential, isolated profile, and runtime state. Normal Claude remains installed and unchanged.
