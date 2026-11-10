# Finding triage

Applies to every agent on this repository: Claude lanes, Codex, and any
swarm, regression, live or audit lane. Target: fewer than 1.0 new issues
opened per issue closed, measured weekly.

Where a finding goes, in order:

1. A defect the PR introduced, or a false claim in its docs or tests: fix it
   in the PR. Never file it.
2. A small in-scope note: fix it in the PR. Nits and test or doc wording:
   drop them.
3. A pre-existing or out-of-scope finding: search open issues for the same
   stage or epic first. If one exists, add a checklist line to it as a
   comment. Do not open a new issue.
4. Open a new issue only for reachable harm: a real user path breaks or data
   is lost or exposed. Include a repro, the bucket label, a `journey:` label
   and a `cause:` label when one fits.
5. A PR leaves at most ONE combined follow-up issue for everything that does
   not fit steps 1 to 3. Link it with `Related #N` in the PR body.
6. A flaky test goes on the known-flaky list. File it only if it fails
   deterministically on develop and blocks the promote.

Claims: a follow-up issue is not started until its claimant adds the claim
labels per [issue claims](issue-claims.md). Skip anything with a live claim
from another agent.

This rule replaces any earlier instruction to file every non-blocking
verifier note as a follow-up issue.
