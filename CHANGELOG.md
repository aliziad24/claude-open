# Changelog

## Unreleased

## 0.2.1 - 2026-07-30

- Fixed gateway and credential reconnection so rotated credentials clear account-scoped model caches and session usage.
- Fixed Claude Code over SSH by maintaining a profile-scoped reverse loopback bridge to the active adapter.
- Fixed live model refresh and per-model context metadata without inventing fallback limits.
- Fixed launcher identity, taskbar grouping, and shortcuts so startup cannot bypass the isolated Claude Open profile.
- Improved usage reporting for rolling 5-hour and 24-hour windows, unlimited monthly plans, and low percentages.
- Added regression coverage for credential rotation, catalog isolation, reconnect behavior, usage refresh, and identity safety.

## 0.2.0 - 2026-07-16

- Added a dedicated Windows launcher, icon, Control Center, isolated profile, and transactional installer.
- Added secure user-supplied gateway configuration backed by Windows Credential Manager.
- Added Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses adaptation.
- Added live model discovery, stable aliases, model picker, verified effort controls, and session usage/context telemetry.
- Added packaged-runtime Cowork support, native SSH configuration selection, and the in-client usage widget.
- Added official-client acquisition for machines without Claude, Authenticode checks, sparse identity registration, safe update rollback, and uninstallation.
- Removed retired vendor-specific proxy code, internal implementation reports, live test evidence, and repository-specific machine details.
