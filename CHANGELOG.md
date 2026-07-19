# Changelog

## Unreleased

### Reliability (gateway / multi-model hosts)

- Fixed Control Center treating a full `/v1/models` body as empty: `JavaScriptSerializer` returns `ArrayList`, not `object[]` (`ParseModels`).
- Publish `runtime.json` before Credential Manager resolve and catalog warm so the launcher no longer times out on slow gateways.
- Raised cold catalog discovery timeout (4s → 30s), single-flight discovery, and accept `data` or `models` list keys.
- Deep health prefers common chat models and retries inference on alternates when the first listed model fails.
- Install-root detection finds `adapter/adapter.mjs` under the exe directory or a sibling `install/` folder.
- GPU-safe direct client launch (`--disable-gpu…`) with AppX activation fallback for machines where Chromium GPU crashes leave a dead taskbar icon.

- Added a dedicated Windows launcher, icon, Control Center, isolated profile, and transactional installer.
- Added secure user-supplied gateway configuration backed by Windows Credential Manager.
- Added Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses adaptation.
- Added live model discovery, stable aliases, model picker, verified effort controls, and session usage/context telemetry.
- Added packaged-runtime Cowork support, native SSH configuration selection, and the in-client usage widget.
- Added official-client acquisition for machines without Claude, Authenticode checks, sparse identity registration, safe update rollback, and uninstallation.
- Removed retired vendor-specific proxy code, internal implementation reports, live test evidence, and repository-specific machine details.
