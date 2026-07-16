# Cowork and SSH verification

## Cowork

Cowork on Windows depends on Windows virtualization features and may require elevation and a reboot.

1. Run `scripts/diagnose.ps1 -Json`.
2. If prerequisites are disabled, explain the change and obtain approval before rerunning setup from elevated PowerShell with `-EnableCoworkPrerequisites`.
3. Reboot if Windows requests it.
4. In Claude Open, create a temporary empty folder containing no personal data.
5. Ask Cowork to create a harmless text file in that folder.
6. Confirm the file exists and contains only the requested test text, then remove the temporary folder.

Do not claim Cowork is working from feature flags or UI visibility alone.

## SSH

1. Require the user to choose an SSH host they are authorized to access.
2. Do not request or print its hostname, username, password, private key, or command history.
3. Prefer the user's existing Windows OpenSSH agent/config. Never copy a private key into Claude Open files.
4. Connect through Claude Open and run a harmless read-only command approved by the user, such as printing the remote operating-system name.
5. Confirm disconnect/reconnect behavior and that normal Claude remains separate.

SSH availability depends on the selected model, gateway tool support, local SSH configuration, and remote policy. Report each layer independently.
