# S4 Mac lab batch 2 (read-only)

Branch: scratch/s4-mac-lab (off origin/main). Daniela audio stays on the Mac; do not commit output that names paths.
Rules: ONE heavy job at a time, `nice -n 10`, `cp -Rc` a fresh clone of the 102-pending Daniela project per script, RSS watchdog 6 GB is built in, swap cap 4 GB, never port 8801, no servers needed (both scripts run in process).

```
cd <repo checkout at this branch>; source venv; export PYTHONPATH=src
cp -Rc <102-pending Daniela dir> /tmp/s4-clone-a
nice -n 10 python lab-s4/profile_approve.py /tmp/s4-clone-a/<episode>.project.json 102 > s4-profile.txt 2>&1
cp -Rc <102-pending Daniela dir> /tmp/s4-clone-b
nice -n 10 python lab-s4/verdict_stability.py /tmp/s4-clone-b/<episode>.project.json 102 10 > s4-stability.txt 2>&1
```
Send back both txt files' text (no audio, no share links). Record `ffmpeg -version` and load average.
Wanted: (1) where the remaining ~4 s per cut goes (top 25 cumulative and tottime, ffmpeg count/seconds); (2) how many of the 92 verdicts change after 10 cuts apply, and whether changed ones are near the applied cuts.
Note: the project JSON has to be at its 102-pending state (same as the S1 recipe); if it is not, N is just the pending count.
