# S1 (PR 1948) Mac lab before/after recipe

Head under test: claude/project-thread-0ed2dn (PR 1948). Before = origin/main. Daniela audio stays on the Mac.

Recreate (as in PR 1869's body; no lab names/paths):
1. Daniela tape project at its 102-pending state, `cp -Rc` clone per run.
2. Add `proposal_origin` and `boundary_intent` "programmatic" to each edit decision lacking them; delete `play_cache`, `session`, `room_tone_pools`; warm with `PlayService.warm_pending_preview(None)`.
3. `nice -n 10 podcast gui --project <json> --port 8815 --no-open --dev` (never 8801, never pkill -f "gui --project").
4. POST `{"type":"ApproveEdits","payload":{"ids":[<first N pending>],"hold_blocked":true},"client_id":"v","role":"viewer","client_seq":1}` to `/api/document/command?path=<json>`. Run N=20 and N=102, one run per arm, same clone state, quiet machine (record load average).

Record per arm: wall seconds, ffmpeg process count if observable (e.g. `sudo`-free: count via `ps` sampling or the PODCAST log), count approved and held.

Pass criteria:
- Project JSON after the batch equals main's, ids and `applied_at` ignored (676 clips, 118 edit-log rows, empty pending list at 102 cuts per PR 1869's run). Any difference in held/approved ids is a FAIL, even if tiny.
- Wall time: main was 3102.8 s at 102 cuts (30.4 s/cut). Expect S1 to land well under 10 min (cloud: 5-min chained tile 215 s to 13 s; the remaining cost is the Python proof, S2/S3).
- Fallback frequency: log how many track builds took the ffmpeg render vs the evaluator (any track with mute regions, off-speaker/bleed restore, envelope points, mixed channel layouts, non-tri crossfade keeps the render). If Daniela's chained tracks mostly fall back, the speedup won't show: report which condition.
- Preview-vs-export: export Daniela's joins before and after is unaffected (S1 changes only proof evidence, not edits); confirm exported WAV sha256 equal between arms.
Open risk the lab must settle: seam frames can differ up to ~0.2 dB between the evaluator and the render; the A/B equality above is the test.
