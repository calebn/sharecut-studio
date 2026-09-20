#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${PODCAST_E2E_PROJECT:-$ROOT/tests/fixtures/aligned_dialogue}"
if [[ -d "$PROJECT" ]]; then
  PROJECT="$PROJECT/episode.project.json"
fi

PODCAST="${PODCAST_BIN:-$ROOT/.venv/bin/podcast}"

echo "==> Seed canned transcript"
"$PODCAST" fixture seed-transcript \
  --project "$PROJECT" \
  --from "$ROOT/tests/fixtures/canned_transcript_aligned.json"

echo "==> Run fast e2e"
make e2e

echo ""
echo "==> Manual listen-through (see docs/e2e-fixture-manual.md)"
echo "  podcast play --project $PROJECT --compare --start 18 --end 28"
echo "  podcast play --project $PROJECT --query documented"
echo ""
echo "==> Bleed debugging (synthetic_bleed_60s + ami_bleed_60s)"
echo "  ./scripts/run_bleed_debug_battery.sh"
echo "  docs/e2e-fixture-manual.md#bleed-debugging"
echo ""
echo "Optional slow tier: make e2e-slow"
echo "Optional nightly tier: make e2e-real"
