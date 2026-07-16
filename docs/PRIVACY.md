# Privacy

## Data locations

- Application: `%LOCALAPPDATA%\Programs\Claude Open` by default
- Isolated data: `%APPDATA%\ClaudeOpen`
- Gateway secret: Windows Credential Manager target `ClaudeOpen/gateway/current`

Normal Claude's profile is separate. Claude Open does not copy its conversations, account state, skills, plugins, SSH keys, or settings.

The upstream gateway receives the prompts, attachments, tool inputs, and outputs sent through it. Review that gateway's own privacy and retention policy.

Remote Companion is disabled by default. When enabled, its expiring pairing code is written only to the same ACL-protected per-run `runtime.json` that the Control Center already uses for local adapter tokens. Device authorization, conversation history, and reconnect event buffers exist only in adapter-process memory. None are written to the repository, desktop profile, or runtime logs. The phone, private HTTPS tunnel, and configured gateway can transport or display companion prompts and outputs.

## Local protection

The adapter listens only on loopback using a random port. Client and diagnostics endpoints have separate per-run tokens. Logs avoid headers/bodies and redact secret-shaped errors. Usage widget files contain session counts and public model metadata, not the base URL or API key.

The packaged-runtime launch briefly sets the current user's `CLAUDE_USER_DATA_DIR` because Windows package activation cannot accept a child-only environment block. The launcher restores the previous value immediately after activation, even on error, and refuses to replace an unrelated existing value. A stale value equal to Claude Open's own profile is cleaned up.

## Publication rules

Public source/releases exclude API keys, credentials, gateway tenant URLs, private IPs, usernames, emails, SSH hosts/keys, conversations, databases, logs, screenshots, local profiles, live test captures, and Anthropic binaries. The release scanner checks both current files and high-signal Git-history secrets. Publishing should use the generated clean export so removed development records are not retained in public history.
