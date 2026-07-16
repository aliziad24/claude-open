# Contributing

Use Windows, Node.js 20+, npm, PowerShell 5.1+, the .NET Framework x64 compiler, and Windows SDK packaging tools.

```powershell
npm ci
npm test
npm run verify:release:selftest
npm run verify:release:full
npm run build:release
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-release.ps1 -Path .\dist\ClaudeOpen-bootstrap
```

Never commit credentials, private URLs/IPs, SSH details, conversations, local profiles, databases, logs, screenshots, live captures, copied official-client files, generated packages/executables, or implementation-session reports.

Keep gateway behavior vendor-neutral and evidence-driven. Preserve tool-call/stream semantics, fail closed on unknown routes, add regression/request-capture tests, and validate renderer patches against the current official client. Do not publish a release until clean-machine installation, normal-Claude isolation, model/inference, Cowork, SSH, usage, and privacy checks pass.
