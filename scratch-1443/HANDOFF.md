# #1443 handoff: relative detection levels (D1)

- **PR:** https://github.com/calebn/sharecut-studio/pull/1452. It is not a draft. Do not merge it; stop when it is merge-ready.
- **Branch:** `refactor/relative-detection-levels-1443`, pushed.
- **Head:** `534d8cb6abf9bf17385c97c652c479f9445364fc`. The working tree is clean, so nothing was committed as WIP.
- **Base:** origin/main as of 2026-10-14 ~04:00Z. The branch was rebased; main has probably moved again.
- **Claim token:** `d1-1443-78277c6a`. The heartbeat comment id on #1443 is 6157337611; edit that comment rather than posting a new one.
- **Worktree used:** `/Users/caleb.nelson/projects/podcast_mcp/.claude/worktrees/agent-a05a1cc5f14b3fe51`.

## Done (commits on the branch)

1. `refactor(levels)` adds one `LevelProfile` (`engines/level_profile.py`).
   - Floors, references and the evidence margin are consolidated into it.
   - Bleed-path levels are offsets under each track's voice, via `voice_gain`.
   - Cross-track comparisons add back the `path_reference_db` gap.
   - #1382 is handled with `span_is_silent` against the audibility floor.
2. `test(levels)` adds:
   - the one gain contract in `tests/test_tighten_gain_invariance.py`;
   - the lint `scripts/check_level_literals.py`, which runs in `make lint-py`.
3. `docs(levels)` updates the docs. The main section is audio-engineering § Detection levels, decision `D-relative-detection-levels`.
4. `fix(levels)` (810bfc9 after the rebase):
   - Prosody now reads the profile of its own energy pass, so it no longer adds a decode and keeps cancellation working.
   - CI test fixes: `test_dsp`, `test_mute_in_place`, `test_coverage_boost5`, `test_inaudible_cuts`, `test_silence_islands`, `test_word_onset`, `test_transcript_reuse` and `test_join_continuity`.
   - The laughs pin in `test_bleed_gate_generality` is now a cap at 5.3 s / 24, because the result differs by platform: macOS gives 5.3/24 and Linux CI gives 5.05/23.
5. `fix(levels)`: the join onset is now 35 dB under the voice level (`_ONSET_UNDER_VOICE_DB`). `JoinContinuityConfig.at_levels(profile)` replaces `at_voice_floor`.
6. `test(levels)`: the `test_speech_energy_guard` fixture now patches `track_level_profile`.

## CI

At 534d8cb, pytest was still pending. Everything else had passed at 8a1e2d6.

The previous pytest run at 8a1e2d6 had exactly 10 errors, all from the speech-guard fixture, which commit 6 fixes. That run passed 13438 tests and coverage was 95.77%.

**Next:** watch pytest at 534d8cb. If anything fails, fix it, rebase onto main, rerun `make lint-py format-py-check typecheck docs-sync decisions-index-check`, and push.

## Untested

- Locally, only focused files ran: join, prosody, speech guard, tighten and pause contracts, and the files that failed in CI. CI has not yet run the full suite at the final head.
- Commits 4 to 6 were not lab-run. The lab trees ran `after2` (`d4bb3f07b`).
  - The onset change moves the onset by at most about 0.3 dB on the lab tracks.
  - Prosody does not run in the lab jobs.

## Lab results (done, in `compare1443.py` outputs)

Outputs are in `~/projects/ShareCut_Podcast_Test/runs/2026-10-13-issue1443/out/`. Labels: `before` is main `5eeed765b`, `after2` is the branch.

At the lab's own level:
- Proposals are identical on both trees: aligned 136 mute / 106 ripple, Whisper 58 / 42.
- Word changes:
  - Aligned: `it's` 693.77 → bleed (better); `don't` 820.44 → bleed (worse, Caleb's own word); `she` 1611.85 bleed → inaudible (suppressed either way).
  - Whisper: `No,` 1610.36 bleed → audible (worse); `Hi,` 567.62 status only; `Okay,` 758.0 newly suspect.

Scaled runs, exact float:

| Variant | main | branch |
| --- | --- | --- |
| all -12 dB, bleed gate | 115/122 spans unmatched | 0/0 |
| all -12 dB, words | 0 changed | 0 changed |
| all -24 dB, bleed gate | 0 spans | 193 spans |
| all -24 dB, words | — | 4 changed |
| Caleb alone -24 dB, bleed gate | 0 spans | 179 spans |
| Caleb alone -24 dB, words | 131 changed | 91 changed (cross-track as recorded; #1376) |
| Tighten drift | 6/6 at -12 dB, 6/14 at -24 dB | same rows |

- The tighten drift is the same on both trees and is not caused by the PR. It is tracked as #1401; my finding is posted at https://github.com/calebn/sharecut-studio/issues/1401#issuecomment-6160866221. The -150 dB silence-cutoff experiment (`after3`) changed none of the rows.
- I ruled out the whole-track profiles. The remaining suspect is the 16-bit dialogue stems (`pcm_s16le`).

## Still needed

1. **Holdout runs.** These never completed: the first x-variant ASR run deadlocked, and its seed was wrong. The seed is now fixed: x-variants hold the unscaled words.
   - Only `after2-g0-holdout` exists. It used the live-transcribed seed and is not comparable with the x-runs.
   - Run in `~/projects/podcast_mcp-session-state/autopilot-2026-10-12/issue-1443/`:
     ```
     python3 holdout1443.py prep
     python3 holdout1443.py run 2 after2:x-guest-0 before:x-guest-0 after2:x-guest-24 before:x-guest-24 after2:x-guest-12 before:x-guest-12
     ```
   - Then compare: copy `compare1443.py`, pointed at `holdout-corpus/runs-1443/out`, with names `<label>-<variant>-holdout`. Compare x-guest-12 and x-guest-24 against x-guest-0 on each tree, and after2 against before at x-guest-0.
   - Each job takes about 20 minutes. Use `nice`; the harness already does.
   - In a cloud session, the paths and the trees under `trees/` must be recreated:
     - `trees/before` = export of main `5eeed765b` src + `.agents/defaults` + `contracts` + `config`;
     - `trees/after2` = branch src at `d4bb3f07b`, or better, the current head.
2. **PR body.** A draft is at `pr-1443-body.md` here, a copy of the scratch draft. It needs the holdout results filled in at `HOLDOUT_RESULTS`. Then `gh pr edit 1452 --body-file`.
3. **Owner question.** Not posted yet. Post it on PR #1452 with the label `needs-user-input` and a comment starting "**Owner question:**". The question: do we accept 2 to 3 word-level flips on the lab tape at its own level (above: `don't` and `No,` worse, `it's` better)? They come from per-track open levels (voice − 45 dB, not -60 dBFS for every track), and buy gain invariance: the bleed gate survives -24 dB, where main loses every span. A regression the PR caused blocks it under the beta rules, so this needs the owner's call.
4. **Cleanup after the proof is posted.**
   - Delete `ShareCut_Podcast_Test/runs/2026-10-13-issue1443/{keep-*,work-*,audio-*,base-*}` and `holdout-corpus/runs-1443/{audio-*,base-*,work-*}`, keeping `out/`.
   - Update `children.tsv` and `decisions.tsv`.
5. **Final report.** Under 15 lines, per the brief.

Net test count on the 35 changed test files: 1414 → 1303, a change of -111.
