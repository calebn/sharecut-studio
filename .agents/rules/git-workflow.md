# Git workflow

Ship via **feature branch → PR → `main`**. Do not commit or push directly to `main` unless the user explicitly overrides.

1. Start from latest `main` (`git checkout main && git pull`).
2. Create `type/short-kebab-description` (`feat` | `fix` | `docs` | `chore` | `refactor` | `test`).
3. Implement with tests and docs in the same change.
4. When the user asks to ship: commit on the branch, `git push -u origin HEAD`, `gh pr create` targeting **`main`**. Put `Fixes #N` (or `Closes` / `Resolves`) in the PR body so merge into `main` auto-closes linked issues.
5. Merge only when the user asks.

Examples: `feat/guest-sign-in-ui`, `fix/share-acl-401`, `docs/agent-pr-workflow`.

`make hooks` installs `.githooks` (lint-staged + check-only pre-commit; **pre-push** gates on `make ci`). Detail: [docs/contributing.md](../../docs/contributing.md) § Git workflow / [docs/testing.md](../../docs/testing.md) § Pre-push local CI gate.

Still only create commits or PRs when asked to ship. Detail: [docs/contributing.md § Git workflow](../../docs/contributing.md#git-workflow), [AGENTS.md § Git workflow](../../AGENTS.md#git-workflow).
