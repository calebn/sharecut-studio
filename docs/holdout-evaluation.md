# Holdout evaluation: breath and onset rules (#1273)

First evaluation slice of #1273: does the breath and word-onset behavior hold on
recordings that did not guide it? Run 2026-10-13 to 2026-10-14 on `origin/main`
at `fe8e143dc8f5f16eaf05d87b714b87ea437ef0b2` with the shipped defaults. A
[second slice](#second-slice-two-more-sessions-from-different-conditions-1273)
adds two more sessions from different conditions. Source
sessions and their development/holdout status are in
[fixture-catalog.md](fixture-catalog.md#source-sessions-provenance-and-developmentholdout-status).

The audio is the owner's own back catalogue. It is private, contains guests'
voices and never leaves the owner's machine. This report holds numbers, commands
and hashes only.

## Verdict

Bounded to three episodes, ten edited listening pairs with owner feedback, two
unscored untouched controls, and the shipped Whisper plus forced-aligner words.

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
6. **Owner feedback reports residual fillers and a mid-breath join concern.**
   The corrected October 15 feedback covers all ten edited pairs. Later owner
   clarification locates L01 near output 2.5 seconds and L09 at the beginning
   of its gap near output 2 seconds. Following-word clipping is not established.
   Overall acceptance and usefulness remain incomplete. The listening does not
   isolate audibility of gain, frame-grid or sample-format changes, so those
   causal links remain inconclusive. No threshold is changed.

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
| `podcast_040`, `podcast_018` | 2020, 2019 | Second slice, see its [provenance](#provenance-of-the-second-slice-sessions) | see there | Holdout |

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

The local pack has 12 items, comprising ten source/output pairs and two untouched
controls from the three sessions. It contains four risky edits, two edits that
vanish when a track is turned down 12 dB, four seeded-random edits and two random
untouched stretches. It was rendered with `podcast play pending-preview` at the
original evaluation SHA. The files have not been regenerated for this correction.

The [corrected October 15 owner feedback](https://github.com/calebn/sharecut-studio/issues/1273#issuecomment-6204646233)
supersedes the earlier four-item summary and L07 speaker-attribution note.
**All ten edited pairs have feedback.** L06 and L10 are untouched controls with
no answers, not missing edited-pair responses. Feedback does not supply every
structured field and does not constitute full-pack acceptance, full-master
approval or merge signoff.

| Item | Explicit answer or owner perception | Separate conservative inference |
| --- | --- | --- |
| L01-111-A | Original clipping/lost-speech answer was yes, with a possible end of "like" heard. Later clarified as residual filler near output 2.5 s. Clipping of the following word is unconfirmed. | None. Do not count this as confirmed following-word clipping. |
| L02-111-A | No clipping/lost speech. | None. |
| L03-111-B | "Sounds good, no bad edits". | No clipping/lost speech. |
| L04-111-C | "Sounds good". | None. |
| L05-111-C | Sounds good, but source and output sounded identical to the owner. | None. File identity is a separate measurement below. |
| L06-111-D | Unanswered untouched control. | None. |
| L07-030-A | No clipping/lost speech, sounds good. Owner confirms Victoria's speech. | None. |
| L08-030-B | Edit sounds good and cuts a breath, but misses the "um" immediately afterward. | Useful edit = yes, qualified by the remaining filler. |
| L09-030-C | Seems to cut mid breath. Later owner clarification places this at the beginning of the gap, near output 2 s. | None. Timing adds no speech-loss verdict or usefulness score. |
| L10-030-D | Unanswered untouched control. | None. |
| L11-016-A | No clipping heard. | None. |
| L12-016-C | Other speaker's voice is preserved, but the beginning of the long "um" remains. | No clipping/lost speech, inferred from the other voice being preserved. Residual filler remains a concern. |

Only the three values in the inference column are inferred structured answers.
Other clipping/lost-speech and usefulness fields remain unknown. Exact defect
timestamps were absent from the October 15 feedback. Later owner clarifications
provide approximate output times for L01 and L09 only. Useful-edit scoring is
incomplete; no aggregate success rate is claimed.

#### Read-only artifact checks on October 16

The saved WAVs, item metadata and original proposal results were inspected locally.
File and decoded-PCM comparisons establish changes to audio, not their perceived
quality. These checks are not a new independent listening verdict.

| Item | Measured or saved evidence | Interpretation and remaining work |
| --- | --- | --- |
| L01 | Saved cut is source 178.225 to 178.520 s, with a 0.350 s replacement gap. Retained audio resumes near output 2.350 s. A 20 ms PCM block at output 2.500 s exactly matches source 178.670 s. | Retained source audio is present near the reported time; the PCM match does not identify the audible residue or prove damage to the following word. Saved ASR labels adjacent "like" tokens, the second with low confidence. Acoustic diagnosis must distinguish a trailing fragment from a repeated-token or alignment error; the mechanism remains unconfirmed. |
| L05 | Source has 214,086 frames and output 208,433 at 44,100 Hz, about 128 ms shorter. Both file hashes and decoded-PCM hashes differ. The source has substantial signal near local 2.0 to 2.7 s; the corresponding output is near the noise floor. | The saved output is not an identical copy or demonstrated no-op. Preserve the owner's perceived similarity separately; usefulness remains unknown. |
| L08 | Saved cut ends at source 2927.590 s. Saved ASR labels "Um" from 2927.390 to 2927.730 s. Replacement gap is 0.799 s. | The owner reports a missed filler. The annotation extends beyond the cut and suggests an ending-boundary investigation, but ASR is not acoustic ground truth. |
| L09 | Saved cut is source 3937.280 to 3938.340 s, with a 0.901 s replacement gap beginning near output 2 s. Saved ASR labels a 20 ms "Um" with low confidence. | The owner locates the mid-breath concern at gap entry. Inspect that boundary acoustically without inferring lost speech from the annotation or timing answer. |
| L12 | Saved cut is source 2621.7655 to 2622.53025 s, with a 0.6500375 s replacement gap. | Diagnose the owner-reported remaining filler acoustically. The existing annotations do not establish its exact location or mechanism. |

Paced replacement gaps explain why some outputs are longer and why L05's net
shortening is much smaller than its cut span. Duration alone does not establish
whether a filler was fully removed.

Local evidence remains in the existing `issue-1273/listen/` pack, including
`answers.csv`, `answers-inference-receipt.md`, `_items-*.json` and each WAV pair.
Original cut bounds and replacement gaps are in `results/r111-ctl.json`,
`results/r030-ctl.json` and `results/r016-ctl.json`; saved ASR is under `asr/`.
The pack builder is `tools/build_listen_1273.py`. Private recordings stay local.

Remaining engineering work is bounded acoustic diagnosis of L01, L08 and L12
residue and L09's gap-entry boundary, followed by routing confirmed defects
through the existing issue/ledger policy. No algorithm defect's root cause is
claimed here. No threshold tuning, production implementation, new corpus work or
new recurring check is part of this correction. Any recording later used to guide
a fix must become development material in the fixture catalog. The existing
coordinator ownership and listening hold remain unchanged.

## Second slice: two more sessions from different conditions (#1273)

The first slice rested on one remote Zoom session, one in-person room recording
and one quiet-guest episode. This slice adds two owner-catalogue episodes that
none of those three are: a 2020 remote call (`podcast_040`) and a 2019 two-mic
recording from one recorder (`podcast_018`). Both are **holdout** and neither
guided any change. Source status is in
[fixture-catalog.md](fixture-catalog.md#source-sessions-provenance-and-developmentholdout-status).
The audio is private and stays on the owner's machine; this section holds
numbers, commands and hashes only.

**Frozen before scoring.** Code is `origin/main` at
`d5380ee7a12f09c85de878167bb703f5ceb34cb2`, the shipped defaults in
[pipeline.yaml](../.agents/defaults/pipeline.yaml), medium intensity, ripple edit
mode. No source file, threshold or test changed in the PR that holds this
section, and no number below was fed back into a threshold. Ran 2026-10-16 to
2026-10-17 on a shared machine (load average 5 to 27, every job at `nice -n 10`).
Only wall times of whole shipped runs and of steps that did not finish are
reported.

### Provenance of the second-slice sessions

Copied read-only from the owner's catalogue; sha256 taken on the copies. Speaker
identity is inferred from file names and conditions from the audio, not from
session notes.

| Episode | Year | Setup | Audio sha256 (the speech tracks) | Condition (inferred) | Status |
| --- | --- | --- | --- | --- | --- |
| `podcast_040` | 2020 | Two mono tracks, 3466.0 s and 3465.3 s: a 24-bit local recorder file (named Host) and a 16-bit Zoom `audio_only` export (named Guest). Host floor -85 dBFS, active in 23% of frames; guest floor -69 dBFS, active in 62%, 1% digital silence; 0.5 s envelope correlation -0.44 | `83e15755647313b179a6aae6a9ed2b7623315fbff3a736754cfd1fb6e76cdeb8`, `53ca4b622997f44c128b410df3ace74d0b9b79280da915d52325130a96f13f00` | Remote, separate sources, the Zoom lane gated | Holdout |
| `podcast_018` | 2019 | Two mono 24-bit raws, equal length 2673.5 s, no digital silence. Floors -56 and -68 dBFS, both active in 55% to 56% of frames, both peak at 0 dBFS; envelope correlation 0.22 | `cb975eb6c371768d0b063a96e15ff165bb1dfa47416752d2bb8c6e1284c7ee18`, `fd5d68dd6559a845eca54e499ceb6f62d1a28eaf15d728adc99de2f3d1a414a7` | Two microphones in one room (inferred from equal length, moderate cross-correlation, no gating) | Holdout |

How they differ from the first slice's three: 111 is a 2024 pair of two Zoom
exports, while 040 (2020) pairs a local recorder file with one Zoom export. 030 is
one room recorder file; if 018 is two mics in one room, as inferred, it has both
bleed and per-lane reads. 016 shares the year and the two-raw layout with 018 but its tracks are
7 dB apart with almost no bleed. 018 has no bounce in the catalogue and 040's
bounces were not copied (they score content cuts, which this slice does not).

### Shipped pipeline

| Episode | Result | Notes |
| --- | --- | --- |
| 040 | Finished, export QC ok with 1 warning (1 zero-length ASR word), 1811 s | 8,888 words. `align_tracks` found both clips near identity and locked them. `fill_gate_holes` ran (guest: 151 holes, 39.4 s filled with comfort noise) and did not crash. |
| 018 | `reconcile_transcript` did not finish. Stopped by hand after 105 minutes in the shipped run and after 70 minutes in a second project | [#1685](https://github.com/calebn/sharecut-studio/issues/1685) (new, `beta:blocker`, J1). ASR itself finished (12,424 words). The stack, after 150 s, is `compute_word_audibility_map` -> `copy_lag_at_timeline` -> `lag_steps_for_lane` -> `measure_lane_lag_steps`: a lane with no lag steps is stored as `None`, and `None` is read as "not measured", so the lane is measured again for every word. |

To continue the 018 evaluation past that step, every 018 and 040 run after ASR
used a wrapper that memoizes `lag_steps_for_lane` for the life of the process
(`podcast_mcp.engines.bleed_audibility_lag`, keyed on the cache set and lane).
The function only reads the caches, so the memo changes time and no value: the
same step on the same 018 project finished in 16 s. This is an evaluation tool,
not part of the repo and not a fix. The 040 shipped run above did not use it.

### Tighten proposals, second slice

Same definition as the first slice: `propose_tighten_edits` after merge, stems,
reconcile and precorrect with the refine and align gates waived, from a seeded
transcript (first ASR with the forced aligner saved once, seeded into every
variant). The 040 transcribe log reports 16 suspect hallucinations and 7 aligned
words with no acoustic evidence, so every 040 variant inherits those words.

| Episode | Proposals | Kinds | With `voiced_edge` | Review required | Skips worth noting |
| --- | --- | --- | --- | --- | --- |
| 040 | 163 | 138 filler, 23 pause, 2 repetition | 52 | 85 | `discourse:like` 518, `acoustic:peer_speaking` 511, `acoustic:breath` 244 |
| 018 | 51 | 51 filler | 7 | 46 | `acoustic:peer_speaking` 326, `discourse:like` 303, `acoustic:kept_voice` 157 |

### Transformed-input checks, second slice

Expected equivalence and tolerance are the first slice's, fixed before the first
run. "Identical" means the same kind on the same track with both edges within
10 ms and the same applied/review state and reason shape. Gain scales the busy
track (040 Guest, 018 Track11) in a 32-bit integer WAV so nothing clips or
requantizes. Reorder swaps the manifest order and the reference speaker. Offset
prepends sample-exact silence to every track and shifts the seeded transcript by
the same amount.

| Episode | Transform | Proposals before | after | identical (10 ms) | moved | moved >30 ms | disappeared | appeared |
|---|---|---|---|---|---|---|---|---|
| 040 | rerun of the same input | 163 | 163 | 162 | 1 | 0 | 0 | 0 |
| 040 | track reorder | 163 | 163 | 161 | 2 | 0 | 0 | 0 |
| 040 | gain 0 dB, 32-bit integer WAV | 163 | 163 | 161 | 2 | 0 | 0 | 0 |
| 040 | gain -12 dB on Guest | 163 | 163 | 163 | 0 | 0 | 0 | 0 |
| 040 | gain -24 dB on Guest | 163 | 163 | 160 | 3 | 0 | 0 | 0 |
| 040 | offset 7.313 s, off the grid | 163 | 165 | 133 | 26 | 10 | 4 | 6 |
| 040 | offset 7.310 s, on the grid | 163 | 163 | 158 | 3 | 1 | 2 | 2 |
| 018 | rerun of the same input | 51 | 51 | 51 | 0 | 0 | 0 | 0 |
| 018 | track reorder | 51 | 51 | 51 | 0 | 0 | 0 | 0 |
| 018 | gain 0 dB, 32-bit integer WAV | 51 | 51 | 51 | 0 | 0 | 0 | 0 |
| 018 | gain -12 dB on Track11 | 51 | 51 | 50 | 1 | 0 | 0 | 0 |
| 018 | gain -24 dB on Track11 | 51 | 51 | 50 | 1 | 0 | 0 | 0 |
| 018 | offset 7.313 s, off the grid | 51 | 50 | 33 | 14 | 6 | 4 | 3 |
| 018 | offset 7.310 s, on the grid | 51 | 50 | 49 | 1 | 1 | 1 | 0 |

What each result shows:

- **Gain (positive on these two, unlike 111 and 016).** Turning the busy track down
  12 or 24 dB removes no proposal on either recording and moves no edge. On 040
  the 2 to 3 "moved" rows are review flag labels that also flip with no level
  change (next bullet). On 018 the one "moved" row at -12 and -24 dB (not at
  0 dB) is a different, small, gain-dependent flag change: the span
  `cut_filler_2241120_2241420` gains the suffix `:other_speaking:track11` in its
  reason when Track11 is turned down. Its edges do not move. The `peer_speaking`
  skip counts are identical across the gain variants. The first slice's loss of 61 and 87 proposals on 111,
  and the quiet-guest inversion on 016, did not reproduce on either new session.
  So the cross-track exposure recorded in [#1443](https://github.com/calebn/sharecut-studio/issues/1443)
  is recording-specific, and these two recordings are not a counterexample to it.
  The 018 flag change is a ledger line for #1443's cross-track reads, not a
  proposal-level failure.
- **Review-flag labels flip on identical or equivalent input (040).** The 8
  "moved" rows in the 040 gain, reorder and rerun checks are a flag label on a
  span whose edges did not move (`acoustic` against `acoustic:possible_word`;
  4 distinct spans). The set, the edges, `applied` and the review state agree. Precision finding for the ledger,
  [#1449](https://github.com/calebn/sharecut-studio/issues/1449).
- **Track order and reruns.** Exact on 018. On 040 the only difference is the flag
  label above.
- **Offset (negative, effect on the ear unknown).** The first slice's grid
  dependence reproduces on both new sessions: the same audio and words, 7.313 s
  later, move 6 of 51 (018) and 10 of 163 (040) edges by more than 30 ms and
  swap 7 and 10 proposals in or out. A whole number of 10 ms frames mostly removes
  it (1 edge over 30 ms on each). Same ledger, #1449.

### Sensitivity check, second slice

The same bounded sweep as the first slice: each of 13 thresholds scaled by 0.8 and
1.2 alone, 26 runs per episode, constants varied inside one process so the repo
is untouched.

**2020 Zoom episode (040), 163 proposals.** 67 of 163 disappeared or moved over
30 ms in at least one of the 26 runs.

| Threshold (shipped) | 0.8x: moved >30 ms / lost / new | 1.2x: moved >30 ms / lost / new |
|---|---|---|
| `burst_db` (12) | 7 / 4 / 1 | 9 / 0 / 4 |
| `rise_db` (6) | 8 / 0 / 1 | 8 / 0 / 0 |
| `burst_floor_under_voice_floor_db` (28) | 1 / 0 / 0 | 1 / 0 / 0 |
| `burst_kind_db` (18) | 0 / 0 / 0 | 0 / 0 / 0 |
| `fall_db` (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `valley_depth_db` (15) | 1 / 0 / 1 | 0 / 2 / 0 |
| `valley_slack_db` (3) | 0 / 1 / 0 | 0 / 0 / 0 |
| `separation_depth_db` (10) | 0 / 0 / 0 | 0 / 0 / 0 |
| `breath_above_floor_db` (9.5) | 1 / 0 / 0 | 0 / 0 / 0 |
| `clear_pitch_peak` (0.55) | 0 / 0 / 0 | 0 / 0 / 1 |
| `sibilant_high_band_fraction` (0.5) | 1 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_quietest_db` (7) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_loudest_db` (40) | 1 / 8 / 2 | 1 / 23 / 8 |

**2019 two-mic recording (018), 51 proposals.** 11 of 51 disappeared or moved over
30 ms in at least one of the 26 runs.

| Threshold (shipped) | 0.8x: moved >30 ms / lost / new | 1.2x: moved >30 ms / lost / new |
|---|---|---|
| `burst_db` (12) | 4 / 1 / 0 | 2 / 0 / 0 |
| `rise_db` (6) | 2 / 0 / 0 | 0 / 0 / 0 |
| `burst_floor_under_voice_floor_db` (28) | 0 / 0 / 0 | 0 / 0 / 0 |
| `burst_kind_db` (18) | 0 / 0 / 0 | 0 / 0 / 0 |
| `fall_db` (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `valley_depth_db` (15) | 0 / 0 / 0 | 0 / 0 / 0 |
| `valley_slack_db` (3) | 0 / 1 / 0 | 0 / 0 / 0 |
| `separation_depth_db` (10) | 0 / 0 / 0 | 0 / 0 / 0 |
| `breath_above_floor_db` (9.5) | 0 / 0 / 0 | 1 / 0 / 0 |
| `clear_pitch_peak` (0.55) | 0 / 0 / 0 | 0 / 0 / 0 |
| `sibilant_high_band_fraction` (0.5) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_quietest_db` (7) | 0 / 0 / 0 | 0 / 0 / 0 |
| `below_speech_loudest_db` (40) | 0 / 1 / 46 | 0 / 0 / 0 |

**Reading.** The contrast thresholds `burst_db` and `rise_db` again move the most
edges, as in the first slice. The new result is `below_speech_loudest_db` (the
upper end of the breath-below-speech range, 40 dB): lowering it 20% adds 46
proposals to 018's 51, and raising it 20% drops 23 of 040's 163 and adds 8. The
first slice saw at most 8 edges move on that constant. It is already relative to
each recording's own speech level, so a per-recording estimate would not replace
it; what the sweep shows is that the number of proposals depends on the 40 dB
choice on these two recordings, and nothing says whether the extra or missing
proposals are good edits. That is a listening question for the pack below, and
**no threshold was tuned against this holdout.**

### Listening pack 2

The local pack has 12 items, comprising ten source/output pairs and two untouched
controls. It was rendered with `podcast play pending-preview` at the frozen SHA
from the 040 and 018 control projects, with the selection seeded by episode so it
can be redrawn. Six items per episode: two risky edits (a plosive or voiced sound
right after the cut, another voice talking in the cut, or a join review), three
seeded-random plain edits and one random untouched stretch. No item is of the
"vanishes at -12 dB" kind because no proposal vanished in the gain test.

| Item | Episode | Kind | What the edit is | Risk to hear |
| --- | --- | --- | --- | --- |
| H01 | 018 | risky | filler `like` while the other mic talks (`other_speaking`) | other voice lost, clipped end of the word before |
| H02 | 018 | risky | filler `like` at a sentence start, other mic talking | clipped onset of the next word (it starts at the cut end) |
| H03 | 018 | random | filler `you know` plus 0.5 s of silence | clipped `b` of the next word (starts 5 ms after the cut) |
| H04 | 018 | random | long `um` (0.86 s) | none expected; join and residue |
| H05 | 018 | random | short `um` inside a 1.3 s trim | onset of the next word (0.1 s after) |
| H06 | 018 | control | no edit, 8 s | a miss: um, pause or breath left in |
| H07 | 040 | risky | filler `um` with `voiced_edge` | clipped `b` of the next word (starts 20 ms before the cut end) |
| H08 | 040 | risky | 0.4 s out of a 13.9 s silence, `join_review` | click or room-tone jump at the join |
| H09 | 040 | random | filler `like`, 70 ms and 120 ms from its neighbours | clipped ends of both neighbours |
| H10 | 040 | random | 1.0 s out of an 8.6 s pause while the other speaker says `um` | the other speaker's `um` cut by 0.35 s |
| H11 | 040 | random | 0.5 s out of a 14.9 s pause | click at the join |
| H12 | 040 | control | no edit, 8 s | a miss |

**Heard by the owner.** The questions per item were the same as the first pack:
clipped word or lost speech (separate from taste), and whether the edit was
useful, so doing nothing cannot win by default. The pack, its README and
`answers.csv` are local: `holdout-1273b/work/listen/`.

| Items | Clipped word or lost speech | Useful edit |
| --- | --- | --- |
| H01 to H05 (018), H07 to H11 (040): 10 edited pairs | no on all 10 | yes on 9; no on H01 |
| H06 (018), H12 (040): untouched controls | not applicable | leaving them uncut is fine |

H01 is a taste finding, not a clipping defect: the cut filler `like` was spoken
with a laugh, the laugh carries the tone, and the edit sounds odd without it.
It is filed as [#1691](https://github.com/calebn/sharecut-studio/issues/1691).
For H06 the owner thought a later processing step would probably cut something
there, so it did not need to be caught at this position.

### Bounded verdict

Bounded to two more recordings, ten edited pairs and two controls heard, and the
shipped Whisper plus forced-aligner words.

1. **The rules run on one of the two new recordings.** The full shipped pipeline
   finished on the 2020 remote call. On the 2019 two-mic recording it stopped at
   `reconcile_transcript` ([#1685](https://github.com/calebn/sharecut-studio/issues/1685),
   outside the breath and onset rules, in the J1 path).
2. **Gain invariance held on both (positive; does not retire the exposure recorded in #1443).** No proposal
   was lost and no edge moved when the busy track dropped 12 or 24 dB.
   The failure on the first slice's 111 and 016 is therefore recording-specific.
3. **Edge placement still depends on the 10 ms frame grid (negative, effect on the
   ear unknown).** Reproduced on both: 6 of 51 and 10 of 163 edges move over 30 ms
   for the same audio and words 7.313 s later.
4. **Reruns and track order are stable in edges and set (positive); a review flag
   label flips on a few borderline spans (040, precision).**
5. **Threshold sensitivity is small except for one constant.** 11 of 51 and 67 of
   163 proposals changed in at least one of 26 runs. `below_speech_loudest_db`
   alone adds 46 (018, 0.8x) or drops 23 (040, 1.2x). This is not a defect call.
6. **Listening (10 edited pairs heard): 0 of 10 clipped a word or lost speech,
   9 of 10 were useful edits, and 1 is a taste finding** (H01, a filler spoken
   with a laugh, [#1691](https://github.com/calebn/sharecut-studio/issues/1691)).
   The sample is small. No success rate beyond these counts is claimed, and the
   measured differences in points 2 to 5 are not called audible defects on this
   evidence. No threshold was tuned. The stall on 018 in point 1 is a separate
   blocker; its fix is in PR #1689, under verification.

Not covered: native 48 kHz audio, three or more speakers, non-English speech, a
run without the forced aligner, live ASR under the transformed inputs, a shipped
pipeline run past `reconcile_transcript` on 018, and any claim of statistical
assurance. Twelve examples are a practical budget.

Together with the first slice this is five owner-catalogue recordings. Any
recording later used to guide a fix becomes development material in the fixture
catalog in the same PR.

## Defects and where they went

| Finding | Reachable on a real recording | Where |
| --- | --- | --- |
| `fill_gate_holes` crash on a Zoom per-participant export | yes, default pipeline fails | [#1451](https://github.com/calebn/sharecut-studio/issues/1451) (new, `beta:blocker`, J1) |
| Quiet-guest verdict inversion (-12 dB) and per-lane peer reads | yes, real recording | evidence on [#1376](https://github.com/calebn/sharecut-studio/issues/1376) |
| Bleed gate plans 0 spans on the quieter lane as recorded | yes, real recording | evidence on [#1374](https://github.com/calebn/sharecut-studio/issues/1374) |
| Tighten proposals not gain invariant on two tracks | yes, real recording | ledger of [#1443](https://github.com/calebn/sharecut-studio/issues/1443) |
| Frame-grid phase and sample-format dependence of edges | effect on the ear unknown | ledger of [#1449](https://github.com/calebn/sharecut-studio/issues/1449) |
| Residual filler in L01, L08 and L12; mid-breath gap entry in L09 | owner-reported concerns on real recordings; following-word clipping and speech loss are not established by these concerns | evidence and bounded diagnosis remain on [#1273](https://github.com/calebn/sharecut-studio/issues/1273) |
| `reconcile_transcript` re-measures lane lag steps per word and does not finish on a two-mic recording (podcast_018, over 105 minutes) | yes, default pipeline stalls | [#1685](https://github.com/calebn/sharecut-studio/issues/1685) (new, `beta:blocker`, J1) |
| Review-flag label flips (`acoustic` against `acoustic:possible_word`) on borderline spans of identical input, and the frame-grid offset effect reproduced on two more sessions | precision, effect on the ear unknown | ledger of [#1449](https://github.com/calebn/sharecut-studio/issues/1449) |

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
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.services.app import ProjectWorkspace

project = ProjectWorkspace.open(path).project.model_copy(deep=True)
proposal = propose_tighten_edits(project, load_defaults())
rows = sorted(
    (
        {
            "track": d.track_id,
            "kind": (d.reason or "").split(":")[0],
            "start": d.start,
            "end": d.end,
            "applied": d.applied,
            "review": d.review_required,
            "reason": d.reason,
        }
        for d in proposal.decisions
    ),
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

### Second-slice commands

The second slice reuses the commands and the driver above unchanged. The copy
folder is `holdout-1273b/` (two episodes, sha256 in the provenance table). Each
episode: `podcast pipeline run --unattended` once for ASR (the first ASR words are
saved and seeded into every variant), then the seeded control, the variants
(`ffmpeg -af volume=-12dB` and `-24dB` with `-c:a pcm_s32le`; `adelay=322503S:all=1`
for 7.313 s and `adelay=322371S:all=1` for 7.310 s, both sample-exact; the manifest
with the speakers in the other order) and the 26-run sweep with `holdout_eval.py
propose --patch`. The pack uses the same builder as the first pack with a seeded
draw per episode (`A=2,C=3,D=1`), rendering `podcast play pending-preview` for
`--mode current` and `--mode suggested` and `podcast play compose` for the
untouched stretch. The memo wrapper described under
[Shipped pipeline](#shipped-pipeline) is the only difference from the CLI: it
patches `podcast_mcp.engines.bleed_audibility_lag.lag_steps_for_lane` to cache its
result per process and then calls the normal CLI entry point.
