# Git policy

Read the active checkout's `AGENTS.md` and `docs/contributing.md`. Keep engineering,
security, UI, product, and CSS approval rules in force throughout native Poteto work.
Do not commit or push directly to `main` unless the user explicitly overrides.

## Prepare and deliver a change

1. Fetch the fresh base branch from `origin` (the base branch in `config/branches.json`, `develop`). Create an isolated implementation worktree from that
   tip. Do not switch or reset another owner's checkout. Use
   `type/short-kebab-description` with `feat`, `fix`, `docs`, `chore`, `refactor`, or `test`.
2. Run `make worktree-setup` there. It provisions hooks, the Python environment
   with CI extras, and `gui/web` dependencies. `make hooks` installs `.githooks`.
   Format staged files through lint-staged. Keep pre-commit hooks check-only.
3. Implement code, relevant tests, and docs together. Run focused local checks.
   GitHub Actions owns the required full-CI gate. Local `make ci` is optional.
4. When the user authorizes commits or PR delivery, make focused Conventional
   Commits. Run `make docs-sync`. Read each changed doc beside the code it describes.
   Post issue-specific screenshots and receipts on the PR, never in `docs/issue-<n>/`.
5. Push the branch and open a draft PR. Independent PRs target the base branch in `config/branches.json` (`develop`).
   A native base-branch stack targets its parent until the parent lands.
   Report the issue selection and draft PR URL to the parent or operator immediately.
   The owning lane carries its PR through verification and an authorized merge.
   Reporting to the coordinator does not add a separate approval dependency.

Put `Fixes #N`, `Closes #N`, or `Resolves #N` on its own line for an issue the PR
finishes. Use `Related #N` for work it touches without completing.
Use `Part of #N` for a non-final part of a series. A bare issue mention does not close it.

## Verify an authorized merge

Merge only under the user's current grant. Opening a PR, invoking the companion,
or passing a helper does not grant merge authority. When that grant covers merge,
the owning lane performs the merge after every gate passes. It does not wait for
a separate coordinator approval or final merge instruction. Ownership is not
self-review. Preserve the independent native review and Shipping seats.

Coordinate shared-state mutations through the current serial merge window.
Confirm the coordinator's recorded turn assignment or handoff names your lane
and PR before preparing the merge. Missing or conflicting turn ownership blocks
that preparation. Do not merge concurrently or take over another lane's claim.
Report the confirmed merge or blocked outcome so the next turn can be assigned.
The coordinator tracks ownership, ordering, evidence, and blockers. It does not
replace an independent verdict or an unresolved user decision.

Require successful `pytest`, `frontend`, `frontend-e2e`, and `gitleaks-history`
checks for the exact final PR head. The Python-floor job is advisory.
After a rebase or any head change, refresh review evidence and required CI.
Resolve review threads and valid findings. Respect `needs-user-input`,
`do-not-merge`, and `pipeline:stalled` holds.

Require the native independent per-PR Shipping verdict.
Complete applicable owner audio listening, live UI checks, and product approval
before merge. Automated checks cannot stand in for an owner gate.

For an issue-backed PR, run this additional manual, read-only repository predicate
immediately before an authorized merge from the provisioned worktree:

```bash
.venv/bin/python scripts/poteto_issue_gate.py --repo calebn/sharecut-studio \
  --pr <N> --issue <issue-N> --claim-token <token> --wont-do <count>
```

The helper fails closed on required checks, a moved head, a base other than the base branch in `config/branches.json`,
an ambiguous issue link, a missing or lost live claim, missing issue merging or PR review/merging stage,
holds, unresolved review threads, won't-do items, or an unmergeable PR.
Its JSON result is an additional predicate, not the native independent verdict.

The issue and live claim must be at merging. Keep exactly one PR stage,
`pipeline:review`, while qualifying. Publish `pipeline:merging` only after the
standalone predicate and all other handoff gates pass. Run the predicate again
immediately before an authorized merge.

