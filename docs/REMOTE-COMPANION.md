# Remote Companion

Remote Companion is an optional, mobile-first PWA for chatting through the gateway already configured on the Claude Open PC. It supports live model discovery, verified effort choices, session usage, streaming, cancellation, and reconnect catch-up.

It is not a remote-control surface for the desktop application. Cowork, SSH, tools, attachments, normal Claude, desktop history, and local files are deliberately unavailable from the companion.

## Security model

- Disabled by default.
- Starts and stops with Claude Open's adapter.
- Binds to a random `127.0.0.1` port only; `0.0.0.0` and LAN binding are rejected.
- Never receives or returns the upstream gateway API key.
- Requires a random six-digit pairing code that expires after 30 minutes.
- Places that expiring code only in the ACL-protected per-run runtime file so Control Center can display it; it is removed with the runtime state.
- Rate-limits failed pairing attempts.
- Establishes an HttpOnly, SameSite browser session; HTTPS proxy requests also receive a Secure cookie.
- Uses a strict same-origin policy, no CORS, restrictive CSP, frame denial, and disabled browser permissions.
- Keeps companion conversations and device sessions in memory only. Restarting Claude Open clears them.
- Sends pairing codes neither in URLs nor application logs.

The configured gateway still receives prompts and outputs. The phone and private tunnel provider can display/transport companion messages, so apply their normal device and network security controls.

## Phone setup with Tailscale Serve

Tailscale is optional third-party software and is not bundled with Claude Open. It provides authenticated private-network access and a valid HTTPS endpoint. Install it on the PC and phone, then sign both into the same tailnet.

1. In Claude Open Control Center, enable **Mobile companion**.
2. Select **Save Configuration**, then launch Claude Open.
3. Select **Mobile setup**.
4. Choose **No** to copy the Tailscale Serve command.
5. In an elevated PowerShell, run the copied command. It resembles:

   ```powershell
   tailscale serve --yes http://127.0.0.1:<random-port>
   ```

6. Keep that command running. Open the private `https://...ts.net` URL it displays on the phone.
7. Enter the pairing code shown in Control Center.
8. Use the browser's **Add to Home Screen** or the companion's **Install** action when offered.

Closing the foreground Tailscale Serve command stops remote routing. Claude Open also becomes unreachable when its adapter stops. Do not use Tailscale Funnel, public tunnels, router port forwarding, or a plaintext LAN reverse proxy.

Tailscale Serve documentation: <https://tailscale.com/docs/reference/tailscale-cli/serve>

## Reconnect behavior

The PC continues reading an in-progress model stream when the phone briefly loses connectivity. Each event has a monotonically increasing cursor. On reconnect, the browser first rebuilds the conversation from the PC's bounded in-memory event log, then resumes EventSource after the last complete cursor. This repairs a detected event gap instead of duplicating the model request, with retry delay backing off to 30 seconds during a longer outage.

Refreshing the page in the same browser tab reconstructs the current session. Restarting Claude Open, closing the browser session, session expiration, or creating a new chat intentionally starts a new in-memory conversation.

## Local preview

In **Mobile setup**, choose **Yes** to open the loopback URL on the PC. Local preview is useful for verification, but it does not make the service reachable from a phone.

## Troubleshooting

- **Pairing required:** reopen Mobile setup and enter the current code.
- **Code expired:** restart Claude Open to create a new code.
- **Reconnecting:** confirm the PC, Claude Open adapter, Tailscale process, and phone network are online.
- **Model missing:** refresh the gateway in Control Center; only compatible chat models are exposed.
- **Effort missing:** only behaviorally verified effort values are shown.
- **PWA install unavailable:** confirm the phone URL is HTTPS and use the browser's Add to Home Screen action.
