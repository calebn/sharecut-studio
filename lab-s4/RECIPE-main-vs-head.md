# #1958 PR-A (PR 2043) Mac A/B: main vs PR head, read-only on clones
Rules: ONE heavy job at a time, `nice -n 10`, quiet machine (note load average; quit browsers/simulators; no other lab run), RSS watchdog 6 GB is in the scripts, swap cap 4 GB, never port 8801, no servers. No audio leaves the Mac; do not post paths or share links. Record `ffmpeg -version` of the pinned pair for both arms (same binary).

## 0. Checkouts (once)
```
cd <repo>; git fetch origin main claude/project-thread-0ed2dn scratch/s4-mac-lab
git worktree add /tmp/s4-wt-main origin/main
git worktree add /tmp/s4-wt-head origin/claude/project-thread-0ed2dn      # note its tip SHA: expected dfee6aa00 or newer
for w in main head; do git archive origin/scratch/s4-mac-lab lab-s4 | tar -x -C /tmp/s4-wt-$w; done
```
Run each arm with its own worktree's `src` (`PYTHONPATH=/tmp/s4-wt-<arm>/src`) and the app venv.

## 1. Fresh N=61 set (the old clones are gone)
```
cp -Rc <daniela-v2 project dir> /tmp/s4-base            # APFS clone, read-only source untouched
PYTHONPATH=/tmp/s4-wt-main/src podcast propose-edits --project /tmp/s4-base/<episode>.project.json --intensity aggressive
```
Do this ONCE (on main); every run then starts from its own `cp -Rc /tmp/s4-base /tmp/s4-<arm>-<run>`. Record the pending count (expected ~61).

## 2. OK-heavy id list (once, on main, ~16 s per edit so allow up to ~30 min)
```
cp -Rc /tmp/s4-base /tmp/s4-sel
PYTHONPATH=/tmp/s4-wt-main/src nice -n 10 python /tmp/s4-wt-main/lab-s4/select_ok_ids.py /tmp/s4-sel/<episode>.project.json /tmp/s4-ok-ids.txt 40 120 | tee s4-select.txt
```
If it finds fewer than ~15 OK edits, the aggressive set is held-heavy by nature: re-propose at `--intensity light` on a fresh `cp -Rc` of daniela-v2 into /tmp/s4-base-light and repeat steps 1-2 on that.

## 3. A/B, alternating, 3 pairs (effect is large; checklist asks for repeats): main, head, main, head, main, head
Each run on a fresh clone (`cp -Rc /tmp/s4-base /tmp/s4-<arm>-<k>`), logs to `s4-<arm>-<k>.txt`:
```
PYTHONPATH=/tmp/s4-wt-<arm>/src nice -n 10 python /tmp/s4-wt-<arm>/lab-s4/profile_approve.py /tmp/s4-<arm>-<k>/<episode>.project.json 61 | tee s4-profile-<arm>-<k>.txt
```
Then the same alternation once more for the OK-heavy set (ids file from step 2): 
```
... profile_approve.py <clone>.project.json 40 /tmp/s4-ok-ids.txt
```
Then verdict stability, once per arm on fresh clones (compare CHANGED lines and the before/after OK/HELD counts):
```
... verdict_stability.py <clone>.project.json 61 10
... verdict_stability.py <clone>.project.json 40 10 /tmp/s4-ok-ids.txt
```

## Pass bars
- EXACTNESS (hard): in every pair the `HELD` list and `applied ids` line are IDENTICAL between main and head (same ids, same reasons), for both sets; verdict_stability prints the same before/after counts. Any difference = FAIL, report it, stop.
- SPEED: head wall < main wall in every pair; report median and range of 3 per arm; expect the heavy-render share (47% of the profile) to disappear; report ffmpeg launches and child seconds for both.
- MEMORY: peak RSS under 6 GB (watchdog exits 3 otherwise); report peak for both arms (main N=102 was 4.6 GB).
- Honest expectation: the head helps held-heavy and mute-overlap batches most; an OK-heavy set whose cuts really apply still pays a per-cut level rebuild (PR-B). Report that number; it is the baseline for PR-B.
Send back the full text of the txt files plus load average at each run's start, and `uname -a`/ffmpeg version once.
