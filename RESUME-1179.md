# Resume note: PR #1179 round 4 (pause trims, edges inside own sounds)

Role: owner of PR #1179 (autopilot-full). Do NOT merge; the root runs the swarm at the code-ready SHA. Branch `fix-1179-r4` tracks `origin/fix/pause-breath-protection-1055` (head 126e23a2d). The WIP commit lives only on `origin/fix/pause-breath-protection-1055-r4-wip`; the PR branch is untouched.

## Intent
Three rounds measured a track's "quiet" from the pause itself (r1 context floor, r2 context p90, r3 pause p20) and failed the same gate: edges inside own sounds. Premise changed: a frame is air only relative to the track's ROOM TONE, read between the track's own words, never relative to a pause that sound fills. It applies to every track checked at a ripple edge (own and peers).

## Done (in the wip commit)
- `audio_cache.room_floor_db(levels, among=, percentile=)`: the one shared room measure. `level_profile(whole_track=True)` uses it (p10, behaviour unchanged).
- `breath_detect._track_room_db`: p5 of the track's 10 ms frames outside its words (padded 50 ms) and outside the pause. Needs at least 0.5 s of such frames, else falls back to `audio_cache.track_profile` room, else None (the whole window is one sound, no air).
- `breath_detect._sounds(levels, gap, speech_db, room_db)`: quiet = min(pause p20, room). The clause "room within 40 dB of speech means the whole gap is one sound" now applies only when the track speaks (speech minus room at least 10 dB). A silent ungated mic (room tone only) no longer blocks pauses.
- The room margin was dropped (a +3 dB margin left a gap in the fade zone against the synthetic ground truth). The percentile is 5 not 10 because p10 over-read the room when air is under 10% of the between-word frames (verifier scene own_breath_fills_pause).
- 4 new tests at the end of `tests/test_breath_detect.py`: pause mostly own sound, peer breathing through the pause, peer breath ending inside the pause, silent room-tone-only mic. 177 pass in test_breath_detect + test_retained_breath_ends.

## Verified so far
- Verifier synthetic scenes (22, including the 2 new ones and silent_ungated_peer): 0 edges inside a sound in all (`scratchpad/p1179r4/synth-c.log`). own_breath_fills_pause gives 18 `no_air` and 0 trims. silent_ungated_peer gives 11 trims (round 3: 0).
- Baselines by the verifier's `mydet.py` on r3 and main: `scratchpad/p1179r4/mydet-r3.json`, `mydet-main.json`, summary `summ2-base.txt` (r3: 26 substantial, 7 body, 8 fade edges inside own and peer sounds).

## NOT done yet (in order)
1. LAB RUN of the new code. Freeze the source: `git archive HEAD src .agents/defaults | tar -x -C scratchpad/p1179r4/fz/r4`. Then `sh scratchpad/p1179r4/go.sh r4 <abs path to fz/r4> ripple`, then `.venv/bin/python scratchpad/p1179r4/summ2.py r4 r3 main` (from inside p1179r4). Goal: 0 edges inside a sound in ALL tiers (fade, body, substantial), own and peer, including the five named cases (guest 1 686.65, host 1351.65, host 797.36, guest 2 994.62, 1158.22). The "fade" tier may still fire (mydet threshold is q+4, ours is room+6). If so, lower the pause rule's sound threshold from the room on general grounds, not lab ones.
2. Check the `no_air` count on the lab (round 3: 149 proposed, 91 no_air). If proposals collapse, revisit the room estimator (p5, or the whole-track room fallback).
3. Timing: `CutWordIndex.build` now runs per track per `pause_air_span` call. Pass prebuilt indexes if it is slow.
4. Stale comments: the block comment above `_protect` in the tests says "dips of up to 30 ms bridged" (code says 50 ms) and describes the quiet as the pause's own 20th percentile.
5. Docs: rewrite the decision "Pause trims cut only air" and its evidence claims (drop the "no join lands inside ... a peer's onset" overclaim and "the verifier's independent detector finds 0 of their 294 edges"). Update `docs/filler-cut-quality.md`, `docs/inaudible-cuts.md`, `docs/decisions/README.md` (`python3 scripts/decisions_index.py --check`), the `.agents/defaults/pipeline.yaml` comment, skill `podcast-tighten-dialogue`, and the constants comment in `breath_detect.py`. Run the docs-sync range check.
6. Premise census as a rerunnable lever: `scratchpad/p1179r4/census3.py` (round 3: 24 of 32 flagged own edges and 24 of 25 flagged peer edges had a pause quiet at least 10 dB over the track's local room).
7. Gates: focused tests with `-n 2` (test_breath_detect, test_retained_breath_ends, test_fillers, test_fillers_voicing, test_tighten*, test_lab_tighten_fixtures), `make lint-py`, `make format-py-check`, `make typecheck`, `decisions_index.py --check`, docs-sync.
8. Commit (conventional, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push to the PR branch (fast-forward, or `--force-with-lease` after an `ls-remote` check), tag `clips/pr1179-r4`, render the clip pack into `listen1055/round4/` with a README (the five named cases plus V1/V4/V5), update the PR recipe comment (PR comment 2 currently holds a stray local path; replace its text) and the PR body, then `gh pr checks 1179 --watch`. No lab names or paths in GitHub text. Report code-ready with the head SHA, then merge-ready.
9. Delete the lab copy `scratchpad/p1179r4/aligned-ready` (1.9 GB, made by the coordinator and left in place) and big intermediates when done.

## Key files
- `src/podcast_mcp/edits/breath_detect.py` (`pause_air_span`, `_sounds`, `_track_room_db`), `src/podcast_mcp/edits/audio_cache.py` (`room_floor_db`), `src/podcast_mcp/edits/fillers.py` (`_gate_cut_edges` calls `pause_air_span`), `tests/test_breath_detect.py`, `docs/filler-cut-quality.md`.
- Scratchpad `/private/tmp/claude-330524735/-Users-caleb-nelson-projects-podcast-mcp--claude-worktrees-pstack-install-setup-8aa8e7/c124ef59-1ee2-4768-98bd-3bdff58a9d33/scratchpad/p1179r4/`: `go.sh`, `synth2.sh`, `dbg_synth.py`, `summ2.py`, `fz/{main,r3}` frozen sources, `mydet-*.json`.

## Gotchas
- The Bash tool refuses commands in this worktree that combine `cd`, inline env assignments or variables with git. Use `env PATH=... cmd`, small `sh` scripts, and plain separate commands.
- PATH needs `~/anaconda3/bin` and the nvm node bin first for make. `.venv` and `node_modules` are already set up here.
- `decisions.tsv` and `children.tsv` stay uncommitted (children: no subagents started).
- `mydet.py` is the verifier's arbiter on the lab. Its q is pause-local (mode of the lower half), so it can disagree with the synthetic ground truth in either direction.
