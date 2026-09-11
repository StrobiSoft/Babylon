# NODE IJET P4 migration control

Temporary review/delivery tooling for the CT105-local NODE IJET P4 migration correction.

This directory is not Babylon product code and is not intended to become a long-lived Babylon dependency. The bounded installer adds only the no-argument `node-ijet-p4-layout-fix` maintenance action. That action accepts only the known P3 migration lineage on CT105, modifies only the migrated benchmark harness and its README, syntax-checks the result, commits exactly those files, and leaves a clean worktree.

The companion GitHub Actions workflow builds an isolated mock CT105/NOEMI-MAINT fixture and verifies installer syntax, allowlist/dispatcher insertion, end-to-end layout repair, argument rejection, clean postconditions, and installer idempotency.

After the real CT105 repair and P4 validation are complete, this temporary delivery branch/PR should be closed without merging into Babylon main.