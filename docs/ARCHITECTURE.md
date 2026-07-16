# Architecture

The visible `ClaudeOpen.exe` owns setup, Credential Manager access, the loopback adapter, model/usage controls, and lifecycle. It starts a bundled Node runtime on a random loopback port, writes an isolated third-party profile, then activates the hidden `Runtime` application from the Claude Open sparse package.

The hidden runtime points to the locally copied, Anthropic-signed `client\claude.exe`. Windows package activation supplies the identity needed by the official local client/VM path. The signed executable and `app.asar` remain unchanged; only copied loose renderer assets receive version-checked patches.

```text
Windows Credential Manager
          |
          v
Claude Open Control Center ----> 127.0.0.1 random port ----TLS----> user gateway
          |                               ^
          | writes isolated config        | per-run local token
          v                               |
hidden packaged Runtime ---------- official signed client
```

When explicitly enabled, the adapter also starts a separate loopback-only Remote Companion service. The companion holds pairing/device/session state in memory, serves a mobile PWA, and calls only the adapter's authenticated model, message, effort, and usage surfaces. A trusted HTTPS reverse proxy may reach the companion loopback port; the companion itself never binds to the LAN.

```text
phone PWA -- private HTTPS tunnel --> 127.0.0.1 companion
                                              |
                                   paired narrow API
                                              v
                                   authenticated adapter --> gateway
```

Shared packages provide configuration validation, discovery/aliases, model facts, protocol conversion, streaming/tool semantics, health, conformance, and usage. Gateway-scoped state is keyed by a non-reversible fingerprint that excludes the secret.

Routing is evidence-driven. Explicit configuration and observed metadata take precedence over registry facts; unknown routes fail rather than being guessed from model names. Effort fields are emitted only when their exact typed controls are verified for the current gateway.

The bootstrap build contains Claude Open code, a bundled Node runtime, sparse identity metadata, icons, and a public package certificate. It contains no Anthropic runtime. Installation obtains the official package locally, verifies it, patches the copied renderer transactionally, and registers the external-location identity.
