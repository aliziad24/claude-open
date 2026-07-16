# Cowork

Claude Open copies the current official client, preserves the Anthropic-signed `claude.exe` and `app.asar`, and activates it through a hidden application in Claude Open's sparse package. Small loose-renderer patches expose the Cowork surface in the isolated third-party profile. This is the same local architecture exercised by the latest development build.

Local Cowork can require:

- Virtual Machine Platform;
- hardware virtualization and a detected hypervisor;
- the official `CoworkVMService`;
- a reboot after Windows feature changes;
- enough disk, memory, and permission to create the local VM.

The installer can check/enable prerequisites with `-EnableCoworkPrerequisites`, but a prerequisite check is not a functional test. After installation, run a harmless Cowork task in a temporary directory and verify the expected file result.

Claude Open cannot promise Anthropic account entitlements, cloud history synchronization, remote Dispatch, plan-specific features, or provider billing through a third-party gateway.
