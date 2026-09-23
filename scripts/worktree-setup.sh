#!/bin/sh
# Idempotent per-checkout dev setup (main checkout or any git worktree):
#   - git hooks resolve to THIS checkout's .githooks (relative core.hooksPath)
#   - Python venv with the same extras CI installs (dev, gui, relay)
#   - gui/web node_modules (lint-staged + Biome for the pre-commit hook)
# Safe to re-run; each step is a fast no-op when already current.
# Also invoked automatically by .githooks/pre-commit when a worktree is unprovisioned.
set -e
cd "$(git rev-parse --show-toplevel)"

# A per-worktree absolute hooksPath (e.g. copied from the main checkout) would run
# another checkout's hook scripts; drop it so the shared relative setting applies.
if [ "$(git config --get extensions.worktreeConfig 2>/dev/null)" = "true" ]; then
  git config --worktree --unset core.hooksPath 2>/dev/null || true
fi
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit

if command -v uv >/dev/null 2>&1; then
  uv sync --quiet --extra dev --extra gui --extra relay
else
  echo "worktree-setup: uv not found; install it (see docs/setup.md) or run ./install.sh" >&2
  exit 1
fi

# npm ci only when node_modules is missing or older than the lockfile.
if [ ! -f gui/web/node_modules/.package-lock.json ] ||
  [ gui/web/package-lock.json -nt gui/web/node_modules/.package-lock.json ]; then
  (cd gui/web && npm ci --no-audit --no-fund --loglevel=error)
fi
