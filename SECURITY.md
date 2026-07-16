# Security policy

Report vulnerabilities with the repository's private Security Advisories feature. Do not open a public issue containing credentials, conversation content, private gateway/SSH details, arbitrary local files, or an exploit that exposes them.

Security invariants:

1. The copied official `claude.exe` and `app.asar` remain byte-for-byte unchanged and Authenticode-valid.
2. Loose renderer patches are content-matched, transactional, and confined to Claude Open's copied runtime.
3. Normal Claude user data is not read, imported, changed, or removed.
4. Gateway credentials live in Windows Credential Manager, not JSON, logs, renderer snapshots, or command-line arguments.
5. Remote gateways require HTTPS; URLs cannot contain credentials.
6. Local endpoints bind to loopback and require random per-run tokens.
7. Unknown model routes/capabilities and unverified effort controls fail closed.
8. Install/update/uninstall actions are constrained by ownership markers and release manifests.
9. Public source/releases exclude personal data, conversations, live evidence, private infrastructure details, secrets, and vendor binaries.

The configured gateway is a trusted data processor for prompts and outputs. Claude Open does not make an untrusted gateway safe.
