# Windows identity and official-client integrity

Claude Open uses one sparse MSIX with two applications:

- `ClaudeOpen` is the visible Control Center and Start-menu application.
- `Runtime` is hidden and points to `client\claude.exe` in the external install directory.

The package itself contains only the manifest and Claude Open icons—no Anthropic files. At install time the official package is acquired locally, its application directory is copied, and `claude.exe` must have a valid Anthropic Authenticode signature.

`claude.exe` keeps its original name and bytes. `resources\app.asar` also remains unchanged. Claude Open applies narrowly matched changes to copied, unpacked `resources\ion-dist` files for:

- Cowork availability in the isolated gateway profile;
- native SSH configuration loading and selection;
- a same-origin, secret-free usage widget.

Patching is transactional. Each expected stock signature must occur exactly once; otherwise all changes are rolled back and installation fails. This prevents silently applying an old patch to an unknown official client build.

The sparse package is self-signed during release creation. Its private PFX is deleted immediately and never shipped. The installer trusts only the included public certificate for the current user, records its thumbprint, and removes the old recorded certificate during update/uninstall.
