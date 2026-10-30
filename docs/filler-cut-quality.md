# Filler and pause cut quality

## Default pipeline status

**`tighten.enabled` defaults to `false`.** `analyze_fillers_pauses` /
`tighten_from_transcript` skip in the pipeline until re-enabled. Manual
`propose-edits` / `apply-edits` still work for experiments.

**Exception, once #1434 lands:** the pipeline applies the suggested actions for
non-speech sounds by default (**Decision: Non-speech sounds get a suggested
action**). The owner accepted that on 2026-10-13 ahead of the gates below,
because every action is reversible in one undo and editable one at a time.

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

Implementation: `edits/tighten/` (`lexicon`, `repeats`, `acoustic_scan`, `collect`, `plan`, `gate`, `prepare`, `apply`; `analyze_fillers_and_pauses` in `apply.py` is the facade), `edits/cut_safety.py`, `edits/cut_quality.py`, `edits/join_continuity.py`, `edits/breath_detect.py`. Defaults: `.agents/defaults/pipeline.yaml` → `tighten`, `join_continuity`, `inaudible_cuts`, `render`.

### Cut-safety authority

`edits/cut_safety.py` owns breath protection, peer-speech disposition and proposed-join
assessment; `edits/cut_placement.py` owns source-placement checks and original-recording
pad eligibility. The
measurement modules retain PCM, level, word, and join measurements. The owner checks
physical recording identity, once-only source occurrences, registered beds, and pad
receipts. `source_removals` and `fillers` consume those results without forwarding
implementations. General `SessionTimeline` geometry remains independent.
`tests/test_source_remove_geometry.py::test_cut_safety_boundary_owns_remove_placement_and_guard_imports`
checks direct, aliased, module-qualified, and private access to the removed APIs.

`assess_held_source` classifies fixed source edges and mute fade footprints with the
same decoded PCM, word index, voiced-frame thresholds and breath evidence used by
preparation. Application never calls the optimizer to compare or replace stored bounds.
`assess_held_pause` checks the current retained original air and binds current effects.
For a pause cut's perceptual join score, the selected edit's current track and physical
recording define the subject. Every completed effect still receives physical held-edge,
peer-voice, breath, placement, and gain checks. A peer effect's join score cannot veto a
different recording's selected join, while missing or ambiguous selected-recording
identity keeps the operation on review. This boundary is enforced by
`tests/test_source_remove_geometry.py::test_pause_join_quality_uses_selected_physical_recording`.
The pipeline carries its configured breath handling into application. Disabling
breath handling selects geometric pause observations, which do not require a
measurable room level. Original quiet support, the retained pause floor, native
source geometry, and any actual pad sample requirements still apply.
Source remove, mute and exact-range writers consume the resulting checked geometry in
their existing mutation. Exact-range and ordinary source proposals are measured before
publication; uncertain edges retain their selected bounds and an `acoustic_review`
reason. These annotations are observations, never application clearance.

`cut_policy.CUT_ACTION_TABLE` maps each sound or safety-observation label and the
time-behavior mode to an action. Ripple maps to `ripple`; time-preserving `GAP` trims
and `MUTE` edits map to `mute`. Sound rows keep the current default actions and their
proposal review metadata. Fresh breath, peer, join and source-placement observations
resolve to `review` in both modes. The private cut candidate checks these rows before
publication. A missing row refuses the operation. Trusted human intent can override
acoustic review rows, while source placement and pad observations remain mandatory.
The mode comes from the operation being written. Lowering a pending `REMOVE`, an exact
range `REMOVE`, and a track-local punch use `mute`; a session `REMOVE` uses `ripple`.
An explicit trim or timeline operation mode takes precedence over the pending edit type.

### Decision: Manual cut intent bypasses acoustic vetoes

<!-- decision
id: D-manual-cut-intent
status: accepted
date: 2026-10-16
decided-by: calebn
evidence:
- #1403 owner decision: https://github.com/calebn/sharecut-studio/issues/1403#issuecomment-6221464888
- #1658 owner decision: https://github.com/calebn/sharecut-studio/pull/1658#issuecomment-6221465273
- Approval decision: https://github.com/calebn/sharecut-studio/issues/1403#issuecomment-6222421759
- Approval decision on PR: https://github.com/calebn/sharecut-studio/pull/1658#issuecomment-6222422242
- Observed proposal gap: https://github.com/calebn/sharecut-studio/pull/1658#issuecomment-6222462273
enforced-by:
- tests/test_source_remove_geometry.py::test_completed_effect_acoustics_is_the_only_veto
- tests/test_source_remove_geometry.py::test_completed_structural_policy_is_the_only_veto
- tests/test_source_remove_geometry.py::test_apply_reassesses_real_sabotage_after_offer
- tests/test_selected_range.py::test_only_trusted_context_marks_selected_boundaries_human
- tests/test_selected_range.py::test_payload_cannot_forge_internal_boundary_intent
- tests/test_selected_range.py::test_propose_range_cut_tool_assesses_edges_and_human_approval_overrides
- tests/test_guest_transcript_selection.py::test_suggest_guest_cut_is_a_pending_suggestion_and_direct_edits_are_refused
- tests/test_manual_cut_intent_role.py::test_host_route_intent_follows_the_actor_role
- tests/test_manual_cut_intent_role.py::test_guest_editor_never_stamps_human_intent
-->

An intentional manual user edit may apply without acoustic-safety vetoes. Programmatic
and agentic decisions keep those checks. Intent follows the acting role, not the route: only
the host `viewer` role is a manual user; guest, `agent` and `cli` roles are programmatic.
The host route trusts the declared role, so a local process that claims `viewer` is treated
as the host. This decision does not remove finite bounds,
finalized-edge preservation, current-placement validation, structural validity, pad
hull checks, or data-integrity checks. It does not make every approval or every edit
path manual. #1403 defines which trusted entry points establish manual intent and
tests the distinction.

This rejects two alternatives. Keeping acoustic vetoes after a human chooses the
boundaries prevents intentional audible edits. Removing them for every command leaves
automated and agentic edits unprotected. Capability, reason, snap choice, and range
mode do not prove a human action. Only the host and review GUI document routes establish
manual boundaries. Each persisted decision records its proposal origin separately from its
current boundary intent. A programmatic retime resets only the latter, including a snapped resize of a
source-witnessed proposal. A trusted explicit human **Approve** of an automated proposal supplies transient manual
application intent. It does not change the proposal's programmatic origin or claim that
the person selected its edges. Programmatic approval supplies no override. A GUI-started
pipeline still generates programmatic decisions.

The policy has two stages. Agent proposals must receive acoustic assessment before they
are offered. Application must assess the current operation again, except for the acoustic
vetoes a trusted human deliberately overrides. Both stages preserve selected bounds and
structural integrity. A real isolated Lab probe found that `propose_range_cut_tool`
created a pending exact cut inside a frozen word without acoustic assessment. That gap
is an intentional behavior correction required by this decision, not refactor parity.
Trusted GUI approval now supplies that transient override to source, mute and exact-range
application. The production MCP exact-range test measures a cut inside a word, refuses
automatic application, and applies the same pending proposal through trusted human
approval while preserving its programmatic origin. Direct range/delete/trim and live edit-plan applications use the same owner.
The tests below cover actual post-write effects and preserved rejection state.

The required application shape is one unpublished working project. The existing writers
must finish mutes, right-to-left removals, pad selection, final fades, and provisional
archives before policy assesses their complete effects. Acceptance adopts that exact
candidate without another writer or optimizer. Services retain transaction and history
ownership. This replaces checked removal geometry as the intended authority because late
fades and pad tiles change audio outside that geometry. A second predicted writer model
would duplicate rendering and placement rules, so it is not an alternative implementation.

`cut_application.py` completes the candidate before `cut_safety.py` applies its four
policies: held breath/onset effects, peer speech, source/pad placement, and
source-qualified archive receipts. The private writer boundary prevents adapters
from calling the mechanical cut writers. Apply-level falsifiers in
`test_source_remove_geometry.py` alter real PCM, late fades, trim extensions, pad
placement and duplicate consumption; each checks preserved state under the normal
policy and harmful publication when only its owning predicate is disabled.

RMS evidence for a track with active processing may use a scoped temporary render.
Cleanup on success and failure is required; durable publication on rejection is forbidden.

## Policy

