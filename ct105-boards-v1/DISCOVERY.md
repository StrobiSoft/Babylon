# Discovery record

Recorded on 2026-09-07 UTC for logical task `boards-v1`, attempt 1.

## Verified environment

- Repository: `StrobiSoft/Babylon`, with the product application confined to
  `babylon-project/` under the repository root.
- Implementation location: root-level `ct105-boards-v1/`, isolated from the
  Babylon application and from the protected `services/babylon-status/` path.
- Runtime available on CT105: Python 3.13.5 with SQLite 3.46.1.
- Authoritative lifecycle policy: issue #40 comment `5496560970`, status
  `APPROVED_DEFAULT`; its 14,400-second productive window and finalization-only
  rules match the supplied execution envelope.
- Issue #40 is open and titled `Dedicated task queue`.

The GitHub organization Projects/Boards listing could not be verified because
the existing GitHub token does not have the `read:project` scope. No credential
or token scope was changed. Issue #40 itself currently reports no linked project
items through the available issue metadata.

## Placement conclusion

No pre-existing canonical, writable CT105 boards directory was established by
the accessible evidence. The versioned skeleton therefore lives in the isolated
repository-root directory above. A real database is intentionally not committed;
the CLI requires an explicit database path, and generated `*.db`, `*.sqlite`,
and `*.sqlite3` files are already excluded by the repository ignore policy.

Selecting a permanent host path, OS owner/group, backup policy, or service
lifecycle would be deployment/security work outside this V1 skeleton and needs
an explicit operational decision.
