# #1958 PR-B1 Mac lab (two jobs, read-only on clones)
Rules as before: ONE heavy job at a time, `nice -n 10`, RSS watchdog 6 GB (in scripts), swap cap 4 GB, never port 8801, no servers, no audio leaves the Mac. Use the app venv and a worktree of origin/claude/project-thread-0ed2dn (PR 2206, head ceb9fcf07 or newer) for `src`; take lab-s4/ from this branch (`git archive origin/scratch/b1-mac-lab lab-s4 | tar -x -C <worktree>`).

## Job 1: resampler locality on REAL speech (minutes)
```
export PODCAST_LAB_SPEECH_WAV=<a copy of a Daniela episode wav, 5+ minutes is plenty; copies are fine, delete after>
PYTHONPATH=<wt>/src nice -n 10 python -m pytest tests/test_resampler_locality.py -q -s -p no:cacheprovider
```
Report the printed "ffmpeg build ... W, G = ..." lines (48k->8k and 48k->16k), the ffmpeg -version, and pass/fail. If it fails or W/G come out larger than 102/96 (8k) or 51/48 (16k), report the numbers.

## Job 2: per-stage timing of approve_edits (the baseline for the phase-bank work)
Fresh clones as in RECIPE-main-vs-head.md (`cp -Rc <daniela-v2 dir> /tmp/b1-<k>`; reuse /tmp/s4-base and /tmp/s4-ok-ids.txt if they still exist; else propose-edits aggressive on a clone and select_ok_ids.py as in that recipe). Run, one at a time, PR head src, logging load average at start:
```
PYTHONPATH=<wt>/src nice -n 10 python lab-s4/stage_timing.py <clone>.project.json 61 | tee b1-stage-61.txt
PYTHONPATH=<wt>/src nice -n 10 python lab-s4/stage_timing.py <clone>.project.json 40 /tmp/s4-ok-ids.txt | tee b1-stage-ok.txt
```
Plus an applied-heavy set if you can build one (many cuts that really apply, e.g. ids selected from a `--intensity light` proposal): same command with that ids file. Send back the full text of each txt, load average, uname -a, ffmpeg -version. The table is exclusive time per stage, per edit; "(unwrapped ...)" is verdict Python, deep copies elsewhere and apply.
