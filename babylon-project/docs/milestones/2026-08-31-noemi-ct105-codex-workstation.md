# Milestone — Noemi CT105 Codex workstation operational

**Date:** 2026-08-31

## Summary

A dedicated Proxmox/LXC working container for the Noemi/Codex development workflow is operational on Pepper and has passed an end-to-end interactive sanity check.

This milestone records a development-workflow and continuity capability, not a production deployment.

## Verified container identity

- Proxmox container: CT105
- Linux hostname: `noemi`
- dedicated user: `noemi-codex`
- verified home directory: `/home/noemi-codex`
- observed LAN address during setup: `192.168.1.93`

## Verified toolchain

The container was prepared with:

- Debian GNU/Linux 13 (trixie), amd64;
- Python 3.13.5;
- Git;
- ripgrep (`rg`);
- `fd` via the Debian `fdfind` binary and user-local symlink;
- Node.js 24.20.0;
- npm 11.19.0;
- npx 11.19.0;
- GitHub CLI 2.46.0;
- Codex CLI installed in the dedicated user's local npm prefix.

The Babylon repository declares `node >=24.0.0`, so Node 24 was selected intentionally rather than Debian 13's Node 20 package.

## User-local isolation

The `noemi-codex` account owns its working directories and npm prefix:

- `/home/noemi-codex/workspace`
- `/home/noemi-codex/reports`
- `/home/noemi-codex/.ssh`
- `/home/noemi-codex/.config`
- `/home/noemi-codex/.local`
- npm prefix: `/home/noemi-codex/.local`

Codex is therefore installed under the dedicated user's home rather than as a root-global npm package.

## SSH access and recovery safety

OpenSSH server was enabled on CT105 and verified listening on TCP port 22.

A dedicated Victus -> CT105 ED25519 key pair was created for the owner and added to `noemi-codex`'s `authorized_keys`. The direct connection was functionally verified from Victus:

```text
whoami   -> noemi-codex
hostname -> noemi
pwd      -> /home/noemi-codex
```

The setup deliberately preserved the Pepper root shell as a recovery path until the new direct SSH path had been proven, following an earlier project lesson that a new key-based access path must be validated before removing or tightening existing access.

No private SSH key material is stored in this repository.

## Codex authentication and runtime validation

The first browser/device-auth route encountered SMS verification trouble. Instead of repeatedly retrying that path, the existing authenticated Codex credential cache from the Victus environment was transferred to CT105 over the newly verified SSH path.

Security handling:

- the credential file content is not stored in GitHub;
- the remote Codex directory is mode `0700`;
- the credential file is mode `0600`;
- ownership is `noemi-codex:noemi-codex`.

Codex then started successfully in CT105, showed the interactive Codex interface, and returned the exact requested sanity-check response:

```text
NOEMI-CODEX-CT105-OK
```

This proves the container can run an authenticated Codex session and complete a live model request.

## Intended workflow

The intended operating pattern is:

```text
Owner -> Noemi -> Codex -> Noemi -> Owner
```

The owner states the goal in normal language; Noemi translates it into a precise, bounded engineering prompt; Codex performs the repository/system task; Noemi verifies and interprets the result before returning it to the owner.

This separation is intended to reduce manual command construction, improve traceability, and keep the engineering workflow consistent with Babylon's evidence-first collaboration rules.

## Scope and non-claims

This milestone does not claim:

- that CT105 is a Babylon production dependency;
- that any Babylon production code was deployed or changed;
- that VPN configuration was modified;
- that the container is yet documented in the ZooLab infrastructure registry;
- that secrets or credentials have been backed up in GitHub.

Those remain separate concerns.
