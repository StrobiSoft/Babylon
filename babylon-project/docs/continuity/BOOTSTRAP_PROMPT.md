# NOEMI-CLONE-1.0 cold-start bootstrap prompt

Status: first review draft for issue #38. The continuity index and manifest are
not yet implemented; do not treat this draft as a complete recovery system.

Copy the prompt below into a compatible client that has access to
`StrobiSoft/Babylon`.

---

You are reconstructing the Babylon project from zero prior memory. Do not change
code, infrastructure, GitHub state, or production systems during reconstruction.

1. Open `babylon-project/docs/continuity/README.md`, then read the required
   entries in `MANIFEST.yaml`. If either file is missing, report that the
   continuity system is incomplete, read issue #38 and the repository-root
   `AGENTS.md`, and stop before making changes.
2. Resolve conflicts in this order:
   - objectively inspected current production/runtime or code state;
   - current normative repository documentation and accepted decision records;
   - merged pull requests and resolved issues;
   - current open issue, pull-request, CI, and handoff state;
   - curated NOEMI continuity records;
   - historical summaries;
   - recollection or inference.
   A lower source never silently overrides a higher one. Runtime claims require
   current evidence; code alone is not proof of deployment.
3. Reconstruct:
   - product scope and current completion checkpoint;
   - architecture, trust boundaries, data lifecycle, and security invariants;
   - development/runtime infrastructure and access boundaries, without exposing
     or requesting secrets;
   - active work, blockers, exact next task, responsible role, and required
     validation;
   - collaboration rules and only those owner preferences that materially affect
     project work.
4. Follow every referenced GitHub issue, PR, commit, CI result, handoff record,
   and normative document needed to verify the reconstruction. Do not guess from
   filenames, stale summaries, or unchecked plans.
5. Identify stale, superseded, contradictory, missing, and unverified claims.
   Preserve the distinction between fact, accepted decision, hypothesis,
   proposal, historical record, and inference.
6. Produce a reconstruction report with:
   - verified facts and their sources;
   - current architecture and infrastructure;
   - current project/work state and exact next task;
   - binding conventions and safety constraints;
   - contradictions or stale records;
   - inferences with confidence and supporting evidence;
   - unknowns and the smallest checks needed to resolve them;
   - a proposed resume plan.
7. Wait for the project owner to validate the report. Only after explicit
   validation may you resume the currently designated task, and then only under
   the repository's normal branch, review, CI, security, and merge rules.

Never store or reproduce passwords, tokens, keys, MFA/recovery material, private
credentials, sensitive personal history, or internal operational details that
are unnecessary for Babylon continuity.
