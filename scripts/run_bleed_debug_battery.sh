#!/usr/bin/env bash
# Prepare bleed fixtures and print listen + CLI checks for manual bleed debugging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PODCAST="${PODCAST_BIN:-$ROOT/.venv/bin/podcast}"
if [[ ! -x "$PODCAST" ]]; then
  PODCAST="podcast"
fi

SYNTH_PROJECT="$ROOT/tests/fixtures/synthetic_bleed_60s/episode.project.json"
AMI_PROJECT="$ROOT/tests/fixtures/ami_bleed_60s/episode.project.json"
RECONCILE_DEFAULTS="$ROOT/tests/fixtures/synthetic_bleed_e2e_pipeline.yaml"

export PODCAST_MCP_PIPELINE_DEFAULTS="$RECONCILE_DEFAULTS"

_bleed_prep() {
  local project="$1"
  local label="$2"
  echo ""
  echo "==> $label: ingest + pass-1 stems"
  "$PODCAST" pipeline run --project "$project" --only ingest_tracks
  "$PODCAST" pipeline run --project "$project" --only render_dialogue_stems
}

_bleed_report() {
  local project="$1"
  local label="$2"
  local start="${3:-12}"
  local end="${4:-16}"
  echo ""
  echo "==> $label: bleed words (host, ${start}-${end}s)"
  "$PODCAST" edit bleed-words --project "$project" --track host --start "$start" --end "$end" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"  count={len(d) if isinstance(d,list) else d.get('count', '?')}\")" \
    || true
  echo "==> $label: overlap pairs (${start}-${end}s) BEFORE reconcile"
  "$PODCAST" edit overlap-duplicates --project "$project" --start "$start" --end "$end" \
    | python3 -c "
import json,sys
r=json.load(sys.stdin)
pairs=r.get('pairs', r if isinstance(r,list) else [])
tm=sum(1 for p in pairs if p.get('text_match'))
print(f\"  pair_count={len(pairs)} text_match_count={tm}\")
for p in pairs[:5]:
    print(f\"    {p.get('track_a')}:{p.get('text_a')} / {p.get('track_b')}:{p.get('text_b')} overlap={p.get('overlap_sec')}s match={p.get('text_match')}\")
" || true
  echo "==> $label: reconcile + overlap AFTER (${start}-${end}s)"
  "$PODCAST" edit reconcile-transcript --project "$project" --start "$start" --end "$end" >/dev/null 2>&1 || true
  "$PODCAST" edit overlap-duplicates --project "$project" --start "$start" --end "$end" \
    | python3 -c "
import json,sys
r=json.load(sys.stdin)
pairs=r.get('pairs', r if isinstance(r,list) else [])
tm=sum(1 for p in pairs if p.get('text_match'))
print(f\"  pair_count={len(pairs)} text_match_count={tm} (target: 0)\")
" || true
}

echo "==> Bleed debug battery (reconcile defaults: synthetic_bleed_e2e_pipeline.yaml)"
echo "    Full checklist: docs/e2e-fixture-manual.md#bleed-debugging"

if [[ -f "$SYNTH_PROJECT" ]]; then
  _bleed_prep "$SYNTH_PROJECT" "synthetic_bleed_60s"
  _bleed_report "$SYNTH_PROJECT" "synthetic_bleed_60s" 12 16
  echo ""
  echo "==> synthetic_bleed_60s — manual listen"
  echo "  # Primary bleed window (guest dominates on host mic)"
  echo "  podcast play --project $SYNTH_PROJECT --compare --start 12 --end 16"
  echo "  podcast play --project $SYNTH_PROJECT --source track:host --start 12 --end 16"
  echo "  podcast play --project $SYNTH_PROJECT --source track:guest --start 12 --end 16"
  echo "  # Cross-track precorrect pair (todae vs today, ~10s)"
  echo "  podcast play --project $SYNTH_PROJECT --compare --start 9.5 --end 11"
  echo "  # Isolated host monologue (no bleed)"
  echo "  podcast play --project $SYNTH_PROJECT --source track:host --start 2 --end 8"
fi

if [[ -f "$AMI_PROJECT" ]]; then
  _bleed_prep "$AMI_PROJECT" "ami_bleed_60s"
  _bleed_report "$AMI_PROJECT" "ami_bleed_60s" 0 60
  echo ""
  echo "==> ami_bleed_60s — manual listen (AMI word timings, synthetic overlap)"
  echo "  podcast play --project $AMI_PROJECT --compare --start 0 --end 30"
  echo "  podcast edit bleed-words --project $AMI_PROJECT --track host"
  echo "  podcast edit overlap-duplicates --project $AMI_PROJECT"
fi

echo ""
echo "==> Reconcile dry-run (preview suppressions)"
echo "  podcast edit reconcile-transcript --project $SYNTH_PROJECT --dry-run --start 12 --end 16"
echo ""
echo "Done. See docs/transcript-reconcile.md for dominance thresholds and tuning."
