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

1. **Join continuity** — blind A/Bs prefer edit vs leave-in for ≥90% of gated-pass cuts; zero leftover-consonant / click fails (`join_quality` / `join_qa_sweep`, `tighten.join_continuity_gate`, golden-ear harness). The harness scores pending-skip previews, not post-apply audio.
2. **Selection** — discourse `like` excluded or rare on a like-heavy fixture
   (`tighten.discourse_markers` + skip counts `discourse:{token}`).
3. **Density** — episode does not feel edited every breath.

Auto-tighten (`analyze_fillers_and_pauses` → `apply_auto_edits`) uses waveform-verified boundaries, per-cut fade sizing, risk gating, **perceptual join-continuity gating** (`tighten.join_continuity_gate`), and optional breath co-removal so filler/pause edits stay inaudible when possible.

Implementation: `edits/fillers.py`, `edits/cut_quality.py`, `edits/join_continuity.py`, `edits/breath_detect.py`. Defaults: `.agents/defaults/pipeline.yaml` → `tighten`, `join_continuity`, `inaudible_cuts`, `render`.

## Policy

- **Repetition and restart proposals** (off at `light` / `tighten.repetition_candidates: false`) — Tighten detects same-track, timestamp-adjacent exact word repeats (`repetition:word:*`), repeated prefixes up to four words (`restart:phrase:*`), and only explicitly marked partial-word cut-offs (`stor- store`, `restart:partial:*`). Split repairs remove the repeated prefix and partial together (`I w- I went` removes `I w-`, retaining `I went`). The detector uses a bounded 0.45 s gap by default (`tighten.repeat_max_gap_sec`, capped at 2 s), skips suppressed/overlapping words and complete filler-lexicon spans (including split multi-word entries such as `you know`), and never compares across tracks. It consumes a matched repair window so periodic text cannot stack adjacent restart proposals. Every repeat/restart candidate is hard-bounded (like an acoustic gap run) to the silence flanking the reparandum: the floor is the end of the preceding surviving word and the ceiling is the start of the repair word, not the reparandum's own start/end (#783; before that, the bound was the reparandum's exact span, which on Whisper's touching word times was the same thing but on aligned times stranded the flanking gap as unremoved air). Waveform snapping, breath extension, and pacing can widen into that flanking silence but can only shrink inward from there, never move the cut onto a neighboring word or into the kept repair (#772). A cut that can only satisfy that bound with a harsh join is dropped by the usual risk / join-continuity gates rather than proposed wide. Because that flanking silence can be much wider than the reparandum itself on aligned times, a final cut covering less than half of the reparandum's own span is dropped outright (PR #792 review): waveform snapping or breath extension sliding the cut mostly into the silence removes neither copy and leaves both audible, which is worse than proposing nothing. These remain proposal-only (`review_required: true`) because emphasis and semantic repairs (for example “store—no, park”) cannot be inferred safely from text alone; coalescing keeps each repeat/restart (and `filler:acoustic`) proposal's id and reason separate from adjacent cuts. The existing golden-ear A/B harness includes `filler`, `pause`, `repetition`, and `restart` by default; listen and approve each hit individually.

- **Leave isolated fillers in** — `tighten.min_filler_cluster: 2` (default). Only cut fillers that appear in clusters within `filler_cluster_gap_sec`.
- **Discourse-safe selection** — Tokens in `tighten.discourse_markers` (default `like`, `you know`, `sort of`, `kind of`) remain in `filler_words` but are **not** cut unless at least one of: (a) an **adjacent** true disfluency (`um` / `uh` / `erm` / `ah`, or any other non-marker lexicon hit) or an immediate repeat (`like like`); (b) a pause ≥ `tighten.discourse_pause_sec` (default 0.35 s) on at least one side of the marker span; (c) ASR confidence < `tighten.discourse_confidence_max` (default 0.6). Multi-word markers match split ASR tokens via adjacent-token windows (`you`+`know` → `you know`). Pause and low-confidence are intentional escape hatches: a fluent quotative/comparative `like` with a ≥0.35 s flanking gap or ASR confidence below 0.6 still becomes `filler:like`. Fluent uses without those signals are counted as `discourse:{token}` (including isolated hits rejected by `min_filler_cluster`) and show up in the propose summary (`N discourse kept`). Accepted hits still use reason `filler:{token}`. Missing `discourse_markers` uses the defaults; explicit `[]` disables demotion.
- **Leave risky cuts in** — When `tighten.leave_in_if_risky: true` (default), cuts that fail the risk model are skipped rather than applied.
- **Join continuity gate** — When `tighten.join_continuity_gate: true` (default), `assess_proposed_cut` runs after boundary optimization; verdict `fail` skips the candidate (fail-closed). Verdict `review` marks `review_required`. The verdict is the worst over every edge placement within `join_continuity.edge_tolerance_ms` (3 ms), which roughly halves the verdict flips a few-millisecond nudge or re-timed word causes; a splice inaudible at the proposed edges passes regardless. See [inaudible-cuts.md](inaudible-cuts.md) § Join continuity.
- **GUI review loop** — Sharecut Studio **Tighten** tab lists pending `filler:` (including review-only `filler:acoustic`), `pause:`, `repetition:`, and `restart:` hits (search, class/track filters, harsh-only). Preview / skip / apply one, or apply-all with **Avoid harsh cuts** (default on; skips `review_required` and `:risky` / `:join_review`). Same `ApproveEdits` / `RejectEdits` path as the pending inspector. See [daw-editing.md](daw-editing.md) § Tighten review.
- **Waveform boundaries** — Proposals call `optimize_source_cut_range` when `tighten.inaudible_opt: true` (default). Short cuts also **extend the end to the quietest point before the next word** (within `trailing_energy_extend_ms`) when ASR ends a filler early (see [inaudible-cuts.md](inaudible-cuts.md) `trailing_energy_*`).
- **Adaptive fades** — Each decision gets `crossfade_ms` from `recommend_cut_fade_ms` (roughly 15–50 ms for fillers, up to ~150 ms for long pauses, scaled by join level jump).
- **Breath co-removal** — Adjacent breath-shaped energy before/after a cut is included in the remove range when detected (`tighten.breath_handling.enabled`). A breath must be **unvoiced noise all the way to the cut, between the track's own room tone and speech level, and outside every kept word**. The detector (`edits/breath_detect.py`) reads 5 s of the kept audio on each side of the cut and takes the 10th and 90th percentiles of its live (not digitally silent) 10 ms frame levels as the room-tone floor and the speech level; a breath frame sits at least 9.5 dB above that floor and 7–40 dB below that speech level (`breath_level_band`). Flanks with no such contrast (a gated track with nothing live nearby, or under 0.5 s of live audio) yield no breath. On the lab tape breaths sit 6–39 dB below the local speech level and 12–45 dB above the floor; the previous band, derived from the fixed `analysis.heuristics.audibility_rms_db`, was −32.4 to −31 dBFS and found 1 of 26 labelled breaths (#814). Within a 400 ms window before and a 250 ms window after the cut, the first run of in-band frames of breath length (80–450 ms) is taken that passes five checks. Frames inside a kept transcript word are never breath and the stretch between the run and the cut may not touch one (a word the cut itself removes at least half of is not kept), so a quiet phrase-final word tail such as lana's `she?` cannot be called breath. A run that continues a kept word on its far side, with no frame at or below the band floor between them, is that word's decay (before the cut) or onset (after it), whatever its own shape: the aligned `uh` at 1441.21–1441.27 decays through the band to 1441.41 and the `sh` of `she` at 1456.65–1456.76 is a 2–3.5 kHz burst under the sibilant split; the scan covers the whole 5 s of flanking audio so the word can lie outside the search window. No frame between the run and the cut may exceed the band ceiling: vocal fry scores 0.1–0.4 on the pitch probe but its pulses sit at speech level (an untranscribed creaky `check` at 1122.98–1123.15, −17 dBFS frames against a −18.8 dBFS ceiling). Neither the run's energy nor that of the gap between it and the cut edge may sit mostly above 4 kHz (a sibilant `s` carries 54–100% of its 100 Hz–8 kHz energy there, a breath 1–24%; the gap is checked on its own so a word-final `s` next to a loud breath cannot average out below the split). And 40 ms speech-pitch (70–350 Hz) autocorrelation probes every 10 ms over the run **and everything between it and the cut edge** must all stay below 0.55, because the cut is extended out to the run and removes what lies between; only probes whose frame reaches the band floor count, since room tone 40 dB under the speech level also scores 0.6–0.8 on this tape and is not speech to protect. A run that fails is skipped for the next quieter one. The band alone cannot tell breath from speech — in a loud window a window-relative band selected the quieter frames of ordinary speech, and on the lab tape 82% of its hits were voiced, including the kept second copy of a repeated word; a breath sitting 270 ms before a cut also pulled the voiced word between them into the cut (#798). Some breaths on the lab tape peak at 0.60–0.65 on the same probe and stay undetected; the gate is kept because quiet voiced speech reaches down to 0.57. Detection also cannot move a cut past its candidate bounds: a pause cut ends where the candidate ends (the retained air before the next word, so a breath in that air stays, as at `793.540` and `1535.750`), and an acoustic cut moves at most 50 ms past its run (`986.354`). Creaky or breathy word tails past a Whisper word end can still count as breath when they abut the cut; candidate bounds keep repeat/restart and acoustic cuts off neighbouring words regardless, and the join-continuity gate still assesses the final span.
- **Pause floor** — Long pauses are shortened but a natural gap remains. **Turn / dead-air** (another dialogue track has words in the gap) keeps `tighten.min_retained_pause_sec` (~0.18 s). **Solo same-speaker** pauses (peers quiet — thinking, list restart) keep `tighten.min_retained_solo_pause_sec` (~0.55 s) so performance air is not crushed to a hard edit. The floor is **contiguous** source air immediately before the next word (holes from prior ripples do not count); any shortfall is padded with silence after ripple. Reasons are tagged `pause:…s:solo` when the solo floor applies.
  The `max_pause_sec` threshold is measured on **surviving timeline air**, not the raw source-clock gap between the two words (`SessionTimeline.map_source_span`, #772). A ripple delete leaves no clip over the removed range, so two words that are adjacent in the transcript can still be far apart in source time; the deleted stretch contributes nothing to the gap and no `pause:` candidate is proposed once what remains falls under `max_pause_sec` (including down to zero, when the whole gap between them was cut away). A hole from an earlier **track-local** punch inside the gap is excluded the same way (#783): the sum only counts spans this track's own clips still cover, so an already-silenced stretch never inflates the measured gap. This is a deliberate undercount — it can only make `max_pause_sec` harder to reach, never propose a cut over audio that still plays — and it is low-impact in practice, since a track-local hole comes from the speech-energy guard punching around a peer, and the guard drops a `pause:` candidate in that same window anyway (above).
  Peer speech is indexed once across dialogue transcripts for a tighten pass; standalone transcripts absent from the project use the direct peer scan. A gap counts unsuppressed words on other dialogue tracks whose start is before the gap end and end is after the gap start, including point-timestamp words strictly inside the gap; the current track and non-dialogue tracks do not supply peer speech.
- **Voiced edges and interior speech** (#815, #818) — After pacing, every candidate's final span is checked against the cut track's own voice (`edits/voiced_runs.py`: 20 ms level frames every 10 ms at or above `analysis.heuristics.audibility_rms_db`, bridged over 30 ms dips, kept as a run only when at least three 40 ms probes carry a clear speech-pitch peak ≥ 0.55, the same bar `breath_detect` uses, so breaths, clicks and room tone never form a run). Word times are the only view a candidate has, and on the lab tape both aligned and Whisper ends sit 120–270 ms inside the voice (`idea` ends 467.33 s by the aligner, the vowel at 467.55 s). An edge that a run surely holds on both sides is moved out of it, past the run plus 60 ms of air (join_speech's pad), when the run belongs to a word that stays, so the word keeps its tail or onset. A cut only ever shrinks here: voice past an edge with no transcript word in it is either the cut word timed short or a word the transcript dropped, and the audio cannot tell which, so the edge stays and the cut is `review_required` with `:voiced_edge` instead of widening onto it. A nudge is also refused, with the same flag, when it would move more than 0.5 s, leave the candidate's bounds, leave under 0.1 s of cut, or (for filler / repeat / restart / acoustic cuts) uncover more than half of the targeted word. A `pause:` span that still holds 0.1 s or more of one voiced run after the edges settle is speech the transcript missed (a dropped sentence, a laugh, an "mm"): it is proposed for review as `:interior_speech`, never auto-applied. Review rather than drop, so the reviewer learns the transcript has a hole there; every apply-all path already skips `review_required`.
  **Which tracks.** A session-scope cut ripples the same window out of every dialogue track, so the check reads every dialogue track whose audio decoded into the tighten audio cache (the cut track alone for a track-local punch). Everything on a peer stays, so a peer's voiced run at an edge is always a kept-word nudge (or `:voiced_edge` when refused), and a peer's voiced run of 0.1 s or more inside the span makes any session cut `:interior_speech`, filler or pause. The speech-energy guard still decides session vs track-local, but it measures a window mean (lana's 110 ms burst at −30 dBFS averaged −48 dBFS over a 7 s pause) and needs 30 ms of overlap, which is why the ripple check reads runs instead. A pause must also be **dead air** on every track it ripples: an audible run of 0.1 s or more at or above the floor that the pitch probe cannot vouch for (a fricative-only word, a laugh, a cough) makes it `:interior_audio` review. Single clicks under 0.1 s do not count; on the lab tape the seven good dead-air cuts hold 20–80 ms blips at −29 to −42 dBFS and stay auto-applicable, while a peak-frame rule would have cost two of them. Known limits, measured with synthetic probes: voiced audio 4 dB under the floor (−46 dBFS) is invisible, and so is speech shorter than 0.1 s.
  Measured on the lab tape: the dropped-ASR repro's two 8 s pauses over speech went from auto-applicable to `:interior_speech`; edges inside kept-word voice went 39→29 (Whisper) and 108→82 (aligned), all of them review-required, and the seven dead-air cuts kept their edges. Some edges the gate used to score `review` while they sat inside a word now score `fail` once they sit honestly on the word's decay and are dropped; others that used to fail now pass as inaudible splices (caleb 1271.60 s) because the edge no longer straddles speech and silence. audra's 671.74 s pause, clean on its own track, is `:interior_speech` for lana's untranscribed burst at 673.3 s inside it.
- **Filler pacing floor** — After filler / NL hesitation cuts, default `filler_room_tone_replace: true` removes the inter-word hesitation and inserts a paced pad: `clamp(min_gap_after_filler_sec, gap × filler_gap_retain_fraction, filler_replace_gap_max_sec)` (defaults **0.35 / 0.85 / 1.0 s**). Expand keeps previous-word release via **`recommend_prev_word_lead_out_ms`** (energy to quiet floor, ~40–250 ms — fixed 60 ms still cut mid-nasal) and `filler_next_word_lead_in_ms` (~80 ms) before the next onset — unless ASR tokens overlap the filler. After the pad, `filler_pre_pad_fade_out_ms` (~5 ms) declicks into silence and **`recommend_post_pad_fade_in_ms`** sizes the resume fade from look-ahead energy (quiet air → `filler_post_pad_fade_in_min_ms` ~15 ms; hot/late onset → up to `filler_post_pad_fade_in_max_ms` ~120 ms). Default pad fill is **`filler_pad_mode: silence`**. Set `filler_pad_mode: room_tone` to prefer a recorded `track.room_tone` bed (abutting tiles with fade-in on the first tile and fade-out on the last when the pad is longer), else sample stem air that is free of **own-track words** (including suppressed) and **peer-track speech** on the session clock (bleed), with **`room_tone_edge_margin_sec`** (~0.15 s) clear of word edges so inter-word micro-gaps are not tiled, and **`room_tone_min_rms_db`** (~-65 dB) so digital silence / gated pre-roll is not tiled as a fake bed. If no bed and no safe audible air exists near the cut, the pad is skipped rather than tiling dialogue/bleed/silence. Set `filler_room_tone_replace: false` to shrink the cut and keep original air instead.
- **Speech-energy guard** — Before session-wide ripple, `tighten.speech_energy_guard` measures other dialogue stems in the cut window. If a peer is audibly speaking (even when ASR missed the word), default `on_conflict: track_local` punches a silence hole on the **cut track only** (`EditDecision.scope=track`) so overlapping dialogue is not mid-word chopped. `skip` refuses the cut; `review` still uses track-local and marks `review_required`. A `pause:` candidate is **dropped** instead of demoted, under either `on_conflict` setting: a track-local punch never ripples, so it cannot shorten the timeline, which is the only reason a pause cut exists (#772).

## Mute vs cut

`tighten.edit_mode` (default **`ripple`**) still proposes `EditDecisionType.REMOVE` and applies via session ripple or track-local punch. Set **`edit_mode: mute`** (config, or `propose_edits(..., edit_mode="mute")` / `--edit-mode mute`) to propose **`MUTE`** decisions instead: the same filler candidate pipeline and `filler:` reasons, same `review_required` gating, but apply/approve writes **`Clip.mute_regions`** (`{start_s, end_s}` source-media seconds) and does **not** move clips or change `timeline.duration_sec`. Render honours those regions as silence with ≤5 ms symmetric fades so the hole does not click.

**Pause candidates are skipped in mute mode** — muting a pause is a no-op (the gap is already silence). Use ripple when you want to shorten dead air.

Pending `EditDecision` fields are unchanged (`type` was already `remove|mute|split`). After apply, the pending row is archived like a remove; the audible hole lives on the clip. Undo via `ProjectWorkspace.mutate()` restores `mute_regions`. `RestoreAppliedEdit` / MCP `revert_applied_edit` on a mute archive (`params.mute`) subtracts intersecting source spans in place — it does **not** ripple or re-insert clips. Use History undo for snapshots that predate the mute row. `SuggestPendingEdit` accepts `edit_type: mute` (default `remove`). `UpdatePendingEdit` already updates MUTE ranges the same way as REMOVE.

Do not mix mute-in-place with track volume envelopes: Levels automation stays on `mix.automation_envelopes`; filler mutes are clip-local so they do not fight a user envelope.

Pipeline `tighten.enabled` stays **false**; mute mode is for manual propose → review → approve.

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

**Which neighbours count as a join:** one rule for every join mode — `clips_abut` in `edits/clips_ops.py`, a timeline gap of at most `JOIN_GAP_TOLERANCE_SEC` (50 ms). A gap within the tolerance closes up when rendered (fade and cut joins concat; crossfade joins crossfade), so the stem is shorter than the timeline by that gap, and by the crossfade overlap for crossfade joins. A wider gap stays as silence and gets no crossfade. Crossfade joins with a 1–50 ms gap used to render as fade joins; when render rules like this change, `RENDER_SEMANTICS_REV` in `engines/timeline_render.py` is bumped so cached stems and play segments re-render. Rev 3 made a cut per join: only the next clip's cut drops a clip's fade-out, and a clip's own cut drops its fade-in only when it has a left neighbour (a track's first clip has no join).

Hard joins (`join_in_mode=cut`, zero fades) use plain concat. See [inaudible-cuts.md](inaudible-cuts.md).

## CLI / MCP

- `podcast propose-edits` / `propose_edits` — proposals include optimized boundaries and per-cut `crossfade_ms`. The MCP payload is `{operation, edits, skip_counts, summary}` (`operation` is `propose_edits`; not a bare array). `skip_counts` maps `discourse:{token}` → kept uses, including isolated cluster-size rejects. CLI prints `proposal.summary()`.
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
| Too many isolated ums still cut | `min_filler_cluster` | **Up** (e.g. `3`) |
| Not enough fillers removed | `min_filler_cluster` | **Down** (`1`, aggressive) |
| Cuts land mid-word / clip consonants | `inaudible_opt` | **On**; widen `inaudible_cuts.search_window_ms` slightly |
| Cuts too close to neighboring words | `inaudible_cuts.min_word_margin_ms` | **Up** (e.g. `10–15`) |
| Obvious clicks or level jumps at joins | `fade_joins_tool` or `recommend_fades_tool` | Run after apply; check `render.join_fade_max_ms` |
| Edits sound "scooped" or too soft | `crossfade_ms` / `recommended_fade_ms` | **Down** slightly; avoid accidental `crossfade_joins` |
| Robotic, rushed cadence after tighten | `min_retained_pause_sec` / `min_retained_solo_pause_sec` / `min_gap_after_filler_sec` / `filler_gap_retain_fraction` | **Up** floor or retain fraction |
| Thinking / list-restart pauses feel slammed | `min_retained_solo_pause_sec` | **Up** (e.g. `0.65–0.8`); or leave the pause uncut |
| Words smash after um/uh / you-know cut | `filler_gap_retain_fraction` / `min_gap_after_filler_sec`; keep `filler_room_tone_replace: true` | **Up** retain (e.g. `0.65–0.75`); or leave filler in |
| Dirty air / mouth noise left at filler joins | `filler_room_tone_replace` + `filler_pad_mode` | Replace on; use `silence` (default) or `room_tone` when you have a matching bed |
| Prefer keeping original pause audio over pad | `filler_room_tone_replace` | **`false`** (shrink cut to leave original air) |
| Sampled room tone mismatches the join / tiles speech or bleed | `filler_pad_mode` | Prefer **`silence`** until a recorded `track.room_tone` bed exists; steal still skips own words + peer speech windows |
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
| `light` | `filler_words: [um, uh, erm]`, `min_filler_confidence: 0.5`, `max_cut_risk_score: 0.5`, `max_pause_sec: 2.0`, `min_retained_pause_sec: 0.5`, `min_retained_solo_pause_sec: 0.75`, `repetition_candidates: false`, `acoustic_gap_filler.enabled: false` (clear um/uh only; never trim a pause below 0.5 s) |
| `medium` (default) | none: the shipped `tighten` block unchanged |
| `aggressive` | `min_filler_cluster: 1`, `discourse_pause_sec: 0.2`, `discourse_confidence_max: 0.85`, `max_pause_sec: 0.8`, `min_retained_solo_pause_sec: 0.3`, `max_cut_risk_score: 0.8`, `repetition_candidates: true`, `acoustic_gap_filler.enabled: true` (isolated fillers, borderline discourse markers, 0.3 s solo pauses) |

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
| `tighten.min_filler_cluster` | `2` | Min fillers in a cluster before cutting |
| `tighten.filler_cluster_gap_sec` | `2.0` | Max gap between fillers in one cluster |
| `tighten.filler_words` | um, uh, … | Token list (ASR-normalized); includes discourse markers |
| `tighten.discourse_markers` | like, you know, sort of, kind of | Demoted lexicon tokens (phrase-matched); cut only with adjacent disfluency/repeat, pause bound, or low ASR confidence. YAML-only (no Advanced list widget). Missing key = defaults; `[]` disables demotion. |
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
| `tighten.filler_pad_mode` | `silence` | Pad fill: hard silence, or `room_tone` (recorded bed, else stem air sample) |
| `tighten.filler_room_tone_max_expand_sec` | `2.0` | Max expansion toward flanking words; larger gaps keep the local cut + pad |
| `tighten.room_tone_edge_margin_sec` | `0.15` | Clear air beyond own/peer ASR edges when stealing room tone (blocks inter-word micro-gaps + bleed skirts) |
| `tighten.room_tone_min_rms_db` | `-65` | Reject digital-silence / gated samples when stealing room tone |
| `tighten.speech_energy_guard.enabled` | `true` | Block session ripple when peers speak in the cut window |
| `tighten.speech_energy_guard.on_conflict` | `track_local` | `track_local` / `skip` / `review` |
| `tighten.leave_in_if_risky` | `true` | Skip high-risk cuts vs flag for review |
| `tighten.max_cut_risk_score` | `0.65` | Risk threshold (0–1 normalized) |
| `tighten.min_filler_confidence` | `0.15` | Min ASR confidence to trust filler token |
| `tighten.inaudible_opt` | `true` | Waveform snap on propose/apply |
| `tighten.crossfade_ms` | `25` | Base fade; adaptive logic may go higher |
| `tighten.breath_handling.enabled` | `true` | Co-remove adjacent breaths |
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
  speaker-matched to another track, or when another dialogue track has words in
  the gap (peer bleed).
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
- Re-proposal (`replace_existing`) regenerates pending acoustic hits and keeps
  ones a human already applied; new proposals that overlap an applied decision
  are skipped (`applied_overlap`).
- Propose summaries report acoustic hits separately (`N acoustic (review)`) and
  count skipped scans and candidates (`acoustic:*` skip reasons such as
  `no_audio`, `peer_speaking`, `breath`, `rejected`, `replaced_pause`).
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

`build` copies the project via `copy_relocated_workspace` (rewrite `workspace_dir`; copies `artifacts/premix.wav` when present so the first preview is not a from-scratch mix). It then runs **`EditService.propose_tighten()`** without apply. That call uses the same **transcript refine gate** as other edit mutations (`_require_refine_clear`): Shot of Truth builds fail until refine status is clear or `analysis.transcript_refine.mode=off`. For each pending `filler:`, `pause:`, `repetition:`, or `restart:` REMOVE that can skip, it writes two short WAVs (±2 s context) via `PlayService.play_pending_preview` (`current` = leave-in, `suggested` = pending-skip splice — **not** the post-`apply` path, so `filler_room_tone_replace` pads/fades are not in Suggested). Suggested is silence-padded to Current duration to avoid a length/file-size unblind. Which of `1.wav` / `2.wav` is the edit is randomized; mapping is only in owner `key.json` next to `listen/` (not inside the listen pack). Listener `manifest.json` is blinded (ids only — no class/verdict/risk). `listen/answers.csv` is the scoring template (`pair_id,prefer,leftover_consonant,notes`). Each key pair stores `join_quality` (`verdict` / `risk`) and an owner-only `audition_context.v2` summary for its timeline play window; failed diagnostics are recorded explicitly as `audition_context_error` and never exposed in the listener manifest. `verdict=pass` is a **gated** cut. Selection shuffles candidates with `--seed` and backfills unsuggestable skips so pair ids stay contiguous (`pair_000`…). Cached `play_cache` windows are reused when `play_pending_preview(..., rerender=False)` (the default).

The context is labeled `project_timeline_metadata_only`: it supplies captions, timing, and render status, but its suggested premix listen references do not describe the edited WAV. `pair_diagnostics` in owner `key.json` analyzes the **rendered** Current and Suggested WAVs directly, recording astats, hum, and waveform PNG paths under owner `diagnostics/pair_NNN/`. Each side has an explicit `file` mapping; per-side failures appear as `error`. The diagnostic images and key stay outside `listen/`. Pair analysis is bounded to exactly those two WAVs, rather than repeating DSP across every dialogue track.

`score` maps `prefer=1|2` through `key.pairs[].edit_file` / `leave_file` (`tie` counts as non-edit). Blank/unknown prefer or leftover cells fail closed. Duplicate `pair_id` rows keep the first. Pass requires **≥90% prefer-edit on gated cuts**, **`gated_n` ≥ `min_gated_n`** (`2` when `--limit` ≥ 2, else `1`), and **zero leftover-consonant fails** (`yes|no` required). The report includes `missing_n`, `pair_count`, `gated_n`, and `n_answers`, plus acceptance rollups by full reason and speaker track with sample, answered/missing, edit-preference, tie, and leftover-failure counts; a rollup counts a pair as answered only when both preference and leftover-consonant responses are valid. In each rollup, `prefer_edit` uses all rows (including incomplete answers counted conservatively as leave-in), while `prefer_edit_answered` uses only rows with both valid cells. Empty gated answers fail closed.

Log the `score` JSON (and which episode / git SHA / tighten config) next to the Shot of Truth session notes. Do not flip `tighten.enabled` until this bar is green on that episode. Cap `--limit` (default 40, max 500).

The `aligned_dialogue` fixture is the automated smoke (`tests/test_golden_ear_harness.py`); it is not a substitute for the owner listen on Shot of Truth.
