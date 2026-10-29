---
name: podcast-tighten-dialogue
description: >-
  Tighten dialogue by proposing filler, pause, repetition, and restart edit decisions for
  review. Use when making episodes more information-dense while keeping natural
  speech flow — not theme/spine cuts (podcast-focus-episode) or cut-by-what-was-said
  / transition handoffs (podcast-edit-natural-language). Default workflow is
  propose_edits → listen-first review → approve per hit; never bulk-apply on a
  production episode without sign-off. Pipeline auto-tighten stays off until the
  golden-ear bar in docs/filler-cut-quality.md.
---

# Tighten dialogue

## Default pipeline status

**Pipeline auto-tighten is disabled** (`tighten.enabled: false` in
`.agents/defaults/pipeline.yaml`) until prev→next join quality passes the
golden-ear bar in [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md)
§ Default pipeline status / § Golden-ear protocol. Discourse `like` is now
demoted (adjacent-token phrase matching for `you know` / `sort of` / `kind of`;
pause/confidence remain escape hatches) but splice flow is still the re-enable
gate. Default workflow is **propose → review (listen-first) → approve per hit**.
Never bulk-apply on a production episode without explicit user sign-off. Do not
flip `tighten.enabled`. The pipeline's `apply_sound_actions` step is separate: on
`tighten.apply_non_speech` (on by default) it applies each non-speech sound's
suggested action in one undo step and leaves filler, pause, repetition and
restart proposals alone; set the key `false` to leave those sounds pending. When
tighten analysis did not run, that step finds the sounds itself without the
Whisper word probe (#1608).

## Policy (from `.agents/defaults/pipeline.yaml`)

- Filler words: um, uh, erm, ah, like, you know, sort of, kind of, etc. ASR
  words match with case and edge punctuation ignored, so Whisper's `Um.` and
  `uh,` are `um` and `uh`.
- **Backchannels are kept** — `tighten.backchannels` (`uh huh`, `mm-hmm`, `mhm`,
  …) are acknowledgments, not hesitations. They match before fillers, so
  Whisper's split `Uh` + `-huh.` is never proposed as `filler:uh`, even when
  the audibility pass suppressed the `-huh.`; each is
  counted as `backchannel:{phrase}` in `skip_counts`. Their Whisper word times
  can still sit on silence of a gated track, so listen before trusting them.
- **Discourse-safe selection** — `like` / `you know` / `sort of` / `kind of` stay
  in the lexicon but are candidates only with an **adjacent** true disfluency or
  immediate repeat, a pause ≥ `tighten.discourse_pause_sec` (~0.35s) on either
  side of the marker span, or ASR confidence < `tighten.discourse_confidence_max`
  (~0.6). Multi-word markers match split ASR tokens (`you`+`know`). Pause and
  low-confidence are escape hatches (a fluent quotative/comparative `like` with
  a flanking pause or low ASR still becomes `filler:like`), except that `like`
  directly before a subject pronoun ("like I'm doing") is content and never cut. Propose summaries
  count those skips as `discourse:{token}` (`N discourse kept`), including
  isolated markers rejected by `min_filler_cluster`. Missing `discourse_markers`
  uses defaults; explicit `[]` disables demotion.
- **Intensity presets** — `tighten.intensity` / `podcast propose-edits --intensity` / MCP `propose_edits(intensity=...)`: `light` = clustered um/uh only, keep at least 0.5 s of every pause; `medium` = defaults; `aggressive` = isolated and borderline discourse markers, 0.3 s solo pauses. You may *suggest* a tier (interview → light; solo rambling monologue → aggressive), but the pipeline stays rule-based. Keys the working set / Pipeline tab changed from `pipeline.yaml` win over the tier (editing `pipeline.yaml` itself does not: it is the baseline, and a key set back to exactly the shipped value counts as untouched). `podcast propose-edits` / MCP `propose_edits` do not read the GUI working-set tier (pass `--intensity` / `intensity=` explicitly); MCP `pipeline_run` uses the working set by default, so it does. See [docs/filler-cut-quality.md § Intensity presets](../../../docs/filler-cut-quality.md#intensity-presets).
- **When to cut fillers** — a lone um/uh is proposed at `medium` and `aggressive` (`tighten.isolated_filler_candidates: true`); every hit is a pending proposal, so listen before approving. `light` turns it off and needs a cluster (`tighten.min_filler_cluster: 2` within `tighten.filler_cluster_gap_sec`, ~2s). Discourse markers always need the cluster.
- **Repetitions and restarts** — propose local exact word repeats, repeated phrase prefixes (up to four words), and explicitly marked partial-word cut-offs. Complete filler-lexicon phrases stay in the filler path. These hits always require listen-first, individual approval because emphasis or a meaning change can resemble a restart. They remain separate decisions during coalescing. Each cut is hard-bounded to the exact duplicate span the detector found; it never widens onto a neighboring word or the kept repair, and drops rather than proposes when only a harsh join would fit that bound.
- **Acoustic gap fillers (`filler:acoustic`)** — with `tighten.acoustic_gap_filler.enabled` (default true), propose also flags short voiced runs inside ASR word gaps that the transcript missed. These are **review-only and listen-first**: never auto-applied, never coalesced into neighbouring cuts, and bounded to the detected run (no gap-wide pacing pad). Each run is checked for breath using the shared sample-window heuristic relative to short audible windows inside both flanking words; without usable speech context the heuristic abstains and keeps the run for review. Clearly periodic runs also stay reviewable when the heuristic sees low energy; only weakly periodic breath-like runs are rejected. `tighten.acoustic_gap_filler.vad_backend: silero` opts into Silero, which does not need that speech reference and falls back to the heuristic on model or inference failure. The check reads only that candidate run, so another breath in the gap cannot reject it. A run whose level bursts three or more times like a laugh stays proposed as `filler:acoustic:likely_laugh` ("Likely laugh" in Studio, counted in the summary): never auto-applied by the pipeline, suggested action Lower when another speaker talks over it and otherwise Leave. It is a hint (a false start or a sharp inhale can look the same), so listen before deciding. Each run is also heard alone by the project's Whisper model (`tighten.acoustic_gap_filler.word_probe`, default true); one that comes back as a word gains `:possible_word` ("Possible missed word" in Studio, counted in the summary), held for review like a likely laugh, so a real word is named before anyone cuts it. A model that is not installed counts `word_probe:unavailable`; a span whose decode fails counts `word_probe:failed` and Propose still returns. The human summary names both. Listening reports progress per span. The detector can still mistake a cough, or a missed real word for a filler, so audition each one with `play_pending_preview_tool` before `approve_edits_tool`. Flat hum/rumble and runs where a peer track has voiced audio (read at the pair's copy lag) are skipped; a peer voiced elsewhere in a long gap does not block a run, and a peer's mistimed ASR word over silent peer audio does not block one; skip reasons, including `acoustic:breath`, appear in `skip_counts`. Three or more voiced runs in one gap, each within the speaker's longest ordinary word step of the next, are an untranscribed phrase (a hum, a sung or playful line), so none of them is proposed: `skip_counts` shows them as `acoustic:phrase`, which is why a run of hits in one gap can come back with no proposals; listen to that stretch if you expect a cut there (`edits/acoustic_phrase.py`; a track with too few word steps to read a cadence from keeps every run for review). The audition context raises an `acoustic_gap_filler` hypothesis per pending hit. Tuning and limits: [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Acoustic gap candidates.
- **Voiced edges and interior speech** — every final span is checked against the cut track's own voice. A pause or filler edge that sits inside a kept word's voice (aligned and Whisper word ends both run 120–270 ms early on real tape) is moved past the voice plus 60 ms of air, or, when no in-bounds move frees it, the cut is `review_required` with `:voiced_edge`. A `pause:` span holding 0.1 s or more of voiced audio is speech the transcript missed and is proposed for review as `:interior_speech`, never auto-applied; treat it as a transcript hole (re-transcribe or add the words) rather than a cut to approve. A session-scope cut ripples every dialogue track, so both checks read every decoded dialogue track, not just the cut track: a peer's voice at an edge nudges or flags the cut, a peer's voice inside any session cut is `:interior_speech`, and a pause with 0.1 s of merely audible (unvoiced) material on any rippled track is `:interior_audio` review. Detail: [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Policy.
- **Leave risky cuts in** — `tighten.leave_in_if_risky: true` (default). Low-confidence boundaries, harsh joins (cuts without a pad only), or low ASR filler confidence → skip the cut. See `docs/filler-cut-quality.md`.
- **Padded filler cuts are not splices** (#978) — a filler cut with a paced pad (`replace_gap_sec`) fades each edge against silence, so breath protection, the risk score's level-jump terms and the join continuity gate skip it (they rejected every owner-approved lab filler cut). Its right edge stops 10 ms before the next word's acoustic onset, read from the audio (at the foot of the rise in continuous voice, a plosive's burst kept whole and never faded over; a gradual onset such as `she` keeps the full recommended fade-in); a cut that would then leave the filler is dropped as `next_onset`, and one that covers a whole kept word as `kept_word:{word}`. Grazing a neighbor's tail is allowed. Ripple cuts without a pad keep every splice check; a mute gets the padded-cut checks and keeps breaths whole (#1024). When auditioning a padded hit or a mute, listen for the next word's first sound.
- **Filler cuts start at the voice** (#1061) — word times start fillers late (lab `um`s by 320–350 ms), so every filler cut, padded or not, starts 10 ms before the filler's first audible frame, read from the audio and never past the previous kept word. A filler whose voice runs on from that word with no quiet frame is dropped as `filler_onset`. When auditioning, listen for the filler's first sound as well as the next word's.
- **Kept words keep their voice** (#1064) — word times end a word before its voice does (lab `So` at 230.78 voices until 230.98), so every cut is held clear of the flanking kept words' voices, read from the audio against the track's own voice floor (27 dB under its speech level, at least 6 dB over its room; never a fixed dBFS level, so the edges hold at any recording level; one level profile per track, [audio-engineering.md § Detection levels](../../../docs/audio-engineering.md#detection-levels)). An acoustic run or a pause starts 60 ms after the previous word's last audible frame and ends 60 ms before the next word's first; a word cut starts no earlier than the first quiet frame after the previous word and ends 10 ms before the next word's voice. A cut that is then too short or misses its target, an acoustic run or pause that a kept word's voice runs on through, or a word cut that lies wholly inside the previous kept word's voice (no quiet frame and no 10 dB dip between them), is dropped as `kept_voice`. One exception (#1358): an untranscribed `filler:acoustic` run that is one decaying hum (one level burst, no step up) may end in a valley 10 dB deep before the next kept word, review-only; a single-syllable word such as `And.` still cannot be told from an `uh` by audio, so listen. When auditioning a mute, listen for the end of the word before it and the start of the word after it.
- **Join continuity gate** — `tighten.join_continuity_gate: true` skips cuts without a pad whose `assess_proposed_cut` verdict is `fail` (the worst over every edge placement within `join_continuity.edge_tolerance_ms`, 3 ms, so a borderline splice fails closed; that roughly halves the flips a few-ms nudge causes, it does not remove them). Use `join_quality_tool` / `podcast edit join-sweep` to audit splices; each sweep row's `speech` lists voiced speech cut through at that join (the same `speech_crosses_cut` the audition context raises).
- Max pause to cut: ~1.2s between words (`tighten.max_pause_sec`). Retain floor depends on context: ~0.18s when a peer is speaking in the gap (`min_retained_pause_sec`); ~0.55s for solo same-speaker pauses (`min_retained_solo_pause_sec`) so thinking / list-restart air is not crushed.
- **Filler pacing** — `tighten.min_gap_after_filler_sec` (~0.28s). Default `filler_room_tone_replace: true` removes the hesitation between flanking words and inserts a paced pad after apply (`filler_pad_mode: room_tone` by default: the track's recorded bed, else a steady stretch at its noise floor chosen from the audio, never from word gaps; gated tracks stay silent; `silence` gives a hard gap on every track). The pad is paced from the span the cut finally removes, so a cut widened to the filler's voice gets a longer pad (#1074). Set replace `false` to shrink the cut and keep original air instead. NL cuts use the same policy.
- **Speech-energy guard** — Each mapped span uses the peer's own 10 ms frames, including the existing 60 ms outward edge pad. One qualifying frame blocks session ripple; up to 5 s of nearby audio calibrates the peer's speech and room levels only. Ripple confirmation derives eligible samples from current placements and native surviving-prefix and suffix reads after selected and batch-chosen speech is subtracted. Fractional placements and source origins follow reader-specific rounding at 8 kHz. A cache sample mixing removed and retained recording contributions supplies no calibrated edge decision; usable interior frames still protect peer activity. Without another qualifying frame, the existing mean fallback applies without an exact-membership guarantee. General reader and mixed-contribution limits remain tracked in [#1258](https://github.com/calebn/sharecut-studio/issues/1258). Raw room calibration uses complete frames inside current lane playback coverage in both the queried span and its context, preserving recorded digital zeros. Detection, own speech levels, and dominated-reference evidence retain their full existing frame views. Missing room reference uses the existing mean fallback. Concurrent owner bleed is excluded from activity and the speech reference. The floor is the higher of own speech minus 25 dB and room plus 6 dB. Whole-span RMS remains diagnostic; unreadable frames or a reference without speech/room contrast normally use the existing mean and owner-dominance rule, so continuous hot sound still blocks and steady noise above the mean threshold can also block. If live owner-dominated reference frames raise the raw room percentile strictly above the own speech reference, non-silent undominated activity in the decision interval conservatively blocks. This protects a brief quiet peer remark amid dense bleed, but can also warn for quiet room noise after the owner stops. Digital silence and entirely owner-dominated bleed stay clear. By default a cut a peer speaks over waits for review and is never auto-applied (`speech_energy_guard.on_conflict: review`; `skip` refuses it). A valid known-peer `pause` remains a session review suggestion with actual CutSpeech context; programmatic application holds; trusted interactive approval can override the acoustic warning. A stored track pause always holds. If peer assessment raises `OSError` or `ValueError`, the candidate publishes nothing and counts one `scope_unavailable`, including an acoustic candidate. Availability is checked before initial planning and after final edge movement, before a pause selects session scope. Initial queries retain the outward pad. Final non-pause checks use the mapped removal after edge protection, and approval repeats this on current validated geometry. A pause uses exact final support only after a completed acoustic observation and successful original-air retention and effect checks; its final mapped spans must remain inside that observation request. Approval prepares the pause afresh and verifies its finished bounds before forwarding current mapped spans. Geometric observations keep the generic query. Unreadable peer media instead uses unsuppressed voiced words as completed evidence. Saved session approval holds unavailable assessment. A filler a peer speaks over is stored as a session ripple review suggestion (`:other_speaking:<peers>`); programmatic approval holds; trusted interactive approval ripples every dialogue track, never a one-track punch. Pause length itself is also measured on the timeline, not raw source-clock word distance, so a gap a ripple already deleted is never re-proposed.
- **Mute vs ripple** — default `tighten.edit_mode: ripple`; use `mute` only for timing-locked work (picture sync, or one speaker's track while another keeps talking). `mute` proposes `MUTE` filler hits (pause candidates skipped) and apply writes `Clip.mute_regions` without moving the timeline. A mute fades each edge in place on its own track, so it skips the join scorers and peer-speech scoping and gets the padded-cut checks (`next_onset`, `kept_word:{word}`). It also keeps breaths whole (an edge moves out of a breath; a span that is mostly breath is skipped as `breath`), drops an acoustic run that runs on into a kept word (`voiced_edge`) and drops audio below the track's voice floor (`inaudible`). Lab: the six word fillers, 13 repeats/restarts and 34 acoustic review hits, 21 of them vocal hesitations; the rest are missed words, a laugh and quiet sounds, so audition every acoustic hit. Approval renders the padded cut's fades around the mute (5 ms out, the post-pad fade-in back, ended before a plosive burst) and lays the `filler_pad_mode` fill under it: `room_tone` by default (recorded bed, else a steady stretch of the track's own air; a gated track stays silent), or `silence` for a hard hole. See `docs/filler-cut-quality.md` § Mute vs cut.
- **Waveform boundaries** — `tighten.inaudible_opt: true` (default). Proposals snap to low-energy points. Automatic apply consumes stored optimized bounds; a source-witnessed removal keeps its currently proved timeline window exact, including after a manual nonsnap resize. Unwitnessed pending rows also retain their finalized bounds; application measures the held operation without running an optimizer. Coalescing keeps different boundary modes separate.
- **Word timing source** — forced alignment is on by default when its model is installed (`transcripts[].word_aligner: onnx-base`). Both aligned and Whisper-only timestamps are estimates. Fresh #775 verification measured a Lana onset 550 ms before the Whisper word start and 850 ms before its aligned word start. Keep waveform optimization on, inspect wider acoustic context, and audition boundaries; installing or re-timing with the aligner does not prove an onset safe. Re-timing requires matching live ASR caches and unedited transcripts.
- **Per-cut fades** — `recommend_cut_fade_ms` sets each decision's `crossfade_ms` (fade-length hint). Apply sets `join_in_mode=fade` with per-join clip fades capped by `render.join_fade_max_ms` (default 40 ms). Render uses butt splice + `afade`, not overlap.
- **Breath co-removal** — adjacent breath energy is included in filler/pause cuts when detected (`tighten.breath_handling.enabled`, default true). A breath must be unvoiced noise up to the cut edge: a quiet run with clear speech-pitch periodicity, voiced audio between it and the cut, or sibilant energy above 4 kHz is speech and never extends the cut. Detection defaults to an RMS-percentile heuristic; `tighten.breath_handling.vad_backend: silero` opts into Silero-VAD-based detection instead (zero extra install — bundled with `faster-whisper`), with automatic fallback to the heuristic if unavailable. See [docs/audio-engineering.md](../../../docs/audio-engineering.md#silero-vad-breath-detection-opt-in).
- **Retained breaths at final cut edges** — Tighten completes quiet onset and tail, shrinks both edges around confirmed breaths, and suppresses proposals with relevant connected uncertainty or missing evidence. A **pause trim** cuts only air: it shrinks to the longest stretch of air inside it, measured against each recording's room tone (read once for the whole recording, where nobody in the session is speaking, and how far it spreads, in a speech band and a low band, so a rumble cannot hide a breath, a peer's bleed is not mistaken for the room, and a steady room shows its quietest breath), so no edge sits inside a word tail, a breath, a missed word or a laugh, on its own track or on a peer's (#1055). A sound that reaches 40 dB under the track's speech level stays whole, even mid-pause; a quieter one (a breath 45 dB down) is removed whole or left whole, never cut through. A pause that is mostly the track's own breath, or a peer's, has no air and is skipped as `no_air`; a track whose room cannot be measured is skipped as `no_room`. A pause trim must retain enough qualified original quiet and add no replacement pad. Its actual played loss must reach both 20 ms and a tenth of the heard pause (`PAUSE_JND_FRACTION`, a design threshold set from lab Weber fractions for silent intervals, not a measured one), or it is skipped as `imperceptible`. One that passes the checks a filler passes applies with `apply_edits` and the pipeline; one that fails them (a voiced edge, a join the gate doubts, a peer speaking) waits for review. `:air_edges` labels one that moved off the span pacing proposed and raises no review. Every track the ripple cuts is judged alike, each peer read through its own clips where the ripple removes it, so a peer's loud sound splits the air and a turn-taking gap gets only the air around the talk; a peer that cannot be read is `no_room`. Two tracks quiet over the same stretch propose it once (`shared_pause`, when the longer trim covers the other; both read the same sounds, so it holds nothing the other left whole; a trim lost to the join gate or an overlap leaves its twin standing). Apply suggested actions leaves a pause trim that waits for review (`listen_one_by_one`) pending and names it in `held`; approve each after listening. An approval that finds a peer now speaking over a session cut applies nothing and says so (`cut_scope_changed`). A track whose room tone is within 40 dB of its speech gets few or no pause trims. When auditioning one, listen for the word tails and breaths on both sides. Exact breath endpoints stay unchanged. See [filler cut quality](../../../docs/filler-cut-quality.md#policy) for protections and limits.
- Automatic apply processes decisions in reverse source order through the shared ripple or track-local removal path, then archives their actual source bounds and applies join fades.
- **Parallel analysis + audio cache** — `propose-edits` decodes each track's raw audio once (`edits/audio_cache.py`) instead of spawning `ffmpeg` per tiny window read, gathers candidates per track (including the acoustic gap scan) and analyzes filler, pause, repetition, restart, and acoustic candidates across all tracks concurrently (`performance.max_workers`, default auto), then applies decisions serially in the original order. See [docs/pipeline.md#performance](../../../docs/pipeline.md#performance).

If cuts still sound clicky after tighten: run `fade_joins_tool` or `recommend_fades_tool` (see **podcast-audio-cleanup**).

## Track alignment

Generated REMOVE/MUTE hits start pending. Coalescing inspects only the generator's owned IDs, preserves excluded manual rows unchanged, and counts held singleton or merged source groups. Auto-apply excludes held rows from chosen speech and restarts preflight plus a fresh final trial from the stable post-MUTE state. Only a clean final copy is adopted and archived once. Every origin placement must fit the actual operation's canonical lanes; parked MUSIC remains pending as `operation_scope`, and voiced parked media still needs fresh conservative speech evidence. Nonpause pad selection keeps its existing policy. Pause trims use current complete word images and original placements to try bounded left, right, or bilateral contraction. Each attempt reruns all gates. A pause holds when required original quiet or evidence is insufficient. Pause trims never add room-tone or silence padding, regardless of configured modes or stale saved pad values. Saved REMOVE pauses remain session ripples, regardless of the current proposal mode. Fresh join review holds automatic application. Trusted human GUI approval supplies a transient acoustic override, preserving programmatic proposal origin. Agent approval and a GUI-started pipeline do not establish manual intent; structural/source/pad integrity still applies to both.

Auto-tighten (`propose-edits` → `apply-edits` / pipeline `tighten_from_transcript`) uses **cross-track ripple delete**. When a filler on one speaker is removed, the same session-time window is cut on **all** dialogue tracks so multitrack alignment is preserved. Render then plays clips at their updated timeline positions — do not expect per-track source-time compress without ripple.

## Timeline helpers

- `strip_silence_tool(speaker=…)` — per-track dead air (does not ripple other tracks)
- `shorten_gaps_tool` — ripple-delete excess inter-word pauses on all dialogue tracks; another speaker talking in a pause can hold the cut; MCP confirmation does not bypass acoustic policy
- `ripple_delete_text_tool(query)` — remove a spoken phrase across tracks

Pause proposal preparation uses current complete word images and original placements to try bounded left, right, or bilateral contraction. Each preparation attempt reruns the operation and safety gates. Application measures the fixed proposed operation and current retained air; it never repeats preparation or resnaps the stored edges. A pause holds when required original quiet or evidence is insufficient. Pause trims never add room-tone or silence padding, regardless of configured modes or stale saved pad values. A trim qualifies only when its final actual net loss is positive and meets the timing JND. Saved REMOVE pauses remain session ripples, regardless of the current proposal mode. Fresh join review holds automatic application. Trusted human GUI approval supplies a transient acoustic override, preserving programmatic proposal origin. Agent approval and a GUI-started pipeline do not establish manual intent; structural/source/pad integrity still applies to both. Keep manual and nonpause room-tone workflows separate; unresolved or suspect pad sources remain on hold pending owner listening.

## Workflow

Omit track and speaker for session handoffs; explicit selectors analyze one lane. Use the [handoff evidence contract](../../../docs/inaudible-cuts.md#narrative-handoffs). Re-clear refinement after word removal; pause-only trims preserve clearance. See the [refinement gate](../../../docs/transcript-workflow.md#agent-gate-require_transcript_refine).

Default: **propose → review → approve**. Never bulk-apply on a production episode
without the user signing off.

1. Ensure per-track transcripts exist (`podcast transcribe --project ...`).
2. Clear the transcript refine gate (**podcast-transcript-refine** → `refine-done`) if status is pending.
   **Long raw session?** Do the content cut **first** (off-topic runs, meta talk, dead start) with **podcast-edit-natural-language**, from the end of the episode toward the start. Mid-episode runs (latest first) use `suggest_handoff_cut_tool`, then `ripple_delete_tool(use_inaudible_opt=false)`. `suggest_handoff_cut_tool`'s `retain_sec` / CLI `--retain-sec` defaults to `1.0` per side (~2s of air at the join); a tighter conversational handoff usually wants `0.3`–`0.6`. Cut the dead start last, because it shifts everything after it: `podcast edit ripple-delete --start 0 --end <first kept line − 0.5>` / `ripple_delete_tool`. The refine waive stays clear through the ripple. Proposals then fall only in the kept range; there is no range argument. Reject tighten hits proposed before the cut (`podcast edit reject --ids …`). Order: [docs/pipeline.md § Long raw sessions](../../../docs/pipeline.md#long-raw-sessions-content-cut-before-tighten).
3. Propose (does not apply):

```bash
podcast propose-edits --project episode.sharecut
podcast propose-edits --project episode.sharecut --intensity light
podcast propose-edits --project episode.sharecut --json
```

MCP `propose_edits` returns `{operation, edits, skip_counts, summary}`
(`operation` is `propose_edits`; not a bare array). Each edit also has a `label` ("Laugh", "Filler word"), a `kind` (filler / pause / repeat / false-start / sound / other), the raw `sound_kind` (for example `laugh`) and a `suggested_action` (cut / shorten / lower / leave) from one table in `edits/cut_policy.py`; it is a suggestion, not an applied change. CLI `propose-edits --json`
prints the same payload (`TightenProposal.to_payload()`); without `--json` it
prints the summary text only. Report `skip_counts`
(`discourse:like`, …) as “N discourse uses kept”, `backchannel:uh huh` as “N
acknowledgments kept”, rejections such as `breath`, `next_onset` or
`kept_word:{word}` as candidates dropped by that check, and `filler:acoustic` hits
separately (“N acoustic, review each”). Proposing again replaces every pending
generated hit, review-flagged and nudged ones included, so an unchanged project
returns the same hits, under the same ids, each run. An Ask thread
(`edit_decision_id`) on a hit stays attached across re-runs.

4. Review each pending decision listen-first:
   - Sharecut Studio Review > Queue (host): **Find more** proposes the hits, each row's
     Cut / Keep decides one, and a group's **Cut all** applies its hits in one undo step, or
   - `list_edit_decisions_tool` / `podcast edit list --pending` plus
     `play_pending_preview_tool` (Suggested / Current / A/B). `list_edit_decisions_tool` and `podcast edit list` rows carry `kind`,
     `sound_kind`, `label` and `suggested_action`, like `propose_edits` rows; group by `kind`, not the reason prefix.
   Entries with `review_required: true` need `approve_edits_tool` before render.
5. Approve **per hit** (`approve_edits_tool` with ids) after the user hears it.
   When the user asks to apply the suggested actions, call
   `propose_edits`, read each edit's `label` and `suggested_action` (cut,
   shorten, lower or leave, from one table per kind of sound), then call
   `apply_suggested_actions_tool(project_path, ids=None, overrides=None)`
   (`podcast edit apply-suggested [--ids a,b] [--override ID=ACTION]`),
   optionally with the ids they listed and `overrides` for the sounds they want
   handled differently. It applies every action in one undo step: lower turns a
   sound down 12 dB when another speaker talks over it and otherwise leaves it,
   and leave dismisses the proposal and keeps the audio. With no ids, or several,
   a cut over a transcript word below `analysis.unsure_word_confidence` stays pending
   and is named in `held_unsure`: check the words, then apply that cut by passing its
   single id. MCP, CLI, and pipeline
   application retain fresh acoustic checks. Only trusted interactive human intent
   overrides an acoustic peer hold; that session ripple is counted in
   `cut_over_speaker`. Programmatic confirmation flags do not create that intent.
   Held cuts stay pending and are named in `held`. Do not filter hits
   yourself. To change one sound afterward (say a cut to leave) without undoing
   the rest, call it again with `revise=true` (`--revise`) and `overrides` for
   that sound and no ids: it steps back to before the batch, which must still be
   the latest edit, and applies it again as one undo step.
   Use `apply_edits` / `podcast apply-edits` only after explicit sign-off on the
   whole batch — not as the default on a real episode.
   After approving, `render_preview` and run **`audition_context_tool` on every
   applied join** (or one `join_qa_sweep_tool`; **podcast-play-audition** § Ears)
   before export: fix each `speech_crosses_cut` with the `trim_clip_edge_tool` call in
   its `evidence.fix` (`mode=ripple` on a session-wide cut, `mode=gap` on a punch), and confirm each
   `echo_risk` by listening or from its per-pair evidence before **podcast-mute-bleed**.
   Before a REMOVE or MUTE changes audio, the shared cut-safety authority checks the final breath/onset edges; a span that no longer passes stays pending. Every ordinary SOURCE REMOVE rechecks complete unique continuous placement before optimization and closes its final consumed window back to origin media. Replay, source holes and unselected overlaps hold; current implicit primary media needs finite duration, while intentional empty lanes stay empty. Pauses also recheck positive perceptible actual played loss while retaining enough qualified original quiet, without adding a replacement pad. Saved selected approval promises the batch unchanged only after successful workspace rollback; automatic holds stay pending while survivors apply, and Suggested checks a separate preview snapshot. Reject the held suggestion or select the intended timeline part; a geometry hold is not permission to force the cut.
6. For NL cuts by topic, use skill **podcast-edit-natural-language**.
7. Do **not** run pipeline from `tighten_from_transcript` on production while
   `tighten.enabled` is false / the golden-ear bar is unmet.
8. Owner golden-ear (Shot of Truth): `make golden-ear ARGS='build --project … --out DIR'` (add `--intensity <tier>` to evaluate a tier) then `score --answers listen/answers.csv` — see [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Golden-ear protocol. Listen under `listen/`; do not open `key.json`. `propose_tighten` is gated by transcript refine (`_require_refine_clear`). Suggested audio is the pending preview's approved render (ripple, paced pad, fades), as approving ships it. Not a CI substitute for the owner listen.

## Undo

Tightening changes are non-destructive. Snapshots are taken before `propose-edits`. Use `podcast undo` or MCP `history_undo` to revert edit decisions; re-render from `assemble_timeline` afterward.

## Rules for agents

- On a long raw session, never run `propose-edits` before the content cut (see Workflow step 2). Proposals in material you later remove are wasted review.
- Never bulk-apply (`apply_edits` / pipeline from `tighten_from_transcript`) on a production episode without explicit user sign-off.
- Do not remove more than ~15% of total duration without explicit user approval.
- Prefer cutting fillers and dead air over cutting substantive words.
- Trust the discourse and risk gates — if a `like` is left in (`discourse:like`
  in skip_counts), do not force-cut without listening.
- If timing precision is more important than smoothness for a one-off debug run, use `--no-inaudible-opt` and compare with `podcast edit preview-cut`.
- Re-run `merge_transcript` after major edits if exporting show notes.

## Tuning

Defaults live in `.agents/defaults/pipeline.yaml` → `tighten`, `inaudible_cuts`, `render`.

**Full tuning guide:** [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) — symptom → knob table, conservative/aggressive presets, parameter reference, debug workflow.

Quick fixes:

| Problem | Try |
|---------|-----|
| Still choppy / clicky joins | Lower `max_cut_risk_score`; raise `min_retained_pause_sec`; run `fade_joins_tool` after apply |
| Too aggressive, not enough left in | Set `isolated_filler_candidates: false` (or use `light`); raise `min_filler_cluster` to `3`; lower `max_cut_risk_score` to `0.5` |
| Too timid, fillers not cut | Lower `min_filler_cluster` to `1` (discourse markers); raise `max_cut_risk_score` to `0.75` |
| Fluent “like” still proposed | Keep `discourse_markers`; raise `discourse_pause_sec` or lower `discourse_confidence_max` |

Always `propose-edits` → listen → approve. For video-linked or “don’t ripple” work, `propose_edits(..., edit_mode="mute")` / `--edit-mode mute`. Do not tune on apply alone.

## Docs

- [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) — selection, risk model, breath handling, pause floor, golden-ear protocol
- [docs/inaudible-cuts.md](../../../docs/inaudible-cuts.md) — boundary optimizer and fade vs crossfade join modes

Application consumes held bounds without resnapping. The cut-domain owner finishes
actual source, mute, pad and fade effects on a private project copy, assesses them,
and publishes once through the existing workspace mutation. Programmatic calls
cannot grant acoustic override with flags, text consent or saved labels. Trusted
manual gestures and explicit interactive approval override acoustics only; source
placement, pad hulls and archive integrity still hold. A refusal publishes no
provisional archives, history or render artifacts.
