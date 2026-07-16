# Claude Open for Windows

Claude Open runs the official Anthropic-signed Claude Desktop client with an isolated profile and connects it to a compatible API gateway. It can coexist with normal Claude and does not use normal Claude's conversations, settings, or credentials.

The Windows app includes:

- a dedicated **Claude Open** Start-menu icon and Control Center;
- first-run fields for your gateway base URL and API key;
- live discovery of every compatible chat model exposed by the gateway;
- model selection and verified model-specific reasoning effort controls;
- local session usage and context telemetry;
- the current official Claude UI, including local Cowork and SSH surfaces;
- a bundled Node.js runtime, so users do not need Node, npm, or development tools.

This is a community project, not an Anthropic product. Your gateway must implement a supported Anthropic- or OpenAI-compatible API.

## Install

1. Download and extract `ClaudeOpen-bootstrap` from the latest release.
2. Open PowerShell in that folder.
3. Run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-ClaudeOpen.ps1
   ```

4. Open **Claude Open** from the Start menu.
5. Enter the gateway root URL, choose the authentication type, enter the API key, and select **Save Configuration**.
6. Select **Verify Gateway**, then **Launch Claude Open**.

Claude Desktop does not need to be installed first. If it is absent, setup obtains the official package with `winget`. If it is already installed, setup leaves that installation and its profile unchanged by default.

Read the [user guide](docs/USER-GUIDE.md) for model selection, Cowork, SSH, usage, updating, and uninstalling. Detailed setup options are in [installation](docs/INSTALL.md).

## Gateway compatibility

Claude Open supports gateways with `/v1/models` discovery and at least one of:

- Anthropic Messages: `/v1/messages`
- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`

Remote gateway URLs must use HTTPS. The credential is stored in Windows Credential Manager. The official client receives only a random loopback URL and a per-run local token; it never receives the upstream gateway key.

Models are discovered at runtime—there is no user-specific model list in the repository. Non-chat models and models without a safe route are excluded. Reasoning controls appear only when the current gateway's behavior has verified them.

## Privacy and trust boundary

- No API key, gateway URL, conversation, SSH host, private key, account ID, local profile, or test capture is included in the source or release.
- Normal Claude's profile is not read, copied, changed, or deleted.
- The upstream key is stored in Windows Credential Manager.
- The adapter binds to a random loopback port and requires per-run tokens.
- The installer verifies its manifest and the copied client's Anthropic Authenticode signature.
- The official `claude.exe` and `app.asar` remain byte-for-byte unchanged. Setup applies small, version-checked patches only to copied loose renderer assets for Cowork visibility, SSH selection, and the secret-free usage widget. If a current official build does not match, installation aborts and rolls back.
- A self-signed sparse-package certificate is trusted for the current user so Windows can give Claude Open its own launcher/runtime identity. The private signing key is destroyed during release creation; uninstall removes the trusted public certificate recorded by that install.

See [privacy](docs/PRIVACY.md), [identity](docs/IDENTITY.md), and [security policy](SECURITY.md).

## Build and verify

Requirements for maintainers: Windows, Node.js 20+, npm, .NET Framework x64 C# compiler, and Windows SDK packaging/signing tools.

```powershell
npm ci
npm test
npm run verify:release:selftest
npm run verify:release:full
npm run build:release
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1 -Path .\dist\ClaudeOpen-bootstrap
```

The bootstrap release intentionally contains no Anthropic application files. The installer acquires those files from the user's official Windows package at install time.

## License and trademarks

Source code is available under the [MIT License](LICENSE). Claude and Anthropic are trademarks of Anthropic PBC.
