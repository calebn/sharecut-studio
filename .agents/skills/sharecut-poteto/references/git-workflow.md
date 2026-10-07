# Git policy

Read the active checkout's `AGENTS.md` and `docs/contributing.md`. Keep engineering,
security, UI, product, and CSS approval rules in force throughout native Poteto work.
Do not commit or push directly to `main` unless the user explicitly overrides.

## Prepare and deliver a change

1. Fetch fresh `origin/main`. Create an isolated implementation worktree from that
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
5. Push the branch and open a draft PR. Independent PRs target `main`.
   A native base-branch stack targets its parent until the parent lands.
   Report the issue selection and draft PR URL to the parent or operator immediately.
   A delegated owner waits for the parent's acknowledgment before any merge.

Put `Fixes #N`, `Closes #N`, or `Resolves #N` on its own line for an issue the PR
finishes. Use `Related #N` for work it touches without completing.
Use `Part of #N` for a non-final part of a series. A bare issue mention does not close it.

## Verify an authorized merge

Merge only under the user's current grant. Opening a PR, invoking the companion,
or passing a helper does not grant merge authority.

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

The helper fails closed on required checks, a moved head, a base other than `main`,
an ambiguous issue link, a missing or lost live claim, missing merging stage labels,
holds, unresolved review threads, won't-do items, or an unmergeable PR.
Its JSON result is an additional predicate, not the native independent verdict.
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
