#!/usr/bin/env bash
# Build tests/fixtures/ami_bleed_60s from AMI word XML + synthetic overlap bleed audio.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/fixtures/ami_bleed_60s"
CACHE="${TMPDIR:-/tmp}/podcast_mcp_ami"
ANNOT_URL="https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip"
SLICE_START="${AMI_SLICE_START:-120}"
SLICE_END="${AMI_SLICE_END:-180}"

mkdir -p "$CACHE"

if [[ ! -d "$CACHE/ami_manual" ]]; then
  echo "==> Downloading AMI manual annotations"
  curl -L -o "$CACHE/ami_manual.zip" "$ANNOT_URL"
  unzip -q -o "$CACHE/ami_manual.zip" -d "$CACHE/ami_manual"
fi

WORDS_DIR="$(find "$CACHE/ami_manual" -type d -name words | head -1)"
if [[ -z "$WORDS_DIR" || ! -d "$WORDS_DIR" ]]; then
  echo "AMI words directory not found after unzip" >&2
  exit 1
fi

python3 "$ROOT/scripts/build_ami_bleed_fixture.py" \
  --words-dir "$WORDS_DIR" \
  --output "$OUT" \
  --slice-start "$SLICE_START" \
  --slice-end "$SLICE_END"

echo "Done: $OUT"
