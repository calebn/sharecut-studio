# Holdout evaluation: breath and onset rules (#1273)

First evaluation slice of #1273: does the breath and word-onset behavior hold on
recordings that did not guide it? Run 2026-10-13 to 2026-10-14 on `origin/main`
at `fe8e143dc8f5f16eaf05d87b714b87ea437ef0b2` with the shipped defaults. Source
sessions and their development/holdout status are in
[fixture-catalog.md](fixture-catalog.md#source-sessions-provenance-and-developmentholdout-status).

The audio is the owner's own back catalogue. It is private, contains guests'
voices and never leaves the owner's machine. This report holds numbers, commands
and hashes only.

## Verdict

Bounded to three episodes, ten listening pairs not yet heard, and the shipped
Whisper plus forced-aligner words.

1. **The rules run on three unseen recordings.** The pipeline finished on a 2020
   in-person room recording and a 2019 quiet-guest episode. On a 2024 Zoom
   per-participant episode it stopped at `fill_gate_holes` ([#1451](https://github.com/calebn/sharecut-studio/issues/1451),
   a crash outside the breath and onset rules).
2. **Tighten proposals are not gain invariant on two-track recordings at the
   pipeline's tighten position (negative).** Turning one of two tracks down 12 dB
   removes 61 of 207 proposals on the 2024 Zoom episode; 24 dB removes 87. The
   same test on the single-track in-person recording loses 3 of 247 at both gains
   with no edge moving. On a finished project (after `balance_tracks` has set
   each track's gain) the 2024 test is invariant, so the exposure is the
   pipeline's own tighten step, which runs before balance. On the 2019 quiet-guest
   episode the reconcile verdict inverts at -12 dB (the guest's own words become
   bleed). The cause is in cross-track reads, not in the breath thresholds:
   scaling those by +/-20% moves at most 9 of 207 edges.
3. **Edge placement depends on the 10 ms frame grid and on the WAV sample format
   (negative, effect on the ear unknown).** A 7.313 s offset moves 49 of 207 edges
   (27 by more than 30 ms) with the same words; 7.310 s moves 4. A 32-bit float
   copy of the same audio moves 68 of 207, a 32-bit integer copy none.
4. **Track order and reruns are exactly stable (positive).**
5. **Threshold sensitivity is small and concentrated.** Across 26 one-at-a-time
   +/-20% changes, 57 of 207 proposals on the 2024 episode and 27 of 247 on the
   room recording changed in at least one (a proposal disappeared or an edge moved
   over 30 ms). Most come from the 12 dB burst-onset contrast
   (`word_onset._BURST_DB`) and the 6 dB rise, not from the breath level offsets.
6. **Listening is partial (4 of 12 items, 2026-10-15).** The owner heard L01,
   L02, L07, and L11 from the local pack. L01 (podcast_111) reports clipped or
   lost speech (possible residual end of “like”; the following word is not
   established). L02, L07, and L11 report no clipping or lost speech. L07 is the
   room-mic `filler:acoustic:join_review` sample; its metadata does not attribute
   the speech to Victoria. Usefulness and exact defect timestamps were not
   answered; eight items remain unheard. No threshold was changed. Until the
   rest of the pack is heard, frame-grid and sample-format differences stay
   precision findings ([#1449](https://github.com/calebn/sharecut-studio/issues/1449)),
   not listening-confirmed defects.

Not covered: native 48 kHz audio, the three-speaker episode (`podcast_073`, held
back), non-English speech, a run without the forced word aligner, live ASR under
the transformed inputs (every variant reuses one seeded transcript), and any
claim of statistical assurance. Twelve listening examples are a practical budget.

## Where each result belongs

| Class | What | Section |
| --- | --- | --- |
| Lab regressions | Committed Lab fixtures and the synthetic gain-invariance tests, on current main | [Lab regressions](#lab-regressions) |
| Transformed-input checks | Gain, offset, reorder and sample-format variants of the same session | [Transformed-input checks](#transformed-input-checks) |
| Independent-session results | The shipped pipeline on the holdout sessions, the sensitivity sweep, the listening pack | [Independent-session results](#independent-session-results) |

One session, however many variants, counts once. The transformed-input checks
use the independent sessions as inputs, so they are not three more recordings.

## Provenance

Copied read-only from the owner's catalogue, sha256 verified on the source after
copying. Speaker identity per file is inferred from file names. Conditions
(in person versus remote) are inferred from envelope correlation, not session notes.

| Episode | Year | Setup | Audio sha256 (the speech tracks) | Status |
| --- | --- | --- | --- | --- |
| `podcast_111` | 2024 | Two mono 16-bit Zoom exports, 2128.2 s, one gated to digital silence (27% active) | `fd9f06d5dbe8db1358ff0f7b1024f769b9e7e74469b77cfffa540fad3a349e66`, `c2e353f783176ee4cf09727846d0ae3ea5bc31f15c0f24bc327d69e7621da274` | Holdout |
| `podcast_030` | 2020 | One 16-bit stereo room-recorder file, 4047.0 s, floor near -52 dBFS, channel correlation 0.86 | `991437ca3df1f0b1787f50507aef33cd332fa558e64ae5a05dc06048cd8add04` | Holdout |
| `podcast_016` | 2019 | Two mono 24-bit raws, 3550.5 s, guest mic about 7 dB under the host | `4052b63da2feba029b40a9cfa94413286f1753d94a80a16fc97f98badc15d2e5`, `354d70e24782df87799048d07befa77733b209a9dbb1f23533a26292f42838b7` | Holdout |
| `podcast_073` | 2021 | Three hot gated bounces, already edited | not run | Holdout, reserved |

The owner's `rough_cut.mp3` and `full_episode.mp3` bounces for each episode were
copied but not used here: they are ground truth for content cuts and levels, not
for filler removal, and this slice scores no content cuts.

Licensing gate: the owner holds the rights to the whole catalogue, so the
public-corpus licence check (Open Yap, AMI, DiPCo) is not needed for this slice.
Nothing is committed, uploaded or pasted. Every project below was built from a
copy in a scratch folder and is deleted after use.

Rule for later: an episode that guides a fix becomes development material in
[fixture-catalog.md](fixture-catalog.md#source-sessions-provenance-and-developmentholdout-status)
in the same PR. This slice changed no threshold, so all three stay holdout. The
sweep and the gain tests read these recordings as evidence, never as a tuning target.

## Method

- **Code.** `origin/main` at `fe8e143dc8f5f16eaf05d87b714b87ea437ef0b2`, a worktree
  with `make worktree-setup`. faster-whisper 1.2.1, `large-v3-turbo`, FFmpeg 9.0.2,
  macOS arm64 on a shared machine (load average 10 to 70 during the runs, every job
  at `nice -n 10`). No timing is reported.
- **Shipped pipeline.** `podcast pipeline run --unattended` with the shipped
  defaults ([pipeline.yaml](../.agents/defaults/pipeline.yaml)): ingest, ASR with the
  forced aligner, align, merge, stems, reconcile (bleed), precorrect, prosody, FX,
  balance, master, export. `tighten.enabled` is false by default, so tighten
  proposals come from `propose-edits` (below).
- **Tighten proposals.** `propose_tighten_edits` at the pipeline's own tighten
  position: after `merge_transcript`, `render_dialogue_stems`,
  `reconcile_transcript` and `precorrect_transcript`, with the refine and align
  gates waived. Medium intensity, ripple edit mode, shipped defaults. A "proposal"
  is one pending decision (kind, track, source start and end, review flags).
  Comparisons match proposals of the same kind on the same track by overlap.
- **Seeded transcript.** The first ASR of each episode (with the pipeline's forced
  aligner) is saved once and seeded into every variant (`podcast fixture
  seed-transcript`), so a variant differs from its control only in the audio.
  Each variant clones the freshly ingested, seeded project, transforms `raw/`,
  then runs the same four prep steps and the same proposal.
- **Transforms.** Expected equivalence and tolerance were fixed before the first
  run of each, except the format controls, which were added after the first float
  copy moved edges.

| Transform | How | Expected | Tolerance |
| --- | --- | --- | --- |
| Rerun | the same input twice | identical | exact |
| Track reorder | manifest speakers in the other order, other reference | identical set and edges | exact |
| Format control | the raw WAV re-encoded at 0 dB as 32-bit integer and as 32-bit float | identical | exact |
| Gain | one track scaled by -12 and -24 dB (`ffmpeg -af volume`, 32-bit integer WAV, so nothing clips and nothing is re-quantized); the other track untouched | the same proposals with edges inside one 10 ms frame, because every level is read against the track's own floor and speech level (the #1443 decision) | same set; edges within 10 ms |
| Offset | silence prepended to every track (sample-exact), transcript shifted by the same amount; 7.313 s (off the 10 ms grid) and 7.310 s (on it) | the same proposals, every edge shifted by the offset | same set; edges within 10 ms after removing the offset |

Gain and offset for the room recording act on its only track. Reorder does not
apply to a single track.

## Lab regressions

`pytest tests/test_lab_bleed_fixtures.py tests/test_lab_tighten_fixtures.py
tests/test_tighten_gain_invariance.py` on `fe8e143dc` (shared machine, load average
17 to 40): the first run, 2026-10-14 01:37 to 01:52 UTC, gave 49 passed, 6 failed
and 3 errors, every one a timeout (the 60 s per-test limit, and a 10 s
`ffprobe -version` probe), not an assertion. The same three files rerun with
`--timeout=900` from 03:43 to 03:52 UTC: 58 passed. **No Lab regression.**
The synthetic gain-invariance contract passes while a real two-track recording
fails the same property at the pipeline's tighten position (see below). Its
scenarios did not reach that case, and widening them belongs to #1443.

## Transformed-input checks

All proposals at the pipeline's tighten position; "before" is the unmodified
control, "after" is the variant. Edges within 10 ms count as identical.

| Episode | Transform | Proposals before | after | identical (10 ms) | edge moved | moved >30 ms | disappeared | appeared |
|---|---|---|---|---|---|---|---|---|
| 111 | rerun of the same input | 207 | 207 | 207 | 0 | 0 | 0 | 0 |
| 111 | track reorder (order and reference swapped) | 207 | 207 | 207 | 0 | 0 | 0 | 0 |
| 111 | gain 0 dB, 32-bit integer WAV | 207 | 207 | 207 | 0 | 0 | 0 | 0 |
| 111 | gain 0 dB, 32-bit float WAV | 207 | 207 | 139 | 68 | 12 | 0 | 0 |
| 111 | gain -12 dB on the busy track | 207 | 146 | 144 | 2 | 1 | 61 | 0 |
| 111 | gain -24 dB on the busy track | 207 | 121 | 119 | 1 | 0 | 87 | 1 |
| 111 | offset 7.313 s, off the grid | 207 | 207 | 153 | 49 | 27 | 5 | 5 |
| 111 | offset 7.310 s, on the grid | 207 | 208 | 203 | 4 | 4 | 0 | 1 |
| 111, finished project | gain -12 dB on the busy track, full shipped pipeline run before the proposal | 145 | 146 | 144 | 0 | 0 | 1 | 2 |
| 030 | gain 0 dB, 32-bit integer WAV | 247 | 247 | 247 | 0 | 0 | 0 | 0 |
| 030 | gain -12 dB | 247 | 244 | 244 | 0 | 0 | 3 | 0 |
| 030 | gain -24 dB | 247 | 244 | 244 | 0 | 0 | 3 | 0 |
| 030 | offset 7.313 s, off the grid | 247 | 250 | 181 | 61 | 38 | 5 | 8 |
| 016 | gain -12 dB on the quiet guest | 88 | 117 | 68 | 8 | 3 | 12 | 41 |
| 016 | gain -24 dB on the quiet guest | 88 | 137 | 58 | 5 | 3 | 25 | 74 |

What each failed expectation looks like:

- **Gain, two tracks (111).** The `breath` rejection count rises from 39 to 102
  (-12 dB) and 125 (-24 dB). All 61 lost proposals at -12 dB are on the scaled
  track, 57 of them an "um". `protect_cut_breaths` returns the same answer for
  every call that both runs make; the difference is which candidates reach it, so
  the dependence is upstream,
  probably in the cross-track scope read (`peer_speaking` skips also change). That
  is inferred, not proven. The "finished project" row explains where it stops:
  after the full pipeline `balance_tracks` has set each track's `gain_db` (the
  scaled track gets about 10 dB more), the proposal count is 145 with 106 `breath`
  rejections for the control and 146 with 105 for the scaled copy. Compared with
  the 207 at the pipeline's tighten position, 65 proposals are gone in both. So the
  level-dependent step is the one that runs before balance, which is exactly where
  the pipeline's own tighten (when enabled, #1434) sits. Filed on the lab epic's
  ledger, [#1443](https://github.com/calebn/sharecut-studio/issues/1443). Items L03
  and L08 in the listening pack are proposals that vanish in this way, for the owner
  to judge whether they were good edits.
- **Gain, one track (030).** Three proposals (one "um" with `voiced_edge`, two plain
  "um") drop at both -12 and -24 dB, so it is a step, not a slope, and no edge moves.
  Within tolerance except for those three.
- **Gain, quiet guest (016).** With the guest 12 dB lower the reconcile verdict
  inverts: 7,329 of the guest's 8,289 words are flagged `bleed` (3,217 as recorded)
  and 553 of the host's 9,302 (4,680 as recorded). At -24 dB: 8,004 and 239. The
  `peer_speaking` skip count falls from 205 to 5, which is why 74 new proposals
  appear. Evidence added to [#1376](https://github.com/calebn/sharecut-studio/issues/1376).
  `apply-bleed-mute --dry-run` plans 1,075 spans on the host lane and 0 on the guest
  lane as recorded, 592 and 0 at -12 dB, 0 and 0 at -24 dB. Evidence added to
  [#1374](https://github.com/calebn/sharecut-studio/issues/1374).
- **Offset.** The same audio and words give different edges when the file starts at
  a different phase of the 10 ms analysis grid. Moving by a whole number of frames
  mostly removes it (4 moved, 1 new pause). Whether a 30 ms move matters to a
  listener is a listening question. Precision finding on the ledger,
  [#1449](https://github.com/calebn/sharecut-studio/issues/1449).
- **Sample format.** A 32-bit float WAV is read by a different path than integer
  WAVs. Same ledger.

Also seen on the way, not explained: the finished project from the original
2024 pipeline run (which was re-run twice after the #1451 crash) gives 189
proposals with 136 `breath` rejections, while a finished project built from the
seeded transcript gives 145 and 106. Both differ from the 207 at the tighten
position. The two finished projects differ in history and reconcile state, not in
audio or words, so treat the exact finished-project counts as soft.

## Independent-session results

### Shipped pipeline on the holdout sessions

| Episode | Result | Wall time | Notes |
| --- | --- | --- | --- |
| 111 (2024 Zoom, 2 tracks) | Stopped at `fill_gate_holes` with `cannot reshape array of size 0`; `--skip fill_gate_holes` then finished, export QC ok | 1054 s to the crash | [#1451](https://github.com/calebn/sharecut-studio/issues/1451): 48 of 60 gate closures on the gated track have under 5 ms of audio before them. 5,411 words; `align_tracks` found two clips near identity and locked them. |
| 030 (2020 room, 1 track) | Finished, export QC ok with 1 warning (13 zero-length ASR words) | 2316 s | `align_tracks` skipped (one clip). 11,473 words, 96 inaudible. |
| 016 (2019, 2 tracks) | Finished, export QC ok with 2 warnings | 4853 s | 17,591 words. After the final reconcile 7,611 (43%) are flagged bleed: 4,964 of the host lane and 2,647 of the guest lane. A level spot check (300 random flagged words per lane) puts flagged host-lane words about 8 dB under the guest mic at the same moment and flagged guest-lane words about 28 dB under the host mic, so the flags look plausible; the corpus note's "almost no bleed" came from a 0.5 s envelope correlation of 0.03 and was too strong. |

### Tighten proposals at the pipeline position

| Episode | Proposals | Kinds | With `voiced_edge` | Review required | Skips worth noting |
| --- | --- | --- | --- | --- | --- |
| 111 | 207 | 187 filler, 20 pause | 115 | 120 | `discourse:like` 209, `acoustic:kept_voice` 264, `breath` 39 |
| 030 | 247 | 243 filler, 3 repetition, 1 restart | 127 | 136 | `discourse:like` 246, `acoustic:breath` 235, `acoustic:kept_voice` 180 |
| 016 | 88 | 69 filler, 19 pause | 5 | 76 | `acoustic:peer_speaking` 205, `discourse:like` 399, `backchannel:mm hmm` 69 |

### Sensitivity check

Each of 13 thresholds was scaled by 0.8 and 1.2 alone, everything else at the
shipped value, and the same proposal was re-run: 26 runs per episode. The
thresholds are module constants in `edits/word_onset.py` (valley depth, separation
depth, valley slack, fall, rise, burst, burst kind, burst floor under voice floor),
`edits/breath_detect.py` (clear pitch peak, breath above floor, sibilant fraction)
and the breath-below-speech pair (7 dB quietest, 40 dB loudest) in the four
modules that read it. The constants were varied inside one process, so a sweep
needs no code change and the repo is untouched. A canary run with five of the
"no change" constants pushed to extreme values did change 7 edges, so the patching
reaches them and "no change" means this recording is not sensitive to them.

**2024 Zoom episode (111), 207 proposals.** Cells are proposals whose edge moved by more than 30 ms / proposals that disappeared / new ones. 57 of 207 changed in at least one of the 26 runs.

| Threshold (shipped) | 0.8x: moved >30 ms / lost / new | 1.2x: moved >30 ms / lost / new |
|---|---|---|
| `burst_db` (12) | 23 / 0 / 2 | 19 / 2 / 0 |
| `rise_db` (6) | 6 / 0 / 1 | 2 / 0 / 0 |
| `burst_floor_under_voice_floor_db` (28) | 1 / 0 / 0 | 2 / 0 / 0 |
| `burst_kind_db` (18) | 0 / 0 / 0 | 0 / 0 / 0 |
| `fall_db` (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `valley_depth_db` (15) | 0 / 0 / 0 | 1 / 0 / 0 |
| `valley_slack_db` (3) | 0 / 1 / 0 | 0 / 0 / 0 |
| `separation_depth_db` (10) | 0 / 0 / 0 | 0 / 0 / 0 |
| `breath_above_floor_db` (9.5) | 0 / 0 / 0 | 1 / 0 / 0 |
| `clear_pitch_peak` (0.55) | 3 / 0 / 0 | 2 / 0 / 0 |
| `sibilant_high_band_fraction` (0.5) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_quietest_db` (7) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_loudest_db` (40) | 8 / 0 / 0 | 4 / 1 / 1 |

**2020 room recording (030), 247 proposals.** 27 of 247 changed in at least one of the 26 runs.

| Threshold (shipped) | 0.8x: moved >30 ms / lost / new | 1.2x: moved >30 ms / lost / new |
|---|---|---|
| `burst_db` (12) | 5 / 1 / 1 | 9 / 1 / 0 |
| `rise_db` (6) | 8 / 0 / 1 | 1 / 0 / 0 |
| `burst_floor_under_voice_floor_db` (28) | 0 / 0 / 0 | 0 / 0 / 0 |
| `burst_kind_db` (18) | 0 / 0 / 0 | 0 / 0 / 0 |
| `fall_db` (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `valley_depth_db` (15) | 2 / 0 / 1 | 0 / 0 / 0 |
| `valley_slack_db` (3) | 0 / 0 / 0 | 0 / 0 / 1 |
| `separation_depth_db` (10) | 0 / 0 / 0 | 0 / 0 / 0 |
| `breath_above_floor_db` (9.5) | 0 / 0 / 0 | 0 / 3 / 0 |
| `clear_pitch_peak` (0.55) | 0 / 0 / 0 | 0 / 0 / 0 |
| `sibilant_high_band_fraction` (0.5) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_quietest_db` (7) | 0 / 0 / 0 | 0 / 1 / 0 |
| `below_speech_loudest_db` (40) | 0 / 0 / 0 | 0 / 0 / 0 |

**Reading.** The breath level offsets (`breath_above_floor`, the below-speech pair,
`clear_pitch_peak`, `sibilant_high_band_fraction`) move few edges. The one visible
breath effect: raising `breath_above_floor_db` by 20% drops three plain "um"
proposals on the room recording, the same count the gain test drops there, so
those are the borderline breath-or-um calls. The most
sensitive constants are `_BURST_DB` and `_RISE_DB`, the dB jumps that classify a
word onset as a plosive burst or a rise. They are contrast rules, not levels, so a
per-recording speech or noise estimate would not replace them. The levels the
breath rules do use (floor, speech) already come from the track's own flanking
audio, and the gain tests above found the level dependence in the cross-track
reads instead. The sweep therefore gives no case for swapping a Lab constant for a
per-recording estimate in the breath path, and no basis for a new threshold.
**No threshold was tuned against this holdout.**

### Listening pack

Staged for the owner, local only: 12 items (10 source/output pairs, 2 untouched
regions) from the three sessions, drawn as 4 risky edits, 2 edits that vanish
when a track is turned down 12 dB, 4 seeded-random edits and 2 random untouched
stretches. It is rendered with `podcast play pending-preview` from the same code
SHA. The owner's question is on #1273 (`needs-user-input`). Clipped words or lost
speech are recorded apart from taste, and useful edits are counted so doing
nothing cannot win. **Owner verdict (partial, 2026-10-15):** 4 of 12 items
answered in `answers.csv` (L01 clipped/lost speech yes; L02, L07, L11 no). Eight
items pending; audio local only.

## Defects and where they went

| Finding | Reachable on a real recording | Where |
| --- | --- | --- |
| `fill_gate_holes` crash on a Zoom per-participant export | yes, default pipeline fails | [#1451](https://github.com/calebn/sharecut-studio/issues/1451) (new, `beta:blocker`, J1) |
| Quiet-guest verdict inversion (-12 dB) and per-lane peer reads | yes, real recording | evidence on [#1376](https://github.com/calebn/sharecut-studio/issues/1376) |
| Bleed gate plans 0 spans on the quieter lane as recorded | yes, real recording | evidence on [#1374](https://github.com/calebn/sharecut-studio/issues/1374) |
| Tighten proposals not gain invariant on two tracks | yes, real recording | ledger of [#1443](https://github.com/calebn/sharecut-studio/issues/1443) |
| Frame-grid phase and sample-format dependence of edges | effect on the ear unknown | ledger of [#1449](https://github.com/calebn/sharecut-studio/issues/1449) |
| L01-111-A: owner reports clipped or lost speech on one risky edit | one holdout item; attribution uncertain | follow-up after the remaining eight listens; no threshold change in this slice |

## Commands

`$H` is the holdout copy folder (`recreate.sh` rebuilds it from the owner's
catalogue), `$R` a scratch project folder, `$P` `$R/episode.project.json`. All
run with `nice -n 10`. The ingest manifest lists each file once per speaker with
`session_start_in_file_sec: 0` and `session_offset_sec: 0` (locked Zoom or
same-recorder tracks).

```sh
# ASR once, and the shipped pipeline (timestamps in the logs)
podcast episode init --dir $R --name holdout
podcast ingest consolidate --audio-dir $H/podcast_111 --manifest ingest.yaml --project $P
podcast pipeline run --project $P --unattended                          # 111 stops at fill_gate_holes (#1451)
podcast pipeline run --project $P --unattended --from analyze_prosody --skip fill_gate_holes

# One variant: clone the seeded ingest, transform raw/, prep, propose
podcast fixture seed-transcript --project $P --from seed.json           # words from the first ASR
ffmpeg -i $R/raw/<track>.wav -af volume=-12dB -c:a pcm_s32le out.wav   # gain; offset uses adelay=322503S:all=1
for s in merge_transcript render_dialogue_stems reconcile_transcript precorrect_transcript; do
  podcast pipeline run --project $P --only $s; done
podcast transcript refine-waive --project $P --reason holdout
podcast align waive --project $P --reason holdout
python holdout_eval.py propose $P out.json                              # driver below
python holdout_eval.py diff base.json out.json --shift-b <offset-sec>

# Sensitivity: the same propose with patched constants
python holdout_eval.py propose $P out.json --patch podcast_mcp.edits.word_onset._BURST_DB=9.6

# Bleed gate, one lane at a time
podcast edit apply-bleed-mute --project $P --track <id> --dry-run

# Listening pack items
podcast propose-edits --project $P
podcast play pending-preview --project $P --edit-id <id> --mode current --padding 2 --dry-run
podcast play pending-preview --project $P --edit-id <id> --mode suggested --padding 2 --dry-run
```

The driver is an unmodified wrapper over `propose_tighten_edits`; it is not part
of the repo and adds no CI check. Its core:

```python
from podcast_mcp.config import load_defaults
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.services.app import ProjectWorkspace

project = ProjectWorkspace.open(path).project.model_copy(deep=True)
proposal = propose_tighten_edits(project, load_defaults())
rows = sorted(
    ({"track": d.track_id, "kind": (d.reason or "").split(":")[0], "start": d.start, "end": d.end,
      "applied": d.applied, "review": d.review_required, "reason": d.reason}
     for d in proposal.decisions),
    key=lambda r: (r["track"], r["start"]),
)
# Patches: setattr(importlib.import_module(module), name, value) before the call
# (the proposal pool is threads, so the patch reaches every worker).
# Diff: greedy match by overlap on the same track and kind; identical when both
# edges are within 10 ms after subtracting the offset and (applied, review, reason
# with numbers removed) agree.
```

No recurring check is added. This corpus work is on-demand and stays out of
per-PR CI, per [contributing.md](contributing.md#choose-recurring-tests-deliberately);
a cheap permanent case for the two-track gain failure is #1443's call, with a
synthetic scene.
