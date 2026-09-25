# Git workflow

Ship via **feature branch → PR → `main`**. Do not commit or push directly to `main` unless the user explicitly overrides.

1. Start from latest `main` (`git checkout main && git pull`).
2. Create `type/short-kebab-description` (`feat` | `fix` | `docs` | `chore` | `refactor` | `test`).
3. Implement with tests and docs in the same change.
4. When the user asks to ship: commit on the branch, `git push -u origin HEAD`, `gh pr create` targeting **`main`**. GitHub Actions runs the required full CI after the push / PR; local `make ci` is optional. Put `Fixes #N` (or `Closes` / `Resolves`) in the PR body so merge into `main` auto-closes linked issues; use `Related #N` for issues the PR touches but does not close (including review follow-ups); one part of a multi-PR series uses `Part of #N` instead of `Fixes #N` until the final part ([docs/contributing.md § Automated issue pipeline](../../docs/contributing.md#automated-issue-pipeline)).
5. Merge with rebase (`gh pr merge --rebase`), not squash, so `main` keeps each focused commit. Merge only when the user asks — except the `issue-pipeline` workflow, which is pre-approved to merge when its gate passes ([docs/contributing.md § Automated issue pipeline](../../docs/contributing.md#automated-issue-pipeline)).

Examples: `feat/guest-sign-in-ui`, `fix/share-acl-401`, `docs/agent-pr-workflow`.

`make hooks` installs `.githooks` (lint-staged + check-only pre-commit). New worktrees: `make worktree-setup` (the pre-commit hook also runs it when `.venv` / `gui/web/node_modules` are missing). GitHub Actions, rather than a pre-push hook, gates public pushes and pull requests. Detail: [docs/contributing.md](../../docs/contributing.md) § Git workflow / [docs/testing.md](../../docs/testing.md) § GitHub CI gate.

Still only create commits or PRs when asked to ship. Detail: [docs/contributing.md § Git workflow](../../docs/contributing.md#git-workflow), [AGENTS.md § Git workflow](../../AGENTS.md#git-workflow).
