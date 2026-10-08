# Filler and pause cut quality

## Default pipeline status

**`tighten.enabled` defaults to `false`.** `analyze_fillers_pauses` /
`tighten_from_transcript` skip in the pipeline until re-enabled. Manual
`propose-edits` / `apply-edits` still work for experiments.

**Why:** On real dialogue (e.g. Shot of Truth — Eladio), auto-tighten applied
~150 cuts (~80% `filler:like`). Selection treated fluent / quotative / comparative
“like” as fillers, but the deeper failure was **edit location**: flow from the
previous kept word to the next almost never sounded continuous (wrong bounds,
leftover L/K onsets, slammed or hollow joins). Leaving fillers in was the better
baseline. Discourse markers (`like`, `you know`, `sort of`, `kind of`) now stay
in the lexicon and become candidates only with a true disfluency/repeat, a pause
bound, or low ASR confidence — see **Discourse-safe selection** below. Join
quality is still the re-enable gate.

**Re-enable only when** (in order):

1. **Join continuity** — blind A/Bs prefer edit vs leave-in for ≥90% of gated-pass cuts; zero leftover-consonant / click fails (`join_quality` / `join_qa_sweep`, `tighten.join_continuity_gate`, golden-ear harness). The harness scores rendered pending previews, whose Suggested side is the edit approved on a snapshot.
2. **Selection** — discourse `like` excluded or rare on a like-heavy fixture
   (`tighten.discourse_markers` + skip counts `discourse:{token}`).
3. **Density** — episode does not feel edited every breath.

Auto-tighten (`analyze_fillers_and_pauses` → `apply_auto_edits`) uses waveform-verified boundaries, per-cut fade sizing, risk gating, **perceptual join-continuity gating** (`tighten.join_continuity_gate`), and optional breath co-removal so filler/pause edits stay inaudible when possible.

Implementation: `edits/fillers.py`, `edits/cut_quality.py`, `edits/join_continuity.py`, `edits/breath_detect.py`. Defaults: `.agents/defaults/pipeline.yaml` → `tighten`, `join_continuity`, `inaudible_cuts`, `render`.

## Policy

