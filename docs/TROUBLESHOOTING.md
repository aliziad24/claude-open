# Troubleshooting

## Verify Gateway fails

- Configuration: enter the gateway root, not an endpoint; remote URLs need HTTPS.
- Secret: save the API key again with the correct authentication mode.
- Transport: check DNS, TLS, firewall, and gateway reachability.
- Authentication: confirm bearer versus `x-api-key` or custom header.
- Discovery: ensure `/v1/models` exists.
- Inference: ensure at least one discovered chat model uses a supported route.

## No models or effort selector

Refresh after launching the adapter. Non-chat or unknown-route models are intentionally filtered. An effort selector stays hidden until the exact control is behaviorally verified for this gateway.

## Claude Open does not launch

Always use the **Claude Open** icon or `ClaudeOpen.exe`; do not start `client\claude.exe` directly. Check that no unrelated user-level `CLAUDE_USER_DATA_DIR` is set. Reinstall if Windows reports a sparse package or certificate error.

## Cowork or SSH fails

For Cowork, check Virtual Machine Platform, virtualization, reboot state, and `CoworkVMService`. For SSH, make the same host work with `ssh host-alias` in PowerShell first, then relaunch Claude Open so it reloads `%USERPROFILE%\.ssh\config`.

## Mobile companion fails or reconnects

- Confirm Mobile companion is enabled, configuration was saved, and Claude Open is currently running.
- Reopen **Mobile setup** for the current pairing code; restart Claude Open if it expired.
- Confirm the companion works through **local preview** before diagnosing Tailscale.
- Confirm the foreground Tailscale Serve command is still running and the phone is signed into the same tailnet.
- Never work around a tunnel problem by binding to `0.0.0.0`, forwarding the router port, or placing the pairing code in a URL.

## Safe bug reports

Include Windows version, Claude Open release, official client version, gateway protocol, and a redacted error. Do not post the gateway hostname if private, API keys, full configuration, conversations, SSH details, runtime tokens, profile directories, or raw captures.
