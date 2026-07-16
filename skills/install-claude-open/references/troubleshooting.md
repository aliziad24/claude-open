# Troubleshooting and uninstall

Start with `scripts/diagnose.ps1 -Json`. Keep reports secret-free.

## Gateway verification fails

- Confirm the value is the gateway root URL and uses HTTPS unless it is loopback.
- Confirm `/v1/models` is reachable with the gateway's documented authentication style.
- Distinguish DNS/TLS, authentication, model discovery, and inference failures.
- Have the user replace a credential directly in Control Center; never ask them to reveal it.

## Models or effort options are missing

- Models are live-discovered and filtered to safe chat routes.
- A model can be visible while some reasoning efforts remain hidden because verification did not prove support.
- Re-run Verify Gateway after changing upstream configuration.

## Claude Open does not launch

- Confirm the dedicated Claude Open identity, launcher, and Start shortcut with the diagnostic script.
- Reinstall from a freshly downloaded verified release.
- If the official Claude build no longer matches a version-checked renderer patch, do not force the patch. Report the incompatibility and wait for a compatible Claude Open release.

## Cowork fails

- Recheck Windows optional features, reboot state, available disk space, gateway tool support, and selected model capability.
- Use a disposable directory for the functional test.

## Uninstall

Run the uninstaller from the chosen installation directory, for example:

```powershell
& "$env:LOCALAPPDATA\Programs\Claude Open\Uninstall-ClaudeOpen.ps1"
```

For a custom location, run `Uninstall-ClaudeOpen.ps1` from that location. Uninstall removes Claude Open-owned files, profile, identity, shortcut, and recorded certificate. It does not uninstall or delete normal Claude.