- **Repetition and restart proposals** (off at `light` / `tighten.repetition_candidates: false`) — Tighten detects same-track, timestamp-adjacent exact word repeats (`repetition:word:*`), repeated prefixes up to four words (`restart:phrase:*`), and only explicitly marked partial-word cut-offs (`stor- store`, `restart:partial:*`). Split repairs remove the repeated prefix and partial together (`I w- I went` removes `I w-`, retaining `I went`). The detector uses a bounded 0.45 s gap by default (`tighten.repeat_max_gap_sec`, capped at 2 s), skips suppressed/overlapping words and complete filler-lexicon spans (including split multi-word entries such as `you know`), and never compares across tracks. It consumes a matched repair window so periodic text cannot stack adjacent restart proposals. Every repeat/restart candidate is hard-bounded (like an acoustic gap run) to the silence flanking the reparandum: the floor is the end of the preceding surviving word and the ceiling is the start of the repair word, not the reparandum's own start/end (#783; before that, the bound was the reparandum's exact span, which on Whisper's touching word times was the same thing but on aligned times stranded the flanking gap as unremoved air). Waveform snapping, breath extension, and pacing can widen into that flanking silence but can only shrink inward from there, never move the cut onto a neighboring word or into the kept repair (#772). A cut that can only satisfy that bound with a harsh join is dropped by the usual risk / join-continuity gates rather than proposed wide. Because that flanking silence can be much wider than the reparandum itself on aligned times, a final cut covering less than half of the reparandum's own span is dropped outright (PR #792 review): waveform snapping or breath extension sliding the cut mostly into the silence removes neither copy and leaves both audible, which is worse than proposing nothing. These remain proposal-only (`review_required: true`) because emphasis and semantic repairs (for example “store—no, park”) cannot be inferred safely from text alone; coalescing keeps each repeat/restart (and `filler:acoustic`) proposal's id and reason separate from adjacent cuts. The existing golden-ear A/B harness includes `filler`, `pause`, `repetition`, and `restart` by default; listen and approve each hit individually.

- **Lexicon matching** — ASR words compare with `tighten.filler_words`, `tighten.discourse_markers` and `tighten.backchannels` in one form (`util/text.lexicon_form`): lowercase, with leading and trailing punctuation stripped from each token and inner apostrophes and hyphens kept. Whisper's `Um.`, `uh,` and `-huh.` read as `um`, `uh` and `huh`. Config entries go through the same function, and repetition detection compares words in that form too.
- **Backchannels are speech** — `tighten.backchannels` (default `uh huh`, `uh-huh`, `mm hmm`, `mm-hmm`, `mm hm`, `mm-hm`, `mhm`, `uh-uh`) lists acknowledgments a listener says while someone else talks. They are matched in the same longest-phrase pass as `filler_words`, before any filler, so Whisper's split `Uh` + `-huh.` (a zero-length `-huh.` included) is one `uh huh` hit, not the filler `uh`. A backchannel also matches across a half the audibility pass suppressed (Whisper's zero-length `-huh.` reads as inaudible), so the `Uh` left is still not a filler; on the lab tape three of Lana's `Uh -huh.` replies had a suppressed `-huh.`. A backchannel is never proposed, never counts toward a filler cluster, and never becomes a repetition hit; each one is counted as `backchannel:{phrase}` in `skip_counts` and the summary (`N backchannel kept`). An entry that is also in `filler_words` is a backchannel. Split `uh uh` is left out of the defaults, because with the hyphen of `-uh` stripped it reads the same as a repeated hesitation (`Uh, uh,`). `[]` disables the list. Whisper word times on these tokens can drift by a second on a gated track (the lab's Lana); that timing problem is not handled here.
- **Isolated hard fillers** — `tighten.isolated_filler_candidates: true` (default). A lone hard filler (a `filler_words` entry that is not a discourse marker, such as `Um.`) is proposed without a cluster, because every hit is a pending proposal the host reviews. `light` turns this off, so a hard filler there needs `tighten.min_filler_cluster` (2) hits within `filler_cluster_gap_sec`. Discourse markers always need the cluster and then the discourse checks below.
- **Discourse-safe selection** — Tokens in `tighten.discourse_markers` (default `like`, `you know`, `sort of`, `kind of`) remain in `filler_words` but are **not** cut unless at least one of: (a) an **adjacent** true disfluency (`um` / `uh` / `erm` / `ah`, or any other non-marker lexicon hit) or an immediate repeat (`like like`); (b) a pause ≥ `tighten.discourse_pause_sec` (default 0.35 s) on at least one side of the marker span; (c) ASR confidence < `tighten.discourse_confidence_max` (default 0.6). Multi-word markers match split ASR tokens via adjacent-token windows (`you`+`know` → `you know`). Pause and low-confidence are intentional escape hatches, with one exception: `like` directly before a subject pronoun (`I`, `I'm`, `you`, `we`, `he`, `she`, `they`, `it`, and their contractions) is content, either comparative ("like I'm doing") or quotative ("I was like, I'm done"), and is never cut, whatever its confidence or flanking gap. The owner confirmed this on the lab recording, where Whisper gave Audra's "like I'm doing again now" a confidence of 0.19. Any other fluent quotative or comparative `like` with a ≥0.35 s flanking gap or ASR confidence below 0.6 still becomes `filler:like`. Fluent uses without those signals are counted as `discourse:{token}` (including isolated markers rejected by `min_filler_cluster`) and show up in the propose summary (`N discourse kept`). Accepted hits still use reason `filler:{token}`. Missing `discourse_markers` uses the defaults; explicit `[]` disables demotion.
- **Leave risky cuts in** — When `tighten.leave_in_if_risky: true` (default), cuts that fail the risk model are skipped rather than applied.
- **Padded cuts are two faded edges, not a splice** (#978) — The join approving ships is decided once, from the edit mode and the cut's final scope (`_CutPlan.for_cut` in `edits/fillers.py`: span, join, paced pad, next burst). The join is `splice` (a ripple with no pad), `padded` (a session ripple with a pad) or `mute` (mute in place, see [Mute vs cut](#mute-vs-cut)), and it picks the edge checks from one table (`_EDGE_CHECKS`). Scope depends on the span and the edge checks move the span, so `_analyze_candidate` gates under the scope the span settles on: a scope that flips after the checks re-gates once under the other plan (a track punch gets the splice checks and no pad; a session cut keeps its pad and skips them), and a second flip drops the cut as `unstable_scope`. With a pad (`replace_gap_sec` > 0) the render never butts the edges together: the left edge fades out into the pad (`filler_pre_pad_fade_out_ms`) and the right edge fades in after it (`recommend_post_pad_fade_in_ms`, which approval calls with the decision's `next_burst_sec`). The checks that score a splice therefore do not run on it: breath protection (`protect_cut_breaths`), the level-jump terms of the cut-risk score, and the join continuity gate. On the lab tape they rejected all four filler cuts the owner approved as rendered (Caleb `uh,` 604.80, `Uh,` 706.14, `Um,` 712.34, `You know` 1441.38) plus two negative controls whose edges ran into neighboring words. Padded cuts get two checks instead. **The right edge stops before the next word's first phoneme**: `edits/word_onset.py` reads the audio from the filler's tail for the first new sound (the first audible frame or high-band jump out of the quiet after the filler, which catches a plosive burst under the audibility floor; in continuous voice, the foot of the rise: once a rise out of the dip shows a new sound began, walk back to where the level started to climb. The dip's trough is too early, because the owner still heard the end of `uh` with the cut at the trough of `uh, we` (lab 706.37 vs a foot at 706.42-706.44), the level falling into a low, dark stretch before the word rises), and the cut ends 10 ms before it. The onset has a kind. A **burst** rises at least 18 dB in the high band within one 10 ms frame step (a plosive out of closure: 22 and 40 dB on the lab tape); anything that ramps (fricative, glide, nasal, vowel) is **gradual** (`she` gains 4 dB per step, `we` out of its dark stretch 10-14 dB). The foot of the rise walks back while each earlier frame is at least 0.5 dB lower, so the flat stretch before it does not drag the edge back. Only a burst travels on the decision as `next_burst_sec`, and the post-pad fade-in is cut down to finish before it, never below the join declick (`inaudible_cuts.micro_fade_ms`, 10 ms), so the ramp never attenuates the burst. A gradual onset moves the cut edge but sets no cap: the fade-in keeps its full recommendation, because a ramp over a fricative such as the `sh` of `she` (+4 dB per frame in the high band) is softer than a 10 ms one (the owner found 10 ms on `she` a little harsh and had approved 112 ms). The scan reaches as far past the cut end as the longest post-pad fade-in (`filler_post_pad_fade_in_max_ms`): an onset within the 10 ms guard shrinks the cut, and a burst further out leaves the cut alone but still caps the fade (the lab's `uh, nope` cut ends 90 ms before `nope`, so its fade is 90 ms, not 120). With no burst in reach the recommendation stands. Word times cannot place this: Whisper and the aligner drift by up to ~1.2 s on the lab tape. If that leaves the cut ending more than 40 ms (two frames of word-time jitter) before the filler's own word end, the cut is dropped as `next_onset`. **No kept word may vanish inside the span**: a cut that covers the whole span of an unsuppressed word other than its own filler tokens is dropped as `kept_word:{word}` (the owner rejected a cut that removed all of `we` plus the start of `should`; a cut that grazes a neighbor's tail is fine). The left edge is otherwise unchanged. Ripple cuts without a pad (track-local punches, acoustic gap runs, repeats and restarts, and a filler with no flanking word) keep every splice check. A pause trim keeps them too, except breath protection, which its air rule replaces (see **Decision: Pause trims cut only air**). A mute gets the padded-cut checks and keeps breaths whole (see [Mute vs cut](#mute-vs-cut)). Confidence and word-margin risk terms, voiced-edge review, the bleed-owner check and the overlap rules apply to all three; peer-speech scoping applies to ripple cuts only.
- **Filler left edge** (#1061) — A word filler's cut starts at its voice, not its word time. The aligner starts fillers late: on the lab tape both `um`s voice 320–350 ms before their word start (616.26 voices from 615.94, 713.00 from 712.65), so a cut from the word start left the head of the `um` audible and the owner heard each cut start mid-`um`. Before any edge check, and for every join (padded, track splice, mute), `_gate_cut_edges` walks back from the word start over 20 ms level frames every 10 ms (`voice_onset` in `edits/word_onset.py`) to the first frame under the track's voice floor (**Voice floor** below); the cut starts 10 ms before the audible frame after it. The walk does not bridge short dips the way voiced runs do, because the `ss` of `digress.` falls under the floor for only 20 ms before the owner-approved `uh` at 706.02. It only ever moves the edge earlier, only when a whole 20 ms frame of voice lies before the word start (a word start on the onset keeps its edge), and never past the previous kept word's end or 2 s back (word times drift by up to ~1.2 s on this tape). When the level stays audible all the way back to that word, the filler runs on from it with no quiet to cut in, and the cut is dropped as `filler_onset`. An edge at the word's end would cut its tail (lab `to like` at 424.6: the vowel of `to` runs 80 ms past its word end into `like`), and an edge at the word start leaves the filler's head; the owner's rule for mute mode (#1024) is to skip a filler that cannot be removed without clipping a neighbour. Acoustic gap hits have no word of their own; **Kept words keep their voice** below bounds them. On the aligned lab tape the `um` cuts now start at 615.93 and 712.64 (were 616.30 and 712.99) and lose their `voiced_edge` review flag; the `like` at 16.52, whose paced start had landed 110 ms inside the word, becomes a review hit starting at 16.45; the owner-approved cuts at 604.62, 706.00 and 1440.88 are unchanged. With Whisper word times only the `um` moves (615.94 to 615.93). A word the transcript dropped that runs straight into the filler would be cut with it; no lab case shows one.
- **Kept words keep their voice** (#1064) — No cut starts inside the voice of the kept word before it or ends inside the voice of the kept word after it. Word times end a word before its voice does: on the lab tape `So` ends at 230.78 by word time, holds full level to 230.88 and falls under the audibility floor only at 230.98, so a mute from 230.805 cut off the second half of the word (owner listening, PR #1169). The voiced-edge check missed it because the vowel is breathy: its pitch peak stays at 0.15-0.49, under the 0.55 a voiced run needs, while the gap scan's 0.28 took it for a hesitation. `_between_kept_voices` in `edits/fillers.py` therefore reads the neighbours by level, not pitch, for every join, against the track's voice floor (**Voice floor** below), the measure the filler-onset walk uses. `voice_end` in `edits/word_onset.py` walks forward from the previous kept word's end to its first quiet frame (the voice ends with the audible frame before it, where a voiced run's edge sits), and `voice_onset` (the filler-onset walk, shared) walks back from the next kept word's start to its last quiet frame. A cut without words of its own (an acoustic run or a pause) then starts 60 ms after that voice ends and ends 60 ms before the next voice starts, the voiced-edge air (`_VOICE_EDGE_PAD_SEC`). A word cut reads its neighbours only up to its own words: it starts no earlier than the first quiet frame after the previous word, where the filler-onset rule puts its edge, and ends 10 ms before the next word's voice. Voice that runs on between a word cut and a neighbour with no quiet frame stays with the filler-onset and next-onset rules; word times cannot stand in for the audio there (Whisper starts the `we` after `Uh,` at 706.26, 180 ms early). The exception is a word cut that the previous kept word's voice runs on through from end to end, with no quiet frame and no dip 10 dB deep (`voice_separates`): the cut lies inside that word's voice and would clip it, so it is dropped as `kept_voice` (#1024: skip what cannot be removed without clipping a neighbour). With Whisper times the repeat mute at 752.72–752.90 is such a cut: it holds -6 to -12 dBFS inside the kept `well,` (aligned, `well,` ends at 752.87). The aligned repeats at 753.17 and 1020.31 start after dips 20 and 14 dB deep and stay review hits. A cut that is then shorter than its minimum or no longer covers half its target, or an acoustic run or pause that a kept word's voice runs on through, is dropped as `kept_voice`. Lab (rev 3b414c4c, mute, against the PR's first head): with aligned word times proposals go from 57 to 55. Three runs are dropped: 230.81 (`So`'s own tail), 1563.83 (it ended 145 ms into the voice of `A`) and 1158.61 on another track (`voiced_edge` once moved). One is new: 949.68, the sound before `Like`, which ended inside `Like`'s early voice and was dropped as `next_onset`. Nine move: three start later (60.80 +65 ms, 63.43 +44, 1646.56 +23) and six end earlier (249.70, 653.89, 874.78, 1173.61, 1549.39, 1555.74, by 35-56 ms). Every word filler and repeat is unchanged. With Whisper times (`edit-ready`) proposals go from 38 to 37: 1153.55 started 95 ms inside `Okay.`, and the `uh` at 705.97 started 40 ms inside `digress.` and now starts at 706.00, the owner-approved aligned edge. Counting proposals with an edge inside a neighbour's measured voice (one 10 ms hop of tolerance): mutes 4 to 0 across both word timings; all six proposal sets (mute, ripple, aggressive ripple, both timings) 8 to 1. The one left is the aggressive Whisper ripple `kind of` at 423.13, whose voice runs on into `happened` with no quiet frame. Three repeat mutes per timing also have no quiet frame between the kept word and the repeated one, so no voice end can be measured; they keep their `voiced_edge` review flag (the Whisper one at 752.72 is now dropped, see above). Ripple at medium intensity loses two review hits (pause 233.37 now fails the splice breath check, acoustic 1555.74) and its word fillers are unchanged. Aggressive ripple gains four pause trims whose starts now clear the previous word's tail (57.56, 63.47, 1320.25, 1554.70).
- **Voice floor** (#1064) — The voice walks (`voice_end`, `voice_onset`) read quiet against the track's own levels, never a fixed dBFS level: Tighten reads raw, unnormalized tracks, and a fixed -42 dBFS floor moved the boundary with recording level (the host track scaled by -12 dB ended 487 of 739 kept words' voices more than 20 ms early, back inside the words; at +6 dB the dip before the approved `uh` at 706.02 never reached it and the cut was dropped). `voice_floor_db` in `edits/word_onset.py` is `max(S − 27 dB, R + 6 dB)`, from the whole track's `level_profile` (`edits/audio_cache.py`, the room/speech profile breath detection reads over 5 s): S is the 90th percentile of its live 10 ms frames, R the 10th percentile of all its frames, so a track a noise gate holds at digital zero between words has digital silence as its room, not its words' soft edges. 27 dB is where the owner-approved audibility floor (-42 dBFS) sits under the lab tape's speech (26.7 dB on the host track, 25.3–28.6 dB on all three), so at the lab's level the floors are -42.3, -40.4 and -43.7 dBFS and the walks keep their edges (`So` still voices until 230.99; the `ss` dip still ends `digress.` at 706.02). 6 dB keeps the floor over a noisy room's frame-to-frame flicker, where the speech term alone finds no quiet, and under the 9.5 dB over the room where the breath detector starts, so a kept word's own breath never reads as quiet. A dip that misses the floor still ends a voice when it is the bottom of a dip 15 dB deep on both sides and within 3 dB of the floor (the `ss` of `digress.` clears the floor by about 1 dB and sits 19 and 28 dB under the sounds either side); a ripple on the slope into a deeper dip is not one. Each dB of allowance over the floor stops more walks at dips inside words: walks started 150 ms inside 362 host-track words stop inside the word 61 times on the floor alone, 73 times with 3 dB, 88 with 6 dB and 105 at any level. Measured on the lab tape with only the gain changed (+12 to -24 dB, all 1146 kept-word gaps of 0.15 s or more on the three tracks), every voice end and onset stays within one 10 ms frame of its lab-level edge. Lab (rev 3b414c4c, against the previous head of this fix): aligned mute 55 → 55 (two acoustic mutes end 10 ms earlier, 520.79 and 1050.93); Whisper mute 37 → 36 (the repeat at 752.72); medium ripple unchanged; aggressive ripple aligned 42 → 42 (pause 643.79 starts 10 ms later and loses its join review) and Whisper 23 → 22 (`kind of` at 423.13, whose start sat on the tail of `it`, is dropped as `filler_onset`). Every owner-approved cut is unchanged. Other rules still compare against `analysis.heuristics.audibility_rms_db` directly, among them the next-onset scan, the inaudible-run check and the voiced runs.
- **Padded left edge and breaths** (#1064) — A padded cut's left edge fades out over `filler_pre_pad_fade_out_ms` (5 ms) with no breath check, so the lab tape was measured before adding one. The sample was every padded ripple proposal at medium and aggressive intensity, with Whisper and with aligned word times: 27 left edges (rev 3b414c4c). None sits inside a complete breath, as `protect_cut_breaths` reads an edge. 20 sit in activity that runs on into a word, either the previous word's decay or the filler's own voice, and 3 are in clear air. The breath-run classifier (`classify_breath_samples` over the fade) calls the tail at 2 cuts breath-shaped (4 edges across the two word timings): `hair.` before `you know` (1440.88) and `the.` before `like` (948.84, aggressive only). Both are the previous word's breathy release, which `recommend_prev_word_lead_out_ms` keeps until 20 ms after it falls under the audibility floor. The edge sits at -49 to -51 dBFS, 10 ms before the run ends and about 40 ms before room tone. The owner approved the 1440.88 cut as rendered (#978). No breath-safe left edge was added.
- **Join continuity gate** — When `tighten.join_continuity_gate: true` (default), `assess_proposed_cut` runs on every cut without a pad after boundary optimization; verdict `fail` skips the candidate (fail-closed). Verdict `review` marks `review_required`. The verdict is the worst over every edge placement within `join_continuity.edge_tolerance_ms` (3 ms), which roughly halves the verdict flips a few-millisecond nudge or re-timed word causes; a splice inaudible at the proposed edges passes regardless. See [inaudible-cuts.md](inaudible-cuts.md) § Join continuity.
- **GUI review loop** — Sharecut Studio **Tighten** tab lists pending `filler:` (including review-only `filler:acoustic`), `pause:`, `repetition:`, and `restart:` hits (search, class/track filters, harsh-only). Preview / skip / apply one, or apply-all with **Avoid harsh cuts** (default on; skips `review_required` and `:risky` / `:join_review`; unticked it sends the other review hits too, but never a pause trim that stays for review, which the editor applies one at a time after listening). Same `ApproveEdits` / `RejectEdits` path as the pending inspector. See [daw-editing.md](daw-editing.md) § Tighten review.
- **Waveform boundaries** — Proposals call `optimize_source_cut_range` when `tighten.inaudible_opt: true` (default). Short cuts also **extend the end to the quietest point before the next word** (within `trailing_energy_extend_ms`) when ASR ends a filler early (see [inaudible-cuts.md](inaudible-cuts.md) `trailing_energy_*`).
- **Adaptive fades** — Each decision gets `crossfade_ms` from `recommend_cut_fade_ms` (roughly 15–50 ms for fillers, up to ~150 ms for long pauses, scaled by join level jump).
- **Breath co-removal** — Adjacent breath-shaped energy before/after a cut is included in the remove range when detected (`tighten.breath_handling.enabled`). A breath must be **unvoiced noise all the way to the cut, between the track's own room tone and speech level, and outside every kept word**. The detector (`edits/breath_detect.py`) reads 5 s of the kept audio on each side of the cut and takes the 10th and 90th percentiles of its live (not digitally silent) 10 ms frame levels as the room-tone floor and the speech level; a breath frame sits at least 9.5 dB above that floor and 7–40 dB below that speech level (`breath_level_band`). Flanks with no such contrast (a gated track with nothing live nearby, or under 0.5 s of live audio) yield no breath. On the lab tape breaths sit 6–39 dB below the local speech level and 12–45 dB above the floor; the previous band, derived from the fixed `analysis.heuristics.audibility_rms_db`, was −32.4 to −31 dBFS and found 1 of 26 labelled breaths (#814). The scan forms complete in-band runs before selecting those overlapping the 400 ms search before or the 250 ms search after the cut. It takes the first complete run of breath length (80–450 ms) that passes five checks. Frames inside a kept transcript word are never breath and the stretch between the run and the cut may not touch one (a word the cut itself removes at least half of is not kept), so a quiet phrase-final word tail such as lana's `she?` cannot be called breath. A run that continues a kept word on its far side, with no frame at or below the band floor between them, is that word's decay (before the cut) or onset (after it), whatever its own shape: the aligned `uh` at 1441.21–1441.27 decays through the band to 1441.41 and the `sh` of `she` at 1456.65–1456.76 is a 2–3.5 kHz burst under the sibilant split; the scan covers the whole 5 s of flanking audio so the word can lie outside the search window. No frame between the run and the cut may exceed the band ceiling: vocal fry scores 0.1–0.4 on the pitch probe but its pulses sit at speech level (an untranscribed creaky `check` at 1122.98–1123.15, −17 dBFS frames against a −18.8 dBFS ceiling). Neither the run's energy nor that of the gap between it and the cut edge may sit mostly above 4 kHz (a sibilant `s` carries 54–100% of its 100 Hz–8 kHz energy there, a breath 1–24%; the gap is checked on its own so a word-final `s` next to a loud breath cannot average out below the split). And 40 ms speech-pitch (70–350 Hz) autocorrelation probes every 10 ms over the run **and everything between it and the cut edge** must all stay below 0.55, because the cut is extended out to the run and removes what lies between; only probes whose frame reaches the band floor count, since room tone 40 dB under the speech level also scores 0.6–0.8 on this tape and is not speech to protect. A run that fails is skipped for the next quieter one. The band alone cannot tell breath from speech — in a loud window a window-relative band selected the quieter frames of ordinary speech, and on the lab tape 82% of its hits were voiced, including the kept second copy of a repeated word; a breath sitting 270 ms before a cut also pulled the voiced word between them into the cut (#798). Some breaths on the lab tape peak at 0.60–0.65 on the same probe and stay undetected; the gate is kept because quiet voiced speech reaches down to 0.57. Detection cannot widen a cut beyond its candidate bounds. After pacing, candidate-bound clamps, and voiced-edge nudges, `protect_cut_breaths` checks both final edges of a cut without a pad (a padded cut fades each edge against silence instead; see **Padded cuts** above). The shared detector completes the quiet onset and tail to measured room-tone separators on the 10 ms level grid and rechecks pitch, sibilance, kept words and the level ceiling over the full envelope. A start inside a confirmed complete breath advances to its offset; an end inside it retreats to its onset. Exact onset/offset boundaries stay unchanged. Both adjustments use the original bounds and only shrink the cut. Empty cuts and non-pause cuts that no longer cover at least half their target span are dropped. Connected above-floor activity that crosses an edge but fails classification suppresses the proposal, as do missing evidence and incomplete bounded envelopes. A **pause trim** is different (see **Decision: Pause trims cut only air**): it shrinks to the longest stretch of air inside it, measured against each track's room tone, rather than being suppressed, so this paragraph's edge rules do not apply to it. Rejected activity elsewhere and floor-level silence do not suppress a cut. Shrink recomputes kept-word eligibility, scope and voiced safety; risk, pad, join and fade use the settled bounds. Enabled handling requires a usable room-tone/speech profile; disabled handling preserves the existing geometry. This conservative bounded check does not guarantee universal breath recall or replace listening. Automatic application consumes stored optimized proposal bounds without a second snap; unsnapped pending edits retain the configured apply-time optimization.
- **Pause floor** — Long pauses are shortened but a natural gap remains. **Turn / dead-air** (another dialogue track has words in the gap) keeps `tighten.min_retained_pause_sec` (~0.18 s). **Solo same-speaker** pauses (peers quiet — thinking, list restart) keep `tighten.min_retained_solo_pause_sec` (~0.55 s) so performance air is not crushed to a hard edit. The floor is **contiguous** source air immediately before the next word (holes from prior ripples do not count); any shortfall is padded with silence after ripple. Reasons are tagged `pause:…s:solo` when the solo floor applies.
  The `max_pause_sec` threshold is measured on **surviving timeline air**, not the raw source-clock gap between the two words (`SessionTimeline.map_source_span`, #772). A ripple delete leaves no clip over the removed range, so two words that are adjacent in the transcript can still be far apart in source time; the deleted stretch contributes nothing to the gap and no `pause:` candidate is proposed once what remains falls under `max_pause_sec` (including down to zero, when the whole gap between them was cut away). A hole from an earlier **track-local** punch inside the gap is excluded the same way (#783): the sum only counts spans this track's own clips still cover, so an already-silenced stretch never inflates the measured gap. This is a deliberate undercount — it can only make `max_pause_sec` harder to reach, never propose a cut over audio that still plays — and it is low-impact in practice, since a track-local hole comes from the speech-energy guard punching around a peer, and the guard drops a `pause:` candidate in that same window anyway (above).
  Peer speech is indexed once across dialogue transcripts for a tighten pass; standalone transcripts absent from the project use the direct peer scan. A gap counts unsuppressed words on other dialogue tracks whose start is before the gap end and end is after the gap start, including point-timestamp words strictly inside the gap; the current track and non-dialogue tracks do not supply peer speech. This word-span test is only the pause floor's turn-versus-thinking choice; the acoustic gap filler measures peer audio instead (§ Acoustic gap candidates).
- **Voiced edges and interior speech** (#815, #818) — After pacing, every candidate's final span is checked against the cut track's own voice (`edits/voiced_runs.py`: 20 ms level frames every 10 ms at or above `analysis.heuristics.audibility_rms_db`, bridged over 30 ms dips, kept as a run only when at least three 40 ms probes carry a clear speech-pitch peak ≥ 0.55, the same bar `breath_detect` uses, so breaths, clicks and room tone never form a run). Word times are the only view a candidate has, and on the lab tape both aligned and Whisper ends sit 120–270 ms inside the voice (`idea` ends 467.33 s by the aligner, the vowel at 467.55 s). An edge that a run surely holds on both sides is moved out of it, past the run plus 60 ms of air (join_speech's pad), when the run belongs to a word that stays, so the word keeps its tail or onset. A cut only ever shrinks here (a word filler's left edge has already moved to its voice onset; see **Filler left edge**): voice past an edge with no transcript word in it is either the cut word timed short or a word the transcript dropped, and the audio cannot tell which, so the edge stays and the cut is `review_required` with `:voiced_edge` instead of widening onto it. A nudge is also refused, with the same flag, when it would move more than 0.5 s, leave the candidate's bounds, leave under 0.1 s of cut, or (for filler / repeat / restart / acoustic cuts) uncover more than half of the targeted word. A `pause:` span that still holds 0.1 s or more of one voiced run after the edges settle is speech the transcript missed (a dropped sentence, a laugh, an "mm"): it is proposed for review as `:interior_speech`, never auto-applied. Review rather than drop, so the reviewer learns the transcript has a hole there; the agent apply-all paths (`apply_edits`, `approve_edits_tool(apply_all_safe=True)`, `podcast edit approve --all-safe`) skip `review_required`, and so does Studio's Apply eligible while Avoid harsh cuts is on (it never batches a pause trim, on or off).
  **Which tracks.** A session-scope cut ripples the same window out of every dialogue track, so the check reads every dialogue track whose audio decoded into the tighten audio cache (the cut track alone for a track-local punch). Everything on a peer stays, so a peer's voiced run at an edge is always a kept-word nudge (or `:voiced_edge` when refused), and a peer's voiced run of 0.1 s or more inside the span makes any session cut `:interior_speech`, filler or pause. The speech-energy guard still decides session vs track-local, but it measures a window mean (lana's 110 ms burst at −30 dBFS averaged −48 dBFS over a 7 s pause) and needs 30 ms of overlap, which is why the ripple check reads runs instead. A pause must also be **dead air** on every track it ripples: an audible run of 0.1 s or more at or above the floor that the pitch probe cannot vouch for (a fricative-only word, a laugh, a cough) makes it `:interior_audio` review. Single clicks under 0.1 s do not count; on the lab tape the seven good dead-air cuts hold 20–80 ms blips at −29 to −42 dBFS and pass this check (a trim whose span moved still waits for the #1055 listen), while a peak-frame rule would have cost two of them. Known limits, measured with synthetic probes: voiced audio 4 dB under the floor (−46 dBFS) is invisible, and so is speech shorter than 0.1 s.
  Measured on the lab tape: the dropped-ASR repro's two 8 s pauses over speech went from auto-applicable to `:interior_speech`; edges inside kept-word voice went 39→29 (Whisper) and 108→82 (aligned), all of them review-required, and the seven dead-air cuts kept their edges. Some edges the gate used to score `review` while they sat inside a word now score `fail` once they sit honestly on the word's decay and are dropped; others that used to fail now pass as inaudible splices (caleb 1271.60 s) because the edge no longer straddles speech and silence. audra's 671.74 s pause, clean on its own track, is `:interior_speech` for lana's untranscribed burst at 673.3 s inside it.
- **Filler pacing floor** — After filler / NL hesitation cuts, default `filler_room_tone_replace: true` removes the inter-word hesitation and inserts a paced pad: `clamp(min_gap_after_filler_sec, gap × filler_gap_retain_fraction, filler_replace_gap_max_sec)` (defaults **0.35 / 0.85 / 1.0 s**). `gap` is the larger of the flanking words' air, when the cut takes the whole gap between them, and the span the cut finally removes. Edge checks move the span after pacing (the **Filler left edge** widens it to the filler's voice), so the cut plan carries the pacing rule (`PacedPad` in `edits/filler_pacing.py`), not a length, and the decision's `replace_gap_sec` is read from the final span (#1074). NL removes read it from their final span too. Coalescing re-paces too (#1129): adjacent cuts that merge into one wider cut get the pad the rule gives the merged span (`paced_pad_for_span`, reading the words around it, with the intensity-adjusted `tighten` values), not the larger of their old pads. A pause's pad is different, not paced: it makes up a retained stretch that earlier ripples shortened, so the largest of those is kept beside the paced pad. On the lab tape (rev 3b414c4c) no default-intensity Tighten run coalesces two cuts, seeded or force-aligned, so no pad there changes. On the aligned lab tape the two widened `um` cuts, 615.93–616.71 and 712.64–713.35, get 0.66 s and 0.60 s pads; main gave both the 0.35 s floor, sized for the 0.1 s word spans the aligner placed late. No other cut changes. Expand keeps previous-word release via **`recommend_prev_word_lead_out_ms`** (energy to quiet floor, ~40–250 ms — fixed 60 ms still cut mid-nasal) and `filler_next_word_lead_in_ms` (~80 ms) before the next onset — unless ASR tokens overlap the filler. After the pad, `filler_pre_pad_fade_out_ms` (~5 ms) declicks into silence and **`recommend_post_pad_fade_in_ms`** sizes the resume fade from look-ahead energy (quiet air → `filler_post_pad_fade_in_min_ms` ~15 ms; hot/late onset → up to `filler_post_pad_fade_in_max_ms` ~120 ms). Default pad fill is **`filler_pad_mode: room_tone`** (see **Decision: Room tone is the default fill**). It prefers a recorded `track.room_tone` bed (abutting tiles with fade-in on the first tile and fade-out on the last when the pad is longer), else a steady stretch of the track's own audio at its noise floor, chosen from the audio and never from word times, so untranscribed speech and peer bleed are not tiled (rules in **Where room tone comes from**). If there is no bed and no such stretch near the cut (a Zoom-gated track, or a voice detector that errors), the pad is skipped rather than tiling dialogue, bleed, or silence. Set `filler_pad_mode: silence` for a hard silent gap on every track. Set `filler_room_tone_replace: false` to shrink the cut and keep original air instead.
- **Speech-energy guard** — Before session-wide ripple, `tighten.speech_energy_guard` measures other dialogue stems in the cut window. If a peer is audibly speaking (even when ASR missed the word), default `on_conflict: track_local` punches a silence hole on the **cut track only** (`EditDecision.scope=track`) so overlapping dialogue is not mid-word chopped. `skip` refuses the cut; `review` still uses track-local and marks `review_required`. Where a peer's own sound cannot be read (its stem and source audio are both missing), sound shows nothing, so its transcript decides instead (#1145): an unsuppressed, unignored peer word in the window whose own voice is there counts as speaking. This is the ripple speech guard's word evidence (`speech_energy_guard.speech_words_in`, see [daw-editing.md § Edit modes](daw-editing.md#edit-modes-ripple-and-gap)); a peer whose sound can be read is decided by sound alone, as before. A `pause:` candidate is **dropped** instead of demoted, under either `on_conflict` setting: a track-local punch never ripples, so it cannot shorten the timeline, which is the only reason a pause cut exists (#772).

### Decision: Filler cuts follow the owner's listening rules

<!-- decision
id: D-filler-cuts-by-ear
status: accepted
date: 2026-10-05
decided-by: calebn
evidence:
- #977 owner: uh-huh and mm-hmm are acknowledgments to preserve
- #978 owner: "keep the first phoneme for the word after, plosives will be important to keep all of"
- #978 owner, on a cut that removed all of "we": "not acceptable, just cut the uh"
- #987: a 10 ms fade onto "she" was harsh, so a gradual onset keeps the full fade; the owner judged "like I'm doing again now" one to keep
- #987 lab: filler hits went from 0 to exactly the five the owner approved, none on a kept word or an uh-huh
- #1061, #1075 owner listening check (2026-10-06): starting at the filler's voice approved, removing 330 ms and 310 ms of audible "uh"
enforced-by:
- tests/test_fillers.py::test_split_uh_huh_is_a_backchannel_skip_not_a_filler
- tests/test_lab_tighten_fixtures.py::test_cut_filler_verdict_gets_filler_hit
- tests/test_fillers.py::test_audio_padded_filler_cut_ends_before_a_plosive_burst
- tests/test_fillers.py::test_gradual_onset_after_a_padded_cut_keeps_the_full_post_pad_fade_in
- tests/test_fillers.py::test_discourse_like_before_subject_pronoun_kept_despite_low_confidence
- tests/test_fillers.py::test_filler_cut_starts_before_the_voice_an_aligner_timed_late
- tests/test_fillers.py::test_filler_pad_is_paced_from_the_span_the_cut_removes
- docs-sync: decision-filler-cuts
-->

The owner set these rules by listening to the lab tape. Backchannels stay
(**Backchannels are speech**). A real `um` or `uh` goes, alone or not
(**Isolated hard fillers**). The next word keeps its first phoneme, a plosive
stays whole, and a gradual onset gets the full fade-in (**Padded cuts are two
faded edges**). The cut starts at the filler's voice (**Filler left edge**).
A content `like` stays (**Discourse-safe selection**). The pad is paced from
the span the cut finally removes (**Filler pacing floor**, #1074; owner listening
check pending). Open listening note: the review-only `like` cut at 16.45 s
sounds rough (#1079).

### Superseded decision: Pause trims cut only air

<!-- decision
id: D-pause-trims-cut-only-air
status: superseded
date: 2026-10-07
decided-by: calebn
evidence:
- #1055 lab census: 286 of 314 ripple pause trims rejected as breath; 8 of their 572 edges sat in a breath, 147 first edges in air under the breath band, 125 in the previous word's audible tail
- #1179 rounds 1 to 4 each read a track's quiet off one percentile of its frames and drew the line a fixed number of dB over it (3 dB, and a run had to peak 10 dB over). Where sound fills the pause its quiet sits inside that sound, and a fixed margin is right in one room and wrong in every other: a breath 5 to 9 dB over a steady room was cut through, a silent mic with a 40 Hz rumble blocked every trim, a hum or a swinging room lost its air
- Owner rule (#1179): a breath, a voiced decay or any other own sound may be removed whole, but no edge may land inside one, on any track the ripple cuts; thresholds come from each episode's own measurements, never fixed levels, and the lab tape and the test harness are evidence, never tuning targets; losing air is the safe direction; newly allowed pause trims stay review-only
- #1179 round 5 audit (independent lanes): a recording offset by 50 ms, 100 ms or 2 s put an edge 20 ms inside a peer's sound because the peer was read at the trim track's own source seconds; the longest of two shared-pause twins could remove a sound the other track's analysis kept; a room wandering +/-6 dB left 3 of 40 edges inside a breath; a 25 to 110 Hz rumble at -60 dBFS left 13 of 40 edges with breath content above hearing threshold after the render's 80 Hz high-pass; a review filler, a review pause and an auto filler coalesced into one `filler:um:risky` cut
- #1179 round 6 audit: the room was read from the track's own gaps between its words, which in a conversation are mostly its peers' speech bleeding into its mic, and from a 30 s window around each pause, so one stretch read differently under different pauses; the trim track's own lane was read through the trim's source seconds, so a hole, a join, a replayed stretch or a clip from an extra source recording put the edge in a sound it never read; extra-source clips were read from the track's primary file, not the file the render plays; a pad longer than its span lengthened the timeline; nested twins were dropped before the join gate scored the trim that stays, so a trim the gate then rejected took its twin with it; tonal tails at 100 to 130 Hz and beats under the band passed a room read at 160 Hz and up
- #1179 round 7, synthetic scenes with known sounds, 34 scenes with a band or tail or beat sound, 20 trials each (1252 edges; the steady-bed scene `pad:-50` is the named limit, 40 of 40 before and after): edges inside a sound by broadband level 64 before, 0 after; edges audible after the render's 80 Hz high-pass (speech at 80 dB SPL, ISO 226 threshold) 171 before, 13 after, the worst 30.7 dB over threshold before (`tonal_tail:100,1`) and 2.6 dB after (`tonal_tail:130,0.5`); the 38-scene round 5 table: third-octave edges inside excluding the steady bed 37 before, 8 after, and 7 before, 1 after at 6 dB; mean share of the pause kept 0.599 before, 0.548 after (0.663 and 0.638 on the 38-scene table), so round 7 gives up 2.5 to 5 points of air for it
- #1179 round 7, local floor window over the 29 wander, swell and steady scenes (20 trials each): third-octave edges inside a sound 21 at 0.5 s, 11 at 0.35 s, 5 at 0.25 s, 6 at 0.2 s and 5 at 0.15 s, edges audible after the high-pass 15, 7, 3, 4 and 4, at 0.014 less of the air kept from 0.5 s to 0.25 s; with the low band and the sustained-excess rule added, the 0.25 s scenes leave 2 third-octave edges and 1 audible after the high-pass
- #1179 round 7, session fuzz (own-lane holes, joins, replays, offsets, extra sources; 10 classes, 660 cases): 0 edges 30 ms or more inside a placed sound, 0 loud sounds removed, 0 ripple mismatches, 0 asks that landed off the lane. The two classes that replay a stretch of the trim's own lane or play an extra source (180 cases) were the failures in round 6: 21 no-ops, 8 of 159 trims with an edge inside a placed sound, 1 loud sound removed; round 7: 0 of 170, 0 and 0. An extra-source breath at 10.70 s, read from the track's primary file in round 6, now stops the trim at 10.69 s
- #1179 round 7 mutation check (70 single-edit mutants of the room, bands, lane, source, twin, pad and review logic, run against the decision block's test files): the first run left 7 alive; the tests added for them kill 6 (the 7th snaps an edge to the span asked for when the two agree to a microsecond, which changes nothing), and writing the one for the trim track's missing speech level found a crash when nobody in the session has a word
- #1055 lab after round 7, against main at b785b17d6 and round 6: 138 pause decisions at medium (main 8, round 6 120), none auto (light 104, aggressive 160); every non-pause decision identical to main at light, medium, aggressive and mute, and no pause trim is applied by `apply_edits` or Apply eligible on either path; 46 candidates dropped as `shared_pause`, each nested exactly in the trim that stays, and no two staying trims overlap (round 6: 8 pairs); R02, the 8.1 dB over threshold peer edge of round 6, is gone, R46 (1010.60 to 1011.07) is 1010.97 to 1011.01, aggressive 83.39 is gone and 87.60 is 87.65 to 87.67; the independent detector (raw stems, a 200 Hz to 4 kHz level over each track's local room) finds 1 edge in a sound of 6 dB or more at medium (round 6: 3), 4.7 dB under the threshold of hearing in every third octave after the high-pass; of the 70 edges any tier flags, 12 stay above threshold after the high-pass, the worst 3.5 dB at 5 kHz (round 6: 8.1 dB)
- #1055 lab turn-taking gaps (the 20 round 5 `other_speaking` candidates that are decisions, 27 in round 6): 0 transcript words inside or straddling a trim, 0 peer onsets inside an edge (round 6: 1); at the 10 turn changes among them the gap the trim leaves between the sounds that bound it is 65 to 520 ms, median 125 ms, 7 under 150 ms (round 6, 12 turn changes: 35 to 1280 ms, median 195, 6 under 150 ms), and between transcript words 340 ms or more, never under 150 ms
superseded-by: D-pause-trims-cut-air-and-apply-when-safe
-->

Superseded on 2026-10-08. This decision held every pause trim for review until the
owner had listened to what it cuts. The owner listened to every round 4 to 7 clip set
and approved them all, and the edges were checked inaudible after the render's 80 Hz
high-pass, so the hold has done its job. What stays: a trim removes only air and no edge
sits inside a sound. What changed: a trim that passes the checks a filler passes now
applies; a trim too small to hear is not proposed; a recording with no words is read from
its own levels; and approving reads what the lanes play now.

### Decision: Pause trims cut only air and apply when they pass the filler checks

<!-- decision
id: D-pause-trims-cut-air-and-apply-when-safe
status: accepted
date: 2026-10-08
decided-by: calebn
supersedes: D-pause-trims-cut-only-air
evidence:
- Owner listening, rounds 4 to 7 of #1179: every clip set was listened to and approved (round 7: 107 clips), and the edges were checked inaudible after the render's 80 Hz high-pass. The review-only rule of D-pause-trims-cut-only-air held pause trims until then; the owner decided they apply by the rules a filler does
- Owner direction, round 8 of #1179: round 7 proposed 138 trims at medium that removed 62.6 s over about 28 minutes, the median 130 ms, 84 under 200 ms and 102 under a tenth of their pause; "far too many cuts for the time saved", and sound that cannot be told from room tone does not matter. A trim is proposed only when a listener would hear the pause shorten, and audibility after the high-pass (ISO 226, speech at 80 dB SPL), not a detector's flag, is what blocks
- #1179 round 8 audit: a recording that speaks but has no live transcript words took its room from session silence, which holds its own speech. Lab host with his transcript removed in memory: speech-band room -90.7 dBFS and line -83.9 dBFS with the transcript, -84.0 and -67.0 without it in round 7 (low-band line -73.9, then -44.0), -89.8 and -83.0 now (low band -72.6); the mode prior read 4.25 dB of spread for want of a speech level where 1.70 was right. Synthetic conversation scenes with an untranscribed guest, 30 trials, edges audible by the smear-free judge (`gated.py`), round 6, round 7, now: natural speech `guest` 1, 3, 3; `guest:-15` 2, 3, 3; `mid` 1, 8, 1; `nosil` 3, 10, 4; compressed speech 0 in every scene in rounds 6 and 8 and 0 to 9 in round 7. The same scenes with the guest transcribed read 3, 3, 1 and 2 in round 7, so most of what is left is the scene (a third octave at 200 Hz in a word's last 150 ms), not the missing words; `nosil` keeps two more
- #1179 round 8 audit: approving trims one at a time turned many into track-local punches. `approve_edits` re-ran the scope guard, which read the rendered stem (the timeline as it was rendered) at post-ripple seconds, found a peer speaking in what the lanes had made silence, and punched; 50 of 138 flipped in order and each approval still reported one applied. Round 7's 138 trims at medium removed 61.85 s per track together and 30.39, 44.03, 37.93 and 44.46 s one at a time (forward, reverse, two shuffles); read from the lanes, the same 138 remove 61.85 s in all four orders
- #1179 round 8 lab, against round 7: pause trims at light, medium and aggressive 104, 138 and 160 before, 55, 66 and 74 now (49, 72 and 86 dropped as `imperceptible`, a median 70, 60 and 50 ms net of any pad), carrying 90.3%, 88.8% and 88.7% of round 7's seconds (49.97, 54.90 and 58.66 s of 55.36, 61.85 and 66.13); every kept trim has the same id, track, span, pad, scope, fade and boundary mode as in round 7; 55, 65 and 73 apply automatically (49.97, 54.67 and 58.43 s) and 0, 1 and 1 wait for review; every non-pause decision and candidate outcome is identical to main and round 7; the 34-scene synthetic table is identical to round 7 and the 660-case session fuzz has 0 edges inside a placed sound, 0 loud sounds removed and 0 ripple mismatches
- #1179 round 9 audit: at aggressive `approve_edits_tool(apply_all_safe=True)` applied nothing and the pipeline held one trim. The trim, 1.08 s of air, never covered a peer's word. A later trim in the same batch needed a 0.3 s pad, and the sampler took its room tone from the nearest quiet run, which lay inside the first trim's span, so the pad replayed that source at the later trim's seam. The first trim then played in two places, mapped to the 11.4 s between them, and the speech guard found a peer's "Uh-huh" in it. Pads now skip source seconds another pending cut still plays. Lab, light, medium and aggressive: `apply_all_safe` and the pipeline each apply every auto pause trim, 55, 65 and 73, with the same seconds lost on every track (49.97, 54.67 and 58.43 s of pause trims); the proposals, and so the kept spans, are unchanged from round 8
enforced-by:
- tests/test_room_model.py::test_a_normal_room_reads_its_median_and_spread
- tests/test_room_model.py::test_what_stands_far_over_the_rooms_median_is_clipped_out_of_the_room_it_is_read_from
- tests/test_room_model.py::test_a_recording_reads_a_spread_no_wider_than_its_own_mode_whatever_its_quiet_holds
- tests/test_room_model.py::test_a_sample_that_is_mostly_sound_reads_the_room_the_tracks_mode_gives_it
- tests/test_room_model.py::test_a_window_of_bleed_with_no_room_in_it_is_one_sound_to_keep_however_tall_it_reads
- tests/test_room_model.py::test_a_room_read_between_the_tracks_own_words_is_bleed_a_room_read_in_the_quiet_is_not
- tests/test_room_model.py::test_a_recording_with_too_little_quiet_falls_back_to_the_low_end_of_its_own_gaps
- tests/test_room_model.py::test_the_conservative_room_stands_at_the_low_percentile_not_the_normals_median
- tests/test_room_model.py::test_runs_of_digital_silence_in_a_live_room_are_not_a_gate_and_do_not_move_the_room
- tests/test_room_model.py::test_a_stretch_gets_the_same_sounds_whatever_surrounds_it
- tests/test_room_model.py::test_a_frame_must_clear_a_line_four_spreads_over_the_rooms_median
- tests/test_room_model.py::test_a_breath_a_few_db_over_a_floor_that_jitters_is_a_sound_the_line_cannot_see
- tests/test_room_model.py::test_a_sustained_sound_with_one_frame_at_the_ceiling_is_kept_whole_though_its_average_is_not
- tests/test_room_model.py::test_a_click_whose_own_frame_reaches_the_ceiling_stays_whole_though_its_average_does_not
- tests/test_room_model.py::test_a_sound_is_traced_out_against_the_room_under_it_not_the_recordings
- tests/test_room_model.py::test_a_mic_that_never_speaks_has_no_speech_to_protect
- tests/test_room_model.py::test_a_narrow_band_reads_a_wider_spread_from_the_steadiest_room
- tests/test_session_air.py::test_a_lane_plays_its_clips_in_timeline_order_and_abutting_clips_are_one
- tests/test_session_air.py::test_a_sound_a_placement_edge_cuts_reaches_a_frame_past_the_edge
- tests/test_session_air.py::test_the_same_stretch_asked_for_in_two_windows_holds_the_same_sounds
- tests/test_session_air.py::test_a_quiet_sound_far_from_the_tracks_speech_is_still_removed_whole
- tests/test_session_air.py::test_a_recording_with_no_duration_in_its_media_is_read_to_where_its_audio_ends
- tests/test_session_air.py::test_a_track_is_read_through_the_decode_the_run_already_holds
- tests/test_pause_air_session.py::test_a_peer_is_read_where_the_ripple_removes_it_when_the_tracks_are_offset
- tests/test_pause_air_session.py::test_material_cut_from_a_peers_lane_contributes_no_sound
- tests/test_pause_air_session.py::test_a_hole_in_the_trim_tracks_own_lane_hides_no_peer_sound
- tests/test_pause_air_session.py::test_a_replayed_stretch_of_the_trim_tracks_own_lane_is_read_where_it_plays
- tests/test_pause_air_session.py::test_a_clip_from_an_extra_source_recording_is_read_from_that_recording
- tests/test_pause_air_session.py::test_an_extra_source_that_cannot_be_found_is_no_room
- tests/test_pause_air_session.py::test_an_extra_source_is_read_from_its_own_file_not_the_decode_the_run_holds_for_the_track
- tests/test_pause_air_session.py::test_an_extra_source_has_the_speech_level_of_its_own_transcript
- tests/test_pause_air_session.py::test_the_trim_track_needs_a_speech_level_a_peer_without_one_does_not
- tests/test_pause_air_session.py::test_both_tracks_judge_a_shared_pause_the_same
- tests/test_pause_air_session.py::test_a_quiet_sound_is_removed_whole_whichever_pause_asks_about_it
- tests/test_pause_air_session.py::test_the_same_decay_gets_the_same_air_whichever_pause_asks_about_it
- tests/test_pause_air_session.py::test_a_track_whose_gaps_are_its_peers_bleed_still_hears_a_murmur_in_the_quiet
- tests/test_pause_air_session.py::test_a_track_that_speaks_seven_percent_of_the_time_has_a_speech_level_from_its_words
- tests/test_breath_detect.py::test_a_quiet_breath_over_a_steady_room_is_sound_not_air
- tests/test_breath_detect.py::test_a_peers_quiet_breath_over_its_steady_room_is_sound_not_air
- tests/test_breath_detect.py::test_a_slow_decay_into_a_steady_room_is_sound_until_it_reaches_the_room
- tests/test_breath_detect.py::test_room_tone_jittering_over_its_median_is_air_not_sound
- tests/test_breath_detect.py::test_a_breath_whose_fade_crosses_an_edge_stays_whole
- tests/test_breath_detect.py::test_a_quiet_breath_goes_whole_or_stays_whole_never_cut_through
- tests/test_breath_detect.py::test_a_quiet_breath_apart_from_the_words_that_the_trim_starts_in_stays_whole
- tests/test_breath_detect.py::test_a_word_tail_next_to_a_louder_stretch_is_not_cut_partway
- tests/test_breath_detect.py::test_a_dip_of_up_to_30_ms_does_not_end_a_sound
- tests/test_breath_detect.py::test_a_gated_track_keeps_its_word_tails_and_breaths_from_a_pause_trim
- tests/test_breath_detect.py::test_a_pause_trim_keeps_an_untranscribed_voiced_sound_whole
- tests/test_breath_detect.py::test_a_peers_word_inside_the_trim_splits_the_air_as_the_trims_own_would
- tests/test_breath_detect.py::test_a_pause_a_peer_talks_through_is_skipped
- tests/test_breath_detect.py::test_a_peer_breathing_through_the_pause_leaves_no_air_on_its_track
- tests/test_breath_detect.py::test_a_silent_peer_mic_carrying_rumble_never_blocks_a_pause_trim
- tests/test_breath_detect.py::test_a_room_rumble_does_not_hide_a_breath_from_a_pause_trim
- tests/test_breath_detect.py::test_a_rumble_reaching_110_hz_does_not_hide_a_breath_from_a_pause_trim
- tests/test_breath_detect.py::test_a_tail_in_the_low_band_the_speech_band_stops_is_still_a_sound_to_a_pause_trim
- tests/test_breath_detect.py::test_a_breath_over_a_dip_in_a_wandering_room_stays_whole
- tests/test_breath_detect.py::test_a_decay_within_four_db_of_the_room_is_still_its_sound
- tests/test_dsp.py::test_the_band_fades_in_from_100_to_160_hz
- tests/test_dsp.py::test_a_flat_rumble_up_to_110_hz_is_38_db_down_and_frame_levels_never_read_louder_than_raw
- tests/test_dsp.py::test_the_low_band_passes_a_tonal_tail_at_100_to_140_hz_the_speech_band_stops
- tests/test_dsp.py::test_frame_level_noise_is_what_stationary_noise_reads
- tests/test_audio_levels.py::test_band_levels_across_a_block_edge_match_the_levels_of_the_whole_signal
- tests/test_audio_levels.py::test_each_block_of_levels_is_read_once_however_often_it_is_asked_for
- tests/test_shared_pause.py::test_a_trim_nested_in_a_longer_one_on_another_track_is_dropped
- tests/test_shared_pause.py::test_a_ten_millisecond_overlap_does_not_cost_a_trim_its_two_seconds
- tests/test_shared_pause.py::test_a_chain_of_partial_overlaps_keeps_every_trim
- tests/test_shared_pause.py::test_twins_are_compared_on_the_session_clock_not_in_source_seconds
- tests/test_tighten.py::test_two_tracks_quiet_over_the_same_stretch_propose_it_once
- tests/test_tighten.py::test_a_twin_stands_when_the_trim_it_was_dropped_for_fails_the_join_gate
- tests/test_tighten.py::test_a_twin_stands_when_the_trim_it_was_dropped_for_overlaps_an_applied_cut
- tests/test_transcript_cuts.py::test_coalesce_never_absorbs_a_session_pause_into_a_cut_that_is_not_its_own
- tests/test_transcript_cuts.py::test_coalesce_never_chains_a_review_filler_a_pause_and_an_auto_filler_into_one_cut
- tests/test_fillers.py::test_a_pause_trim_that_moved_onto_air_is_labelled_not_held_for_review
- tests/test_fillers.py::test_a_pause_trim_must_shorten_the_timeline_after_the_pad_it_needs
- tests/test_fillers.py::test_only_a_pause_trim_is_cut_down_to_its_air
- tests/test_tighten_apply_eligible.py::test_a_pause_trim_that_stays_for_review_is_listened_to_one_by_one_and_never_eligible
- tests/test_tighten_apply_eligible.py::test_studio_view_carries_the_same_harsh_and_listen_one_by_one_flags
- gui/web/src/utils/tightenHits.test.ts::never batches a pause trim, whether or not harsh cuts are avoided
- tests/test_benchmark_tighten_smoke.py::test_each_kind_of_decision_stays_within_the_rebuild_bound_alone
- tests/test_fillers.py::test_a_pause_trim_that_fails_a_filler_check_stays_for_review
- tests/test_fillers.py::test_a_pause_trim_is_proposed_only_when_a_listener_would_hear_the_pause_shorten
- tests/test_fillers.py::test_a_pause_trim_is_judged_against_the_silence_a_listener_hears_not_the_tracks_own_gap
- tests/test_fillers.py::test_the_pad_a_pause_trim_needs_is_not_time_it_removes
- tests/test_tighten.py::test_apply_tighten_decisions_applies_a_pause_trim_that_needs_no_review
- tests/test_tighten.py::test_a_twin_stands_when_the_trim_it_was_dropped_for_went_to_an_acoustic_cut
- tests/test_transcript_cuts.py::test_coalesce_keeps_a_pause_shortfall_pad_apart_from_the_filler_pad
- tests/test_approval_order.py::test_approving_session_cuts_one_at_a_time_removes_what_approving_them_together_does
- tests/test_approval_order.py::test_a_cut_a_peer_now_speaks_through_is_held_not_punched
- tests/test_approval_order.py::test_applying_auto_edits_leaves_a_cut_a_peer_speaks_through_pending
- tests/test_approval_order.py::test_the_approve_tool_refuses_a_held_cut_and_leaves_the_project_as_it_was
- tests/test_decisions.py::test_approve_remove_is_held_when_guard_cannot_resolve
- tests/test_room_model.py::test_a_recording_with_no_words_reads_its_room_where_its_own_levels_pile_up
- tests/test_room_model.py::test_a_recording_that_never_speaks_is_a_room_throughout
- tests/test_room_model.py::test_a_gate_that_holds_a_talker_at_digital_silence_between_its_words_is_its_room
- tests/test_room_model.py::test_a_talker_with_no_room_mode_falls_back_to_the_low_end_of_all_its_frames
- tests/test_session_air.py::test_a_recording_with_no_words_is_not_read_through_the_sessions_silence
- tests/test_session_air.py::test_the_sessions_speech_is_laid_on_the_session_clock_not_the_recordings_seconds
- tests/test_session_air.py::test_a_frame_played_twice_is_silent_only_if_nobody_speaks_at_either_playing
- tests/test_session_air.py::test_a_lane_window_lays_each_placement_where_it_plays_and_is_silent_in_a_hole
- tests/test_session_air.py::test_the_silence_around_a_stretch_runs_from_the_last_word_before_it_to_the_first_after
- tests/test_pause_air_session.py::test_a_trim_says_how_long_nobody_speaks_around_it_and_that_moves_nothing
- tests/test_approval_order.py::test_the_pad_of_one_auto_trim_is_not_taken_from_the_air_of_another
- tests/test_approval_order.py::test_the_pipeline_applies_the_same_auto_trims_apply_all_safe_does
- tests/test_room_tone.py::test_room_tone_is_not_taken_from_source_a_pending_cut_still_plays
-->

A pause trim exists to shorten air, so it removes only air, and no edge of it sits
inside a sound. Instead of being dropped when an edge sits in sound, it shrinks to the
longest stretch of air inside it (`pause_air_span` in `edits/breath_detect.py`). A
breath, a word's tail, a voiced decay, a laugh or word the transcript missed, and a
peer's onset all stay whole: a sound is either removed whole or left whole. Other
splices and mutes keep the rules in **Breath co-removal**; a pause trim does not take
that path.

Air is a recording's room tone, and the line between room and sound is the room's own,
never a level chosen in advance. Rounds 1 to 4 of #1179 each fixed a margin and each failed
the same gate, because the right margin is a property of the room: a dB or two over a
steady one, several dB over one that swings. The rule reads it from the recording
(`edits/session_air.py`, `edits/room_model.py`) and applies it to every track the ripple
cuts, the trim's own and each peer's:

- **One reading per recording.** A recording's room, speech level and sounds are read once
  over the whole recording, under a lock, and a window only selects among them
  (`SessionAir.sounds_in`). A stretch therefore has the same sounds whichever pause, track
  or thread asks about it, which a window read around each pause could not give.
- **The room** is the recording's levels where nobody in the session is speaking: the
  frames outside every dialogue track's live words (each padded 50 ms), laid on the session
  clock through each track's lane. There a mic holds its room tone and nothing else,
  whatever its peers did a moment before. In a conversation a track's own gaps between its
  words are mostly its peers' speech bleeding into its mic, so a room read from them sits
  tens of dB too high. A recording with under half a second of such frames falls back to its
  own gaps, read conservatively at their 5th percentile itself rather than as a normal's
  median (`read_conservative_room`), so it can only read too low (more sound, less air);
  one with neither is `no_room`. A recording a gate holds at digital silence for at least
  half of those frames has digital silence for a room, so any live frame over it is sound;
  a few runs of digital zero in a live floor (a denoiser's mute, a gap in the file; 16% of
  one lab mic's quiet) are not a gate. The room sits at the 5th percentile of the sample's
  smoothed levels read as a normal's median, and its **spread** is the lesser of two
  readings: the 5th and 25th percentiles with what lies over three spreads clipped away,
  and the recording's densest low mode (sound can only thin a mode, so a sample that is
  mostly sound or bleed still gives one). Neither is less than stationary noise averaged
  over 50 ms reads in that band (`least_spread`).
- **The speech level** is the 90th percentile of the levels of the frames inside the track's
  own live words, read once (`speech_level_db`), not of all live frames: a track that sits
  in a noisy room, or carries a peer's bleed between its words, would otherwise read its
  floor as speech. A track with under half a second of words has none, and a trim cut from
  such a track is `no_room`: it has nothing to protect.
- **A recording with no words.** A recording that speaks but has no live transcript words
  (a take that was never transcribed, an extra source) has its own speech in every frame the
  session calls quiet, so session silence says nothing about its room. Its room is read from
  its own levels instead (`read_unwatched_room`): a gate's digital silence if that fills
  half of its quieter frames; the whole recording as room if its speech level (the 90th
  percentile of all its live frames, in place of the words') does not stand 7 dB out of its
  quietest; otherwise the one place its levels pile up under 40 dB below that speech (the
  densest low mode, with the median of the frames near it as the room's level), else the low
  end of all its frames. That speech level also sets the ceiling and the mode prior for the
  recording, where round 7 had none (a ceiling of infinity, a spread of 4.25 dB for the lab
  host where 1.70 is right), and its sounds are kept whole or removed whole by the same
  rule. The limit is a recording that speaks under a tenth of the time: its 90th
  percentile lands in its room, so nothing in it is quiet enough to remove whole (more
  sound, less air).
- **The bands.** Levels are read in two bands at once (`util/dsp.py`). The speech band is
  a raised-cosine high-pass from 100 Hz (stopped) to 160 Hz (passed): a rumble or desk
  thump can sit 10 dB over a room's broadband air and hide every breath riding on it. It
  loses 23.5 dB at 110 Hz, 12 dB at 120 Hz, 6 dB at 130 Hz, 2.5 dB at 140 Hz and 0.6 dB at
  150 Hz; a flat 25 to 110 Hz rumble is 38.5 dB down, and one that is not flat passes the
  part of it near 100 Hz. The low band is a Gaussian around 120 Hz (sigma 30 Hz) with the
  least ringing of the shapes tried (a raised-cosine band of the same reach smeared a sound
  by 140 ms where this one smears 50): it reads 120 Hz at 0 dB, 110 and 100 Hz at 0.5 and
  1.9 dB down, 140 Hz at 1.9 down, 80 and 160 Hz at 7.7 down and 60 Hz at 17.4 down. It sees
  the tonal tails (a room mode ringing after a word) and beats (two hums) that the speech
  band is half deaf to, and its own room and speech level are read in it. A sound in either
  band is a sound; the low band does not give up a whole window to "cannot tell air from
  sound", because its speech level is not the speech band's. A frame never reads louder than
  it does unfiltered, so a filter's ringing is no sound.
- **The levels** are the 10 ms frames averaged in power over 50 ms (`smoothed`). A frame
  of noise wanders by a dB or more and a decay moves by tenths of a dB a frame, so the
  average is what lets the line sit close enough to the room to catch the decay's tail.
- **The line** is four spreads over the room's median: a room whose high side mirrors its
  low side crosses it in one frame of 30,000. A sound is the run around a crossing that
  stays over two spreads (its reach), with dips of up to 50 ms bridged (a breath's or a
  decay's level flutters for a frame or two, and creaky voice pulses about 20 times a
  second), and carries a guard frame either side so no edge touches it. A breath that
  sits only a few dB over a floor that jitters (a denoiser's, 1.7 dB frame to frame) never
  crosses a line seven dB up; it stays up, though: **a stretch of at least 80 ms of
  frames all over the room by a spread, whose mean excess is four spreads of a mean of
  that many correlated frames, is a sound however low it runs.** A noise floor's mean
  over thirty frames does not wander that far, a breath's does.
- **A room that wanders.** A room that drifts by several dB over a second or two reads wide
  over the whole recording, so where it dips its line and reach sit several dB over the
  room under a breath. Each frame's line and reach are therefore lowered further where the
  room within a quarter second of it is quieter: the levels' 5th percentile there, read as
  a normal's median, with the spread the levels show over that running floor, every 0.1 s
  and drawn straight between. The lower line stands, so sound never raises it. A quarter
  second, not half: over 29 wander, swell and steady scenes 0.5 s left 21 edges inside a
  sound in some third octave (15 audible after the render's high-pass) and 0.25 s left 5
  (3 audible), for 0.014 of the air; 0.15 and 0.2 s left 5 and 6 (4 audible) and no more
  air, 0.35 s left 11 (7).
- **The ceiling.** A sound that reaches 40 dB under the track's speech level is kept whole
  and splits the air; a quieter sound is removed whole when the trim holds all of it and
  kept whole when it crosses an edge. A track speaks when its speech level stands at least
  7 dB (the nearest a breath sits under speech) out of its quietest live frames. A speech
  band that speaks and whose line reaches within 40 dB of its speech cannot tell air from
  sound, because breaths sit down to there: the whole recording is one sound to keep. That
  is a room within 40 dB of the speech, and it holds no air. A mic that never speaks nearby
  and carries only its room tone has no speech to protect, and its room tone is air.
- **Peers, lanes and sources.** A session ripple removes the same stretch of session time
  from every dialogue track, so one rule judges every track, the trim's own included, each
  through its own lane and never another's (`lane_placements`): the clips of a lane laid on
  the session clock, with holes, joins, offsets and replayed stretches as the render plays
  them. The trim's own track is read that way too, so a hole in its lane hides no peer's
  sound, and a stretch it replays is read where it plays. A clip that plays an extra
  source recording is read from the file the render resolves (`resolve_clip_audio_path`),
  not from the track's primary file; one that cannot be found is `no_room`. Where a peer's
  lane holds no clip it has no audio and no sound, a sound a clip boundary cuts reaches one
  frame past the join, and a peer that cannot be read is `no_room`. A peer's word wholly
  inside the span splits the air as the trim's own would.
- **One decision per stretch of shared air.** The same rule on every track makes two
  tracks that are both quiet over a stretch propose the same trim, each at its own source
  seconds. `shared_pause_twins` (`edits/shared_pause.py`) drops a session pause trim as
  `shared_pause` only when another track's longer trim covers all of it, within one 10 ms
  frame (two tracks' frame grids sit at arbitrary offsets), on the session clock. Because
  every track reads the same sounds, a covered twin holds no sound the longer trim left
  whole. Anything else (two trims that overlap by 10 ms, a chain of partial overlaps) is a
  different cut and both stay: losing air is safe, removing a sound a twin kept is not.
  The drop happens after each trim is resolved, so the join gate scores the trim that
  stays; a twin whose kept trim the gate, the applied-overlap check or an acoustic
  replacement then rejects gets its own chance rather than being lost with it.
- **Only pauses a listener would hear.** A trim is proposed only when the time it takes
  out of the timeline (its span less the pad a ripple puts back) is at least a tenth of the
  pause it shortens (`PAUSE_JND_FRACTION`, `pause_trim_is_imperceptible`), and never less
  than `MIN_PACED_CUT_SEC`; otherwise it is skipped as `imperceptible`. The tenth is a design
  threshold, not a measured one. Laboratory Weber fractions for an empty auditory interval
  run from a few percent to about 10% and vary with the interval and its markers (Grondin
  2010, a review in *Attention, Perception & Psychophysics* 72(3), 561-582), measured between
  brief tones in forced-choice tasks, not on speech pauses. Friberg and Sundberg 1995 (*JASA*
  98(5), 2524-2531) found a displaced tone in a steady tone sequence detectable at about 6 ms
  for short tones and 2.5% above 250 ms, a best case for a different task. A tenth sits above
  both, so a trim is proposed only when a listener would plausibly notice the pacing. The
  pause is how long nobody speaks around the trim on the session clock
  (`SessionAir.silence_around`: from the end of the last live word of any dialogue track
  before it to the start of the first after it), so a track's long gap that a peer talks across is judged by the pause actually heard, and the track's own word
  gap when no other word bounds it. The rule is relative to each pause, not to the lab
  tape, and it only drops trims: every kept trim has the span, pad and scope it had
  without it, and the twins are resolved before it so a dropped trim never frees one.
- **Review or apply.** A pause trim is reviewed or applied by the same checks a filler gets
  (join continuity, scope and the speech guard, risky and voiced edges, `:interior_speech`,
  `:interior_audio`): one that passes them has `review_required` false, applies with
  `apply_edits` and the pipeline's `tighten_from_transcript`, and joins Studio's Apply
  eligible; one that does not stays for review. `:air_edges` labels a span that differs from
  the one pacing proposed, whether the air rule moved it or a kept-voice walk did before
  the rule ran, and raises no review: both of its edges are in air by construction. A pause
  trim is never merged into a filler, a track-local cut or an NL cut beside it
  (`_keeps_independent_review`), so its label, its scope and its pad stay its own. The
  server marks each pause trim that stays for review `listen_one_by_one`
  (`tighten_hits.py`), and Studio's Apply eligible takes that flag, not a reason prefix it
  parses itself: it never batches one, whatever Avoid harsh cuts says, and a hit the server
  never classified is not batched either. A trim with nothing left is skipped as `no_air`.
- **Approval reads what the lanes play now.** Approving a session cut re-runs the speech
  guard against the project as it stands. The guard reads a rendered stem only while it is
  fresh, and otherwise the recordings through each track's lane (`lane_window`, the mapping
  the air is read through), because after an earlier ripple a stem still holds the old
  timeline: round 7 read it at the later cut's new seconds, found a peer speaking in what
  the lanes had made silence, and punched a hole that shortened nothing, in 50 of 138
  approvals one at a time. A session cut a peer is now truly speaking over, or that the guard
  cannot check, is not applied: `approve_edits` raises `ScopeChangedAtApproval`
  (`cut_scope_changed`, "This cut was not applied: Avery is speaking where it would be cut
  from every track ... Nothing changed. Reject it, or cut that part of the track on its
  own"), and the auto path leaves the decision pending. One at a time and together now
  remove the same time, in any order.
- **A pad longer than the span.** When earlier ripples left the next word less retained
  air than pacing's floor, the trim pads the shortfall with silence. What the trim removes
  less that pad must still clear the minimum a cut may remove (`too_short` otherwise), and
  the check runs on the span the air rule leaves, so a trim never lengthens the timeline.

What this means for listening:

- An edge sits inside no sound that rises out of its recording's room in either band, on
  the trim's track or a peer's, and a guard frame clear of the stretch that stays over two
  spreads. What is under that is not seen: the last stretch of a decay within two spreads
  of the room's median (a dB or two in a steady room) is the last thing the rule cannot
  see, and a tonal decay can still be audible in a narrow band under it. In the synthetic
  scenes that is a 160 Hz tonal tail (6 of 20 trims audible after the high-pass, at most 2.1
  dB over threshold) and a slow tail at 120 or 130 Hz decaying half a dB per 10 ms (5 and 2
  of 20, at most 2.6 dB).
- A sound quieter than 40 dB under the speech level may be gone whole (a breath 45 dB
  down between two stretches of air). A sound that reaches that level stays, even
  mid-pause.
- A recording whose room tone sits within 40 dB of its speech (a noisy room, a quiet
  speaker, a busy bleed-filled stretch) gets few or no pause trims. A turn-taking gap
  that a peer talks across gets only the air before and after the talk, never the
  talk: a peer's sound that reaches the ceiling splits the air as the trim's own would.
- Round 7 keeps less air than round 6 for this: 138 pause decisions at medium against 120
  on the lab tape, but the synthetic scenes keep 2.5 to 5 points less of each pause, and
  some trims are shorter or gone (R02). Round 8 proposes fewer still, by dropping the trims
  nobody would hear: 66 at medium, carrying 88.8% of round 7's seconds.

Limits. The rule reads levels, so it can only see what a level shows:

- A bed that is steady under everything the recording shows is the room. The synthetic
  chord 50 dB under the speech (8 dB over the true room, continuous) is air by this
  rule; one within 40 dB of the speech is not (the ceiling). Nothing in a recording's
  levels tells a steady bed from a steady hum.
- Rumble inside the speech band is room. A 100 to 160 Hz rumble at -60 dBFS over a -74 dBFS
  room leaves all 20 of 20 trials with no air (round 6: 17 of 20), none with an edge inside
  a breath; a flat rumble up to 110 Hz is 38.5 dB down and does not reach the speech-band
  levels, though the low band reads what is near 100 Hz.
- A room that wanders gives up air. Its swing over its quarter-second floor is sound, so a
  +/-6 dB wander keeps 0.36 of a pause (round 6: 0.42) and a short pause in one keeps 0.24.
- A room that swings flat through a range, with no peak to read, reads narrow: the upper
  part of the swing is called sound and the air there is given up, which errs toward
  keeping sound.
- Content under 100 Hz that is not tonal, and a tonal sound the low band weights less (80 or
  160 Hz: 7.7 dB down; 60 Hz: 17.4 dB down), reads low. A 100 to 130 Hz tonal tail
  decaying 1 dB per 10 ms left 14 to 20 of 20 trims audible after the high-pass in round 6
  and 0 in round 7; at 160 Hz 11 of 20 became 6. A deep voice's speech level reads 1 to 8
  dB lower in the speech band, so it keeps more sounds whole and reaches the "cannot tell
  air from sound" rule sooner.
- Sounds on a denoised floor. The lab host's floor is denoised: it jitters by 1.7 dB or
  more frame to frame and dips to digital zero. A word's last tail or a breath that stays
  within about four spreads of it and under 80 ms is the floor to any level rule. Six edges
  on five of the 138 trims at medium sit there by the verifier's own-track detector (two
  inside a word's tail, four in a fade), each with the detector's wide-band reading at most
  0.2 dB over the room; measured in real renders (speech at 80 dB SPL, ISO 226 threshold,
  after the render's 80 Hz high-pass) all six are below threshold in every third octave
  (-1.5 to -9.2 dB at the worst band). Over all 70 edges any detector tier flags at medium,
  12 sit above threshold, the worst 3.5 dB at 5 kHz (the end edge of the trim at 12.92 to
  13.00 s, 800 ms after a word and 1.26 s before the next, flagged by the full-band 3 dB
  tier alone) and 1.5, 1.1, 1.0 and 1.0 dB at the next four. Lab detectors also disagree
  about quiet air on that floor, which wanders by 10 dB. A detector flag on an edge that is
  inaudible after the high-pass is not a defect. The round 7 aggressive flag at 1183.60 to
  1183.71 (+5.4 dB at 635 Hz, the host's end edge) sits 170 ms after a decayed word in room tone
  (speech-band levels of -89 to -91 dBFS against a room of -91), with a 20 ms bump 9 dB over
  the room on the removed side: both
  32 ms sides read under the ISO 226 threshold at 635 Hz (about 0 and -10 dB SPL against
  3.0), and that 110 ms trim of a 1.10 s pause removes a tenth of it, so round 8 does not
  propose it.
- A track with its audio unreadable or its extra source missing is skipped as `no_room`,
  not guessed.
- A recording with no words reads its own speech level from all its frames, so a talker
  who speaks under a tenth of the time keeps every sound whole, and one whose room is
  within 40 dB of its speech gives up its air as a transcribed one does. Untranscribed
  speech also bleeds into the other mics' session silence, which a transcribed peer's room
  reads through its 5th percentile; the lab host's peers are gated and read digital zero.
- The pause a trim is judged against is bounded by words. Untranscribed speech does not
  shorten it, so a trim beside an untranscribed talker is judged against a longer pause
  than a listener hears and may be dropped as `imperceptible`; it never makes a trim that
  would be proposed otherwise.

Listened: the owner listened to every #1055 round 4 to 7 clip set and approved them all (round 7: 107 clips); every kept round 8 trim has the span of a round 7 trim.

## Mute vs cut

`tighten.edit_mode` (default **`ripple`**) still proposes `EditDecisionType.REMOVE` and applies via session ripple or track-local punch. Set **`edit_mode: mute`** (config, or `propose_edits(..., edit_mode="mute")` / `--edit-mode mute`) to propose **`MUTE`** decisions instead: the same filler candidate pipeline and `filler:` reasons, same `review_required` gating, but apply/approve writes **`Clip.mute_regions`** (`{start_s, end_s, fade_out_ms, fade_in_ms, fill?}` source-media seconds) and does **not** move clips or change `timeline.duration_sec`. Render fades the clip out over each region's first `fade_out_ms` and back in over its last `fade_in_ms` (5 ms each unless set) and lays the region's fill under it, so the hole does not click.

### Decision: Ripple by default; mute in place for timing-locked work

<!-- decision
id: D-mute-in-place-opt-in
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1024 owner: "Mute stays opt-in for timing-locked work."
- #1024 owner: "A mute should honour the existing `tighten.filler_pad_mode`"
- #1065 owner direction: "silence in place is for timing-locked work, with the gap filled the way a cut's gap is"
- #1065 owner listening on 9 A/B clips: 6 approved; 2 started mid-um (fixed by #1075), 1 was bleed (#1071)
enforced-by:
- tests/test_mute_in_place.py::test_approved_mute_is_filled_like_the_ripple_pad
- tests/test_mute_in_place.py::test_approved_mute_fades_like_a_padded_cut
- tests/test_mute_in_place.py::test_invalid_edit_mode_falls_back_to_ripple
- tests/test_fillers.py::test_a_mute_fades_each_edge_against_fill_so_the_join_gate_skips_it
- docs-sync: decision-filler-cuts
-->

Ripple stays the default. Mute keeps the timeline length for work locked to
picture or other timing, and fills its gap the way a ripple pad fills a cut
(**Fill, not hole** below). The fill default is room tone (**Decision: Room tone
is the default fill** below).

**A mute is two faded edges on one track, not a splice** (#1024) — Nothing butts together and no other track changes: approving a mute renders the padded cut's edges (`decisions._apply_mute_edit`). The clip fades out over `filler_pre_pad_fade_out_ms` ending at the cut start and back in over `recommend_post_pad_fade_in_ms` from the cut end, cut down to end before the decision's `next_burst_sec`, so the fades fall on the kept audio either side exactly where a padded cut puts them and the cut itself is silent end to end. The region stored is the cut widened by those fades (revert subtracts all of it). On the lab tape three of the six word fillers resume into sound 10-28 dB under speech (`uh` 646.84, `uh` 706.00, `you know` 1440.88), where the recommendation is 92-120 ms; a fixed 5 ms ramp there starts the next word abruptly. The checks that score a join (the cut-risk level-jump terms and the join continuity gate) therefore skip a mute, as they skip a padded cut, and the padded-cut checks run: the right edge stops 10 ms before the next word's acoustic onset (dropped as `next_onset` when that would leave the filler), a burst within reach travels on the decision as `next_burst_sec`, and a mute may not cover a whole kept word (`kept_word:{word}`). Four more checks follow from what a mute is (`_EDGE_CHECKS` in `edits/fillers.py`):

- **Breaths stay whole.** Best practice keeps breaths, so a mute edge never chops one and a mute never removes one. `protect_cut_breaths(strict=False)` moves an edge that sits inside a complete breath out of it, and drops a span that a breath covers at least half of as `breath`: either the breath run inside the span, or a complete breath traced back to room tone (any span covering half the cut contains its midpoint, so the edge evidence there decides). Unlike a splice (`strict=True`), an edge may sit in other connected activity, such as a filler running into a word; the splice rule dropped all six word fillers.
- **An acoustic run that runs into a kept word is that word's sound.** An acoustic gap run has no word label, so when its voiced audio runs on into a kept word at either edge (the voiced-edge check cannot nudge a bounded candidate clear), a mute drops it as `voiced_edge`. A splice's strict breath protection already refuses such an edge. Before either, every join holds an acoustic run clear of the flanking words' voices read by level, not pitch (**Kept words keep their voice**), so a breathy word tail with no clear pitch is caught as `kept_voice` too (lab `So` at 230.78). A word filler keeps its `:voiced_edge` review flag instead: ASR says the voiced audio is the filler.
- **A mute must silence something audible.** It keeps the time, so muting audio below `analysis.heuristics.audibility_rms_db` (span RMS) changes nothing a listener hears; it is dropped as `inaudible`. A ripple still removes time there.
- **Peers do not matter.** A mute's scope is `track`. Peer speech never scopes it, never flags it (`track_local`, `other_speaking`, `interior_speech`) and never nudges its edges; the bleed-owner check and the acoustic scan's peer-voice test, which decide whose voice the audio is, still run.

Lab (`aligned-ready`, refine waived; ripple proposal byte-identical throughout). Before #1024 mute mode proposed 11 hits and no word filler. Dropping the splice checks alone proposed 222: the six Caleb fillers (`uh` 604.62, `um` 616.30, `uh` 646.84, `uh` 706.00, `um` 712.99, `you know` 1440.88), 13 repetitions/restarts and 203 acoustic runs. Heard alone and measured, those 203 were 112 runs into a kept word, 26 breaths or breath-like unvoiced noise, 22 quiet sounds 15 dB or more under the speaker, 6 bleed, 9 missed words or laughs and 28 vocal hesitations. With these checks mute mode proposes 53: the six fillers, the 13 repetitions/restarts, and 34 acoustic runs (21 vocal hesitations within 9 dB of speech, 5 missed words or a laugh, 7 quiet sounds, 1 unvoiced). Skips: `acoustic:voiced_edge` 134, `acoustic:inaudible` 26, `acoustic:breath` 29 (12 at the scan, 17 at the edges). Acoustic hits stay review-only.

**No gap to keep** (#1064) — Pacing's gap rule is for a ripple. It shrinks a cut, or drops it as `pacing`, so that the flanking words keep `min_gap_after_filler_sec` once the gap closes. A mute closes nothing, so pacing never shrinks or drops one (`apply_filler_pacing(keeps_time=True)`), and an acoustic run is muted whole. The room-tone expansion still sets a word filler's span, so a mute silences what a padded ripple would remove. Lab (rev 3b414c4c, `aligned-ready`, mute): proposals went from 54 to 57 and `acoustic:pacing` from 7 to 0. All 7 runs sat in 0.36 s gaps. That is the narrowest gap the 0.35 s scan floor admits on 20 ms word times, and too short to keep 0.35 s and still cut 20 ms. Each run starts 25 ms after the previous word ends. Unshrunk, 6 fail `voiced_edge` and 1 fails `breath`, so none is proposed. Shrinking had hidden the same verdicts behind `too_short` (23 to 1) and `reparandum` (5 to 0). 3 runs are newly proposed (230.81, since dropped by **Kept words keep their voice**, 1644.50, 1646.56), 2 are muted whole instead of shrunk (60.80, 874.78), and the word fillers and every ripple proposal are unchanged. With Whisper word times (`edit-ready`) mute proposals went from 39 to 38: the one `pacing` skip fails `voiced_edge`, 3 runs are muted whole, and the run at 267.24 is dropped as `inaudible`, because its full span averages under the audibility floor where the shrunk one did not.

**Fill, not hole** — Dialogue editors fill a gap with matching room tone, because dead air on a track with a noise floor reads as a dropout. Approving a mute lays under it the fill a ripple pad gets from `tighten.filler_pad_mode`. `silence` leaves digital silence. With `room_tone` (the default), approval picks a sample once with the ripple pad's sampler (**Where room tone comes from** below), nearest the middle of the mute. It stores the sample on the region as `fill` (`{source_id, start_s, end_s}`), and render tiles it under the region with fades that cross the clip's: in over the region's fade-out, out over its fade-in. A track with no bed and no room tone (a Zoom-gated track, whose gaps are already digital silence) keeps a silent mute, as a ripple pad would. GUI exact-range mutes stay silent.

**Where room tone comes from** (#1054, `edits/room_tone.py`). With `room_tone`, a ripple pad, an approved mute and `fill_with_room_tone` all ask one sampler for a stretch of the track's room near the cut. A recorded `track.room_tone` bed wins when its `sources[]` entry exists and it is not digital silence. Otherwise the sample comes from the track's own audio, read once per file version as 10 ms frame levels at 16 kHz. Word times are not consulted, because a transcript gap can hold speech the transcript missed (#979).

| Rule | Value | Why |
|---|---|---|
| Noise floor | 10th percentile of the track's live frames (digital silence excluded) | The breath detector's floor rule, over the whole track |
| Speech level | 90th percentile of the frames more than 10 dB above the floor | A track with little speech still measures its voice, not its floor |
| Gated track | No room tone when more of the track is digital silence than live frames within 10 dB of the floor | Its bed is the silence, so a hole already matches it. Its live frames are speech, whose quiet onsets and tails would otherwise pass for a floor; this does not depend on Silero |
| Quiet run | Every frame live and within 10 dB of the floor, less 0.15 s at each end that meets louder audio or digital silence | Room tone is steady; a click, breath or syllable ends the run. At its edges a word's attack or reverb tail, or a gate's, still sits at the floor's level, where no level check can tell it from room |
| Candidate | Window of the requested length nearest the cut, from each run at least 0.25 s long (or the request, if shorter) | Shorter scraps tile as a flutter |
| Ranking | Runs nearest the cut first, at most 16 tried | Every run sits at the floor, so the nearest matches the room at the cut |
| `above_floor` | Window RMS at most 6 dB over the floor | The fill sits at the floor |
| `near_speech` | Window RMS at least 30 dB under the speech level | The owner heard bleed turned down 20 dB as an echo of the voice (#945); 10 dB more clears it |
| `voiced` | Silero speech probability under 0.5 | No voice, even at the floor |
| Pending cuts | A ripple pad skips source seconds that another pending cut on the track still plays (`avoid`) | A cut maps to the session time its source seconds play at. A pad that replays them elsewhere makes the cut play in two places, and approving it removes all between, other tracks' words included. Approving a batch then asked to confirm, or the pipeline held the cut |

The first window that passes every check is the fill; the caller tiles it when it is shorter than the gap, fading only the pad's outer edges (10 ms in on the first tile, 10 ms out on the last) so the seams carry no dip. A window that cannot be measured (an unreadable file, or a Silero error) fails like any other check. A track with no passing window, such as a Zoom-gated track whose gaps are digital silence, keeps a silent pad or mute. Spectral flatness is not a check: on the lab tape the room floor's flatness (median 0.019, 10th percentile 0.005) overlaps voice and bleed (median 0.005), so no threshold separates them.

Lab tape (`aligned-ready`, every ripple and mute proposal approved with `room_tone`): main picked 69 samples and none sat within 6 dB of its track's floor. 39 were within 30 dB of speech, and one was 0.8 dB louder than Caleb's speech level. Audra's speech at −23.7 dBFS filled a pad at 615.93. With the sampler, all 51 picks on Caleb's track sit −3.0 to +6.5 dB from his −75.3 dBFS floor and at least 53.6 dB under his speech; Audra's and Lana's gated tracks stay silent. Without the 0.15 s edge guard, 36 of the 42 distinct mute fills started or ended within 50 ms of louder audio, and 8 rose more than 3 dB in the 80–400 Hz voice band over their first or last 60 ms (a word's tail or onset); with it, none and 2. Caleb's tails take 130 ms to settle to the quiet run's median level at the 90th percentile, and onsets 70 ms. The guard leaves fewer runs, so his fills come from a median 24.7 s from the cut instead of 1.0 s, all at his floor. Reading the three 28-minute tracks costs about 1.2 s each, once per process.

**Pause candidates are skipped in mute mode** — muting a pause is a no-op (the gap is already silence). Use ripple when you want to shorten dead air.

**A span already muted is not proposed again** (#1002) — Approving a mute removes the decision from `edit_decisions` and leaves the word in the transcript, so nothing else records it. `_resolve_analyzed_cuts` (the one pass every filler, repetition and acoustic candidate goes through) therefore reads what render silences: the track's `Clip.mute_regions`, merged across its clips. A mute-mode cut whose final span they fully cover (within 1 ms) is dropped and counted as `already_muted`. A cut that only partly overlaps a mute is still proposed, since part of it is audible. Ripple cuts never read `mute_regions`, so ripple mode is unchanged. On the lab tape, approving the acoustic hit at 40.31-40.995 s and re-running Find hits went from 4 hits (the same span back pending) to 3 hits with `already_muted: 1`.

Pending `EditDecision` fields are unchanged (`type` was already `remove|mute|split`). After apply, the pending row is archived like a remove; the audible hole lives on the clip. Undo via `ProjectWorkspace.mutate()` restores `mute_regions`. `RestoreAppliedEdit` / MCP `revert_applied_edit` on a mute archive (`params.mute`) subtracts intersecting source spans in place — it does **not** ripple or re-insert clips. Use History undo for snapshots that predate the mute row. `SuggestPendingEdit` accepts `edit_type: mute` (default `remove`). `UpdatePendingEdit` already updates MUTE ranges the same way as REMOVE.

Do not mix mute-in-place with track volume envelopes: Levels automation stays on `mix.automation_envelopes`; filler mutes are clip-local so they do not fight a user envelope.

Pipeline `tighten.enabled` stays **false**; mute mode is for manual propose → review → approve.

### Decision: Room tone is the default fill

<!-- decision
id: D-room-tone-default-fill
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- 2026-10-06 owner: room tone is the default pause fill, so `tighten.filler_pad_mode` defaults to `room_tone`
- #1054, #1114 the sampler picks only a steady stretch at the track's floor and leaves a gated or noisy track silent
enforced-by:
- tests/test_filler_pacing.py::test_filler_pad_mode_defaults_to_room_tone
- tests/test_filler_pacing.py::test_shipped_defaults_fill_pads_with_room_tone
- docs-sync: decision-filler-cuts
-->

A ripple pad and an approved mute fill with the track's room, because dead air
on a track with a noise floor reads as a dropout (**Fill, not hole**). The
sampler (**Where room tone comes from**) takes only true room floor, so a track
with no such stretch, such as a Zoom-gated track, keeps a silent pad. Set
`tighten.filler_pad_mode: silence` for a hard gap on every track. Any other value is rejected
when the config is loaded, with an error naming `silence` and `room_tone`.

## Risk model

`assess_cut_risk` in `edits/cut_quality.py` scores each candidate using:

| Signal | Effect |
|--------|--------|
| Low boundary optimizer confidence | Higher risk |
| Cut within `inaudible_cuts.min_word_margin_ms` of retained words | Higher risk |
| Low ASR confidence on filler token | Higher risk |
| Harsh level jump at start/end join | Higher risk |
| Very short cut window (&lt; 20 ms) | Higher risk |

When normalized score ≥ `tighten.max_cut_risk_score` (default `0.65`), the cut is **skipped** if `leave_in_if_risky` is true, or marked `review_required` with reason suffix `:risky` when false.

## Render joins

Dialogue cuts default to **fade joins** (`join_in_mode=fade`): hard concat with per-segment `afade` declick. Fade length is capped at `render.join_fade_max_ms` (default 40 ms) so multitrack stems stay the same length.

**Crossfade** (`join_in_mode=crossfade`) is opt-in only (set it with `set_clip_join_tool`, which also sets the fades the overlap needs; `set_join_mode_tool` changes the mode alone) — FFmpeg `acrossfade` overlap that shortens the rendered track. Use `crossfade_joins_tool` for music beds or when the user explicitly wants overlapping blend. Configure curve via `render.crossfade_curve` (default `tri`).

**Which neighbours count as a join:** one rule for every join mode — `clips_abut` in `edits/clips_ops.py`, a timeline gap of at most `JOIN_GAP_TOLERANCE_SEC` (50 ms). A gap within the tolerance closes up when rendered (fade and cut joins concat; crossfade joins crossfade), so the stem is shorter than the timeline by that gap, and by the crossfade overlap for crossfade joins. A wider gap stays as silence and gets no crossfade. Crossfade joins with a 1–50 ms gap used to render as fade joins; when render rules like this change, `RENDER_SEMANTICS_REV` in `engines/timeline_render.py` is bumped so cached stems and play segments re-render. Rev 3 made a cut per join: only the next clip's cut drops a clip's fade-out, and a clip's own cut drops its fade-in only when it has a left neighbour (a track's first clip has no join). Rev 7 keeps nested multi-recording overlaps at their authored timeline positions by comparing each placement with the accumulated rendered end; segment renders use the same rule and retain join fades from lane neighbors just outside the requested window. Rev 8 uses the same source-aware placement assembly for every segment window, including windows whose selected clips all use one recording. It preserves summed overlaps and requested leading/trailing timeline holes while subtracting cut and join contraction from the output duration. Rev 9 resets the sample clock after a summed overlap before later pad/concat joins, preserving sample-accurate output length. Rev 12 reads every input through `MediaSeek`, so a `.m4a` window no longer starts up to one AAC frame late (#1141).

Hard joins (`join_in_mode=cut`, zero fades) use plain concat. See [inaudible-cuts.md](inaudible-cuts.md).

## CLI / MCP

Omit track and speaker for a session handoff to require quiet across all dialogue lanes, including muted lanes. Explicit selectors analyze one lane. Results list the analyzed `track_ids`. Missing or incomplete evidence cannot qualify a hop as quiet; each proposed boundary must lie in a shared measured quiet island. See [Narrative handoffs](inaudible-cuts.md#narrative-handoffs) for evidence and locking bounds.

- `podcast propose-edits` / `propose_edits` — proposals include optimized boundaries and per-cut `crossfade_ms`. The MCP payload is `{operation, edits, skip_counts, summary}` (`operation` is `propose_edits`; not a bare array). `skip_counts` maps `discourse:{token}` → kept uses, including isolated cluster-size rejects, `backchannel:{phrase}` → acknowledgments left in, `kept_word:{word}` → padded cuts and mutes dropped for covering a whole kept word, and `next_onset` → padded cuts and mutes dropped because ending before the next word's onset would leave the filler. Every candidate analysis rejects is counted under one reason: `breath` (splice breath protection: an edge in sound that is not a complete breath; for a mute, a span that is mostly breath or whose edges cannot leave a breath whole), `no_air` (a pause trim with no air left in it on the tracks the ripple cuts), `no_room` (a pause trim on a track whose room tone cannot be measured: audio it cannot read, or under half a second of frames between its words even in the widened window), `shared_pause` (a session pause trim that overlaps a longer one proposed on another track, so the stretch is proposed once), `voiced_edge` (a mute of an acoustic run that runs on into a kept word), `inaudible` (a mute of audio below the audibility floor), `too_short`, `reparandum` (a repeat cut no longer covers its reparandum), `bounds` (the span left the candidate's bounds), `not_owner` (the span is a peer's bleed), `pacing`, `scope`, `other_speaking` (a pause under a peer's speech), `unsettled_edges`, `unstable_scope`, `risky`, `join_continuity`, `next_onset`, `kept_word:{word}`, `filler_onset` (the filler's voice runs on from the kept word before it, #1061) and `kept_voice` (a cut that keeps clear of the flanking kept words' voices is too short or misses its target, or, without words of its own, a kept word's voice runs on through it, #1064). An acoustic gap candidate's reason is prefixed `acoustic:`. CLI prints `proposal.summary()`.
- Re-proposing (CLI, MCP, or Sharecut Studio **Find hits**) replaces every pending generated `filler:` / `pause:` / repetition / restart / acoustic hit, including ones the generator flagged for review (`:voiced_edge`, `:risky`, `:other_speaking`, `:join_review`, `:air_edges`) and ones a human nudged. Applied hits and manual, NL and focus edits stay. Re-running on an unchanged project returns the same hits in the same order (#995), with the same ids (#999).
- A generated hit's id is its identity, not a random token: `cut_<kind>_<start ms>_<end ms>_<track digest>`, from the hit's track, its kind (`filler` (lexical or acoustic), `pause`, `repeat`, `restart`) and the source span it targets (the filler, repeated or restarted words, the acoustic run, or a pause's whole word gap). Cut edges, review flags and a pause's trim end are analysis output, so a hit keeps its id when intensity or analysis moves them, and an Ask thread on it stays attached. A fresh hit whose id an existing decision already holds (an applied copy, or a pending one under `replace_existing=False`) is skipped as `same_hit`. Editing the transcript under a hit gives it a new id.
- `podcast apply-edits` / `apply_edits` — applies via batch ripple + per-join fades (`apply_join_fades_from_decisions`).

Tune behavior in `.agents/defaults/pipeline.yaml` (or a project-local override). Full guide below.

## Tuning guide

Start from defaults, **propose without apply**, listen, then adjust one knob at a time.

```bash
podcast propose-edits --project episode.project.json
# Review edit_decisions; audition with play --compare or processed stems
podcast apply-edits --project episode.project.json   # when happy
```

Per-episode overrides: copy relevant keys from `tighten:` / `inaudible_cuts:` / `render:` into your project's pipeline config or pass defaults when calling MCP tools.

### Symptom → knob

| You hear / see | Turn this | Direction |
|----------------|-----------|-----------|
| Too many isolated ums proposed | `isolated_filler_candidates` | **`false`** (`light`); hard fillers then need `min_filler_cluster` |
| Not enough discourse markers proposed | `min_filler_cluster` | **Down** (`1`, aggressive) |
| Cuts land mid-word / clip consonants | `inaudible_opt` | **On**; widen `inaudible_cuts.search_window_ms` slightly |
| Cuts too close to neighboring words | `inaudible_cuts.min_word_margin_ms` | **Up** (e.g. `10–15`) |
| Obvious clicks or level jumps at joins | `fade_joins_tool` or `recommend_fades_tool` | Run after apply; check `render.join_fade_max_ms` |
| Edits sound "scooped" or too soft | `crossfade_ms` / `recommended_fade_ms` | **Down** slightly; avoid accidental `crossfade_joins` |
| Robotic, rushed cadence after tighten | `min_retained_pause_sec` / `min_retained_solo_pause_sec` / `min_gap_after_filler_sec` / `filler_gap_retain_fraction` | **Up** floor or retain fraction |
| Thinking / list-restart pauses feel slammed | `min_retained_solo_pause_sec` | **Up** (e.g. `0.65–0.8`); or leave the pause uncut |
| Words smash after um/uh / you-know cut | `filler_gap_retain_fraction` / `min_gap_after_filler_sec`; keep `filler_room_tone_replace: true` | **Up** retain (e.g. `0.65–0.75`); or leave filler in |
| Dirty air / mouth noise left at filler joins | `filler_room_tone_replace` + `filler_pad_mode` | Replace on; `room_tone` (default) fills with the track's room, or set `silence` for a hard gap |
| Prefer keeping original pause audio over pad | `filler_room_tone_replace` | **`false`** (shrink cut to leave original air) |
| Sampled room tone mismatches the join | `filler_pad_mode` | Set **`silence`**, or record a `track.room_tone` bed. The sampler only takes a steady stretch at the track's floor, so a mismatch means the room itself changes across the episode |
| Mid-word chop when ASR missed a word on another mic | `speech_energy_guard` | Keep **`enabled`**; default `on_conflict: track_local` |
| A proposal carries `:interior_speech` | the transcript, not a knob | A track the ripple removes has voice there Whisper dropped; re-transcribe or add the words, then re-propose |
| A `pause:` proposal carries `:interior_audio` | `analysis.heuristics.audibility_rms_db` | Audible but unvoiced material (a fricative, a laugh) on a rippled track; listen before approving |
| A `pause:` proposal carries `:air_edges` | none | The trim moved off the span pacing proposed (the air rule, or a kept-voice walk before it), onto the air inside the pause, off a word tail, a breath or a peer's onset at an edge; a label only: it raises no review |
| Cuts carry `:voiced_edge` | `analysis.heuristics.audibility_rms_db` | Voice runs through both sides of the edge with no silence inside the candidate's bounds; listen, or leave the cut in |
| Long dead air remains | `max_pause_sec` | **Down** (e.g. `0.9`) |
| Dangling breaths after filler cuts | `breath_handling.enabled` | **On**; widen `search_before_ms` / `search_after_ms` |
| Good cuts skipped; too conservative | `max_cut_risk_score` | **Up** (e.g. `0.75–0.85`) |
| Bad cuts still applied | `max_cut_risk_score` | **Down** (e.g. `0.45–0.55`) |
| ASR mis-tags real words as fillers | `min_filler_confidence` | **Up**; trim `filler_words` list |
| Fluent / quotative “like” still proposed | `discourse_markers` / `discourse_pause_sec` / `discourse_confidence_max` | Keep markers in the list; raise pause floor or lower confidence max if needed |
| Want `like` treated as a hard filler again | `discourse_markers` | Remove `like` from the list (empty list = no demotion) |
| Want manual review on borderline cuts | `leave_in_if_risky` | **`false`** (marks `:risky`, `review_required`) |

### Intensity presets

`tighten.intensity` selects a named, deterministic overlay on the keys below. No model calls: the same transcript always yields the same proposals. The source of truth is `TIGHTEN_INTENSITY_PRESETS` in `edits/tighten_intensity.py`.

| Tier | Overrides |
|------|-----------|
| `light` | `filler_words: [um, uh, erm]`, `isolated_filler_candidates: false`, `min_filler_confidence: 0.5`, `max_cut_risk_score: 0.5`, `max_pause_sec: 2.0`, `min_retained_pause_sec: 0.5`, `min_retained_solo_pause_sec: 0.75`, `repetition_candidates: false`, `acoustic_gap_filler.enabled: false` (clustered um/uh only; never trim a pause below 0.5 s) |
| `medium` (default) | none: the shipped `tighten` block unchanged |
| `aggressive` | `min_filler_cluster: 1`, `discourse_pause_sec: 0.2`, `discourse_confidence_max: 0.85`, `max_pause_sec: 0.8`, `min_retained_solo_pause_sec: 0.3`, `max_cut_risk_score: 0.8`, `repetition_candidates: true`, `acoustic_gap_filler.enabled: true` (isolated and borderline discourse markers, 0.3 s solo pauses) |

- **Precedence:** explicit argument (CLI `--intensity`, MCP `intensity=`, golden-ear `--intensity`) > `tighten.intensity` in config > `medium`. Unknown names raise; blank means `medium`; matching is case-insensitive. Both `propose_tighten_edits` and the single-transcript `analyze_fillers_and_pauses` resolve the tier (`with_tighten_intensity`).
- **Where `tighten.intensity` comes from:** the Tighten tab, **Find hits**, GUI pipeline runs and MCP `pipeline_run` (`use_working_set=True` by default) read the project's pipeline working set (what the Tighten or Pipeline tab last saved), so an agent-driven `pipeline_run(only_step="analyze_fillers_pauses")` uses the Tighten tab tier. CLI `podcast propose-edits` and MCP `propose_edits` read only the shipped `.agents/defaults/pipeline.yaml` plus their explicit `--intensity` / `intensity=`, so a tier picked in the Tighten tab does not carry over to them; pass the tier explicitly.
- `light` / `aggressive` override only the keys they name (nested dicts merge), and only where your config still holds the shipped `.agents/defaults/pipeline.yaml` value. A key the working set changed from that file (by hand in the Pipeline tab, or applied by Pipeline Analyze), such as `max_pause_sec` or an extended `filler_words` list, wins over the tier. Editing `.agents/defaults/pipeline.yaml` itself (or the file named by `PODCAST_MCP_PIPELINE_DEFAULTS`) moves the baseline, so the tier still overrides those edits. A key set back to exactly the shipped value cannot be told apart from an untouched one, so the tier applies there. The Pipeline tab shows the base config, not the tier-adjusted values.
- Presets are **propose-only**: they change what is proposed, never auto-apply, and `tighten.enabled` is unchanged. Discourse-marker demotion stays on at every tier.
- Surfaces: `podcast propose-edits --intensity`, MCP `propose_edits(intensity=...)`, the Tighten tab **Intensity** + **Find hits**, the Pipeline tab "Tighten intensity", and golden-ear `--intensity`.

### Key parameters reference

| Key | Default | Role |
|-----|---------|------|
| `tighten.intensity` | `medium` | `light` / `medium` / `aggressive` preset overlay (see Intensity presets) |
| `tighten.repetition_candidates` | `true` | Propose review-only `repetition:` / `restart:` hits (`light` turns this off) |
| `tighten.isolated_filler_candidates` | `true` | Propose a lone hard filler without a cluster (`light` turns this off) |
| `tighten.min_filler_cluster` | `2` | Min lexicon hits in a cluster before a discourse marker (or, with `isolated_filler_candidates: false`, a hard filler) is a candidate |
| `tighten.filler_cluster_gap_sec` | `2.0` | Max gap between fillers in one cluster |
| `tighten.filler_words` | um, uh, … | Token list; includes discourse markers. Matched in lexicon form (case and edge punctuation ignored) |
| `tighten.discourse_markers` | like, you know, sort of, kind of | Demoted lexicon tokens (phrase-matched); cut only with adjacent disfluency/repeat, pause bound, or low ASR confidence. YAML-only (no Advanced list widget). Missing key = defaults; `[]` disables demotion. |
| `tighten.backchannels` | uh huh, uh-huh, mm hmm, mm-hmm, mm hm, mm-hm, mhm, uh-uh | Acknowledgments matched before fillers and never proposed; counted as `backchannel:{phrase}` skips. `[]` disables. |
| `tighten.discourse_pause_sec` | `0.35` | Min flanking pause that qualifies a discourse marker |
| `tighten.discourse_confidence_max` | `0.6` | ASR confidence below this qualifies a discourse marker |
| `tighten.max_pause_sec` | `1.2` | Inter-word gap before pause trim |
| `tighten.min_retained_pause_sec` | `0.18` | Gap left after pause trim when a peer is speaking in the gap |
| `tighten.min_retained_solo_pause_sec` | `0.55` | Gap left for same-speaker pauses with quiet peers (thinking / restart) |
| `tighten.min_gap_after_filler_sec` | `0.35` | Min beat after short filler cuts (um/uh floor); ripple only, a mute keeps its gap |
| `tighten.filler_gap_retain_fraction` | `0.85` | Fraction of original inter-word gap kept as pad |
| `tighten.filler_replace_gap_max_sec` | `1.0` | Hard cap on paced pad length |
| `tighten.filler_next_word_lead_in_ms` | `80` | Keep this much before next word onset after replace |
| `tighten.filler_prev_word_lead_out_min_ms` | `40` | Floor for adaptive previous-word release keep |
| `tighten.filler_prev_word_lead_out_max_ms` | `250` | Cap for adaptive previous-word release keep |
| `tighten.filler_prev_word_look_ahead_ms` | `300` | Source look-ahead to find release quiet floor |
| `tighten.filler_pre_pad_fade_out_ms` | `5` | Declick out of previous word into paced pad |
| `tighten.filler_post_pad_fade_in_min_ms` | `15` | Floor for adaptive resume fade after pad |
| `tighten.filler_post_pad_fade_in_max_ms` | `120` | Cap for adaptive resume fade after pad |
| `tighten.filler_post_pad_look_ahead_ms` | `120` | Source look-ahead used to size resume fade |
| `tighten.filler_room_tone_replace` | `true` | Replace hesitation with paced pad (`clamp(min, gap×retain, max)`) |
| `tighten.filler_pad_mode` | `room_tone` | Fill for ripple pads and approved mutes: `room_tone` (recorded bed, else a steady stretch at the track's floor; none on a gated track; **Where room tone comes from**), or hard `silence` |
| `tighten.filler_room_tone_max_expand_sec` | `2.0` | Max expansion toward flanking words; larger gaps keep the local cut + pad |
| `tighten.speech_energy_guard.enabled` | `true` | Block session ripple when peers speak in the cut window |
| `tighten.speech_energy_guard.on_conflict` | `track_local` | `track_local` / `skip` / `review` |
| `tighten.leave_in_if_risky` | `true` | Skip high-risk cuts vs flag for review |
| `tighten.max_cut_risk_score` | `0.65` | Risk threshold (0–1 normalized) |
| `tighten.min_filler_confidence` | `0.15` | Min ASR confidence to trust filler token |
| `tighten.inaudible_opt` | `true` | Waveform snap on proposal and on application of unsnapped edits |
| `tighten.crossfade_ms` | `25` | Base fade; adaptive logic may go higher |
| `tighten.breath_handling.enabled` | `true` | Co-remove adjacent breaths and protect both final edges |
| `inaudible_cuts.min_word_margin_ms` | `5` | Min distance from retained word edges |
| `inaudible_cuts.max_shift_ms` | `80` | Max boundary snap |
| `analysis.heuristics.boundary_jump_db` | `12` | dB jump that triggers longer fades |
| `render.join_fade_max_ms` | `40` | Cap dialogue edge fades (fade join mode); harsh-join recommendations scale up to this; the DAW reads it as `TrackView.fade_max_ms` |
| `render.crossfade_curve` | `tri` | FFmpeg acrossfade curve when `join_in_mode=crossfade` |
| `tighten.acoustic_gap_filler.enabled` | `true` | Propose review-only `filler:acoustic` cuts for voiced audio inside ASR gaps (see below) |
| `tighten.acoustic_gap_filler.min_gap_sec` | `0.35` | Shortest inter-word gap scanned; values below `0.35` clamp up (max `10`) |
| `tighten.acoustic_gap_filler.max_run_sec` | `1.5` | Longest voiced run proposed; values above `1.5` clamp down (min `0.1`) |
| `tighten.acoustic_gap_filler.max_frames` | `600` | 10 ms analysis frames per gap (~6 s); gaps longer than the budget are skipped; values above `600` clamp down (min `20`) |
| `tighten.acoustic_gap_filler.vad_backend` | `heuristic` | Reject breath-shaped candidate runs with the shared RMS heuristic; `silero` is opt-in and falls back when unavailable or not at 16 kHz |

#### Acoustic gap candidates

When `tighten.acoustic_gap_filler.enabled` is on (the default), propose scans
the decoded 16 kHz track cache for a short voiced run inside an owner-word gap
of at least `min_gap_sec`. It never auto-cuts: every hit is `filler:acoustic`
with `review_required: true`, because ASR-free VAD can mistake breaths, noise,
laughter, music, or a missed word for a filler. **Listen before approving.**

Detection (`edits/acoustic_gap.py`, shared DSP in `util/dsp.py`):

- Gaps are skipped when either flanking word is suppressed, bleed, or
  speaker-matched to another track, or when another dialogue track has **voiced
  audio** inside the gap (peer bleed, counted as `acoustic:peer_speaking`).
  Peer occupancy is measured from the peer's own decoded track with the same
  voiced runs the cut-edge gate reads (`edits/voiced_runs.py`, audibility floor
  `analysis.heuristics.audibility_rms_db`), never from its ASR word spans (#982):
  a mistimed peer word can span seconds of digital silence on a gated track
  (Lana's `-huh.` spans 1438.48–1444.32 s on the lab tape) and used to block 220 of
  355 acoustic skips. A peer word over silent audio does not block a gap; an
  untranscribed peer voice does. A peer whose track did not decode supplies no
  evidence.
  A peer run is not peer speech when it is the cut track's own voice bleeding
  onto the peer's mic (#994). The run's RMS is compared with the cut track's RMS
  over the same frames, and a peer at least `analysis.heuristics.bleed_dominance_db`
  (6 dB) under the cut track is bleed, the same test the word audit applies from
  the other side. On the lab tape Caleb's mic carries Audra's voice on purpose, so
  her own hesitations were blocked by it. On the full lab episode 50 of 1,361
  peer runs read as bleed, with margins from 6 to 28 dB (14 under 10 dB), so a
  real peer "mm-hm" within a few dB of that margin can also read as bleed; the
  candidates it frees are review-only. A quiet or gated cut track never explains a peer run: a
  speaker whose own track is shut while their voice survives only on another
  track still blocks (#945), and so do independent voices at similar levels.
  `_peer_voiced_in_gap` is the single decision for peer occupancy.
- Frame levels (25 ms / 10 ms hop) must show real contrast: the loudest frame
  must sit at least 12 dB above the gap's 20th-percentile noise estimate, so
  flat hum, HVAC, or steady rumble never yields a candidate. Active frames must
  clear that noise estimate by 8 dB (and -55 dBFS); dips up to 60 ms are bridged.
- A run must last 0.1 s–`max_run_sec`, cover at most 80% of the gap (a longer
  run is a level plateau), and pass a speech-pitch (70–350 Hz) autocorrelation
  voicing check. Each surviving run is checked against the shared breath
  classifier using only that run's audio, so a breath elsewhere in the gap
  cannot veto it. The default RMS heuristic compares the run with up to 200 ms
  of speech inside each flanking ASR word and uses the quieter word as its
  reference. Both windows must be finite and above the configured audibility
  floor; without that context the RMS classifier abstains and keeps the run for
  review. Before the RMS band is applied, 40 ms pitch probes every 10 ms keep
  the run reviewable when any has clear speech-pitch periodicity (≥ 0.55); only
  low-energy, weakly periodic breath-like runs are rejected. This conservative
  check can leave uncertain breaths for the listener, and the relative RMS and
  normalized pitch comparisons are stable under overall gain changes.
  `vad_backend: silero` opts into the existing speech-probability classifier,
  which does not need the flanking RMS reference.
- The proposed cut is bounded by the run, not the gap: waveform snapping and
  breath handling may move it at most 50 ms past the run, and never within
  25 ms of either word's time or 60 ms of either word's measured voice
  (**Kept words keep their voice**). Pacing never widens it across the gap or adds a paced
  pad, so the pause left behind is always shorter than the original and keeps
  `min_gap_after_filler_sec`. A mute keeps the whole run (**No gap to keep**).
  Risk is re-assessed on the final span.

Interaction with other proposals:

- An acoustic hit that overlaps a word-based filler cut after pacing (for
  example `filler:um` widened across the gap) is dropped.
- A long-pause trim in the same gap is replaced only when the acoustic cut
  survives analysis; if the acoustic candidate is rejected, the pause trim is
  still proposed.
- Coalescing keeps `filler:acoustic` separate from neighbouring cuts (like
  repetition/restart), and never merges decisions whose `applied` flags differ.
- Re-proposal (`replace_existing`) regenerates pending acoustic hits under the
  same ids and keeps ones a human already applied; new proposals that overlap an
  applied decision are skipped (`applied_overlap`), as are ones whose id an
  applied decision holds (`same_hit`).
  In mute mode a candidate whose span the clips' `mute_regions` already cover is
  skipped too (`already_muted`).
- Propose summaries report acoustic hits separately (`N acoustic (review)`) and
  count skipped scans and candidates (`acoustic:*` skip reasons such as
  `no_audio`, `peer_speaking` (a peer voiced in the gap), `breath`,
  `replaced_pause`, and every analysis rejection under its reason, such as
  `acoustic:kept_voice`, `acoustic:next_onset` or `acoustic:too_short`).
- The audition context adds an `acoustic_gap_filler` hypothesis per pending hit,
  with the edit's own span in `evidence`.

### Debug workflow

1. `podcast propose-edits` — inspect `edit_decisions` (note `cut_confidence`, `crossfade_ms`, reasons).
2. `podcast play --compare` or `play_tool` on a window with known fillers before/after apply.
3. If joins still click after apply: `fade_joins_tool` or `recommend_fades_tool` → `apply_fade_recommendations_tool`.
4. One knob per iteration; re-propose and re-listen.

See also: [inaudible-cuts.md](inaudible-cuts.md) (boundary optimizer), `.agents/skills/podcast-tighten-dialogue/SKILL.md` (agent workflow).

## Golden-ear protocol

The owner listening bar in § Default pipeline status is **not** a CI gate. Run the harness on a relocated copy (never the committed fixture tree or the Shot of Truth working copy):

```bash
make golden-ear ARGS='build --project /path/to/shot-of-truth --out /tmp/golden-ear --limit 40'
# Listen under listen/pair_NNN/1.wav vs 2.wav. Do not open key.json (owner-only, beside listen/).
# Fill prefer=1|2|tie and leftover_consonant=yes|no in listen/answers.csv.
make golden-ear ARGS='score --dir /tmp/golden-ear --answers listen/answers.csv'
```

To evaluate a preset, add `--intensity`, e.g. `make golden-ear ARGS='build --project … --out /tmp/golden-light --intensity light'`, and score each tier separately.

Rebuilds of a non-empty `--out` (or a filled `answers.csv`) require `--force`. For untrusted argument strings, call `uv run python scripts/golden_ear_harness.py …` instead of `make golden-ear ARGS=…`.

`build` copies the project via `copy_relocated_workspace` (rewrite `workspace_dir`; copies `artifacts/premix.wav` when present so the first preview reads its recorded headroom trim instead of measuring the mix peak). It then runs **`EditService.propose_tighten()`** without apply. That call uses the same **transcript refine gate** as other edit mutations (`_require_refine_clear`): Shot of Truth builds fail until refine status is clear or `analysis.transcript_refine.mode=off`. For each pending `filler:`, `pause:`, `repetition:`, or `restart:` REMOVE with a Suggested side (no `suggest_reason`), it writes two short WAVs (±2 s context) via `PlayService.play_pending_preview` (`current` = leave-in, `suggested` = the edit approved on a snapshot, so its ripple, `replace_gap_sec` paced pad and fades are in Suggested). Whichever clip is shorter (Suggested after a plain cut, Current when the paced pad is longer than the cut) gets trailing silence appended until both have the same frame count, so length cannot unblind the pair; the audio itself is never trimmed or stretched. Which of `1.wav` / `2.wav` is the edit is randomized; mapping is only in owner `key.json` next to `listen/` (not inside the listen pack). Listener `manifest.json` is blinded (ids only — no class/verdict/risk). `listen/answers.csv` is the scoring template (`pair_id,prefer,leftover_consonant,notes`). Each key pair stores `join_quality` (`verdict` / `risk`) and an owner-only `audition_context.v2` summary for its timeline play window; failed diagnostics are recorded explicitly as `audition_context_error` and never exposed in the listener manifest. `verdict=pass` is a **gated** cut. Selection shuffles candidates with `--seed` and backfills edits without a Suggested side so pair ids stay contiguous (`pair_000`…). Cached `play_cache` windows are reused when `play_pending_preview(..., rerender=False)` (the default).

The context is labeled `project_timeline_metadata_only`: it supplies captions, timing, and render status, but its suggested premix listen references do not describe the edited WAV. `pair_diagnostics` in owner `key.json` analyzes the **rendered** Current and Suggested WAVs directly, recording astats, hum, and waveform PNG paths under owner `diagnostics/pair_NNN/`. Each side has an explicit `file` mapping; per-side failures appear as `error`. The diagnostic images and key stay outside `listen/`. Pair analysis is bounded to exactly those two WAVs, rather than repeating DSP across every dialogue track.

`score` maps `prefer=1|2` through `key.pairs[].edit_file` / `leave_file` (`tie` counts as non-edit). Blank/unknown prefer or leftover cells fail closed. Duplicate `pair_id` rows keep the first. Pass requires **≥90% prefer-edit on gated cuts**, **`gated_n` ≥ `min_gated_n`** (`2` when `--limit` ≥ 2, else `1`), and **zero leftover-consonant fails** (`yes|no` required). The report includes `missing_n`, `pair_count`, `gated_n`, and `n_answers`, plus acceptance rollups by full reason and speaker track with sample, answered/missing, edit-preference, tie, and leftover-failure counts; a rollup counts a pair as answered only when both preference and leftover-consonant responses are valid. In each rollup, `prefer_edit` uses all rows (including incomplete answers counted conservatively as leave-in), while `prefer_edit_answered` uses only rows with both valid cells. Empty gated answers fail closed.

Log the `score` JSON (and which episode / git SHA / tighten config) next to the Shot of Truth session notes. Do not flip `tighten.enabled` until this bar is green on that episode. Cap `--limit` (default 40, max 500).

The `aligned_dialogue` fixture is the automated smoke (`tests/test_golden_ear_harness.py`); it is not a substitute for the owner listen on Shot of Truth.
