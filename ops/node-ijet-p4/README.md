# NODE IJET P4 migration control

Temporary review/delivery tooling for the CT105-local NODE IJET P4 migration correction.

This directory is not Babylon product code and is not intended to become a long-lived Babylon dependency. The bounded installer adds only the no-argument `node-ijet-p4-layout-fix` maintenance action. That action accepts only the known P3 migration lineage on CT105, modifies only the migrated benchmark harness and its README, syntax-checks the result, commits exactly those files, and leaves a clean worktree.

`run-node-ijet-p4-once.sh` is the one-shot execution contract for the real CT105 gate. It temporarily installs the bounded action, applies the layout correction, verifies the immutable historical #63 benchmark evidence hashes, rejects active Babylon layout dependencies, installs only NODE IJET development dependencies, runs source/test typechecks, build and the complete migrated test suite, executes a five-run minimal benchmark smoke against the CT105-local fixed commit, cleans transient build/dependency artifacts, verifies a clean target worktree, and restores the pre-existing NOEMI-MAINT/dispatcher surface before declaring `NODE_IJET_P4=PASS`.

The companion GitHub Actions workflow builds an isolated mock CT105/NOEMI-MAINT fixture and verifies installer syntax, allowlist/dispatcher insertion, end-to-end layout repair, argument rejection, clean postconditions, and installer idempotency.

Validation is intentionally exercised on every reviewed control change before any CT105 activation.

After the real CT105 repair and P4 validation are complete, this temporary delivery branch/PR should be closed without merging into Babylon main.