- **Repetition and restart proposals** (off at `light` / `tighten.repetition_candidates: false`) — Tighten detects same-track, timestamp-adjacent exact word repeats (`repetition:word:*`), repeated prefixes up to four words (`restart:phrase:*`), and only explicitly marked partial-word cut-offs (`stor- store`, `restart:partial:*`). Split repairs remove the repeated prefix and partial together (`I w- I went` removes `I w-`, retaining `I went`). The detector uses a bounded 0.45 s gap by default (`tighten.repeat_max_gap_sec`, capped at 2 s), skips suppressed/overlapping words and complete filler-lexicon spans (including split multi-word entries such as `you know`), and never compares across tracks. It consumes a matched repair window so periodic text cannot stack adjacent restart proposals. Every repeat/restart candidate is hard-bounded (like an acoustic gap run) to the silence flanking the reparandum: the floor is the end of the preceding surviving word and the ceiling is the start of the repair word, not the reparandum's own start/end (#783; before that, the bound was the reparandum's exact span, which on Whisper's touching word times was the same thing but on aligned times stranded the flanking gap as unremoved air). Waveform snapping, breath extension, and pacing can widen into that flanking silence but can only shrink inward from there, never move the cut onto a neighboring word or into the kept repair (#772). A cut that can only satisfy that bound with a harsh join is dropped by the usual risk / join-continuity gates rather than proposed wide. Because that flanking silence can be much wider than the reparandum itself on aligned times, a final cut covering less than half of the reparandum's own span is dropped outright (PR #792 review): waveform snapping or breath extension sliding the cut mostly into the silence removes neither copy and leaves both audible, which is worse than proposing nothing. These remain proposal-only (`review_required: true`) because emphasis and semantic repairs (for example “store—no, park”) cannot be inferred safely from text alone; coalescing keeps each repeat/restart (and `filler:acoustic`) proposal's id and reason separate from adjacent cuts. The existing golden-ear A/B harness includes `filler`, `pause`, `repetition`, and `restart` by default; listen and approve each hit individually.

- **Lexicon matching** — ASR words compare with `tighten.filler_words`, `tighten.discourse_markers` and `tighten.backchannels` in one form (`util/text.lexicon_form`): lowercase, with leading and trailing punctuation stripped from each token and inner apostrophes and hyphens kept. Whisper's `Um.`, `uh,` and `-huh.` read as `um`, `uh` and `huh`. Config entries go through the same function, and repetition detection compares words in that form too.
- **Backchannels are speech** — `tighten.backchannels` (default `uh huh`, `uh-huh`, `mm hmm`, `mm-hmm`, `mm hm`, `mm-hm`, `mhm`, `uh-uh`) lists acknowledgments a listener says while someone else talks. They are matched in the same longest-phrase pass as `filler_words`, before any filler, so Whisper's split `Uh` + `-huh.` (a zero-length `-huh.` included) is one `uh huh` hit, not the filler `uh`. A backchannel also matches across a half the audibility pass suppressed (Whisper's zero-length `-huh.` reads as inaudible), so the `Uh` left is still not a filler; on the lab tape three of Lana's `Uh -huh.` replies had a suppressed `-huh.`. A backchannel is never proposed, never counts toward a filler cluster, and never becomes a repetition hit; each one is counted as `backchannel:{phrase}` in `skip_counts` and the summary (`N backchannel kept`). An entry that is also in `filler_words` is a backchannel. Split `uh uh` is left out of the defaults, because with the hyphen of `-uh` stripped it reads the same as a repeated hesitation (`Uh, uh,`). `[]` disables the list. Whisper word times on these tokens can drift by a second on a gated track (the lab's Lana); that timing problem is not handled here.
- **Isolated hard fillers** — `tighten.isolated_filler_candidates: true` (default). A lone hard filler (a `filler_words` entry that is not a discourse marker, such as `Um.`) is proposed without a cluster, because every hit is a pending proposal the host reviews. `light` turns this off, so a hard filler there needs `tighten.min_filler_cluster` (2) hits within `filler_cluster_gap_sec`. Discourse markers always need the cluster and then the discourse checks below.
- **Discourse-safe selection** — Tokens in `tighten.discourse_markers` (default `like`, `you know`, `sort of`, `kind of`) remain in `filler_words` but are **not** cut unless at least one of: (a) an **adjacent** true disfluency (`um` / `uh` / `erm` / `ah`, or any other non-marker lexicon hit) or an immediate repeat (`like like`); (b) a pause ≥ `tighten.discourse_pause_sec` (default 0.35 s) on at least one side of the marker span; (c) ASR confidence < `tighten.discourse_confidence_max` (default 0.6). Multi-word markers match split ASR tokens via adjacent-token windows (`you`+`know` → `you know`). Pause and low-confidence are intentional escape hatches, with one exception: `like` directly before a subject pronoun (`I`, `I'm`, `you`, `we`, `he`, `she`, `they`, `it`, and their contractions) is content, either comparative ("like I'm doing") or quotative ("I was like, I'm done"), and is never cut, whatever its confidence or flanking gap. The owner confirmed this on the lab recording, where Whisper gave Audra's "like I'm doing again now" a confidence of 0.19. Any other fluent quotative or comparative `like` with a ≥0.35 s flanking gap or ASR confidence below 0.6 still becomes `filler:like`. Fluent uses without those signals are counted as `discourse:{token}` (including isolated markers rejected by `min_filler_cluster`) and show up in the propose summary (`N discourse kept`). Accepted hits still use reason `filler:{token}`. Missing `discourse_markers` uses the defaults; explicit `[]` disables demotion.
- **Leave risky cuts in** — When `tighten.leave_in_if_risky: true` (default), cuts that fail the risk model are skipped rather than applied.
- **Padded cuts are two faded edges, not a splice** (#978) — The join approving ships is decided once, from the edit mode and the paced pad (`_CutPlan.for_cut` in `edits/tighten/plan.py`: span, join, paced pad, next burst). The join is `splice` (a ripple with no pad), `padded` (a session ripple with a pad) or `mute` (mute in place, see [Mute vs cut](#mute-vs-cut)), and it picks the edge checks from one table (`CUT_EDGE_CHECKS` in `edits/cut_policy.py`). A ripple is always a session cut, so a peer speaking over the span never changes the join (it raises a review flag, see **Decision: A guard-blocked filler waits for review**) and the edge checks run once. With a pad (`replace_gap_sec` > 0) the render never butts the edges together: the left edge fades out into the pad (`filler_pre_pad_fade_out_ms`) and the right edge fades in after it (`recommend_post_pad_fade_in_ms`, which approval calls with the decision's `next_burst_sec`). The checks that score a splice therefore do not run on it: breath protection (`protect_cut_breaths`), the level-jump terms of the cut-risk score, and the join continuity gate. On the lab tape they rejected all four filler cuts the owner approved as rendered (Caleb `uh,` 604.80, `Uh,` 706.14, `Um,` 712.34, `You know` 1441.38) plus two negative controls whose edges ran into neighboring words. Padded cuts get two checks instead. **The right edge stops before the next word's first phoneme**: `edits/word_onset.py` reads the audio from the filler's tail for the first new sound (the first audible frame or high-band jump out of the quiet after the filler, which catches a plosive burst under the voice floor; in continuous voice, the foot of the rise: once a rise out of the dip shows a new sound began, walk back to where the level started to climb. The dip's trough is too early, because the owner still heard the end of `uh` with the cut at the trough of `uh, we` (lab 706.37 vs a foot at 706.42-706.44), the level falling into a low, dark stretch before the word rises), and the cut ends 10 ms before it. The onset has a kind. A **burst** rises at least 18 dB in the high band within one 10 ms frame step (a plosive out of closure: 22 and 40 dB on the lab tape); anything that ramps (fricative, glide, nasal, vowel) is **gradual** (`she` gains 4 dB per step, `we` out of its dark stretch 10-14 dB). The foot of the rise walks back while each earlier frame is at least 0.5 dB lower, so the flat stretch before it does not drag the edge back. Only a burst travels on the decision as `next_burst_sec`, and the post-pad fade-in is cut down to finish before it, never below the join declick (`inaudible_cuts.micro_fade_ms`, 10 ms), so the ramp never attenuates the burst. A gradual onset moves the cut edge but sets no cap: the fade-in keeps its full recommendation, because a ramp over a fricative such as the `sh` of `she` (+4 dB per frame in the high band) is softer than a 10 ms one (the owner found 10 ms on `she` a little harsh and had approved 112 ms). The scan reaches as far past the cut end as the longest post-pad fade-in (`filler_post_pad_fade_in_max_ms`): an onset within the 10 ms guard shrinks the cut, and a burst further out leaves the cut alone but still caps the fade (the lab's `uh, nope` cut ends 90 ms before `nope`, so its fade is 90 ms, not 120). With no burst in reach the recommendation stands. Word times cannot place this: Whisper and the aligner drift by up to ~1.2 s on the lab tape. If that leaves the cut ending more than 40 ms (two frames of word-time jitter) before the filler's own word end, the cut is dropped as `next_onset`. **No kept word may vanish inside the span**: a cut that covers the whole span of an unsuppressed word other than its own filler tokens is dropped as `kept_word:{word}` (the owner rejected a cut that removed all of `we` plus the start of `should`; a cut that grazes a neighbor's tail is fine). The left edge is otherwise unchanged. Ripple cuts without a pad (acoustic gap runs, repeats and restarts, and a filler with no flanking word) keep every splice check. A pause trim keeps them too, except breath protection, which its air rule replaces (see **Decision: Pause trims cut only air**). A mute gets the padded-cut checks and keeps breaths whole (see [Mute vs cut](#mute-vs-cut)). Confidence and word-margin risk terms, voiced-edge review, the bleed-owner check and the overlap rules apply to all three; peer-speech scoping applies to ripple cuts only.
- **Filler left edge** (#1061) — A word filler's cut starts at its voice, not its word time. The aligner starts fillers late: on the lab tape both `um`s voice 320–350 ms before their word start (616.26 voices from 615.94, 713.00 from 712.65), so a cut from the word start left the head of the `um` audible and the owner heard each cut start mid-`um`. Before any edge check, and for every join (padded, track splice, mute), `_gate_cut_edges` walks back from the word start over 20 ms level frames every 10 ms (`voice_onset` in `edits/word_onset.py`) to the first frame under the track's voice floor (**Voice floor** below); the cut starts 10 ms before the audible frame after it. The walk does not bridge short dips the way voiced runs do, because the `ss` of `digress.` falls under the floor for only 20 ms before the owner-approved `uh` at 706.02. It only ever moves the edge earlier, only when a whole 20 ms frame of voice lies before the word start (a word start on the onset keeps its edge), and never past the previous kept word's end or 2 s back (word times drift by up to ~1.2 s on this tape). When the level stays audible all the way back to that word, the filler runs on from it with no quiet to cut in, and the cut is dropped as `filler_onset`. An edge at the word's end would cut its tail (lab `to like` at 424.6: the vowel of `to` runs 80 ms past its word end into `like`), and an edge at the word start leaves the filler's head; the owner's rule for mute mode (#1024) is to skip a filler that cannot be removed without clipping a neighbour. Acoustic gap hits have no word of their own; **Kept words keep their voice** below bounds them. On the aligned lab tape the `um` cuts now start at 615.93 and 712.64 (were 616.30 and 712.99) and lose their `voiced_edge` review flag; the `like` at 16.52, whose paced start had landed 110 ms inside the word, becomes a review hit starting at 16.45; the owner-approved cuts at 604.62, 706.00 and 1440.88 are unchanged. With Whisper word times only the `um` moves (615.94 to 615.93). A word the transcript dropped that runs straight into the filler would be cut with it; no lab case shows one.
- **Kept words keep their voice** (#1064) — No cut starts inside the voice of the kept word before it or ends inside the voice of the kept word after it. Word times end a word before its voice does: on the lab tape `So` ends at 230.78 by word time, holds full level to 230.88 and falls under the track's voice floor only at 230.98, so a mute from 230.805 cut off the second half of the word (owner listening, PR #1169). The voiced-edge check missed it because the vowel is breathy: its pitch peak stays at 0.15-0.49, under the 0.55 a voiced run needs, while the gap scan's 0.28 took it for a hesitation. `_between_kept_voices` in `edits/tighten/plan.py` therefore reads the neighbours by level, not pitch, for every join, against the track's voice floor (**Voice floor** below), the measure the filler-onset walk uses. `voice_end` in `edits/word_onset.py` walks forward from the previous kept word's end to its first quiet frame (the voice ends with the audible frame before it, where a voiced run's edge sits), and `voice_onset` (the filler-onset walk, shared) walks back from the next kept word's start to its last quiet frame. A cut without words of its own (an acoustic run or a pause) then starts 60 ms after that voice ends and ends 60 ms before the next voice starts, the voiced-edge air (`_VOICE_EDGE_PAD_SEC`). A word cut reads its neighbours only up to its own words: it starts no earlier than the first quiet frame after the previous word, where the filler-onset rule puts its edge, and ends 10 ms before the next word's voice. Voice that runs on between a word cut and a neighbour with no quiet frame stays with the filler-onset and next-onset rules; word times cannot stand in for the audio there (Whisper starts the `we` after `Uh,` at 706.26, 180 ms early). The exception is a word cut that the previous kept word's voice runs on through from end to end, with no quiet frame and no dip 10 dB deep (`voice_separates`): the cut lies inside that word's voice and would clip it, so it is dropped as `kept_voice` (#1024: skip what cannot be removed without clipping a neighbour). With Whisper times the repeat mute at 752.72–752.90 is such a cut: it holds -6 to -12 dBFS inside the kept `well,` (aligned, `well,` ends at 752.87). The aligned repeats at 753.17 and 1020.31 start after dips 20 and 14 dB deep and stay review hits. A cut that is then shorter than its minimum or no longer covers half its target, or an acoustic run or pause that a kept word's voice runs on through, is dropped as `kept_voice`. The exception to the exception is a hum the transcript missed that decays into the next kept word through a valley (**A valley between an untranscribed sound and the next word**, #1358). Lab (rev 3b414c4c, mute, against the PR's first head): with aligned word times proposals go from 57 to 55. Three runs are dropped: 230.81 (`So`'s own tail), 1563.83 (it ended 145 ms into the voice of `A`) and 1158.61 on another track (`voiced_edge` once moved). One is new: 949.68, the sound before `Like`, which ended inside `Like`'s early voice and was dropped as `next_onset`. Nine move: three start later (60.80 +65 ms, 63.43 +44, 1646.56 +23) and six end earlier (249.70, 653.89, 874.78, 1173.61, 1549.39, 1555.74, by 35-56 ms). Every word filler and repeat is unchanged. With Whisper times (`edit-ready`) proposals go from 38 to 37: 1153.55 started 95 ms inside `Okay.`, and the `uh` at 705.97 started 40 ms inside `digress.` and now starts at 706.00, the owner-approved aligned edge. Counting proposals with an edge inside a neighbour's measured voice (one 10 ms hop of tolerance): mutes 4 to 0 across both word timings; all six proposal sets (mute, ripple, aggressive ripple, both timings) 8 to 1. The one left is the aggressive Whisper ripple `kind of` at 423.13, whose voice runs on into `happened` with no quiet frame. Three repeat mutes per timing also have no quiet frame between the kept word and the repeated one, so no voice end can be measured; they keep their `voiced_edge` review flag (the Whisper one at 752.72 is now dropped, see above). Ripple at medium intensity loses two review hits (pause 233.37 now fails the splice breath check, acoustic 1555.74) and its word fillers are unchanged. Aggressive ripple gains four pause trims whose starts now clear the previous word's tail (57.56, 63.47, 1320.25, 1554.70).
- **Voice floor** (#1064) — The voice walks (`voice_end`, `voice_onset`) read quiet against the track's own levels, never a fixed dBFS level: Tighten reads raw, unnormalized tracks, and a fixed -42 dBFS floor moved the boundary with recording level (the host track scaled by -12 dB ended 487 of 739 kept words' voices more than 20 ms early, back inside the words; at +6 dB the dip before the approved `uh` at 706.02 never reached it and the cut was dropped). `LevelProfile.voice_floor_db` (`engines/level_profile.py`) is `max(S − 27 dB, R + 6 dB)`, from the whole track's level profile, measured once per audio file revision and sample rate (the same room/speech measure breath detection reads over 5 s; [audio-engineering.md § Detection levels](audio-engineering.md#detection-levels)): S is the 90th percentile of its live 10 ms frames, R the 10th percentile of all its frames, so a track a noise gate holds at digital zero between words has digital silence as its room, not its words' soft edges. 27 dB is where the owner-approved audibility floor (-42 dBFS) sits under the lab tape's speech (26.7 dB on the host track, 25.3–28.6 dB on all three), so at the lab's level the floors are -42.3, -40.4 and -43.7 dBFS and the walks keep their edges (`So` still voices until 230.99; the `ss` dip still ends `digress.` at 706.02). 6 dB keeps the floor over a noisy room's frame-to-frame flicker, where the speech term alone finds no quiet, and under the 9.5 dB over the room where the breath detector starts, so a kept word's own breath never reads as quiet. A dip that misses the floor still ends a voice when it is the bottom of a dip 15 dB deep on both sides and within 3 dB of the floor (the `ss` of `digress.` clears the floor by about 1 dB and sits 19 and 28 dB under the sounds either side); a ripple on the slope into a deeper dip is not one. Each dB of allowance over the floor stops more walks at dips inside words: walks started 150 ms inside 362 host-track words stop inside the word 61 times on the floor alone, 73 times with 3 dB, 88 with 6 dB and 105 at any level. Measured on the lab tape with only the gain changed (+12 to -24 dB, all 1146 kept-word gaps of 0.15 s or more on the three tracks), every voice end and onset stays within one 10 ms frame of its lab-level edge. Lab (rev 3b414c4c, against the previous head of this fix): aligned mute 55 → 55 (two acoustic mutes end 10 ms earlier, 520.79 and 1050.93); Whisper mute 37 → 36 (the repeat at 752.72); medium ripple unchanged; aggressive ripple aligned 42 → 42 (pause 643.79 starts 10 ms later and loses its join review) and Whisper 23 → 22 (`kind of` at 423.13, whose start sat on the tail of `it`, is dropped as `filler_onset`). Every owner-approved cut is unchanged. **One floor for every tighten rule** (#1195): the next-onset scan (its high-band burst floor sits 28 dB under it), the voiced runs and voiced-edge nudge of the cut-edge gate, the peer-voice check, the `inaudible` check on a mute, the acoustic scan's local speech reference, and the optimizer's and fades' quiet levels (`inaudible_cuts.trailing_energy_*_over_floor_db`, `absorb_trailing_silence_quiet_over_floor_db`, the post-pad fade-in and previous-word lead-out in `edits/cut_quality.py`) all read it, so no tighten rule has a fixed dBFS level any more. The last two were the peer-speech fallback (`min_other_rms_db`, -42 dBFS) and the handoff cut's `quiet_db` (-48 dBFS): both are gone (#1306, #1373), and a handoff hop is quiet when every lane is at or under its own voice floor ([inaudible-cuts.md § Narrative handoffs](inaudible-cuts.md#narrative-handoffs)). Callers with no decoded track (approval, natural-language edits) read the same floor through `track_level_profile` (`edits/audio_cache.py`), which falls back to the recording's profile, measured once per audio file revision and sample rate. The acoustic scan's active floor is the track's speech level minus `BREATH_BELOW_SPEECH_DB[1]` (40 dB, the deepest a breath sits under speech; it replaces a fixed -55 dBFS, which is 40 dB under the lab host's speech level of about -15 dBFS) or the gap's noise estimate plus 8 dB, whichever is higher, and the fade-in's hot level is the speech level minus 7 dB (the -22 dBFS it replaces). Gain invariance: `tests/test_tighten_gain_invariance.py` is the one contract for every detector (#1443): each runs one scene at 0 dB, at -12 and -24 dB on every track, and with one track alone at -24 dB, and must give the literal outcome pinned for 0 dB. The level readings that decide the `inaudible` check, the previous-word lead-out, the post-pad fade-in and the peer-dominance check report digital silence as -200 dBFS (`DIGITAL_SILENCE_DB`, `util/dsp.py`, now the default for every `rms_db` caller), not the -80 dBFS floor they once used: on a gated track with speech near -60 dBFS the -80 floor read a silent gap as louder than the voice floor, which kept mutes that were inaudible and moved filler starts to the lead-out maximum. Transcription's word-span trim, reconcile and the bleed audit read the same floor (`LevelProfile.voice_floor_db` through `TrackRmsCache.profile`, which `TrackAudioCache.profile` delegates to; #1324, [transcript-reconcile.md](transcript-reconcile.md)). Evidence for the relative offsets (lab rev 3b414c4c): the burst floor 28 dB under the voice floor puts the high-band level a jump out of the quiet must reach at -72 to -68 dB on the three tracks, where room noise sits near -95 dB in that band and flickers by about 10 dB; the acoustic scan's 40 dB equals the -55 dBFS it replaced at the host's speech level of about -15 dBFS and is now the deepest breath depth, so the scan is unchanged there. The digital-silence floor change (above) moved no edge at the lab's own level (aligned and Whisper word times, mute and ripple at medium and aggressive: 0 edges differ by more than 10 ms from the previous head, review hints included). Against main the `um` at 40.32 ends at 40.97 instead of 41.07: the high-band burst level, 0.26 dB lower, finds the next word's onset a frame earlier; the two renders differ by at most -62.7 dBFS, over audio averaging -80 dBFS. With the lab tape's raw tracks scaled by -12 dB as 32-bit WAV, all 56 aligned mute proposals, review hints included, match the 0 dB run to 10 ms. Scaling the Zoom originals and re-running the transcript steps used to change the transcript itself first: reconcile marked 176 more words `inaudible` at -12 dB under the fixed `audibility_rms_db` (#1324, now removed); with the 0 dB transcript held fixed, all 41 proposals match at -12 dB.
- **Padded left edge and breaths** (#1064) — A padded cut's left edge fades out over `filler_pre_pad_fade_out_ms` (5 ms) with no breath check, so the lab tape was measured before adding one. The sample was every padded ripple proposal at medium and aggressive intensity, with Whisper and with aligned word times: 27 left edges (rev 3b414c4c). None sits inside a complete breath, as `protect_cut_breaths` reads an edge. 20 sit in activity that runs on into a word, either the previous word's decay or the filler's own voice, and 3 are in clear air. The breath-run classifier (`classify_breath_samples` over the fade) calls the tail at 2 cuts breath-shaped (4 edges across the two word timings): `hair.` before `you know` (1440.88) and `the.` before `like` (948.84, aggressive only). Both are the previous word's breathy release, which `recommend_prev_word_lead_out_ms` keeps until 20 ms after it falls under the track's voice floor. The edge sits at -49 to -51 dBFS, 10 ms before the run ends and about 40 ms before room tone. The owner approved the 1440.88 cut as rendered (#978). No breath-safe left edge was added.
- **Join continuity gate** — When `tighten.join_continuity_gate: true` (default), `assess_proposed_cut` runs on every cut without a pad after boundary optimization; verdict `fail` skips the candidate (fail-closed). Verdict `review` marks `review_required`. The verdict is the worst over every edge placement within `join_continuity.edge_tolerance_ms` (3 ms), which roughly halves the verdict flips a few-millisecond nudge or re-timed word causes; a splice inaudible at the proposed edges passes regardless. See [inaudible-cuts.md](inaudible-cuts.md) § Join continuity.
- **GUI review loop** — ShareCut Studio's Review Queue lists pending `filler:`, `pause:`, `repetition:`, `restart:` and review-only `filler:acoustic` hits, grouped by the server `kind` (filler, pause, repeat, false-start, sound; acoustic hits are the Sound chip). Cut, keep or lower one, or **Cut all N** on a group header (every eligible hit in it gets the one action its kind of sound carries, from `edits/cut_policy.py`: cut, shorten, lower or leave; one Undo; a pause trim whose join still needs review stays pending, which the editor applies one at a time after listening). **Find more** re-runs the proposal at the saved intensity. Cut and Keep use the same `ApproveEdits` / `RejectEdits` path as the pending inspector. See [daw-editing.md](daw-editing.md) § Tighten review.
- **Waveform boundaries** — Proposals call `optimize_source_cut_range` when `tighten.inaudible_opt: true` (default). Short cuts also **extend the end to the quietest point before the next word** (within `trailing_energy_extend_ms`) when ASR ends a filler early (see [inaudible-cuts.md](inaudible-cuts.md) `trailing_energy_*`).
- **Adaptive fades** — Each decision gets `crossfade_ms` from `recommend_cut_fade_ms` (roughly 15–50 ms for fillers, up to ~150 ms for long pauses, scaled by join level jump).
- **Breath co-removal** — Adjacent breath-shaped energy before/after a cut is included in the remove range when detected (`tighten.breath_handling.enabled`). A breath must be **unvoiced noise all the way to the cut, between the track's own room tone and speech level, and outside every kept word**. The detector (`edits/breath_detect.py`) reads 5 s of the kept audio on each side of the cut and takes the 10th and 90th percentiles of its live (not digitally silent) 10 ms frame levels as the room-tone floor and the speech level; a breath frame sits at least 9.5 dB above that floor and 7–40 dB below that speech level (`breath_level_band`). Flanks with no such contrast (a gated track with nothing live nearby, or under 0.5 s of live audio) yield no breath. On the lab tape breaths sit 6–39 dB below the local speech level and 12–45 dB above the floor; the previous band, derived from the fixed `analysis.heuristics.audibility_rms_db`, was −32.4 to −31 dBFS and found 1 of 26 labelled breaths (#814). The scan forms complete in-band runs before selecting those overlapping the 400 ms search before or the 250 ms search after the cut. It takes the first complete run of breath length (80–450 ms) that passes five checks. Frames inside a kept transcript word are never breath and the stretch between the run and the cut may not touch one (a word the cut itself removes at least half of is not kept), so a quiet phrase-final word tail such as lana's `she?` cannot be called breath. A run that continues a kept word on its far side, with no frame at or below the band floor between them, is that word's decay (before the cut) or onset (after it), whatever its own shape: the aligned `uh` at 1441.21–1441.27 decays through the band to 1441.41 and the `sh` of `she` at 1456.65–1456.76 is a 2–3.5 kHz burst under the sibilant split; the scan covers the whole 5 s of flanking audio so the word can lie outside the search window. No frame between the run and the cut may exceed the band ceiling: vocal fry scores 0.1–0.4 on the pitch probe but its pulses sit at speech level (an untranscribed creaky `check` at 1122.98–1123.15, −17 dBFS frames against a −18.8 dBFS ceiling). Neither the run's energy nor that of the gap between it and the cut edge may sit mostly above 4 kHz (a sibilant `s` carries 54–100% of its 100 Hz–8 kHz energy there, a breath 1–24%; the gap is checked on its own so a word-final `s` next to a loud breath cannot average out below the split). And 40 ms speech-pitch (70–350 Hz) autocorrelation probes every 10 ms over the run **and everything between it and the cut edge** must all stay below 0.55, because the cut is extended out to the run and removes what lies between; only probes whose frame reaches the band floor count, since room tone 40 dB under the speech level also scores 0.6–0.8 on this tape and is not speech to protect. A run that fails is skipped for the next quieter one. The band alone cannot tell breath from speech — in a loud window a window-relative band selected the quieter frames of ordinary speech, and on the lab tape 82% of its hits were voiced, including the kept second copy of a repeated word; a breath sitting 270 ms before a cut also pulled the voiced word between them into the cut (#798). Some breaths on the lab tape peak at 0.60–0.65 on the same probe and stay undetected; the gate is kept because quiet voiced speech reaches down to 0.57. Detection cannot widen a cut beyond its candidate bounds. After pacing, candidate-bound clamps, and voiced-edge nudges, `protect_cut_breaths` checks both final edges of a cut without a pad (a padded cut fades each edge against silence instead; see **Padded cuts** above). The shared detector completes the quiet onset and tail to measured room-tone separators on the 10 ms level grid and rechecks pitch, sibilance, kept words and the level ceiling over the full envelope. A start inside a confirmed complete breath advances to its offset; an end inside it retreats to its onset. Exact onset/offset boundaries stay unchanged. Both adjustments use the original bounds and only shrink the cut. Empty cuts and non-pause cuts that no longer cover at least half their target span are dropped. Connected above-floor activity that crosses an edge but fails classification suppresses the proposal, as do missing evidence and incomplete bounded envelopes. A **pause trim** is different (see **Decision: Pause trims cut only air**): it shrinks to the longest stretch of air inside it, measured against each track's room tone, rather than being suppressed, so this paragraph's edge rules do not apply to it. Rejected activity elsewhere and floor-level silence do not suppress a cut. Shrink recomputes kept-word eligibility, scope and voiced safety; risk, pad, join and fade use the settled bounds. Enabled handling requires a usable room-tone/speech profile; disabled handling preserves the existing geometry. This conservative bounded check does not guarantee universal breath recall or replace listening. Automatic application consumes stored optimized proposal bounds without a second snap. Source-witnessed removals keep their current proved timeline window exact, including after a manual nonsnap resize. Unwitnessed pending edits also retain their finalized bounds. Pause trims assess the held operation and current retained air without another preparation pass.
- **Pause floor**. Long pauses retain original quiet on both sides of the final removal. Turn pauses with another dialogue track's words in the gap keep `tighten.min_retained_pause_sec`, about 0.18 s. Solo pauses with quiet peers keep `tighten.min_retained_solo_pause_sec`, about 0.55 s. The floor counts disjoint, once-played source pieces between complete flanking word images on the current timeline. Deleted material, mutes, ignored regions, replay, foreign media, registered beds, and known pad samples contribute nothing. If a bounded smaller cut cannot retain the floor and pass the ordinary safety checks, the pause holds. Neither configured silence nor room tone automatically fills a pause-floor shortfall. Reasons retain the `pause:…s:solo` tag when the solo floor applies.
  Peer turn evidence follows each current playback occurrence. Ignored tokens and
  fully muted speech do not lower the floor. Partial mute fades and unmuted replays
  retain their audible kept words. A track's mix listening mute retains turn evidence.

### Peer speech guard

The tighten candidate scan (`analyze_candidates` in `edits/tighten/prepare.py`) builds
timeline RMS caches once per run via `shared_timeline_rms_caches` in
`edits/cut_proof.py` (`build_track_rms_caches(..., unprocessed=True)`) and passes
that `TrackRmsCacheSet` through `resolve_cut_scope` for every peer-scoped cut
(#1660).

`speech_energy_guard` checks each mapped span independently with 10 ms frames,
including up to the existing 60 ms outward edge pad. One qualifying frame can
block session ripple, even when a long cut dilutes its whole-span mean. New
decision reads are at most 2 s; up to 5 s of nearby audio on either side supplies
calibration only. Detection and context stop at the peer lane's end.
Ripple confirmation already knows the exact removal and chosen speech. Its
sound windows derive the removed samples by applying the removal to each peer clip
as the consumer does and laying the lane out on the reader's sample grid
([architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock)),
after subtracting selected and batch-chosen spans, so the raw projection, placed
playback and the guard agree on which native samples a removal deletes, at any
fractional source origin or placement. A window keeps the containing live removal
component as private geometry; where it meets the component's own edge it extends
to the physically removed cells. Selected and batch-chosen sound stays outside the
window's evidence and diagnostics. Speech in another window cannot be attributed
to an earlier window. A cell that a removed and a retained recording both play in
(an overlay) is read from the removed audio alone, so the retained recording's
sound does not count as removed and the removed one is not hidden. If that audio
cannot be read, those cells give no calibrated decision and the existing mean
fallback applies.
Dense owner bleed can fill a peer's reference frames, so its room cannot be read
from them (#1252). The peer's own frames, those the owner does not dominate,
then show it. A run of them is room when it carries no speech pitch and none of
its 40 ms windows (the pitch probe length, so a low hum does not flicker the
level) rises more than `VOICE_FLOOR_OVER_ROOM_DB` (6 dB) over the lower quartile
of the peer's own windows. The pitch test is
`voiced_runs.carries_speech_pitch(..., interior=True)`: the autocorrelation peak
tighten's voiced runs use to keep breaths, clicks and room tone out, counted
only where it is a true peak, because low-frequency room noise has a correlation
that only falls and would otherwise read as a high voice. When bleed buries a
remark under that room reference, `voiced_runs.carries_quiet_speech_pitch` also
reads the peer's own sound: weak but stable speech-period f0 across three probes,
with an f0 spread cap relative to the median f0, so a quiet backchannel still
warns while scattered hum peaks do not (#1357). Both tests are relative to the
peer's own sound, so recording gain, the owner's pitch and a same-gender pair
change nothing. A run that carries pitch, rises above that
quiet, is under three probes (60 ms) or cannot be read blocks as before. The
exception is a run shorter than one 40 ms window: a stray frame or three between
the owner's words holds no pitch to read, so it is room where its mean power
stays within the same 6 dB (#1361).
Supported boundary: in this case only, a quiet unvoiced peer sound (for example a
short "shh" or "psst" 28 to 37 dB under the owner's speech, filling an owner gap) can
read as room. Voiced speech, whispers with any voicing, laughter and inhales still
warn; the pitch test finds harmonic voices from 300 to 1,200 Hz, not only the
70-350 Hz speech range. A sound that fills most of the peer's own frames sets its own
reference, and a steady hum strong enough to show a pitch peak reads as voice and
still blocks. The room test reads the removed cells above (`sole` and `shared`), so
its pitch probe, like its levels, sees only the audio the removal deletes.
Initial proposal queries retain the outward pad. After
edge protection, a non-pause cut checks only its finalized mapped removal;
approval repeats that check on the current validated removal geometry.
Pause cuts refresh that evidence only after a completed acoustic observation
and successful original-air retention and effect checks. The final mapped
removal must stay inside that observation's request bounds. Approval checks
the pause's stored bounds and completed effects before using fresh mapped spans.
Geometric observations retain the generic query. Peer sound inside a pause
still requires session review and excludes automatic application.
The local floor is `max(S − 25 dB, R + 6 dB)`, using the peer's live-frame
90th percentile for S and all-frame 10th percentile for R. A concurrently louder
owner excludes a peer frame from both activity and S, with the configured
`dominance_db`; owner speech elsewhere cannot discount that frame.
Every raw room reference, including the decision interval's reference view,
uses only complete frames within current peer-lane playback coverage. Real
clip gaps and time before a shifted clip supply no reference frames. Digital
zeros recorded inside a clip and owner-dominated raw frames remain eligible.
Detection and own speech-level frames, whole-span means, and unread spans retain
their existing meaning. Missing room reference uses the existing mean fallback.
A qualifying frame also reaches the peer's own `LevelProfile.audibility_floor_db` (#1549): a peer who
is quiet around the cut calibrates against its own room, and without this floor that room's
flicker, 40 dB or more under its speech, read as a voice. Which mic is louder (the dominance
rule here) is read on the recordings against each mic's own voice
(`LevelProfile.path_reference_db`, the voice scale of [audio-engineering.md](audio-engineering.md)),
with no balance gain: a call recording carries a guest hotter than the guest's own mic, so
as recorded it always out-sounds them, and a gain is a listening choice that moves no verdict.
The scale applies only when every track compared has a recording of its own and a voice within
40 dB of the session's loudest: a track with no media (parked clips read their sources), an
unreadable file, or residue is read as recorded along with the tracks it is compared with, since
a scale on one side only moves the verdict.
`asr_silence.SpeechLevels.has_speech` compares the recordings without the gains but not yet
against each mic's voice.
The mean fallback (#1306, #1373) holds a peer's whole-span level to
`LevelProfile.voice_reach_db` (read through `TrackRmsCache.profile` or `track_level_profile`, `edits/speech_energy_guard.py`): the peer's
audibility floor, no lower than 27 dB (`VOICE_FLOOR_UNDER_SPEECH_DB`) under its loudest frames, so
a sparse speaker whose 90th percentile is room tone does not put the floor under the room. A peer
with no live audio never speaks. A peer whose loudest frames show no contrast with its room has
no voice level of its own, so it is held to the median voice reach of the session's other
tracks, and with none to read it against it speaks only when its mean is `dominance_db` or more over
the owner's own mean in the span (a flat track as loud as the owner's is no voice, a flat track over a
silent owner is one). There is no fixed dBFS level and no
`tighten.speech_energy_guard.min_other_rms_db` setting; the same recording at any level names the
same speaking peers (the detectors' one gain contract, `tests/test_tighten_gain_invariance.py`,
runs it at 0, -12 and -24 dB and with one track 24 dB down, with a sparse guest 20 dB under the
host; two voices of one pitch are told apart by level).
A peer that has a voice level of its own is read at its loudest 100 ms window in the span
(never below its span mean), not at the span mean, and the owner is read the same way in those spans (a peer without a voice level of its own stays on
the means for both), so a
short peer word inside a long cut is not diluted by the silence around it; noise under the
voice reach still never reads as a voice (#1419). A dialogue lane with no readable file is
skipped, not an error, when the session median reach is built.

Whole-span RMS values remain diagnostics. If fine frames cannot be read or the
local reference has no speech/room contrast, the existing mean threshold and
owner-dominance rule normally decide. This keeps continuous hot activity protected;
steady noise raised above the mean threshold can still block without usable
contrast. When live owner-dominated reference frames are present and raw R is
strictly above S, the guard conservatively blocks if the decision interval has
non-silent undominated activity. Dense bleed therefore cannot hide a brief quiet
peer remark through a whole-span dominance fallback. This can also warn for quiet
room noise after an owner stops, because these levels cannot distinguish that
noise from quiet independent speech. Sparse owner activity over stationary quiet
noise does not qualify merely because `R + 6 dB` exceeds S. Readable digital silence
and entirely owner-dominated bleed stay clear.
Unreadable whole-span audio retains the unsuppressed voiced-word fallback.
This guard's local reference is separate from the 27 dB kept-word voice walks
and the recording-wide pause-air model described above.

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
check pending). After #1075 moved the left edge to the filler's voice, the review-only
`like` cut at 16.45 s could still start while `of` was decaying (#1079); `_start_at_filler_onset`
now waits with `recommend_prev_word_lead_out_ms` only when the previous kept word's voice
runs on through the filler word time (`voice_end` finds no break), the proposed left edge
sits in that decay tail, and the filler's own onset is at or after its word time (#1079).
Early acoustic onsets and separated neighbours are unchanged.

### Decision: A guard-blocked filler waits for review

<!-- decision
id: D-guard-blocked-filler-waits-for-review
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- #1370 lab (Whisper word times, ripple, light then aggressive apply): one of 20 applied records was a one-track punch, `filler:like:track_local:caleb`, Audra's track only, 1400.01 to 1400.73 (0.72 s), with Caleb speaking over it; aligned word times, ripple: 0 of 43
- Owner trim-mode decision (2026-10-06, #1137): a ripple edit ripples every dialogue track, and cutting another speaker's speech is a warning the user confirms, not a silent local edit
- Operator decision (2026-10-13) on #1370: when the speech guard blocks cutting a filler across all dialogue tracks, it must not auto-apply as a one-track punch; the default `on_conflict` becomes `review`, and `track_local` is deleted because no current product workflow asks for a local punch
- Owner (2026-10-13, amended in place): the editor's own bulk Apply suggested actions and, by default, the pipeline apply a held cut too, rippled across every track, because it is reversible (**Decision: Non-speech sounds get a suggested action**)
- Operator decision (2026-10-13) on #1407, from the same trim-mode decision: approving a guard-blocked filler ripples every dialogue track on a trusted human approval, never as a one-track punch. The suggestion is stored as a session ripple (scope `session`, with the speech it would cut recorded), not as scope `track`
enforced-by:
- tests/test_cut_scope_publication_contract.py::test_an_unknown_conflict_policy_is_rejected_at_load
- tests/test_cut_scope_publication_contract.py::test_the_shipped_and_the_unset_conflict_policy_is_review
- tests/test_cut_scope_publication_contract.py::test_a_guard_blocked_filler_in_ripple_waits_for_review_and_is_never_applied
- tests/test_cut_scope_publication_contract.py::test_mute_mode_ignores_peer_speech_and_needs_no_review
- tests/test_cut_scope_publication_contract.py::test_known_peer_generated_controls_preserve_conflict_policy
- tests/test_speech_energy_guard.py::test_add_remove_decision_over_peer_speech_waits_for_review
- tests/test_filler_pacing.py::test_analyze_candidate_blocked_peer_waits_for_review_as_a_padded_session_ripple
- tests/test_fillers.py::test_a_filler_a_peer_speaks_over_is_a_padded_session_ripple_for_review
- tests/test_approve_guard_blocked_ripple.py::test_programmatic_approval_holds_and_changes_nothing
- tests/test_approve_guard_blocked_ripple.py::test_confirmed_approval_ripples_every_dialogue_track_and_records_no_one_track_cut
- tests/test_approve_guard_blocked_ripple.py::test_programmatic_document_and_mcp_approval_cannot_override_peer_speech
- tests/test_approve_guard_blocked_ripple.py::test_a_mute_a_peer_speaks_over_still_applies_in_place_without_asking
- docs-sync: decision-filler-cuts
-->

The manual-confirmation requirement in this decision is superseded by
[D-manual-cut-intent](filler-cut-quality.md#decision-manual-cut-intent-bypasses-acoustic-vetoes).
Trusted explicit human approval is an acoustic override, including peer speech.
Programmatic calls retain acoustic checks, and both paths retain structural checks.
The complete-effect owner applies this distinction at publication; the structural
checks remain mandatory for both paths.


In ripple mode, a filler that a peer is speaking over is a pending suggestion
marked `review_required` with the reason `:other_speaking:<peers>`. Its intended
operation remains a session ripple, so approval does not silently convert it into
a one-track hole. Programmatic Apply suggested actions and pipeline calls retain
fresh acoustic checks. Trusted interactive Approve or a trusted human gesture can
override acoustic holds, including peer speech, while mandatory structural checks
still apply. MCP and CLI confirmation flags do not establish that intent. The
original programmatic proposal origin remains saved when a human approves it.
`tighten.speech_energy_guard.on_conflict` takes `review` (the default) or `skip`,
which refuses the cut. Any other value, including the removed `track_local`, is
rejected with a `ValueError` when the pipeline config loads. A mute is a track-scope edit by design, so mute mode
never consults peer speech and is unchanged.

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
- #1055 lab after round 7, against main at b785b17d6 and round 6: 138 pause decisions at medium (main 8, round 6 120), none auto (light 104, aggressive 160); every non-pause decision identical to main at light, medium, aggressive and mute, and no pause trim is applied by `apply_edits` or Apply eligible (now Apply suggested actions) on either path; 46 candidates dropped as `shared_pause`, each nested exactly in the trim that stays, and no two staying trims overlap (round 6: 8 pairs); R02, the 8.1 dB over threshold peer edge of round 6, is gone, R46 (1010.60 to 1011.07) is 1010.97 to 1011.01, aggressive 83.39 is gone and 87.60 is 87.65 to 87.67; the independent detector (raw stems, a 200 Hz to 4 kHz level over each track's local room) finds 1 edge in a sound of 6 dB or more at medium (round 6: 3), 4.7 dB under the threshold of hearing in every third octave after the high-pass; of the 70 edges any tier flags, 12 stay above threshold after the high-pass, the worst 3.5 dB at 5 kHz (round 6: 8.1 dB)
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
- #1179 round 9 audit: at aggressive `approve_edits_tool(apply_all_safe=True)` (since replaced by `apply_suggested_actions_tool`) applied nothing and the pipeline held one trim. The trim, 1.08 s of air, never covered a peer's word. A later trim in the same batch needed a 0.3 s pad, and the sampler took its room tone from the nearest quiet run, which lay inside the first trim's span, so the pad replayed that source at the later trim's seam. The first trim then played in two places, mapped to the 11.4 s between them, and the speech guard found a peer's "Uh-huh" in it. Pads now skip source seconds another pending cut still plays. Lab, light, medium and aggressive: `apply_all_safe` and the pipeline each apply every auto pause trim, 55, 65 and 73, with the same seconds lost on every track (49.97, 54.67 and 58.43 s of pause trims); the proposals, and so the kept spans, are unchanged from round 8
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
- tests/test_mute_in_place.py::test_apply_prefix_mutes_before_overlapping_remove
- tests/test_source_remove_geometry.py::test_saved_ordinary_remove_refuses_replayed_source
- tests/test_pause_reproposal_invariants.py::test_reproposing_over_a_padded_cut_never_double_cuts_or_splits_the_tracks
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
- tests/test_pause_policy_public_red.py::test_selected_saved_batch_with_held_pause_restores_bytes_mirrors_and_history
- tests/test_fillers.py::test_only_a_pause_trim_is_cut_down_to_its_air
- tests/test_tighten_hit_flags.py::test_a_pause_trim_that_stays_for_review_is_listened_to_one_by_one_and_never_eligible
- tests/test_tighten_hit_flags.py::test_studio_view_carries_the_same_harsh_and_listen_one_by_one_flags
- tests/test_bulk_pause_review_authority.py::test_bulk_leaves_a_fresh_pause_review_pending_without_writing
- tests/test_benchmark_tighten_smoke.py::test_each_kind_of_decision_stays_within_the_rebuild_bound_alone
- tests/test_fillers.py::test_a_pause_trim_that_fails_a_filler_check_stays_for_review
- tests/test_fillers.py::test_a_pause_trim_is_proposed_only_when_a_listener_would_hear_the_pause_shorten
- tests/test_fillers.py::test_a_pause_trim_is_judged_against_the_silence_a_listener_hears_not_the_tracks_own_gap
- tests/test_pause_policy_bilateral_original_contract.py::test_saved_and_suggested_retain_original_bilateral_air_without_a_pad
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
- tests/test_approval_order.py::test_original_auto_trims_keep_the_intervening_guest_without_replaying_source
- tests/test_approval_order.py::test_the_pipeline_applies_the_same_auto_trims_apply_suggested_actions_does
- tests/test_room_tone.py::test_room_tone_is_not_taken_from_source_a_pending_cut_still_plays
- tests/test_room_model.py::test_a_talker_whose_room_is_a_small_share_of_its_frames_still_reads_the_rooms_mode
- tests/test_room_model.py::test_a_talker_gated_over_a_third_of_its_frames_has_the_gates_silence_for_its_room
- tests/test_room_model.py::test_the_level_of_a_mode_is_the_median_of_its_frames_not_the_middle_of_its_bin
- tests/test_session_air.py::test_a_recording_with_no_words_takes_its_speech_level_from_its_own_levels
- tests/test_pause_reproposal_invariants.py::test_reproposing_over_a_padded_cut_never_double_cuts_or_splits_the_tracks
- tests/test_room_tone.py::test_a_pause_trim_over_source_a_pad_replays_is_held_not_a_hull
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
  densest low mode, with the median of the frames near it as the room's level; its histogram
  bins start at that ceiling, not at the recording's quietest live frame, which sits at the edge of
  digital silence and moved the bins, and so the mode, with the recording's level, #1195), else the low
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
  run from a few percent to about 10% and vary with the interval and its markers (Grondin's
  studies, reviewed in Grondin 2010, *Attention, Perception & Psychophysics* 72(3),
  561-582), measured between brief tones in forced-choice tasks, not on speech pauses.
  Friberg and Sundberg's [1993 ASA abstract](https://doi.org/10.1121/1.407650) reports
  about 10 ms for tones shorter than about 240 ms and about 5% for longer tones.
  Their metrical six-tone experiment does not measure speech pauses. The 0.1 threshold is
  a pacing design choice. These laboratory results do not validate a speech-pause boundary. The
  pause is how long nobody speaks around the trim on the session clock
  (`SessionAir.silence_around`: from the end of the last live word of any dialogue track
  before it to the start of the first after it), so a track's long gap that a peer talks across is judged by the pause actually heard, and the track's own word
  gap when no other word bounds it. The rule is relative to each pause, not to the lab
  tape, and it only drops trims: every kept trim has the span, pad and scope it had
  without it, and it runs before shared twins, so an invalid or imperceptible leader cannot suppress a valid twin.
- **Review or apply.** A pause trim is reviewed or applied by the same checks a filler gets
  (join continuity, scope and the speech guard, risky and voiced edges, `:interior_speech`,
  `:interior_audio`): one that passes them has `review_required` false, applies with
  `apply_edits` (the `ApplyAutoEdits` command, which an Editor link also runs) and the pipeline's
  `tighten_from_transcript`, and joins Studio's Apply
  eligible; one that does not stays for review. `:air_edges` labels a span that differs from
  the one pacing proposed, whether the air rule moved it or a kept-voice walk did before
  the rule ran, and raises no review: both of its edges are in air by construction. A pause
  trim is never merged into a filler, a track-local cut or an NL cut beside it
  (`_keeps_independent_review`), so its label, its scope and its pad stay its own. The
  server marks each pause trim that stays for review `listen_one_by_one`
  (`tighten_hits.py`) for the Review Queue. Apply suggested actions re-runs the join check at apply time instead of reading that flag: a pause trim whose join still needs review remains pending and is named as held. A trim with nothing left is skipped as `no_air`.
- **Approval reads what the lanes play now.** Approving a session cut re-runs the speech
  guard against the project as it stands. The guard reads a rendered stem only while it is
  fresh, and otherwise the recordings through each track's lane (`lane_window`, the mapping
  the air is read through), because after an earlier ripple a stem still holds the old
  timeline: round 7 read it at the later cut's new seconds, found a peer speaking in what
  the lanes had made silence, and punched a hole that shortened nothing, in 50 of 138
  approvals one at a time. Current scope evidence distinguishes peer speech, speaker bleed
  and genuinely unavailable checks. A fresh conflict holds the session cut; it never
  converts it to a track punch. An otherwise valid known-peer pause can remain a session
  review suggestion with actual CutSpeech context and the existing confirmation.
  Every ordinary SOURCE REMOVE proves original geometry before optimization and the actual
  final source/window pair before mutation. Missing, repeated, discontinuous or foreign
  source holds, as does a stored track pause. Positive played loss after the actual pad and
  the existing perceptibility gate are checked again against current playback.
  Holds name IDs and causes. Saved selected approval promises no selected change only after
  workspace rollback reports restoration; automatic application keeps held rows pending
  and applies independent survivors. Suggested fails on its separate preview snapshot.
  Finite implicit current primary lanes materialize before removal; unknown extent and
  intentional empty lanes cannot authorize source cuts.
- **Original pause or hold.** A pause counts qualified original quiet on both sides
  of the removal, using one source-piece collection with duration derived from its
  disjoint source union. Exact forward and reverse mapping proves each current piece.
  A chain of abutting clips can cross deleted source interior and retain inner original
  pieces. Full placed words and effect reach bound the observation query. Actual
  activity on simultaneous lanes bounds quiet, including tails beyond word timing.
  Renderer-selected paths identify media across source aliases. Lane mutes, clip mutes,
  ignored regions, repeated images, registered beds, and known pad receipts earn no
  duration. Current clip fields cannot distinguish a history-free replacement with
  identical source and placement from retained original. The consumer does not infer
  missing history or claim universal provenance.
- **Bounded contractions.** A shortfall tries a small deterministic set of right, left,
  and bilateral contractions from qualified original quiet inside the cut. The existing
  conservative right reserve remains preferred when available. Each attempt pins both
  bounds and preserves the original decision ID. Fresh preparation repeats scope,
  speech, breath, geometry, original floor, perceptibility, risk, and finite effects.
  Finish must pass before an attempt is selected, so a failed right join can yield to an
  independently checked left or bilateral attempt. The ordinary caller finishes the
  selected plan again. Exhausted attempts hold the original pending row.
- **Guarded removal and measured retention.** Whole-session guarded sound selection runs
  before generic peer voice contraction. Guarded `Sound` bounds remain the removal rule.
  Retention measures the actual origin recording's onset and release independently.
  Each side uses the first or last touching word and its adjacent measured pause anchor.
  Native DSP filters every original sample in that complete release-to-onset corridor,
  caps frame levels, stores them as float32, and smooths the whole corridor in power.
  Every outer collar frame must be at or below the same original reach in both bands,
  with at least five complete source-grid frames. The collar is not smoothed again.
  Missing anchors, sample or reach support, nongrid bounds, nonfinite samples and
  clipping keep the affected guard edge. Full guard samples are checked separately
  from corridor samples. The full guard must play through its queried placement once,
  with no additional same-media placement touching it on any lane or outside the query.
  Deleted corridor interior and interior-only replay remain measurable but add no
  retained original duration. Interior content stays protected. These finite-source
  observations do not establish universal acoustic detection. Disabled breath handling
  reads no room and uses conservative placement bounds only for unknown directions.
- **No automatic floor pad.** A pause holds when original quiet is insufficient or
  unavailable. `filler_pad_mode` and stale saved pad values do not change that rule.
  Pause trims never insert room-tone or silence pads. MUTE, manual gap fill, and nonpause
  filler/NL pacing retain their separate sample, fade, lane, loss, and receipt behavior.
- **Finite pause effects.** The final plan binds each survivor's fade to its source
  footprint before finishing the splice. Temporary split-kernel fades do not become
  authored fades. Genuine safe inherited fades remain. A newly generated splice fade may
  be zero at an edge with no safe capacity; an unsafe inherited fade holds the operation.
  Quiet fade duration still counts under the current retention floor. The scalar
  `crossfade_ms` recommendation does not overwrite the bound effects. Approval assigns
  exact effects after the kernel and archives actual source and timeline edges in
  `params.edge_fades`. The pause edge receipt omits private media paths and recording
  identity keys. `params.pad_samples` records actual inserted tiles only for manual and
  nonpause operations, with their track, source identity, and source bounds. An unresolved
  indicated source holds future pause analysis when its relevance cannot be resolved.
- **Pause shortening.** After bounded contraction and all fresh gates pass, final actual
  net loss must be positive and meet the existing ten-percent timing JND. The calculation
  uses current original audio and operation geometry. A stored pad value does not record
  replacement intent and cannot authorize or veto a pause trim. Proposal, saved, automatic,
  and Suggested paths apply the same final check. A tile cut from a recorded pad's samples
  is a copy, not original audio, and does not count as another play of the clip it was
  copied from, so a pad that borrows a pause's quiet leaves that quiet original.

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

## Non-speech sounds

Laughs, breaths, mouth sounds, false starts and short vocalizations sit between
words. Whether to remove one is often an editorial call that no detector can
settle: the same burst can be a laugh or a sharp inhale, and a real laugh can
still be worth trimming. This section sets what the tools suggest for them.

### Decision: Non-speech sounds get a suggested action, not a cut-or-keep verdict

<!-- decision
id: D-non-speech-sound-actions
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- #1355 owner listening (2026-10-13): cut mouth sounds, abandoned word starts and short vocalizations; keep laughs and playful vocal phrases such as "boop boop boop boop"
- #1365 owner listening on nine clips the burst-run laugh detector in #1428 read as laughs (2026-10-13): five were laughs; the other four were a retracted word start, a breath between two words, a breath before a word, and a sharp inhale before "um", three of which the owner would cut
- #1365 owner: these are "judgement calls that should just be brought up or flagged during editing", with probably no strict rule that gets them right
- Owner (2026-10-13): keeping laughter is usually good, though at times it can make another speaker hard to hear
- Owner (2026-10-13) accepted common podcast-editing practice as the basis without citations: keep laughter, lower a laugh that covers another speaker on that speaker's own track, lower or shorten breaths rather than remove them all, cut false starts, keep some hesitations for rhythm
- Owner (2026-10-13): a user who wants a quick result applies the suggested actions in bulk instead of reviewing each one, and can change any single decision later; bulk apply is "as low risk as labeling cause it's not permanent"
- Owner (2026-10-13), #1062 scope: a word-like acoustic span is labelled "possible missed word" with default Leave, not rejected, so the label can never hide a proposal
- Owner (2026-10-13): the pipeline applies the suggested actions by default, "it's low risk and could potentially save the user a lot of time"
enforced-by:
- tests/test_sound_actions.py::test_every_row_uses_a_known_action_and_every_case_kind_has_a_row
- tests/test_apply_suggested_actions.py::test_one_step_cuts_lowers_and_leaves_each_by_its_own_action
- tests/test_apply_suggested_actions.py::test_one_sound_can_change_after_the_batch_without_undoing_the_others
- tests/test_apply_sound_actions_step.py::test_the_defaults_apply_sounds_without_turning_tighten_on
- tests/test_apply_sound_actions_step.py::test_the_step_acts_on_sounds_and_leaves_spoken_proposals_pending
- tests/test_apply_sound_actions_step.py::test_with_tighten_off_the_scan_skips_the_word_probe
- tests/test_apply_sound_actions_step.py::test_with_tighten_on_but_analysis_not_run_the_step_ignores_stale_proposals
- tests/test_apply_sound_actions_step.py::test_a_rerun_does_not_relower_a_lower_the_editor_removed
- tests/test_apply_sound_actions_step.py::test_a_rerun_does_not_propose_a_left_sound_again
- tests/test_session_timeline.py::test_same_source_overlaps_count_a_lowered_span_as_audible_but_not_a_mute
- tests/test_acoustic_gap.py::test_coalesce_keeps_a_likely_laugh_apart_from_a_pause_or_filler_beside_it
- tests/test_decided_sounds.py::test_a_proposal_is_decided_only_when_it_and_a_record_cover_each_other
- tests/test_decided_sounds.py::test_the_source_id_matches_the_way_apply_lower_matches_it
- tests/test_decided_sounds.py::test_dropping_decided_sounds_keeps_speech_edits_and_applied_rows_beside_them
- tests/test_apply_suggested_actions.py::test_an_unreadable_peer_check_leaves_the_sound_pending_not_recorded
- tests/test_apply_sound_actions_step.py::test_a_runner_run_does_not_trust_the_analysis_log_of_an_earlier_run
- tests/test_speaker_split.py::test_reopening_a_span_inside_a_lowered_region_keeps_its_gain
- tests/test_acoustic_gap.py::test_a_laugh_like_run_is_proposed_and_flagged
- tests/test_acoustic_gap.py::test_a_likely_laugh_is_held_for_review_and_named_in_the_summary
- tests/test_acoustic_gap.py::test_a_span_the_model_hears_as_a_word_is_flagged_held_and_named_in_the_summary
- tests/test_acoustic_gap.py::test_a_span_the_model_hears_as_a_hesitation_is_proposed_unflagged
-->

Each non-speech sound or disfluency a detector finds is a pending proposal with
a label in plain words (for example "likely laugh" or "breath") and one
suggested action:

| Action | What it does |
| --- | --- |
| **Cut** | Removes the sound under the filler rules above (ripple or mute). |
| **Shorten** | Removes part of a long sound and keeps its start, under the same edge rules. |
| **Lower** | Turns the sound down on its own track for its span and leaves timing alone. |
| **Leave** | Keeps the sound. It stays listed with its label so the editor can choose another action. |

Default action by kind:

| Kind | Default | Note |
| --- | --- | --- |
| False start or abandoned word | Cut | |
| Hard filler (`um`, `uh`) | Cut | The filler rules above apply. The editor keeps some for rhythm. |
| Mouth click or smack in a gap | Cut | |
| Breath | Leave | A long breath between sentences may be suggested as Shorten. A breath next to a cut can still go with it (**Breath co-removal**), and no edge falls inside a breath. |
| Laugh | Leave | When it overlaps another speaker's words on another track, Lower on the laughing track for the overlap. |
| Backchannel (`mm-hmm`) | Leave | Lower when it covers another speaker, as for a laugh. |
| Playful vocal phrase | Leave | |
| Possible missed word | Leave | An acoustic span the project's Whisper hears, alone, as a word. Detection is by listening, not by shape (§ Key parameters reference, "A possible missed word is flagged"). A real word is never cut by a default action. |

The rules that follow from it:

1. **Detection labels and suggests. It never hides a proposal.** A wrong label
   then costs one click instead of a missed cut. On the #1365 clips a detector
   that hid laughs would have hidden three sounds the owner wanted cut.
2. **The editor decides, one at a time or all at once.** Each suggestion can
   be reviewed alone. One bulk action, **Apply suggested actions**, applies
   every pending suggestion's own action in one undoable step: cuts and
   shortens are cut, lowers are lowered, and leaves are marked kept.
   Because every applied action is reversible, a bulk apply is as low risk as
   a label, so it includes suggestions the speech guard holds for review: the
   editor asked for them by pressing the button. Such a cut ripples every
   dialogue track, never one, and the result names how many cut over another
   speaker so the editor can check them first. Every applied action stays
   editable afterward: the editor can change one sound's action (for example
   Cut to Leave) without undoing the rest.
3. **The pipeline applies them by default.** A pipeline run proposes the
   non-speech suggestions and applies them as Apply suggested actions would,
   held cuts included, in one undo step, and its summary names what it applied
   and how many cuts went over another speaker. The `apply_sound_actions` step
   does this on `tighten.apply_non_speech` (default `true`), independent of
   `tighten.enabled`; set it `false` to leave the suggestions pending. It acts
   on the non-speech kinds only. Filler, pause, repetition and restart
   proposals keep their own gate: they apply only through the tighten steps,
   behind `tighten.enabled`, and a cut the speech guard holds there still waits
   for review. The step uses the proposals already on the project only when
   `analyze_fillers_pauses` completed earlier in the same run. Otherwise
   (`--from apply_sound_actions`, `--only`, or a skipped analysis) it scans for
   sounds itself, because the proposals left by an earlier run are stale. A
   proposal never merges a laugh or unclear sound with a pause or filler cut
   beside it: review-only proposals stay apart in coalescing
   (`_keeps_independent_review`).
   Apply suggested actions records every sound it lowers or leaves in
   `editorial.sound_actions` (track, source, span, action). Only the
   `apply_sound_actions` step drops decided sounds; `analyze_fillers_pauses`,
   `propose_edits` and Studio still list them as pending. The step drops a
   pending sound when one record and the proposal each cover at least 75% of
   the longer of the two, on the same track and recording (equivalent source
   ids, as Lower matches a clip), so a re-run does not lower a sound again or
   leave one again, and a lower the editor removed by hand stays removed. A
   proposal that reaches well past a record keeps its fresh part. The record
   survives that removal and goes only with History Undo of the batch. A laugh
   whose peer-speech check cannot read audio is held pending and reported, never
   recorded as a leave.
4. **A laugh over someone else is a level problem.** Each speaker has a track,
   so lowering the laugh keeps both the laugh and the other speaker's words.
   Lower reuses the per-track attenuation bleed handling already uses. A lowered
   span still plays, so no later check treats it as silence: the same-source
   overlap check counts it as audible, and only a mute (no `gain_db`) is skipped
   as `already_muted` or counted as muted.
5. **One table, not a detector per sound.** Adding a kind adds a row to the
   table and to its one table-driven test. Owner verdicts on clips are evidence
   for the defaults, never targets to tune a threshold against.

Shipped today: the labels "Likely laugh" (#1365) and "Possible missed word" (#1062), not the table. Hard fillers, backchannels and acoustic gap
runs behave as described elsewhere in this doc. #1434 builds the table and its
checks; until it lands, this block records the target.

## Mute vs cut

`tighten.edit_mode` (default **`ripple`**) still proposes `EditDecisionType.REMOVE` and applies via session ripple; a cut a peer is speaking over waits for review (**Decision: A guard-blocked filler waits for review**). Set **`edit_mode: mute`** (config, or `propose_edits(..., edit_mode="mute")` / `--edit-mode mute`) to propose **`MUTE`** decisions instead: the same filler candidate pipeline and `filler:` reasons, same `review_required` gating, but apply/approve writes **`Clip.mute_regions`** (`{start_s, end_s, fade_out_ms, fade_in_ms, fill?}` source-media seconds) and does **not** move clips or change `timeline.duration_sec`. Render fades the clip out over each region's first `fade_out_ms` and back in over its last `fade_in_ms` (5 ms each unless set) and lays the region's fill under it, so the hole does not click.

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

**A mute is two faded edges on one track, not a splice** (#1024) — Nothing butts together and no other track changes: approving a mute renders the padded cut's edges (`decisions._apply_mute_edit`). The clip fades out over `filler_pre_pad_fade_out_ms` ending at the cut start and back in over `recommend_post_pad_fade_in_ms` from the cut end, cut down to end before the decision's `next_burst_sec`, so the fades fall on the kept audio either side exactly where a padded cut puts them and the cut itself is silent end to end. The region stored is the cut widened by those fades (revert subtracts all of it). On the lab tape three of the six word fillers resume into sound 10-28 dB under speech (`uh` 646.84, `uh` 706.00, `you know` 1440.88), where the recommendation is 92-120 ms; a fixed 5 ms ramp there starts the next word abruptly. The checks that score a join (the cut-risk level-jump terms and the join continuity gate) therefore skip a mute, as they skip a padded cut, and the padded-cut checks run: the right edge stops 10 ms before the next word's acoustic onset (dropped as `next_onset` when that would leave the filler), a burst within reach travels on the decision as `next_burst_sec`, and a mute may not cover a whole kept word (`kept_word:{word}`). Four more checks follow from what a mute is (`CUT_EDGE_CHECKS` in `edits/cut_policy.py`):

- **Breaths stay whole.** Best practice keeps breaths, so a mute edge never chops one and a mute never removes one. `protect_cut_breaths(strict=False)` moves an edge that sits inside a complete breath out of it, and drops a span that a breath covers at least half of as `breath`: either the breath run inside the span, or a complete breath traced back to room tone (any span covering half the cut contains its midpoint, so the edge evidence there decides). Unlike a splice (`strict=True`), an edge may sit in other connected activity, such as a filler running into a word; the splice rule dropped all six word fillers.
- **An acoustic run that runs into a kept word is that word's sound.** An acoustic gap run has no word label, so when its voiced audio runs on into a kept word at either edge (the voiced-edge check cannot nudge a bounded candidate clear), a mute drops it as `voiced_edge`. A splice's strict breath protection already refuses such an edge. Before either, every join holds an acoustic run clear of the flanking words' voices read by level, not pitch (**Kept words keep their voice**), so a breathy word tail with no clear pitch is caught as `kept_voice` too (lab `So` at 230.78). A word filler keeps its `:voiced_edge` review flag instead: ASR says the voiced audio is the filler.
- **A valley between an untranscribed sound and the next word** (#1358) — An untranscribed `uh` can decay into the next kept word through a valley that stays far over the voice floor, so the kept word's voice walk (`voice_onset`) used to run back through the valley into the `uh` and the whole acoustic run sat inside the word's voice (`kept_voice`). Lab measurement (Audra's decoded track, 20 ms frames, rev 3b414c4c): her `uh` rises at 646.89, holds -9 to -10 dBFS to 647.15, falls to a valley of -29.5 dBFS at 647.29 and rises into `Yeah,` (word time 647.30) at -11 to -14 dBFS. Her speech level is -16.4 dBFS and her voice floor -43.4 dBFS, so the valley is 13 dB under the speech level, 14 dB over the floor and 19 dB deep (`valley_depth_db`, the shallower climb out of it); no walk against the floor stops there. For an acoustic run the walk may also stop at a valley `HEARD_APART_DEPTH_DB` (10 dB, the depth `voice_separates` reads) deep on both sides at any level (`voice_onset(..., heard_apart=True)`), **only when the sound from the cut start to that valley is one hum** (`is_one_hum` in `edits/word_onset.py`: a single burst of level, counted with `burst_count` from `edits/acoustic_laugh.py`, the measure behind `likely_laugh`, bursts 6 dB apart). The reason for the second condition is that a dip this deep is not a boundary between a filler and a word by itself. A word dips that deep inside itself (the break between two syllables, a stop closure, the `h` of `uh-huh`), and a first syllable the transcript missed, or a short phrase, followed by such a dip reads as a filler decaying into a word. A hesitation holds one level and falls once; syllables, phrases and `uh-huh` switch the voice on and off, so their level has several bursts and they keep the word's voice (`kept_voice`), as before. One burst is not enough on its own: a quiet plateau followed by a louder syllable is one burst too, because the level only rises. A decaying hum never steps up, so the frames before its peak region (within the burst dip, 6 dB, of its loudest frame) must be no more than the frames it holds there; a hum has a short onset and a long hold. On the LibriSpeech fixture the word `antonia` is 0.5 s at -37 dBFS and then `an` at -17 dBFS with the an|to syllable break as the valley at 43.69: with the word dropped from the transcript, the first form of the rule proposed a mute at 42.945-43.68 and this form refuses it (dropping each of the 66 fixture words in turn: 1 admitted before, 0 after). On the lab tape `I mean, with-` (3 bursts, caleb 163.57) and the `uh` before `huh` (2 bursts, caleb 1532.74) are not admitted by the rule, and Audra's `uh` (1 burst) is proposed. The cut's right edge then sits in the valley 10 ms before the frame after its bottom, not 60 ms before the word, where a quiet frame would leave air, and the plan is marked `end_in_valley` only when that edge lies in the valley's lower half (`edge_in_valley`). The mute's fade-in is capped at the frame after the valley bottom (`next_burst`, as for a plosive; 10 ms of fade-in for an edge at the bottom), so it does not ramp over the word's first syllable. The voiced-edge check reads the same valley as a break for a cut so marked (`audible_runs(..., split_at_valleys=True)` ends a run in the valley's lower half, `valley_basins` in `util/dsp.py`), because the run over the floor would otherwise straddle the edge. Approval reads it by the same rule: `complete_effect_acoustics` asks `edge_decays_into_valley` (`edits/word_onset.py`, the predicate the plan uses) about each acoustic contributor's own span and passes the result to `assess_voiced_edges`, so a proposal the rule admitted is not held at programmatic `approve_edits` as `voiced_edge`. The split applies to both edges of the check, since the mute's fade-in region starts in that valley; a cut's own start lies after the previous word's voice, so it cannot sit in kept voice that the split would free. Nothing here is an absolute level or a per-speaker constant: the depth and the burst dip are dB differences inside the audio, and the valley's lower half is measured from its own depth, so the rule reads the same at every recording level (synthetic tests at -18 to +12 dB) and for every voice. A dip of 4 or 8 dB is inside one sound and stays the word's voice. **What it cannot separate.** A single sustained sound that is the first part of a word has one burst, so it passes: the probe writes `And.` for caleb 1406.70-1407.11 (one burst, 0 dB re speech, a 0.41 s hum with a valley about 10 dB under it before the next kept word), and the span's duration, level over the speech level and spectral steadiness all lie among those of the acoustic fillers main already proposes, so no audio-only measure tried here tells it from an `uh`. Such a run is still a review-only hit: the word probe labels it `possible_word` (suggested action `leave`, "Possible missed word") when Whisper writes a word for it, and Audra's own span carries that label too (Whisper writes `Hey.` or `Uh, yeah.` for it, depending on the span's exact ends, so the label may read the decay tail). **Ripple.** Nothing about the valley itself keeps this path out of ripple mode; two splice guards do, and only they. The breath check refuses an edge that sits in sound where a breath detector backend confirms it, and the join continuity gate (`tighten.join_continuity_gate`, on by default) refuses the splice. `test_a_filler_decaying_into_a_word_is_refused_as_a_ripple_only_by_the_splice_checks` pins what is guaranteed: with the breath check off (`tighten.breath_handling.enabled: false`) the join continuity gate alone refuses the splice (`acoustic:join_continuity` 1), and with the gate off too the span is proposed in ripple. A ripple proposal on this path is review-only either way (`review_required`), the same as the mute. The test does not pin what the breath check does when a detector backend is installed. **Not covered: the mirror case.** A kept word that decays through a valley into an untranscribed filler after it is still read by `voice_end` against the floor alone, so the filler's start is held back as part of the word's voice. With Whisper word times the transcript holds `Yeah,` from 646.50 to 647.16 on Audra's track, the `uh` sits inside a transcribed word, and there is no untranscribed run to propose. **What the rule admits that main refuses.** An audio-only rule cannot tell a decaying `uh` from a dropped real word of the same shape: one burst, a short onset, a hold, then a valley. Measured by dropping words from the transcript and proposing in mute mode: 0 of 66 on the `aligned_dialogue` fixture (each word dropped in turn), 0 on `ami_bleed_60s`, and on LibriSpeech `word_boundary` 5338-24640-0003 the head admits `bean` (5.066-5.435) and the `particularly` tail (1.869-2.34), which main refuses as `kept_voice`. Each is a mute, review-only proposal. Main already admits comparable spans on the same clip (`donald`, and the `particularly` span as `likely_laugh`), so this widens an existing review-only class and does not open a new one. The reviewer sees `leave` and, when Whisper writes a word, `possible_word`. Lab (rev 3b414c4c, aligned base rebuilt as in the PR, medium, `propose_tighten_edits`, compared with `origin/main` source on the same base): aligned mute proposals 164 to 165 (the one new proposal is Audra's `uh`, 646.847-647.28, review-only; nothing earlier is lost) with `acoustic:voiced_edge` 28 to 27; aligned ripple 127 to 127; Whisper mute 57 to 57; Whisper ripple 30 to 30; `acoustic:kept_voice` 288, 269, 153, 151 unchanged in all four. The 10 dB depth has not been set by the owner's ear, so no decision block is added.
- **A mute must silence something audible.** It keeps the time, so muting audio below the track's voice floor (**Voice floor** above; span RMS) changes nothing a listener hears; it is dropped as `inaudible`. A ripple still removes time there.
- **Peers do not matter.** A mute's scope is `track`. Peer speech never scopes it, never flags it (`other_speaking`, `interior_speech`) and never nudges its edges; the bleed-owner check and the acoustic scan's peer-voice test, which decide whose voice the audio is, still run. The owner check of a word filler is the word's `audibility_status`, set by reconcile with the peer's track read at the pair's measured copy lag ([Words are judged at the copy lag](transcript-reconcile.md#words-are-judged-at-the-copy-lag-1052)), never from two levels at one instant: a remote guest's filler that reaches the host's mic before the guest's own track carries it is `bleed` and is not proposed (#1072; `tests/test_tighten_lagged_bleed.py`). A pair with no measurable lag keeps the same-instant reading. The acoustic scan's peer-voice test reads the pair at the same measured lag ([Acoustic gap candidates](#acoustic-gap-candidates), #1073).

Lab (`aligned-ready`, refine waived; ripple proposal byte-identical throughout). Before #1024 mute mode proposed 11 hits and no word filler. Dropping the splice checks alone proposed 222: the six Caleb fillers (`uh` 604.62, `um` 616.30, `uh` 646.84, `uh` 706.00, `um` 712.99, `you know` 1440.88), 13 repetitions/restarts and 203 acoustic runs. Heard alone and measured, those 203 were 112 runs into a kept word, 26 breaths or breath-like unvoiced noise, 22 quiet sounds 15 dB or more under the speaker, 6 bleed, 9 missed words or laughs and 28 vocal hesitations. With these checks mute mode proposes 53: the six fillers, the 13 repetitions/restarts, and 34 acoustic runs (21 vocal hesitations within 9 dB of speech, 5 missed words or a laugh, 7 quiet sounds, 1 unvoiced). Skips: `acoustic:voiced_edge` 134, `acoustic:inaudible` 26, `acoustic:breath` 29 (12 at the scan, 17 at the edges). Acoustic hits stay review-only.

**No gap to keep** (#1064) — Pacing's gap rule is for a ripple. It shrinks a cut, or drops it as `pacing`, so that the flanking words keep `min_gap_after_filler_sec` once the gap closes. A mute closes nothing, so pacing never shrinks or drops one (`apply_filler_pacing(keeps_time=True)`), and an acoustic run is muted whole. The room-tone expansion still sets a word filler's span, so a mute silences what a padded ripple would remove. Lab (rev 3b414c4c, `aligned-ready`, mute): proposals went from 54 to 57 and `acoustic:pacing` from 7 to 0. All 7 runs sat in 0.36 s gaps. That is the narrowest gap the 0.35 s scan floor admits on 20 ms word times, and too short to keep 0.35 s and still cut 20 ms. Each run starts 25 ms after the previous word ends. Unshrunk, 6 fail `voiced_edge` and 1 fails `breath`, so none is proposed. Shrinking had hidden the same verdicts behind `too_short` (23 to 1) and `reparandum` (5 to 0). 3 runs are newly proposed (230.81, since dropped by **Kept words keep their voice**, 1644.50, 1646.56), 2 are muted whole instead of shrunk (60.80, 874.78), and the word fillers and every ripple proposal are unchanged. With Whisper word times (`edit-ready`) mute proposals went from 39 to 38: the one `pacing` skip fails `voiced_edge`, 3 runs are muted whole, and the run at 267.24 is dropped as `inaudible`, because its full span averages under the track's voice floor where the shrunk one did not.

**Fill, not hole** — Dialogue editors fill a gap with matching room tone, because dead air on a track with a noise floor reads as a dropout. Approving a mute lays under it the fill a ripple pad gets from `tighten.filler_pad_mode`. `silence` leaves digital silence. With `room_tone` (the default), approval picks a sample once with the ripple pad's sampler (**Where room tone comes from** below), nearest the middle of the mute. It stores the sample on the region as `fill` (`{source_id, start_s, end_s}`), and render tiles it under the region with fades that cross the clip's: in over the region's fade-out, out over its fade-in. A track with no bed and no room tone keeps a silent mute, as a ripple pad does (**Where room tone comes from**). GUI exact-range mutes stay silent.

**Where room tone comes from** (#1054, `engines/room_tone.py`). With `room_tone`, a ripple pad, an approved mute and `fill_with_room_tone` all ask one sampler for a stretch of the track's room near the cut. A recorded `track.room_tone` bed wins when its `sources[]` entry exists and it is not digital silence. Otherwise the sample comes from the track's own audio, read once per file version as 10 ms frame levels at 16 kHz. Word times are not consulted, because a transcript gap can hold speech the transcript missed (#979).

**Fill a range** (#1136). The `FillRoomTone` document command (`fill_with_room_tone_tool` with `track_id`, `start_sec`, `end_sec`) runs the same fill over only the clip-free time inside `[start_sec, end_sec)` of one track; clips are never touched. The range form runs for editors and the host; a fill without a range (`track_id` or `speaker`, no `start_sec`/`end_sec`) is the same command and is host-only. It fails with `no_source` when no room tone can be sampled and `nothing_to_fill` when the range holds no gap wider than the join tolerance.

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

The first window that passes every check is the fill; the caller tiles it when it is shorter than the gap: equal tiles, each starting at its own offset inside the span (derived from the span's position, so a preview and the render agree) and blended to the next over a 40 ms crossfade that borrows only audio inside the span, so a repeat has no fixed period and no hard seam (#2699). The pad's outer edges fade 10 ms in and out. A span under 0.7 s is too short to inset and is butt-spliced from its start, as before. A window that cannot be measured (an unreadable file, or a Silero error) fails like any other check. A track with no passing window keeps a silent pad or mute. On a track gated to digital silence (a Zoom track) that matches the room, because its gaps already are silence. On a live room (no quiet run, runs too short, every window rejected, or its quiet runs claimed by other pending cuts) the operator chose the cut over the fill (2026-10-13, #1393): the cut applies with a silent pad on that track, the other tracks keep their room tone, and nothing is held. The silent hole is the cost of landing the cut; the edit log's `pad_samples` omits that track. Spectral flatness is not a check: on the lab tape the room floor's flatness (median 0.019, 10th percentile 0.005) overlaps voice and bleed (median 0.005), so no threshold separates them.

**Room tone is picked once per recording.** The first-passing-window pick above measures audio (a decode and a voice-detector run per candidate window), so on a long real tape it cost tens of seconds per cut. `record_room_tone_pool` (`engines/room_tone.py`) runs that same pick at evenly spaced points along the track (about one a minute, from 12 to 64), keeps the samples that passed (up to 2 s each), and records them under `artifacts/room_tone_pools/`, keyed on the recording's path and file revision (picks read the first audio stream, and for media with several audio streams the key carries a first-stream term, #2110) plus every other dialogue track's path, revision and ingest offset from this track, so a replaced recording, a new peer or a realign is picked again. Music and SFX tracks are not peers. A pooled sample is at least 1 s (`POOL_MIN_SAMPLE_SEC`), so no scrap is recorded for a pad to tile. It runs at ingest: in the background, at low priority, when a dialogue track is added or given new media; inline in the pipeline's ingest step. Approval never creates or prunes pool files. The background warm of a project with an edit awaiting review records any that is still missing (the same place the level profiles are recorded). Planning and preview paths only read the record, and a pool is not recorded while the voice detector is unavailable, so a later run picks it with the `voiced` check. A request on a track with a pool takes the nearest pooled sample that is clear of `avoid`, reads no audio, and tiles it as before; a track with no pool, or one whose pooled samples are all claimed by pending cuts, picks as described above.

A sample must not be another speaker's voice reaching this microphone, which sits near the floor and passes every level check. The check correlates the sample's 10 ms level envelope with each peer's envelope over the same moment. The peer's window is read at the ingest-shifted second (this track's shift minus the peer's, from `meta.ingest_alignment`). A peer gated to silence is evidence at any live frame. A peer that does not cover the window is no evidence. A pad ranks pooled samples away from any played within 120 s of the cut (`TAKEN_WINDOW_SEC`, by a pad clip or a mute fill), then by distance. A mute fill is source-pure: it takes the sample by source position alone, so preview and approve pick alike. A cut on a recording other than the pool's has no position in it, so such cuts rotate over the pool by their 120 s slot of the timeline. A gated track or a track with no passing window is recorded as having none, so it is not picked again.

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
- #1054, #1114 the sampler picks only a steady stretch at the track's floor
- 2026-10-13 #1212, #1369 held a ripple pad over a live room with no sample as `pad_unavailable`
- 2026-10-13 #1393 operator reversed that (amended in place): a cut lands with a silent pad on any track with no room-tone sample, because the operator prefers the cut to land over being held
enforced-by:
- tests/test_filler_pacing.py::test_filler_pad_mode_defaults_to_room_tone
- tests/test_filler_pacing.py::test_shipped_defaults_fill_pads_with_room_tone
- tests/test_room_tone.py::test_a_live_track_with_no_room_tone_gets_a_silent_pad
- tests/test_room_tone.py::test_a_gated_track_keeps_its_silent_pad_while_the_live_track_gets_room_tone
- tests/test_room_tone.py::test_room_tone_is_not_taken_from_source_a_pending_cut_still_plays
- tests/test_pause_reproposal_invariants.py::test_reproposing_over_a_padded_cut_never_double_cuts_or_splits_the_tracks
- tests/test_room_tone.py::test_a_lane_problem_reads_as_a_sentence
- docs-sync: decision-filler-cuts
-->

A ripple pad and an approved mute fill with the track's room, because dead air
on a track with a noise floor reads as a dropout (**Fill, not hole**). The
sampler (**Where room tone comes from**) takes only true room floor. A track
with no such stretch keeps a silent pad, and so does an approved mute. On a
track gated to digital silence, such as a Zoom-gated track, that matches the
room. On a live room it leaves a hole of digital silence that can read as a
dropout; the operator accepted that on 2026-10-13 (#1393) so the cut lands
instead of being held, reversing the #1369 hold. Set
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

Dialogue cuts default to **fade joins** (`join_in_mode=fade`): independent clip placement with per-segment `afade` declick. Fade length is capped at `render.join_fade_max_ms` (default 40 ms) so multitrack stems stay the same length.

**Crossfade** (`join_in_mode=crossfade`) is opt-in only (set it with `set_clip_join_tool`, which also sets the fades the overlap needs; `set_join_mode_tool` changes the mode alone) — FFmpeg `acrossfade` blend centred on the seam, which does not shorten the track (rev 17: each clip borrows half the overlap from its recording past the seam, see below). Use `crossfade_joins_tool` for music beds or when the user explicitly wants overlapping blend. Configure curve via `render.crossfade_curve` (default `tri`).

**Which neighbours count as a join:** one rule for every join mode — `clips_abut` in `engines/clips_ops.py`, a timeline gap of at most `JOIN_GAP_TOLERANCE_SEC` (50 ms). On a linear lane, a gap within the tolerance closes up when rendered (fade and cut actors abut; crossfade joins crossfade), so the stem is shorter than the timeline by that gap. A crossfade join no longer shortens it (rev 17). In a windowed render, a window edge at or inside a seam does not change whether the join blends: the edge fades stay off there, and a blend shrinks to what each window piece has (never more than either piece's length), so a window can differ from the same slice of the full render within a blend's width of its edge. The render hash includes what each join borrows, since it depends on the recordings' lengths. A wider gap stays as silence and gets no crossfade. An overlapping actor keeps its extent; a join changes the lane clock only when its component changes the lane frontier. Crossfade joins with a 1–50 ms gap used to render as fade joins; when render rules like this change, `RENDER_SEMANTICS_REV` in `engines/timeline_render.py` is bumped so cached stems and play segments re-render. Rev 3 made a cut per join: only the next clip's cut drops a clip's fade-out, and a clip's own cut drops its fade-in only when it has a left neighbour (a track's first clip has no join). Rev 7 keeps nested multi-recording overlaps at their authored timeline positions by comparing each placement with the accumulated rendered end; segment renders use the same rule and retain join fades from lane neighbors just outside the requested window. Rev 8 uses the same source-aware placement assembly for every segment window, including windows whose selected clips all use one recording. It preserves summed overlaps and requested leading/trailing timeline holes while subtracting cut and join contraction from the output duration. Rev 9 resets the sample clock after a summed overlap before later pad/concat joins, preserving sample-accurate output length. Rev 12 reads every input through `MediaSeek`, so a `.m4a` window no longer starts up to one AAC frame late (#1141). Rev 13 extends accumulated placement to all full-track renders, including nested clips from one recording. It prevents a ripple-reordered follower from shifting later audio beyond its saved placement and invalidates cached audio produced under the previous rules. Rev 14 replaces the flat relative accumulator with connected native crossfade components and independent placed actors. The saved predecessor owns the join, even under an enclosing follower. Sequential native chains and the first retained right-piece cap remain. Authored windows keep local source selection and fade preparation rather than becoming full-stem slices. Rev 17 stops a blending crossfade from pulling its lane earlier (#1888): `clips_ops.crossfade_borrow_sec` gives each side half the overlap, taken from the recording just past the left clip's end and just before the right clip's start (at a real cut that is briefly the removed audio, under the fade), so the blend spans the authored seam and every lane keeps one clock. The borrow shrinks to the room the recordings have, to a quarter of either clip, and to nothing for an unmeasured or missing recording, and it comes in whole 5 ms steps, at least one (so a 25 ms crossfade overlaps 20 ms and a 4 ms one 10 ms, and a chain of joins stays on whole samples at the common rates); the borrow also stops at the nearest mute region, off-speaker region or ignored transcript word of another clip (or the transcript) on the same recording, so a blend never plays what a neighbour muted; room shorter than the requested overlap, at most 20 ms, plays the fades instead (`no_headroom`). A join with no borrow renders as a plain fade join with the stored fades. In a window render a join blends only when both clips play whole at the seam. Rev 18 makes that borrow stop at a mute region of the clip's own that ends at its edge (also within a millisecond of it, whatever the float rounding), at one of its own lying wholly past the edge, and at an ignored transcript word of the same recording under another source id. Rev 19 places delayed slices on `ms * rate // 1000` samples at the rate the render graph runs at there (#2025). Rev 20 decodes each input's first audio stream, the one the render graph takes, in the dry run, the Restore clock and the source-proxy baseline, instead of FFmpeg's default pick (#2104). Rev 21 caps the borrow across a cut (#2094): when the right clip starts past the left clip's end in one recording (a source gap of at least `SPLICE_SOURCE_EPS_SEC`, 0.1 ms), `crossfade_borrow_sec` also stops at half that gap (`_gap_room`, the gap rounded to 6 places), so the two borrowed spans never overlap inside the removed audio and none of it plays twice. A gap too small to leave a 20 ms blend plays the stored fades (`no_headroom`). Contiguous clips (a split), a right clip that starts before the left ends, and clips of different recordings borrow as before; the browser draft (`joinDraftOverlapMs`) mirrors the cap with the clips' `recording_key`. Rev 22 places a track's clips on one absolute sample grid (#2456): a clip edge is `round(timeline * rate)` and each placed piece is cut by `MediaSeek.sample_time`, the exact inverse of `first_sample`, so a joined run's pieces sum to the clip edges and a window render holds the same samples as the same slice of the stem. Blend borrows are whole samples. Delays place on `round(seconds * rate)` samples at the rate the graph runs at, replacing Rev 19's whole-millisecond rule, so a run that starts after a gap or at a late first clip lands on the same sample in a window and in the stem; the source proxy's input identity moves to `source-proxy-inputs-v3` with it. A track whose recordings do not share one sample rate, or run above 192 kHz, keeps float placement with sample-rounded delays; a window decides this from every clip of the track, so it takes the same rule as the stem, but on such a track a window and the stem can still differ by a sample. A chain with `arnndn`, which runs at 48 kHz only, resamples every recording to 48 kHz before `atrim`, so the grid takes that rate (`graph_rate`) whatever the recordings' own rates and a window equals the stem there too: a 44.1 kHz recording was cut on a 44.1 kHz grid while `atrim` rounded every piece again at 48 kHz, so a window drifted a sample or two from the stem, and a delayed component's resampler restarted at the window's own start (#2456). The render graph names that 48 kHz resample on each input, so a delay's rate pin cannot move `atrim` back to the recording's rate. `loudnorm` (192 kHz) keeps the recordings' grid: a sample there is 5 microseconds.

Hard joins (`join_in_mode=cut`, zero fades) use independent clip placement without a crossfade. See [inaudible-cuts.md](inaudible-cuts.md).

## CLI / MCP

Omit track and speaker for a session handoff to require quiet across all dialogue lanes, including muted lanes. Explicit selectors analyze one lane. Results list the analyzed `track_ids`. Missing or incomplete evidence cannot qualify a hop as quiet; each proposed boundary must lie in a shared measured quiet island. See [Narrative handoffs](inaudible-cuts.md#narrative-handoffs) for evidence and locking bounds.

- `podcast propose-edits` / `propose_edits` — proposals include optimized boundaries and per-cut `crossfade_ms`. The MCP payload is `{operation, edits, skip_counts, summary}` (`operation` is `propose_edits`; not a bare array). `skip_counts` maps `discourse:{token}` → kept uses, including isolated cluster-size rejects, `backchannel:{phrase}` → acknowledgments left in, `kept_word:{word}` → padded cuts and mutes dropped for covering a whole kept word, and `next_onset` → padded cuts and mutes dropped because ending before the next word's onset would leave the filler. Every candidate analysis rejects is counted under one reason: `breath` (splice breath protection: an edge in sound that is not a complete breath; for a mute, a span that is mostly breath or whose edges cannot leave a breath whole), `no_air` (a pause trim without sufficient verifiable original quiet or complete flanking word context), `no_room` (a pause trim on a track whose room tone cannot be measured: audio it cannot read, or under half a second of frames between its words even in the widened window), `shared_pause` (a session pause trim that overlaps a longer one proposed on another track, so the stretch is proposed once), `voiced_edge` (a mute of an acoustic run that runs on into a kept word), `inaudible` (a mute of audio below the track's voice floor), `too_short`, `reparandum` (a repeat cut no longer covers its reparandum), `bounds` (the span left the candidate's bounds), `not_owner` (the span is a peer's bleed), `pacing`, `scope`, `source_geometry` (an ordinary source cut without complete unique continuous placement), `pause_not_shorter` (final actual net loss is not positive), `imperceptible` (net pause loss below the existing perceptibility rule), `unsettled_edges`, `risky`, `join_continuity`, `next_onset`, `kept_word:{word}`, `filler_onset` (the filler's voice runs on from the kept word before it, #1061) and `kept_voice` (a cut that keeps clear of the flanking kept words' voices is too short or misses its target, or, without words of its own, a kept word's voice runs on through it, unless the sound before it is one hum ending in a valley a listener hears as a boundary, #1064, #1358). Unavailable peer assessment counts once as `scope_unavailable`. Other acoustic gap candidate rejection reasons keep the `acoustic:` prefix. CLI prints `proposal.summary()`.
- Re-proposing (CLI, MCP, or ShareCut Studio **Find more**) replaces every pending generated `filler:` / `pause:` / repetition / restart / acoustic hit, including ones the generator flagged for review (`:voiced_edge`, `:risky`, `:other_speaking`, `:join_review`, `:air_edges`) and ones a human nudged. Applied hits and manual, NL and focus edits stay. Re-running on an unchanged project returns the same hits in the same order (#995), with the same ids (#999).
- A generated hit's id is its identity, not a random token: `cut_<kind>_<start ms>_<end ms>_<track digest>`, from the hit's track, its kind (`filler` (lexical or acoustic), `pause`, `repeat`, `restart`) and the source span it targets (the filler, repeated or restarted words, the acoustic run, or a pause's whole word gap). Cut edges, review flags and a pause's trim end are analysis output, so a hit keeps its id when intensity or analysis moves them, and an Ask thread on it stays attached. A fresh hit whose id an existing decision already holds (an applied copy, or a pending one under `replace_existing=False`) is skipped as `same_hit`. Editing the transcript under a hit gives it a new id.
- `podcast apply-edits` / `apply_edits` — applies via batch ripple + per-join fades (`apply_join_fades_from_decisions`). The `apply_edits` tool submits the `ApplyAutoEdits` document command, which an Editor link may also run (one journal row per call, `ExternalMutate` before); the CLI stays direct, so for a call with nothing to apply the tool journals an `ApplyAutoEdits` row and the CLI journals none.

Tune behavior in `.agents/defaults/pipeline.yaml` (or a project-local override). Full guide below.

## Tuning guide

Start from defaults, **propose without apply**, listen, then adjust one knob at a time.

```bash
podcast propose-edits --project episode.sharecut
# Review edit_decisions; audition with play --compare or processed stems
podcast apply-edits --project episode.sharecut   # when happy
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
| Mid-word chop when ASR missed a word on another mic | `speech_energy_guard` | Keep **`enabled`**; default `on_conflict: review` holds the cut for review |
| A proposal carries `:interior_speech` | the transcript, not a knob | A track the ripple removes has voice there Whisper dropped; re-transcribe or add the words, then re-propose |
| A `pause:` proposal carries `:interior_audio` | the track's voice floor (`LevelProfile.voice_floor_db`) | Audible but unvoiced material (a fricative, a laugh) on a rippled track; listen before approving |
| A `pause:` proposal carries `:air_edges` | none | The trim moved off the span pacing proposed (the air rule, or a kept-voice walk before it), onto the air inside the pause, off a word tail, a breath or a peer's onset at an edge; a label only: it raises no review |
| Cuts carry `:voiced_edge` | the track's voice floor (`LevelProfile.voice_floor_db`) | Voice runs through both sides of the edge with no silence inside the candidate's bounds; listen, or leave the cut in |
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
- **Where `tighten.intensity` comes from:** the Review Queue's **Find more**, GUI pipeline runs and MCP `pipeline_run` (`use_working_set=True` by default) read the project's pipeline working set (what Prepare's **How tight** last saved), so an agent-driven `pipeline_run(only_step="analyze_fillers_pauses")` uses the same tier. CLI `podcast propose-edits` and MCP `propose_edits` read only the shipped `.agents/defaults/pipeline.yaml` plus their explicit `--intensity` / `intensity=`, so a tier picked in Prepare does not carry over to them; pass the tier explicitly.
- `light` / `aggressive` override only the keys they name (nested dicts merge), and only where your config still holds the shipped `.agents/defaults/pipeline.yaml` value. A key the working set changed from that file (by hand in the Pipeline tab, or applied by Pipeline Analyze), such as `max_pause_sec` or an extended `filler_words` list, wins over the tier. Editing `.agents/defaults/pipeline.yaml` itself (or the file named by `PODCAST_MCP_PIPELINE_DEFAULTS`) moves the baseline, so the tier still overrides those edits. A key set back to exactly the shipped value cannot be told apart from an untouched one, so the tier applies there. The Pipeline tab shows the base config, not the tier-adjusted values.
- Presets are **propose-only**: they change what is proposed, never auto-apply, and `tighten.enabled` is unchanged. Discourse-marker demotion stays on at every tier.
- Surfaces: `podcast propose-edits --intensity`, MCP `propose_edits(intensity=...)`, Prepare's **How tight** and the Queue's **Find more**, and golden-ear `--intensity`.

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
| `tighten.filler_post_pad_hot_under_speech_db` | `7` | The resume fade reaches its cap when the edge is this far under the track's own speech level |
| `tighten.filler_room_tone_replace` | `true` | Replace hesitation with paced pad (`clamp(min, gap×retain, max)`) |
| `tighten.filler_pad_mode` | `room_tone` | Fill for ripple pads and approved mutes: `room_tone` (recorded bed, else a steady stretch at the track's floor; none on a gated track; **Where room tone comes from**), or hard `silence` |
| `tighten.filler_room_tone_max_expand_sec` | `2.0` | Max expansion toward flanking words; larger gaps keep the local cut + pad |
| `tighten.speech_energy_guard.enabled` | `true` | Block session ripple when peers speak in the cut window |
| `tighten.speech_energy_guard.on_conflict` | `review` | `review` (hold the cut as a pending suggestion) / `skip` (refuse it). There is no one-track punch (#1370) |
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
| `tighten.acoustic_gap_filler.max_frames` | `600` | 10 ms analysis frames per scan window (~6 s); a longer gap is scanned in overlapping windows of this size; values above `600` clamp down (min `20`) |
| `tighten.acoustic_gap_filler.vad_backend` | `heuristic` | Reject breath-shaped candidate runs with the shared RMS heuristic; `silero` is opt-in and falls back when unavailable or not at 16 kHz |

#### Acoustic gap candidates

When `tighten.acoustic_gap_filler.enabled` is on (the default), propose scans
the decoded 16 kHz track cache for a short voiced run inside an owner-word gap
of at least `min_gap_sec`. It never auto-cuts: every hit is `filler:acoustic`
with `review_required: true`, because ASR-free VAD can mistake breaths, noise,
laughter, music, or a missed word for a filler. **Listen before approving.**

Detection (`edits/acoustic_gap.py`, shared DSP in `util/dsp.py`):

- Gaps are skipped when either flanking word is suppressed, bleed, or
  speaker-matched to another track. A **run** is skipped when another dialogue
  track has **voiced audio** where the run sounds (peer bleed, counted as
  `acoustic:peer_speaking`); a peer voiced elsewhere in the gap says nothing about it.
  Peer occupancy is measured from the peer's own decoded track with the same
  voiced runs the cut-edge gate reads (`edits/voiced_runs.py`, at the track's voice
  floor), never from its ASR word spans (#982):
  a mistimed peer word can span seconds of digital silence on a gated track
  (Lana's `-huh.` spans 1438.48–1444.32 s on the lab tape) and used to block 220 of
  355 acoustic skips. A peer word over silent audio does not block a gap; an
  untranscribed peer voice does. A peer whose track did not decode supplies no
  evidence.
- **A string of hits is an untranscribed phrase, not several fillers** (#1359,
  `edits/acoustic_phrase.py`). Three or more runs in one gap that survive the peer
  test, each starting within the speaker's longest ordinary word step of the previous
  run's end, are proposed as none (`acoustic:phrase`): a hummed, sung or playful
  phrase the transcript dropped ("boop boop boop boop"), which muting hit by hit
  would mute. The step is the 95th percentile of onset-to-onset steps between this
  track's live words that are less than `min_gap_sec` apart, so it follows the
  speaker's own cadence. A run that touches either end of the gap is a flanking word's voice
  running past its transcript time, not a free-standing hit, and does not join a
  string. A track with fewer than 30 such steps has no cadence and
  nothing is grouped. A single hit, a pair, and hits further apart than that step
  are each still proposed.
- **A likely laugh is flagged, not dropped** (#1365, `edits/acoustic_laugh.py`). Inside one
  voiced run the frame level rises and falls: a held "uh" is one burst, "ha ha ha" is
  several. A burst ends when the level falls 6 dB under its peak and the next begins
  when it climbs 6 dB over the valley between them. Three or more bursts in a row, each
  peak within 12 dB of the one before, make the run a **likely laugh**. The proposal is
  kept whole and its reason gains `:likely_laugh` (`filler:acoustic:likely_laugh`), the
  Tighten row reads "Likely laugh", and `propose_edits` counts it in its summary
  ("1 acoustic (review, 1 likely laugh)"). It is a review flag like `:risky`, so it is
  never cut by the pipeline; `apply_sound_actions` gives it its suggested action, which is Lower when another speaker talks over it and otherwise Leave (Apply suggested actions), and the
  editor decides. Both numbers are dB differences inside one run, so the rule reads the same
  at any recording level and needs no cadence, pitch or model. It is a hint and not a
  verdict: on the 2026-10-13 operator listening, 5 of 9 flagged clips were real laughs; the
  other four were a false start, a breath between words, a sharp inhale before "um" and a
  breath before a word, which the operator would cut or keep case by case. Level bursts
  cannot separate those, so the thresholds are not tuned to them and the call stays with
  the editor. Lab (mute, aggressive, 2026-10-13): acoustic proposals are the same as
  before the rule, 70 with forced-aligner word times (8 flagged) and 37 with Whisper times
  (5 flagged), and none was eligible for Apply eligible (then); ripple proposals (14 and 4) are
  identical and none is flagged. This is the first slice of the non-speech sound policy tracked in #1434.
- **A possible missed word is flagged, not dropped** (#1062, `edits/acoustic_word.py`). An
  acoustic run is voiced audio the transcript has no word for. Most runs are hesitations, but
  some are real words the ASR dropped ("Then...", "Here"), and cutting one loses speech. After
  analysis, each surviving acoustic proposal's span, padded with 0.3 s of silence each side, is
  heard alone by the project's own `transcribe.model` (no VAD, no earlier text, a disfluency
  prompt so a hesitation is written down as one). A result holding a token that is not a
  hesitation, laugh, backchannel or breath (`um`, `uh`, `mm-hmm`, `ha ha`) is a **possible
  missed word**: the reason gains `:possible_word` (`filler:acoustic:possible_word`, after
  `:likely_laugh` when both apply), the pending edit's inspector subtitle and timeline overlay title read "Possible missed word", and
  `propose_edits` counts it ("1 acoustic (review, 1 possible missed word)"). Like every
  review flag it never hides a proposal, is never cut by the pipeline, and its suggested action, applied by Apply suggested actions and by the pipeline's `apply_sound_actions` step, is Leave (#1434). A shape test (voiced length, spectral motion)
  cannot do this job: on the lab tape a drawn-out "Then" (0.98 s) moves less than several
  "umm", and backchannels move as much as words. `tighten.acoustic_gap_filler.word_probe:
  false` turns the listening off. The pipeline's `apply_sound_actions` self-scan (when
  `analyze_fillers_pauses` did not run) uses that off setting for the scan only (#1608): a
  possible missed word stays an unclear sound or likely laugh, whose default action leaves
  the audio in place (Leave, or Lower on overlap), so a real word is still not cut. A Whisper
  model that is not installed leaves the proposals
  unlabelled and counts `word_probe:unavailable`. A span whose Whisper decode fails counts
  `word_probe:failed` and Propose still returns the rest; the human summary names both
  (`N word probe unavailable`, `N word probe failed`). Listening reports a named
  `word-probe` progress child once per heard span. The decode is deterministic (#2632):
  temperature 0 with no fallback ladder, a penalised retry for a looping decode, and the
  probe's CPU model pinned to 4 threads, so a span reads the same on every call and in
  every process (`transcribe_samples`). Lab (2026-10-13, #1062; oracle: the #1024
  classification, Whisper `base.en` on each span with the disfluency prompt, so the probe model
  and the oracle differ): proposal counts are identical before and after in all four variants
  (mute 58 and 91, ripple 27 and 54, Whisper and forced-aligner word times); of 17 oracle
  words, 15 were flagged; of 107 non-words, 15 were flagged (12 backchannels, whose default is
  Leave anyway). The two missed words were a clipped "And" and a "Um, that, uh, that's what"
  the oracle itself heard from a 0.2 s span. Holdout (podcast_111, a 5-minute excerpt, mute): 6
  acoustic proposals, 2 oracle words (1 flagged, the miss a hesitation with a word fragment), 4
  non-words, 0 false flags. The model is the oracle's cousin, not ground truth, so these are
  agreement counts and the threshold-free design has nothing to tune against the tape.
  Cost: one Whisper decode per surviving acoustic proposal. Measured on a machine at load
  27 to 57 and `nice` 10, `large-v3-turbo` took a median 8 to 10 s per span (71 spans in 11 to 15
  minutes) and `base` 0.7 s per decode.
  Model choice (2026-10-14, lab tape rebuilt on a 4-core cloud machine at load 2 to 3, `nice` 10,
  oracle rebuilt on the same spans). The span sets differ from the run above (74 ripple proposals
  where it had 54), so these counts do not extend it. Over 131 acoustic spans in the four
  variants, `large-v3-turbo` flagged 16 of 24 oracle words and 13 of 107 non-words, and `base`
  flagged 11 of 24 and 6 of 107. Turbo's false flags were 6 "mm-hmm" and 3 "mmm" hums, plus 2
  "umm", 1 "uh" and 1 "hmm", where the table's target for um and uh is Cut; base's were 2 laughs, 2
  "umm", 1 "uhh" and 1 "mm-hmm". The oracle shares the probe's prompt and padding, the four
  variants reuse one recording and 24 words is a small sample, so this is agreement, not
  accuracy. Cost is the propose wall time with the probe minus without, per acoustic span, and
  includes the model load. In the mute variants it was about 8 to 9 s with `large-v3-turbo` and
  1.5 s with `base`. The ripple deltas (10 to 12 s and 0.4 to 4 s) are noise, because the first
  ripple run built the audio caches. Turbo's cost at load 2 to 3 matches the load 27 to 57 figure
  above, so that figure was not inflated by load. The default stays the project's
  `transcribe.model`: the label exists to catch a dropped word, turbo's recall is 67% against
  46%, and a second probe-only model would need its own download, setting and docs. The price is
  that a hard filler flagged by mistake moves from the target Cut to Leave.
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
  Both reads take the pair's copy lag (#1073). A remote guest's own track trails
  their voice on the host's mic, so a run on the host is checked against the guest
  that much later (`CopyPath.lag_sec` of the guest to the host), and a guest run that
  is the cut track's voice on the guest's mic is compared with the cut track that much
  later (the lag of the cut track to the guest). The lag is the one reconcile reads for
  word audibility ([Words are judged at the copy lag](transcript-reconcile.md#words-are-judged-at-the-copy-lag-1052)),
  measured once per run through `edits/peer_copy_lag.py`; a pair with no measured path reads
  at 0 lag. `_peer_voiced_at` is the single decision for peer occupancy.
- A gap longer than one scan window (`max_frames`, ~6 s) is scanned in overlapping windows
  that overlap by more than the longest run, so every run is seen whole in one window and
  a run that touches the seam between two windows is left to the one that holds it whole.
  Each window is judged on its own level (the contrast, noise estimate and plateau checks
  below read the window), so a cost bound holds however long a speaker is silent and a
  filler missing from a minute of word gap is found (#1073).
- Frame levels (25 ms / 10 ms hop) must show real contrast: the loudest frame
  must sit at least 12 dB above the gap's 20th-percentile noise estimate, so
  flat hum, HVAC, or steady rumble never yields a candidate. Active frames must
  clear that noise estimate by 8 dB and sit no more than 40 dB (`BREATH_BELOW_SPEECH_DB`, the deepest a breath sits) under the track's own speech level; dips up to 60 ms are bridged.
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
  `no_audio`, `peer_speaking` (a peer voiced where a run sounds), `phrase` (a hit in a string of three or more), `breath`,
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

Pause edge effects preserve joins outside the approved removal. A left edge
changes only its outgoing fade. The right edge owns the new incoming fade.
Original quiet evidence compares physical files, including hardlinks, while
retaining each selected source's transcript provenance. A replay through another
lane's primary media or unclipped playback holds the source removal.

## Golden-ear protocol

The owner listening bar in § Default pipeline status is **not** a CI gate. Run the harness on a relocated copy (never the committed fixture tree or the Shot of Truth working copy):

```bash
make golden-ear ARGS='build --project /path/to/shot-of-truth --out /tmp/golden-ear --limit 40'
# Listen under listen/pair_NNN/1.wav vs 2.wav. Do not open key.json (owner-only, beside listen/).
# Fill prefer=1|2|tie and leftover_consonant=yes|no in listen/answers.csv.
make golden-ear ARGS='score --dir /tmp/golden-ear --answers listen/answers.csv'
```

To evaluate a preset, add `--intensity`, e.g. `make golden-ear ARGS='build --project … --out /tmp/golden-light --intensity light'`, and score each tier separately.

The pair window's pad is `pad_sec`, validated like the audition's: 0 to 10 seconds, and 0 is allowed (a pair that is just the edit). Out of range is refused with `pending_preview_pad_out_of_range` before anything is built (earlier builds silently clamped it).

Rebuilds of a non-empty `--out` (or a filled `answers.csv`) require `--force`. For untrusted argument strings, call `uv run python scripts/golden_ear_harness.py …` instead of `make golden-ear ARGS=…`.

`build` copies the project via `copy_relocated_workspace` (rewrite `workspace_dir`; copies `artifacts/premix.wav` when present so the first preview reads its recorded headroom trim instead of measuring the mix peak). It then runs **`EditService.propose_tighten()`** without apply. That call uses the same **transcript refine gate** as other edit mutations (`_require_refine_clear`): Shot of Truth builds fail until refine status is clear or `analysis.transcript_refine.mode=off`. For each pending `filler:`, `pause:`, `repetition:`, or `restart:` REMOVE with a Suggested side (no `suggest_reason`), it writes two short WAVs (±2 s context) via `PlayService.play_pending_preview` (`current` = leave-in, `suggested` = the edit approved on a snapshot, so its ripple, `replace_gap_sec` paced pad and fades are in Suggested). Whichever clip is shorter (Suggested after a plain cut, Current when the paced pad is longer than the cut) gets trailing silence appended until both have the same frame count, so length cannot unblind the pair; the audio itself is never trimmed or stretched. Which of `1.wav` / `2.wav` is the edit is randomized; mapping is only in owner `key.json` next to `listen/` (not inside the listen pack). Listener `manifest.json` is blinded (ids only — no class/verdict/risk). `listen/answers.csv` is the scoring template (`pair_id,prefer,leftover_consonant,notes`). Each key pair stores `join_quality` (`verdict` / `risk`) and an owner-only `audition_context.v2` summary for its timeline play window; failed diagnostics are recorded explicitly as `audition_context_error` and never exposed in the listener manifest. `verdict=pass` is a **gated** cut. Selection shuffles candidates with `--seed` and backfills edits without a Suggested side so pair ids stay contiguous (`pair_000`…). Cached `play_cache` windows are reused when `play_pending_preview(..., rerender=False)` (the default).

The context is labeled `project_timeline_metadata_only`: it supplies captions, timing, and render status, but its suggested premix listen references do not describe the edited WAV. `pair_diagnostics` in owner `key.json` analyzes the **rendered** Current and Suggested WAVs directly, recording astats, hum, and waveform PNG paths under owner `diagnostics/pair_NNN/`. Each side has an explicit `file` mapping; per-side failures appear as `error`. The diagnostic images and key stay outside `listen/`. Pair analysis is bounded to exactly those two WAVs, rather than repeating DSP across every dialogue track.

`score` maps `prefer=1|2` through `key.pairs[].edit_file` / `leave_file` (`tie` counts as non-edit). Blank/unknown prefer or leftover cells fail closed. Duplicate `pair_id` rows keep the first. Pass requires **≥90% prefer-edit on gated cuts**, **`gated_n` ≥ `min_gated_n`** (`2` when `--limit` ≥ 2, else `1`), and **zero leftover-consonant fails** (`yes|no` required). The report includes `missing_n`, `pair_count`, `gated_n`, and `n_answers`, plus acceptance rollups by full reason and speaker track with sample, answered/missing, edit-preference, tie, and leftover-failure counts; a rollup counts a pair as answered only when both preference and leftover-consonant responses are valid. In each rollup, `prefer_edit` uses all rows (including incomplete answers counted conservatively as leave-in), while `prefer_edit_answered` uses only rows with both valid cells. Empty gated answers fail closed.

Log the `score` JSON (and which episode / git SHA / tighten config) next to the Shot of Truth session notes. Do not flip `tighten.enabled` until this bar is green on that episode. Cap `--limit` (default 40, max 500).

The `aligned_dialogue` fixture is the automated smoke (`tests/test_golden_ear_harness.py`); it is not a substitute for the owner listen on Shot of Truth.
