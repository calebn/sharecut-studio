# S4 Mac batch: two read-only checks (Caleb: go, 2026-10-22 02:08Z)
Branch scratch/s4-mac-lab. Both run in process, no server, no audio leaves the Mac, nothing is written to the project. One heavy job at a time; these two are light. Use the app's own venv and the pinned ffmpeg (the probe prints which one it used).

1. Daniela decline census (seconds; which tracks would decline to the ffmpeg render, and how many pending cuts touch a mute)
```
cd <repo checkout at scratch/s4-mac-lab>; source <venv>/bin/activate
cp -Rc <Daniela dir> /tmp/s4-clone-c
PYTHONPATH=src python lab-s4/decline_census.py /tmp/s4-clone-c/<episode>.project.json | tee s4-census.txt
```
Pass bar: none (informational). Report the whole output. Decides whether bleed-restore emulation is worth doing next (tracks with bleed_restore_clips > 0).
The clone must open on current main: the old 102-pending clones fail with "serialized edit decisions require proposal_origin and boundary_intent"; use the same clone the N=61 profile used.

2. Resampler restart probe (1-3 min, CPU only, synthetic noise, no project)
```
PYTHONPATH=src nice -n 10 python lab-s4/resampler_restart_probe.py 120 30 1 | tee s4-probe.txt
```
Pass bar: last line `RESULT: PASS`; for 48000->8000 and 48000->16000 some warm-up <= 4096 input samples gives bit-equal output in ALL 30 trials; 44.1 kHz lines are informational. FAIL = PR-B uses prefix reuse (~2x) instead of the splice.
Cloud receipt (ffmpeg 6.1.1, 20 s, 6 trials): PASS, smallest all-equal warm-up 256 (48k->8k), 64 (48k->16k), 1024 (44.1k); off-grid restarts never equal. The Mac result on the pinned ffmpeg is the one that counts.
Send back the full text of both txt files plus load average.
