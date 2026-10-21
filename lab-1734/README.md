# #1734 Mac lab: a bleed mute should leave the lane's own room tone

Proof the rule asks for: before (main) vs after (PR 1994 head), on the Daniela episode, with and
without the forced aligner. Audio stays on the Mac. Never post audio, stems or share links.

## Safety
- Work on a **scratch copy** of the daniela-v2 project (e.g. `cp -R` to `~/lab-1734/daniela-copy`). Never touch Caleb's Studio on 8814, never `pkill -f "gui --project"`.
- One heavy job at a time, `nice -n 10`, RSS watchdog 6 GB, swap cap 4 GB. Run the four renders below one after another.
- Needs the PR head checked out in a separate worktree/venv from main: `git worktree add ~/lab-1734/pr origin/claude/project-thread-ic97to` and one for `origin/main`.

## Steps (for each arm: `forced_alignment.enabled: true`, then `false`)
1. Copy the project fresh for the arm, set the arm's flag in the copy's defaults override.
2. On **main**: `podcast edit apply-bleed-mute --dry-run` (note per-track `bleed_reduction`; the host lane must read `mute`), then apply. Copy the host stem to `~/lab-1734/<arm>/host_main.wav`.
3. Fresh copy again. On the **PR head**: same dry-run (new fields `room_tone_fill` / `room_tone_fill_reason` per candidate: expect source `room_tone_bed` or `comfort_noise`, not a reason) then apply. Copy the host stem to `host_pr.wav`.
4. Pull the muted spans from the dry-run candidates into `spans.json` (`[[start_sec, end_sec], ...]`, timeline seconds). Pick 3 to 10 pauses where the host is silent and Vicky is silent (also seconds, same clock) into `pauses.json`; at least 30 s in all.
5. Run the measurement (cloud-tested on a synthetic episode: PASS on a filled mute, FAIL on a silent one):
   `python3 measure_mute_fill.py --before host_main.wav --after host_pr.wav --peer <vicky stem> --spans spans.json --pauses pauses.json --out report-<arm>.json`
6. **Listen** to 3 muted spans on each arm (host stem solo, then the mix): the room should not drop out, and Vicky should not be audible in it.

## Pass rubric (the script prints each)
- no run of exact zeros over 10 ms inside a muted span (main fails this, that is the bug)
- muted-span level within 2 dB of the host's own pauses, every 1/3-octave band within 3 dB
- audio outside the muted spans (50 ms margin) within 1 LSB of main
- peer correlation inside the spans at most 0.2
- no click at span edges

Report back: the two JSON reports, the per-track dry-run lines, any listening notes. Do not
attach audio. If the aligner-on arm and aligner-off arm differ in which spans are muted, say so
(that is expected); the fill check applies to whichever spans each arm muted.
