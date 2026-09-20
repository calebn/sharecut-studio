#!/usr/bin/env bash
# Build optional 5-minute Dropbox test fixture (not committed to podcast_mcp).
set -euo pipefail

: "${PODCAST_E2E_PROJECT:?Set PODCAST_E2E_PROJECT to test_fixture_5min directory}"
: "${PODCAST_AUDIO_DIR:?Set PODCAST_AUDIO_DIR to episode Audio Files directory}"

PODCAST="${PODCAST_BIN:-$(dirname "$0")/../.venv/bin/podcast}"
MANIFEST="${MANIFEST:-$(dirname "$PODCAST_E2E_PROJECT")/ingest.yaml}"

if [[ ! -x "$PODCAST" ]]; then
  PODCAST="$(command -v podcast)"
fi

mkdir -p "$PODCAST_E2E_PROJECT"

echo "==> Init"
"$PODCAST" episode init --dir "$PODCAST_E2E_PROJECT" --name "podcast_123 test (5 min)"

echo "==> Consolidate opening 300s (see ingest.yaml session_start)"
"$PODCAST" ingest consolidate \
  --audio-dir "$PODCAST_AUDIO_DIR" \
  --manifest "$MANIFEST" \
  --project "$PODCAST_E2E_PROJECT/episode.project.json" \
  --extract-start 0 \
  --extract-duration 300 \
  --analysis-start 0 \
  --analysis-duration 60

echo "Done: $PODCAST_E2E_PROJECT"
echo "For CI/tests use: tests/fixtures/aligned_dialogue in the podcast_mcp repo"
