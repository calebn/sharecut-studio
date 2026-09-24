#!/bin/sh
# lint-staged (>=16) no longer runs task commands through a shell, so a task
# string can't use `cd gui/web && biome ...`. This wrapper does the `cd` in a
# real shell, then execs biome with the same flags lint-staged.config.mjs used
# to pass inline. Paths are given relative to gui/web (see lint-staged.config.mjs).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../gui/web"
exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched -- "$@"
