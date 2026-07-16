# Updating

1. Download and extract the new bootstrap.
2. Close Claude Open.
3. Run the new `Install-ClaudeOpen.ps1`.
4. Verify the gateway and refresh models.
5. Test a harmless Cowork task and SSH connection if you use those features.

Existing official Claude is not upgraded by default. Add `-UpdateOfficialClaude` only when you want setup to upgrade the shared official package before copying it. Rerunning setup without that switch still refreshes Claude Open from the currently installed official package.

The installer preserves Claude Open user data and rolls back the application/identity if the new release, signature, UI patch, or sparse registration fails. It does not roll back a separately requested official Claude upgrade.
