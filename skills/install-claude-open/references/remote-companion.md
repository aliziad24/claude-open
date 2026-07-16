# Remote Companion

Remote Companion is optional and disabled by default. It offers mobile chat but deliberately cannot access Cowork, SSH, tools, attachments, normal Claude, desktop history, or local files.

1. Ask whether the user already has a trusted private HTTPS tunnel. Recommend Tailscale Serve when they want the documented path, but do not install or sign into third-party software without authorization.
2. Have the user enable **Mobile companion**, save, launch, and select **Mobile setup**.
3. Never request, repeat, copy, log, or place the pairing code in chat or a command. The user enters it directly on their phone.
4. The copied Tailscale command contains only a random loopback port. Run it in an elevated PowerShell on the PC and keep it in the foreground.
5. Open the private HTTPS URL on a phone signed into the same tailnet and pair directly.
6. Verify live model discovery and verified effort options.
7. Send a harmless disposable message, interrupt the phone network briefly, reconnect, and confirm the remainder catches up without a duplicate request.
8. Confirm stopping Claude Open makes the companion unavailable.

Never use Tailscale Funnel, a public quick tunnel, router port forwarding, a plaintext LAN proxy, or `0.0.0.0`. Report Remote Companion as chat-only and in-memory; do not claim remote Cowork/SSH or persistent history.
