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
- **Padded cuts are two faded edges, not a splice** (#978) — The join approving ships is decided once, from the edit mode and the cut's final scope (`_CutPlan.for_cut` in `edits/fillers.py`: span, join, paced pad, next burst). The join is `splice` (a ripple with no pad), `padded` (a session ripple with a pad) or `mute` (mute in place, see [Mute vs cut](#mute-vs-cut)), and it picks the edge checks from one table (`_EDGE_CHECKS`). Scope depends on the span and the edge checks move the span, so `_analyze_candidate` gates under the scope the span settles on: a scope that flips after the checks re-gates once under the other plan (a track punch gets the splice checks and no pad; a session cut keeps its pad and skips them), and a second flip drops the cut as `unstable_scope`. With a pad (`replace_gap_sec` > 0) the render never butts the edges together: the left edge fades out into the pad (`filler_pre_pad_fade_out_ms`) and the right edge fades in after it (`recommend_post_pad_fade_in_ms`, which approval calls with the decision's `next_burst_sec`). The checks that score a splice therefore do not run on it: breath protection (`protect_cut_breaths`), the level-jump terms of the cut-risk score, and the join continuity gate. On the lab tape they rejected all four filler cuts the owner approved as rendered (Caleb `uh,` 604.80, `Uh,` 706.14, `Um,` 712.34, `You know` 1441.38) plus two negative controls whose edges ran into neighboring words. Padded cuts get two checks instead. **The right edge stops before the next word's first phoneme**: `edits/word_onset.py` reads the audio from the filler's tail for the first new sound (the first audible frame or high-band jump out of the quiet after the filler, which catches a plosive burst under the audibility floor; in continuous voice, the foot of the rise: once a rise out of the dip shows a new sound began, walk back to where the level started to climb. The dip's trough is too early, because the owner still heard the end of `uh` with the cut at the trough of `uh, we` (lab 706.37 vs a foot at 706.42-706.44), the level falling into a low, dark stretch before the word rises), and the cut ends 10 ms before it. The onset has a kind. A **burst** rises at least 18 dB in the high band within one 10 ms frame step (a plosive out of closure: 22 and 40 dB on the lab tape); anything that ramps (fricative, glide, nasal, vowel) is **gradual** (`she` gains 4 dB per step, `we` out of its dark stretch 10-14 dB). The foot of the rise walks back while each earlier frame is at least 0.5 dB lower, so the flat stretch before it does not drag the edge back. Only a burst travels on the decision as `next_burst_sec`, and the post-pad fade-in is cut down to finish before it, never below the join declick (`inaudible_cuts.micro_fade_ms`, 10 ms), so the ramp never attenuates the burst. A gradual onset moves the cut edge but sets no cap: the fade-in keeps its full recommendation, because a ramp over a fricative such as the `sh` of `she` (+4 dB per frame in the high band) is softer than a 10 ms one (the owner found 10 ms on `she` a little harsh and had approved 112 ms). The scan reaches as far past the cut end as the longest post-pad fade-in (`filler_post_pad_fade_in_max_ms`): an onset within the 10 ms guard shrinks the cut, and a burst further out leaves the cut alone but still caps the fade (the lab's `uh, nope` cut ends 90 ms before `nope`, so its fade is 90 ms, not 120). With no burst in reach the recommendation stands. Word times cannot place this: Whisper and the aligner drift by up to ~1.2 s on the lab tape. If that leaves the cut ending more than 40 ms (two frames of word-time jitter) before the filler's own word end, the cut is dropped as `next_onset`. **No kept word may vanish inside the span**: a cut that covers the whole span of an unsuppressed word other than its own filler tokens is dropped as `kept_word:{word}` (the owner rejected a cut that removed all of `we` plus the start of `should`; a cut that grazes a neighbor's tail is fine). The left edge is otherwise unchanged. Ripple cuts without a pad (track-local punches, pause trims, acoustic gap runs, repeats and restarts, and a filler with no flanking word) keep every splice check. A mute gets the padded-cut checks and keeps breaths whole (see [Mute vs cut](#mute-vs-cut)). Confidence and word-margin risk terms, voiced-edge review, the bleed-owner check and the overlap rules apply to all three; peer-speech scoping applies to ripple cuts only.
- **Filler left edge** (#1061) — A word filler's cut starts at its voice, not its word time. The aligner starts fillers late: on the lab tape both `um`s voice 320–350 ms before their word start (616.26 voices from 615.94, 713.00 from 712.65), so a cut from the word start left the head of the `um` audible and the owner heard each cut start mid-`um`. Before any edge check, and for every join (padded, track splice, mute), `_gate_cut_edges` walks back from the word start over 20 ms level frames every 10 ms (`filler_onset` in `edits/word_onset.py`) to the first frame under the audibility floor (`analysis.heuristics.audibility_rms_db`); the cut starts 10 ms before the audible frame after it. The walk does not bridge short dips the way voiced runs do, because the `ss` of `digress.` falls under the floor for only 20 ms before the owner-approved `uh` at 706.02. It only ever moves the edge earlier, only when a whole 20 ms frame of voice lies before the word start (a word start on the onset keeps its edge), and never past the previous kept word's end or 2 s back (word times drift by up to ~1.2 s on this tape). When the level stays audible all the way back to that word, the filler runs on from it with no quiet to cut in, and the cut is dropped as `filler_onset`. An edge at the word's end would cut its tail (lab `to like` at 424.6: the vowel of `to` runs 80 ms past its word end into `like`), and an edge at the word start leaves the filler's head; the owner's rule for mute mode (#1024) is to skip a filler that cannot be removed without clipping a neighbour. Acoustic gap hits are placed from audio already and keep their bounds. On the aligned lab tape the `um` cuts now start at 615.93 and 712.64 (were 616.30 and 712.99) and lose their `voiced_edge` review flag; the `like` at 16.52, whose paced start had landed 110 ms inside the word, becomes a review hit starting at 16.45; the owner-approved cuts at 604.62, 706.00 and 1440.88 are unchanged. With Whisper word times only the `um` moves (615.94 to 615.93). A word the transcript dropped that runs straight into the filler would be cut with it; no lab case shows one.
- **Join continuity gate** — When `tighten.join_continuity_gate: true` (default), `assess_proposed_cut` runs on every cut without a pad after boundary optimization; verdict `fail` skips the candidate (fail-closed). Verdict `review` marks `review_required`. The verdict is the worst over every edge placement within `join_continuity.edge_tolerance_ms` (3 ms), which roughly halves the verdict flips a few-millisecond nudge or re-timed word causes; a splice inaudible at the proposed edges passes regardless. See [inaudible-cuts.md](inaudible-cuts.md) § Join continuity.
- **GUI review loop** — Sharecut Studio **Tighten** tab lists pending `filler:` (including review-only `filler:acoustic`), `pause:`, `repetition:`, and `restart:` hits (search, class/track filters, harsh-only). Preview / skip / apply one, or apply-all with **Avoid harsh cuts** (default on; skips `review_required` and `:risky` / `:join_review`). Same `ApproveEdits` / `RejectEdits` path as the pending inspector. See [daw-editing.md](daw-editing.md) § Tighten review.
- **Waveform boundaries** — Proposals call `optimize_source_cut_range` when `tighten.inaudible_opt: true` (default). Short cuts also **extend the end to the quietest point before the next word** (within `trailing_energy_extend_ms`) when ASR ends a filler early (see [inaudible-cuts.md](inaudible-cuts.md) `trailing_energy_*`).
- **Adaptive fades** — Each decision gets `crossfade_ms` from `recommend_cut_fade_ms` (roughly 15–50 ms for fillers, up to ~150 ms for long pauses, scaled by join level jump).
- **Breath co-removal** — Adjacent breath-shaped energy before/after a cut is included in the remove range when detected (`tighten.breath_handling.enabled`). A breath must be **unvoiced noise all the way to the cut, between the track's own room tone and speech level, and outside every kept word**. The detector (`edits/breath_detect.py`) reads 5 s of the kept audio on each side of the cut and takes the 10th and 90th percentiles of its live (not digitally silent) 10 ms frame levels as the room-tone floor and the speech level; a breath frame sits at least 9.5 dB above that floor and 7–40 dB below that speech level (`breath_level_band`). Flanks with no such contrast (a gated track with nothing live nearby, or under 0.5 s of live audio) yield no breath. On the lab tape breaths sit 6–39 dB below the local speech level and 12–45 dB above the floor; the previous band, derived from the fixed `analysis.heuristics.audibility_rms_db`, was −32.4 to −31 dBFS and found 1 of 26 labelled breaths (#814). The scan forms complete in-band runs before selecting those overlapping the 400 ms search before or the 250 ms search after the cut. It takes the first complete run of breath length (80–450 ms) that passes five checks. Frames inside a kept transcript word are never breath and the stretch between the run and the cut may not touch one (a word the cut itself removes at least half of is not kept), so a quiet phrase-final word tail such as lana's `she?` cannot be called breath. A run that continues a kept word on its far side, with no frame at or below the band floor between them, is that word's decay (before the cut) or onset (after it), whatever its own shape: the aligned `uh` at 1441.21–1441.27 decays through the band to 1441.41 and the `sh` of `she` at 1456.65–1456.76 is a 2–3.5 kHz burst under the sibilant split; the scan covers the whole 5 s of flanking audio so the word can lie outside the search window. No frame between the run and the cut may exceed the band ceiling: vocal fry scores 0.1–0.4 on the pitch probe but its pulses sit at speech level (an untranscribed creaky `check` at 1122.98–1123.15, −17 dBFS frames against a −18.8 dBFS ceiling). Neither the run's energy nor that of the gap between it and the cut edge may sit mostly above 4 kHz (a sibilant `s` carries 54–100% of its 100 Hz–8 kHz energy there, a breath 1–24%; the gap is checked on its own so a word-final `s` next to a loud breath cannot average out below the split). And 40 ms speech-pitch (70–350 Hz) autocorrelation probes every 10 ms over the run **and everything between it and the cut edge** must all stay below 0.55, because the cut is extended out to the run and removes what lies between; only probes whose frame reaches the band floor count, since room tone 40 dB under the speech level also scores 0.6–0.8 on this tape and is not speech to protect. A run that fails is skipped for the next quieter one. The band alone cannot tell breath from speech — in a loud window a window-relative band selected the quieter frames of ordinary speech, and on the lab tape 82% of its hits were voiced, including the kept second copy of a repeated word; a breath sitting 270 ms before a cut also pulled the voiced word between them into the cut (#798). Some breaths on the lab tape peak at 0.60–0.65 on the same probe and stay undetected; the gate is kept because quiet voiced speech reaches down to 0.57. Detection cannot widen a cut beyond its candidate bounds. After pacing, candidate-bound clamps, and voiced-edge nudges, `protect_cut_breaths` checks both final edges of a cut without a pad (a padded cut fades each edge against silence instead; see **Padded cuts** above). The shared detector completes the quiet onset and tail to measured room-tone separators on the 10 ms level grid and rechecks pitch, sibilance, kept words and the level ceiling over the full envelope. A start inside a confirmed complete breath advances to its offset; an end inside it retreats to its onset. Exact onset/offset boundaries stay unchanged. Both adjustments use the original bounds and only shrink the cut. Empty cuts and non-pause cuts that no longer cover at least half their target span are dropped. Connected above-floor activity that crosses an edge but fails classification suppresses the proposal, as do missing evidence and incomplete bounded envelopes. Rejected activity elsewhere and floor-level silence do not suppress a cut. Shrink recomputes kept-word eligibility, scope and voiced safety; risk, pad, join and fade use the settled bounds. Enabled handling requires a usable room-tone/speech profile; disabled handling preserves the existing geometry. This conservative bounded check does not guarantee universal breath recall or replace listening. Automatic application consumes stored optimized proposal bounds without a second snap; unsnapped pending edits retain the configured apply-time optimization.
- **Pause floor** — Long pauses are shortened but a natural gap remains. **Turn / dead-air** (another dialogue track has words in the gap) keeps `tighten.min_retained_pause_sec` (~0.18 s). **Solo same-speaker** pauses (peers quiet — thinking, list restart) keep `tighten.min_retained_solo_pause_sec` (~0.55 s) so performance air is not crushed to a hard edit. The floor is **contiguous** source air immediately before the next word (holes from prior ripples do not count); any shortfall is padded with silence after ripple. Reasons are tagged `pause:…s:solo` when the solo floor applies.
  The `max_pause_sec` threshold is measured on **surviving timeline air**, not the raw source-clock gap between the two words (`SessionTimeline.map_source_span`, #772). A ripple delete leaves no clip over the removed range, so two words that are adjacent in the transcript can still be far apart in source time; the deleted stretch contributes nothing to the gap and no `pause:` candidate is proposed once what remains falls under `max_pause_sec` (including down to zero, when the whole gap between them was cut away). A hole from an earlier **track-local** punch inside the gap is excluded the same way (#783): the sum only counts spans this track's own clips still cover, so an already-silenced stretch never inflates the measured gap. This is a deliberate undercount — it can only make `max_pause_sec` harder to reach, never propose a cut over audio that still plays — and it is low-impact in practice, since a track-local hole comes from the speech-energy guard punching around a peer, and the guard drops a `pause:` candidate in that same window anyway (above).
  Peer speech is indexed once across dialogue transcripts for a tighten pass; standalone transcripts absent from the project use the direct peer scan. A gap counts unsuppressed words on other dialogue tracks whose start is before the gap end and end is after the gap start, including point-timestamp words strictly inside the gap; the current track and non-dialogue tracks do not supply peer speech. This word-span test is only the pause floor's turn-versus-thinking choice; the acoustic gap filler measures peer audio instead (§ Acoustic gap candidates).
- **Voiced edges and interior speech** (#815, #818) — After pacing, every candidate's final span is checked against the cut track's own voice (`edits/voiced_runs.py`: 20 ms level frames every 10 ms at or above `analysis.heuristics.audibility_rms_db`, bridged over 30 ms dips, kept as a run only when at least three 40 ms probes carry a clear speech-pitch peak ≥ 0.55, the same bar `breath_detect` uses, so breaths, clicks and room tone never form a run). Word times are the only view a candidate has, and on the lab tape both aligned and Whisper ends sit 120–270 ms inside the voice (`idea` ends 467.33 s by the aligner, the vowel at 467.55 s). An edge that a run surely holds on both sides is moved out of it, past the run plus 60 ms of air (join_speech's pad), when the run belongs to a word that stays, so the word keeps its tail or onset. A cut only ever shrinks here (a word filler's left edge has already moved to its voice onset; see **Filler left edge**): voice past an edge with no transcript word in it is either the cut word timed short or a word the transcript dropped, and the audio cannot tell which, so the edge stays and the cut is `review_required` with `:voiced_edge` instead of widening onto it. A nudge is also refused, with the same flag, when it would move more than 0.5 s, leave the candidate's bounds, leave under 0.1 s of cut, or (for filler / repeat / restart / acoustic cuts) uncover more than half of the targeted word. A `pause:` span that still holds 0.1 s or more of one voiced run after the edges settle is speech the transcript missed (a dropped sentence, a laugh, an "mm"): it is proposed for review as `:interior_speech`, never auto-applied. Review rather than drop, so the reviewer learns the transcript has a hole there; every apply-all path already skips `review_required`.
  **Which tracks.** A session-scope cut ripples the same window out of every dialogue track, so the check reads every dialogue track whose audio decoded into the tighten audio cache (the cut track alone for a track-local punch). Everything on a peer stays, so a peer's voiced run at an edge is always a kept-word nudge (or `:voiced_edge` when refused), and a peer's voiced run of 0.1 s or more inside the span makes any session cut `:interior_speech`, filler or pause. The speech-energy guard still decides session vs track-local, but it measures a window mean (lana's 110 ms burst at −30 dBFS averaged −48 dBFS over a 7 s pause) and needs 30 ms of overlap, which is why the ripple check reads runs instead. A pause must also be **dead air** on every track it ripples: an audible run of 0.1 s or more at or above the floor that the pitch probe cannot vouch for (a fricative-only word, a laugh, a cough) makes it `:interior_audio` review. Single clicks under 0.1 s do not count; on the lab tape the seven good dead-air cuts hold 20–80 ms blips at −29 to −42 dBFS and stay auto-applicable, while a peak-frame rule would have cost two of them. Known limits, measured with synthetic probes: voiced audio 4 dB under the floor (−46 dBFS) is invisible, and so is speech shorter than 0.1 s.
  Measured on the lab tape: the dropped-ASR repro's two 8 s pauses over speech went from auto-applicable to `:interior_speech`; edges inside kept-word voice went 39→29 (Whisper) and 108→82 (aligned), all of them review-required, and the seven dead-air cuts kept their edges. Some edges the gate used to score `review` while they sat inside a word now score `fail` once they sit honestly on the word's decay and are dropped; others that used to fail now pass as inaudible splices (caleb 1271.60 s) because the edge no longer straddles speech and silence. audra's 671.74 s pause, clean on its own track, is `:interior_speech` for lana's untranscribed burst at 673.3 s inside it.
- **Filler pacing floor** — After filler / NL hesitation cuts, default `filler_room_tone_replace: true` removes the inter-word hesitation and inserts a paced pad: `clamp(min_gap_after_filler_sec, gap × filler_gap_retain_fraction, filler_replace_gap_max_sec)` (defaults **0.35 / 0.85 / 1.0 s**). `gap` is the larger of the flanking words' air, when the cut takes the whole gap between them, and the span the cut finally removes. Edge checks move the span after pacing (the **Filler left edge** widens it to the filler's voice), so the cut plan carries the pacing rule (`PacedPad` in `edits/filler_pacing.py`), not a length, and the decision's `replace_gap_sec` is read from the final span (#1074). NL removes read it from their final span too. On the aligned lab tape the two widened `um` cuts, 615.93–616.71 and 712.64–713.35, get 0.66 s and 0.60 s pads; main gave both the 0.35 s floor, sized for the 0.1 s word spans the aligner placed late. No other cut changes. Expand keeps previous-word release via **`recommend_prev_word_lead_out_ms`** (energy to quiet floor, ~40–250 ms — fixed 60 ms still cut mid-nasal) and `filler_next_word_lead_in_ms` (~80 ms) before the next onset — unless ASR tokens overlap the filler. After the pad, `filler_pre_pad_fade_out_ms` (~5 ms) declicks into silence and **`recommend_post_pad_fade_in_ms`** sizes the resume fade from look-ahead energy (quiet air → `filler_post_pad_fade_in_min_ms` ~15 ms; hot/late onset → up to `filler_post_pad_fade_in_max_ms` ~120 ms). Default pad fill is **`filler_pad_mode: room_tone`** (see **Decision: Room tone is the default fill**). It prefers a recorded `track.room_tone` bed (abutting tiles with fade-in on the first tile and fade-out on the last when the pad is longer), else a steady stretch of the track's own audio at its noise floor, chosen from the audio and never from word times, so untranscribed speech and peer bleed are not tiled (rules in **Where room tone comes from**). If there is no bed and no such stretch near the cut (a Zoom-gated track, or a voice detector that errors), the pad is skipped rather than tiling dialogue, bleed, or silence. Set `filler_pad_mode: silence` for a hard silent gap on every track. Set `filler_room_tone_replace: false` to shrink the cut and keep original air instead.
- **Speech-energy guard** — Before session-wide ripple, `tighten.speech_energy_guard` measures other dialogue stems in the cut window. If a peer is audibly speaking (even when ASR missed the word), default `on_conflict: track_local` punches a silence hole on the **cut track only** (`EditDecision.scope=track`) so overlapping dialogue is not mid-word chopped. `skip` refuses the cut; `review` still uses track-local and marks `review_required`. A `pause:` candidate is **dropped** instead of demoted, under either `on_conflict` setting: a track-local punch never ripples, so it cannot shorten the timeline, which is the only reason a pause cut exists (#772).

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
- **An acoustic run that runs into a kept word is that word's sound.** An acoustic gap run has no word label, so when its voiced audio runs on into a kept word at either edge (the voiced-edge check cannot nudge a bounded candidate clear), a mute drops it as `voiced_edge`. A splice's strict breath protection already refuses such an edge. A word filler keeps its `:voiced_edge` review flag instead: ASR says the voiced audio is the filler.
- **A mute must silence something audible.** It keeps the time, so muting audio below `analysis.heuristics.audibility_rms_db` (span RMS) changes nothing a listener hears; it is dropped as `inaudible`. A ripple still removes time there.
- **Peers do not matter.** A mute's scope is `track`. Peer speech never scopes it, never flags it (`track_local`, `other_speaking`, `interior_speech`) and never nudges its edges; the bleed-owner check and the acoustic scan's peer-voice test, which decide whose voice the audio is, still run.

Lab (`aligned-ready`, refine waived; ripple proposal byte-identical throughout). Before #1024 mute mode proposed 11 hits and no word filler. Dropping the splice checks alone proposed 222: the six Caleb fillers (`uh` 604.62, `um` 616.30, `uh` 646.84, `uh` 706.00, `um` 712.99, `you know` 1440.88), 13 repetitions/restarts and 203 acoustic runs. Heard alone and measured, those 203 were 112 runs into a kept word, 26 breaths or breath-like unvoiced noise, 22 quiet sounds 15 dB or more under the speaker, 6 bleed, 9 missed words or laughs and 28 vocal hesitations. With these checks mute mode proposes 53: the six fillers, the 13 repetitions/restarts, and 34 acoustic runs (21 vocal hesitations within 9 dB of speech, 5 missed words or a laugh, 7 quiet sounds, 1 unvoiced). Skips: `acoustic:voiced_edge` 134, `acoustic:inaudible` 26, `acoustic:breath` 29 (12 at the scan, 17 at the edges). Acoustic hits stay review-only.

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

**Which neighbours count as a join:** one rule for every join mode — `clips_abut` in `edits/clips_ops.py`, a timeline gap of at most `JOIN_GAP_TOLERANCE_SEC` (50 ms). A gap within the tolerance closes up when rendered (fade and cut joins concat; crossfade joins crossfade), so the stem is shorter than the timeline by that gap, and by the crossfade overlap for crossfade joins. A wider gap stays as silence and gets no crossfade. Crossfade joins with a 1–50 ms gap used to render as fade joins; when render rules like this change, `RENDER_SEMANTICS_REV` in `engines/timeline_render.py` is bumped so cached stems and play segments re-render. Rev 3 made a cut per join: only the next clip's cut drops a clip's fade-out, and a clip's own cut drops its fade-in only when it has a left neighbour (a track's first clip has no join). Rev 7 keeps nested multi-recording overlaps at their authored timeline positions by comparing each placement with the accumulated rendered end; segment renders use the same rule and retain join fades from lane neighbors just outside the requested window. Rev 8 uses the same source-aware placement assembly for every segment window, including windows whose selected clips all use one recording. It preserves summed overlaps and requested leading/trailing timeline holes while subtracting cut and join contraction from the output duration. Rev 9 resets the sample clock after a summed overlap before later pad/concat joins, preserving sample-accurate output length.

Hard joins (`join_in_mode=cut`, zero fades) use plain concat. See [inaudible-cuts.md](inaudible-cuts.md).

## CLI / MCP

Omit track and speaker for a session handoff to require quiet across all dialogue lanes, including muted lanes. Explicit selectors analyze one lane. Results list the analyzed `track_ids`. Missing or incomplete evidence cannot qualify a hop as quiet; each proposed boundary must lie in a shared measured quiet island. See [Narrative handoffs](inaudible-cuts.md#narrative-handoffs) for evidence and locking bounds.

- `podcast propose-edits` / `propose_edits` — proposals include optimized boundaries and per-cut `crossfade_ms`. The MCP payload is `{operation, edits, skip_counts, summary}` (`operation` is `propose_edits`; not a bare array). `skip_counts` maps `discourse:{token}` → kept uses, including isolated cluster-size rejects, `backchannel:{phrase}` → acknowledgments left in, `kept_word:{word}` → padded cuts and mutes dropped for covering a whole kept word, and `next_onset` → padded cuts and mutes dropped because ending before the next word's onset would leave the filler. Every candidate analysis rejects is counted under one reason: `breath` (splice breath protection; for a mute, a span that is mostly breath or whose edges cannot leave a breath whole), `voiced_edge` (a mute of an acoustic run that runs on into a kept word), `inaudible` (a mute of audio below the audibility floor), `too_short`, `reparandum` (a repeat cut no longer covers its reparandum), `bounds` (the span left the candidate's bounds), `not_owner` (the span is a peer's bleed), `pacing`, `scope`, `other_speaking` (a pause under a peer's speech), `unsettled_edges`, `unstable_scope`, `risky`, `join_continuity`, `next_onset`, `kept_word:{word}` and `filler_onset` (the filler's voice runs on from the kept word before it, #1061). An acoustic gap candidate's reason is prefixed `acoustic:`. CLI prints `proposal.summary()`.
- `podcast propose-edits` / `propose_edits` — proposals include optimized boundaries and per-cut `crossfade_ms`. The MCP payload is `{operation, edits, skip_counts, summary}` (`operation` is `propose_edits`; not a bare array). `skip_counts` maps `discourse:{token}` → kept uses, including isolated cluster-size rejects, `backchannel:{phrase}` → acknowledgments left in, `kept_word:{word}` → padded cuts and mutes dropped for covering a whole kept word, and `next_onset` → padded cuts and mutes dropped because ending before the next word's onset would leave the filler. Every candidate analysis rejects is counted under one reason: `breath` (splice breath protection), `too_short`, `reparandum` (a repeat cut no longer covers its reparandum), `bounds` (the span left the candidate's bounds), `not_owner` (the span is a peer's bleed), `pacing`, `scope`, `other_speaking` (a pause under a peer's speech), `unsettled_edges`, `unstable_scope`, `risky`, `join_continuity`, `next_onset`, `kept_word:{word}` and `filler_onset` (the filler's voice runs on from the kept word before it, #1061). An acoustic gap candidate's reason is prefixed `acoustic:`. CLI prints `proposal.summary()`.
- Re-proposing (CLI, MCP, or Sharecut Studio **Find hits**) replaces every pending generated `filler:` / `pause:` / repetition / restart / acoustic hit, including ones the generator flagged for review (`:voiced_edge`, `:risky`, `:other_speaking`, `:join_review`) and ones a human nudged. Applied hits and manual, NL and focus edits stay. Re-running on an unchanged project returns the same hits in the same order (#995), with the same ids (#999).
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
| `tighten.min_gap_after_filler_sec` | `0.35` | Min beat after short filler cuts (um/uh floor) |
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
  25 ms of either word. Pacing never widens it across the gap or adds a paced
  pad, so the pause left behind is always shorter than the original and keeps
  `min_gap_after_filler_sec`. Risk is re-assessed on the final span.

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
  `acoustic:next_onset` or `acoustic:too_short`).
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