Collection uses GitHub REST for the pull request, workflow runs, attempt jobs,
check runs, issue, and issue comments. For each required workflow, it selects
the latest eligible PR run for the exact head and checks its current attempt.
Missing, ambiguous, changed, or incomplete evidence blocks qualification.
Review threads prefer GraphQL `reviewThreads` when GraphQL returns HTTP
200. When GraphQL returns 403 (`Resource not accessible by integration`), threads
fall back to `GET .../pulls/{n}/comments` grouped by walking `in_reply_to_id` to a
thread root. That REST path is fail-closed: each group counts as unresolved because
REST exposes no `isResolved`.

Run the helper as its own tool action. Capture the process exit status and
retain the JSON receipt. Before a separate merge action, require all of these:

- The helper exits with status `0`.
- `mergeable` is `true`.
- `head_sha` is non-null and equals the expected verified PR head.
- `blockers` is an empty list.

A command error, malformed or missing JSON, an API failure such as HTTP 503,
or a null head stops the merge invocation. Do not put the helper and merge
on separate unchecked lines in one shell action. The owning lane inspects the
receipt and exit status before invoking the separate merge action, and reports
them to the coordinator. A previous passing receipt cannot replace this
immediate predicate.

When qualifying this procedure, retain a PR-only failure-path demonstration.
Use a harmless command as the merge stand-in. Show that both an exit-1 helper
and an HTTP-503/null-head result invoke no stand-in, and that the all-passing
control invokes it. Retain the commands, JSON, exit statuses, and stand-in count.
Do not invoke a real merge to test a failure path.
Do not invent an issue for a contributor PR to run it.

Before merge, mark the draft ready through the built-in PR tool when available,
or through the resolved forge otherwise. Recheck the exact head, required checks,
review state, and owner gates after that transition.

Merge by rebase, overriding native squash defaults. Match the verified head:

```bash
gh pr merge <N> --rebase --match-head-commit <sha>
```

Clean up only worktrees this run created. Release owned claims on every exit,
including completion, hold, abandon, and failure.

## Refresh evidence after interruption or change

After a disconnect, reconcile any uncertain prior command against its process,
local state, and remote outcome before repeating it. A lost connection does not
prove that a push, label change, or merge failed. Preserve denied operations as
blocked. Do not retry them or switch routes without new applicable authorization.

Immediately refresh the relevant final checks after reconnection or a material
head or base change. Re-read the PR head, target and base tip, current-main
integration, current-base integration, ownership, holds, required CI attempts,
review state, and outstanding owner gates. Record the exact revisions and scope
of each integration result. A conflict-free composition alone is not a test pass.
If execution remains unavailable, report the missing checks and keep merge blocked.

Apply native Shipping's evidence-reuse procedure to the recorded verdict head,
base, and stable patch-id. Keep only evidence that still covers the current patch
and surface. Refresh exact-head CI and mergeability, rerun affected verification,
and obtain the independent verdict required by native Shipping. Do not rerun an
uncertain command blindly or discard valid bounded evidence just because a
connection dropped. For an issue-backed PR, repeat the standalone repository
predicate immediately before the separate authorized merge action. Preserve all
applicable native predicates and unresolved listening or user-decision gates.

## Show the current verdict and retain history

When a later relevant check fails, put the failure first in the PR's current
verification summary. State that it supersedes the earlier Shipping pass for
merge readiness. Name the failed command or check, result, exact head and base
SHAs, tested scope, and remaining blocker. Link the retained receipts and earlier
verdict. Mark the older pass historical, with its original revisions and scope.
Do not delete it or present it as the current result.

Distinguish failed evidence from pending refresh or blocked execution. A missing
refresh invalidates a claim of current readiness without inventing a test failure.
After repair, record fresh evidence and the applicable independent verdict before
restoring a passing summary. A narrow passing rerun does not erase a broader
failure outside its tested scope.
