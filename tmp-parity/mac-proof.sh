#!/usr/bin/env bash
# Mac lab proof for PR 1938 (#1813 slice 3). Run from ~/projects/podcast_mcp. Needs PODCAST_MCP_FFMPEG/FFPROBE exported.
set -euo pipefail
export LAB=~/projects/ShareCut_Podcast_Test LAB_RUNS_DIR=/tmp/lab-runs
git fetch origin main claude/project-thread-ar5qpc tmp/cut-parity-1938
git show origin/tmp/cut-parity-1938:tmp-parity/cut_parity.py > /tmp/cut_parity.py
git worktree add --detach /tmp/wt-main 89bdc3d
git worktree add --detach /tmp/wt-head 97172abc46527893fdf1ca39998eafd565d65984
for R in main head; do (cd /tmp/wt-$R && uv sync --frozen); done
cd /tmp/wt-main
$LAB/scripts/make-run.sh plain --prep
cp -ac /tmp/lab-runs/plain /tmp/lab-runs/aligned
.venv/bin/podcast pipeline run --project /tmp/lab-runs/aligned/episode.project.json --only transcribe_tracks --retime-words
for V in plain aligned; do for R in main head; do
  (cd /tmp/wt-$R && nice -n 10 uv run --frozen python /tmp/cut_parity.py /tmp/out-$R-$V.json --lab-run /tmp/lab-runs/$V)
done; done
rc=0
for V in plain aligned; do
  if cmp /tmp/out-main-$V.json /tmp/out-head-$V.json; then echo "PASS $V"; else echo "FAIL $V"; diff /tmp/out-main-$V.json /tmp/out-head-$V.json | head -40; rc=1; fi
  python3 -c "import json,sys;d=json.load(open('/tmp/out-head-$V.json'));print('$V proposals',{k:len(v['proposals']) for k,v in d.items()},'export',{k:bool(v.get('export_sha256')) for k,v in d.items()})"
done
exit $rc
