# User guide

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

The model selector is filled from the gateway's live `/v1/models` response. Refresh it from the Control Center after the gateway changes its catalog. Claude Open keeps stable local aliases, while the gateway's actual model IDs remain visible in model details.

Reasoning effort is deliberately conservative. A selector is available only when the adapter knows the exact wire field and the current gateway has behaviorally verified it. **Verify & apply** performs real gateway requests and may incur normal usage charges.

## Usage widget

The floating widget inside Claude Open shows requests and tokens observed by the current local adapter session, plus available-model and context information. It reads secret-free files generated locally by the adapter.

This is not provider billing or subscription quota. It resets when the adapter restarts and does not count requests made outside Claude Open.

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

## Updating

Download the new bootstrap and rerun its installer. Configuration, credential reference, and the isolated profile are preserved. Existing normal Claude is not upgraded unless you explicitly add `-UpdateOfficialClaude`.

Rerun setup after an official Claude update if you want Claude Open to copy and validate that newer client. Renderer patch compatibility is checked transactionally; an incompatible official build does not replace the working Claude Open install.

## Uninstalling

```powershell
& "$env:LOCALAPPDATA\Programs\Claude Open\Uninstall-ClaudeOpen.ps1"
```

Add `-RemoveUserData` to delete Claude Open's saved configuration, credential, isolated profile, and runtime state. Normal Claude remains installed and unchanged.
