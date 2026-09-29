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
flip `tighten.enabled`.

## Policy (from `.agents/defaults/pipeline.yaml`)

- Filler words: um, uh, erm, ah, like, you know, sort of, kind of, etc.
- **Discourse-safe selection** — `like` / `you know` / `sort of` / `kind of` stay
  in the lexicon but are candidates only with an **adjacent** true disfluency or
  immediate repeat, a pause ≥ `tighten.discourse_pause_sec` (~0.35s) on either
  side of the marker span, or ASR confidence < `tighten.discourse_confidence_max`
  (~0.6). Multi-word markers match split ASR tokens (`you`+`know`). Pause and
  low-confidence are escape hatches (a fluent quotative/comparative `like` with
  a flanking pause or low ASR still becomes `filler:like`). Propose summaries
  count those skips as `discourse:{token}` (`N discourse kept`), including
  isolated hits rejected by `min_filler_cluster`. Missing `discourse_markers`
  uses defaults; explicit `[]` disables demotion.
- **Intensity presets** — `tighten.intensity` / `podcast propose-edits --intensity` / MCP `propose_edits(intensity=...)`: `light` = clear um/uh only, keep at least 0.5 s of every pause; `medium` = defaults; `aggressive` = isolated fillers, borderline discourse markers, 0.3 s solo pauses. You may *suggest* a tier (interview → light; solo rambling monologue → aggressive), but the pipeline stays rule-based. Keys the working set / Pipeline tab changed from `pipeline.yaml` win over the tier (editing `pipeline.yaml` itself does not: it is the baseline, and a key set back to exactly the shipped value counts as untouched). `podcast propose-edits` / MCP `propose_edits` do not read the GUI working-set tier (pass `--intensity` / `intensity=` explicitly); MCP `pipeline_run` uses the working set by default, so it does. See [docs/filler-cut-quality.md § Intensity presets](../../../docs/filler-cut-quality.md#intensity-presets).
- **When to cut fillers** — remove **clusters** only (`tighten.min_filler_cluster: 2`, default). Isolated um/uh are left in. Group nearby fillers with `tighten.filler_cluster_gap_sec` (~2s).
- **Repetitions and restarts** — propose local exact word repeats, repeated phrase prefixes (up to four words), and explicitly marked partial-word cut-offs. Complete filler-lexicon phrases stay in the filler path. These hits always require listen-first, individual approval because emphasis or a meaning change can resemble a restart. They remain separate decisions during coalescing. Each cut is hard-bounded to the exact duplicate span the detector found; it never widens onto a neighboring word or the kept repair, and drops rather than proposes when only a harsh join would fit that bound.
- **Acoustic gap fillers (`filler:acoustic`)** — with `tighten.acoustic_gap_filler.enabled` (default true), propose also flags short voiced runs inside ASR word gaps that the transcript missed. These are **review-only and listen-first**: never auto-applied, never coalesced into neighbouring cuts, and bounded to the detected run (no gap-wide pacing pad). Each run is checked for breath using the shared sample-window heuristic relative to short audible windows inside both flanking words; without usable speech context the heuristic abstains and keeps the run for review. Clearly periodic runs also stay reviewable when the heuristic sees low energy; only weakly periodic breath-like runs are rejected. `tighten.acoustic_gap_filler.vad_backend: silero` opts into Silero, which does not need that speech reference and falls back to the heuristic on model or inference failure. The check reads only that candidate run, so another breath in the gap cannot reject it. The detector can still mistake a laugh, cough, or a missed real word for a filler, so audition each one with `play_pending_preview_tool` before `approve_edits_tool`. Flat hum/rumble and gaps where a peer is speaking are skipped; skip reasons, including `acoustic:breath`, appear in `skip_counts`. The audition context raises an `acoustic_gap_filler` hypothesis per pending hit. Tuning and limits: [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Acoustic gap candidates.
- **Voiced edges and interior speech** — every final span is checked against the cut track's own voice. A pause or filler edge that sits inside a kept word's voice (aligned and Whisper word ends both run 120–270 ms early on real tape) is moved past the voice plus 60 ms of air, or, when no in-bounds move frees it, the cut is `review_required` with `:voiced_edge`. A `pause:` span holding 0.1 s or more of voiced audio is speech the transcript missed and is proposed for review as `:interior_speech`, never auto-applied; treat it as a transcript hole (re-transcribe or add the words) rather than a cut to approve. A session-scope cut ripples every dialogue track, so both checks read every decoded dialogue track, not just the cut track: a peer's voice at an edge nudges or flags the cut, a peer's voice inside any session cut is `:interior_speech`, and a pause with 0.1 s of merely audible (unvoiced) material on any rippled track is `:interior_audio` review. Detail: [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Policy.
- **Leave risky cuts in** — `tighten.leave_in_if_risky: true` (default). Low-confidence boundaries, harsh joins, or low ASR filler confidence → skip the cut. See `docs/filler-cut-quality.md`.
- **Join continuity gate** — `tighten.join_continuity_gate: true` skips candidates whose `assess_proposed_cut` verdict is `fail`. Use `join_quality_tool` / `podcast edit join-sweep` to audit splices; each sweep row's `speech` lists voiced speech cut through at that join (the same `speech_crosses_cut` the audition context raises).
- Max pause to cut: ~1.2s between words (`tighten.max_pause_sec`). Retain floor depends on context: ~0.18s when a peer is speaking in the gap (`min_retained_pause_sec`); ~0.55s for solo same-speaker pauses (`min_retained_solo_pause_sec`) so thinking / list-restart air is not crushed.
- **Filler pacing** — `tighten.min_gap_after_filler_sec` (~0.28s). Default `filler_room_tone_replace: true` removes the hesitation between flanking words and inserts a paced pad after apply (`filler_pad_mode: silence` by default; `room_tone` opt-in). Set replace `false` to shrink the cut and keep original air instead. NL cuts use the same policy.
- **Speech-energy guard** — If another dialogue track is speaking in the cut window, do not session-ripple; default punches silence on the filler track only (`speech_energy_guard.on_conflict: track_local`). A `pause` candidate is dropped instead: a track-local punch never ripples, so it can't shorten the timeline. Pause length itself is also measured on the timeline, not raw source-clock word distance, so a gap a ripple already deleted is never re-proposed.
- **Mute vs ripple** — default `tighten.edit_mode: ripple`. `mute` proposes `MUTE` filler hits (pause candidates skipped) and apply writes `Clip.mute_regions` without moving the timeline. See `docs/filler-cut-quality.md` § Mute vs cut.
- **Waveform boundaries** — `tighten.inaudible_opt: true` (default). Proposals snap to low-energy points; apply uses the same optimizer on batch ripple.
- **Per-cut fades** — `recommend_cut_fade_ms` sets each decision's `crossfade_ms` (fade-length hint). Apply sets `join_in_mode=fade` with per-join clip fades capped by `render.join_fade_max_ms` (default 40 ms). Render uses butt splice + `afade`, not overlap.
- **Breath co-removal** — adjacent breath energy is included in filler/pause cuts when detected (`tighten.breath_handling.enabled`, default true). A breath must be unvoiced noise up to the cut edge: a quiet run with clear speech-pitch periodicity, voiced audio between it and the cut, or sibilant energy above 4 kHz is speech and never extends the cut. Detection defaults to an RMS-percentile heuristic; `tighten.breath_handling.vad_backend: silero` opts into Silero-VAD-based detection instead (zero extra install — bundled with `faster-whisper`), with automatic fallback to the heuristic if unavailable. See [docs/audio-engineering.md](../../../docs/audio-engineering.md#silero-vad-breath-detection-opt-in).
- Apply uses **batch ripple** (one-pass clips + transcript) instead of per-cut ripple loops.
- **Parallel analysis + audio cache** — `propose-edits` decodes each track's raw audio once (`edits/audio_cache.py`) instead of spawning `ffmpeg` per tiny window read, gathers candidates per track (including the acoustic gap scan) and analyzes filler, pause, repetition, restart, and acoustic candidates across all tracks concurrently (`performance.max_workers`, default auto), then applies decisions serially in the original order. See [docs/pipeline.md#performance](../../../docs/pipeline.md#performance).

If cuts still sound clicky after tighten: run `fade_joins_tool` or `recommend_fades_tool` (see **podcast-audio-cleanup**).

## Track alignment

Auto-tighten (`propose-edits` → `apply-edits` / pipeline `tighten_from_transcript`) uses **cross-track ripple delete**. When a filler on one speaker is removed, the same session-time window is cut on **all** dialogue tracks so multitrack alignment is preserved. Render then plays clips at their updated timeline positions — do not expect per-track source-time compress without ripple.

## Timeline helpers

- `strip_silence_tool(speaker=…)` — per-track dead air (does not ripple other tracks)
- `shorten_gaps_tool` — ripple-delete excess inter-word pauses on all dialogue tracks
- `ripple_delete_text_tool(query)` — remove a spoken phrase across tracks

## Workflow

Default: **propose → review → approve**. Never bulk-apply on a production episode
without the user signing off.

1. Ensure per-track transcripts exist (`podcast transcribe --project ...`).
2. Clear the transcript refine gate (**podcast-transcript-refine** → `refine-done`) if status is pending.
   **Long raw session?** Do the content cut **first** (off-topic runs, meta talk, dead start) with **podcast-edit-natural-language**, from the end of the episode toward the start. Mid-episode runs (latest first) use `suggest_handoff_cut_tool`, then `ripple_delete_tool(use_inaudible_opt=false)`. `suggest_handoff_cut_tool`'s `retain_sec` / CLI `--retain-sec` defaults to `1.0` per side (~2s of air at the join); a tighter conversational handoff usually wants `0.3`–`0.6`. Cut the dead start last, because it shifts everything after it: `podcast edit ripple-delete --start 0 --end <first kept line − 0.5>` / `ripple_delete_tool`. Every ripple drops words and makes the refine waive stale, so re-clear it before step 3: `podcast transcript refine-waive --project … --reason "content cut: structural edit"` / `transcript_refine_waive_tool`. Proposals then fall only in the kept range; there is no range argument. Reject tighten hits proposed before the cut (`podcast edit reject --ids …`). Order: [docs/pipeline.md § Long raw sessions](../../../docs/pipeline.md#long-raw-sessions-content-cut-before-tighten).
3. Propose (does not apply):

```bash
podcast propose-edits --project episode.project.json
podcast propose-edits --project episode.project.json --intensity light
podcast propose-edits --project episode.project.json --json
```

MCP `propose_edits` returns `{operation, edits, skip_counts, summary}`
(`operation` is `propose_edits`; not a bare array). CLI `propose-edits --json`
prints the same payload (`TightenProposal.to_payload()`); without `--json` it
prints the summary text only. Report `skip_counts`
(`discourse:like`, …) as “N discourse uses kept”, and `filler:acoustic` hits
separately (“N acoustic, review each”).

4. Review each pending decision listen-first:
   - Sharecut Studio **Tighten** tab (host): search/filter filler (incl. `filler:acoustic`), pause, repetition, and restart hits,
     Preview / Skip / Apply one, or Apply eligible with Avoid harsh cuts
     (one `ApproveEdits` batch; skips `review_required` / `:risky` /
     `:join_review`), or
   - `list_edit_decisions_tool` / `podcast edit list --pending` plus
     `play_pending_preview_tool` (Suggested / Current / A/B).
   Entries with `review_required: true` need `approve_edits_tool` before render.
5. Approve **per hit** (`approve_edits_tool` with ids) after the user hears it.
   Use `apply_edits` / `podcast apply-edits` only after explicit sign-off on the
   whole batch — not as the default on a real episode.
   After approving, `render_preview` and run **`audition_context_tool` on every
   applied join** (or one `join_qa_sweep_tool`; **podcast-play-audition** § Ears)
   before export: fix each `speech_crosses_cut` with the `trim_clip_edge_tool` call in
   its `evidence.fix` (`all_tracks=true` on a session-wide cut), and confirm each
   `echo_risk` by listening or from its per-pair evidence before **podcast-mute-bleed**.
6. For NL cuts by topic, use skill **podcast-edit-natural-language**.
7. Do **not** run pipeline from `tighten_from_transcript` on production while
   `tighten.enabled` is false / the golden-ear bar is unmet.
8. Owner golden-ear (Shot of Truth): `make golden-ear ARGS='build --project … --out DIR'` (add `--intensity <tier>` to evaluate a tier) then `score --answers listen/answers.csv` — see [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Golden-ear protocol. Listen under `listen/`; do not open `key.json`. `propose_tighten` is gated by transcript refine (`_require_refine_clear`). Suggested audio is the pending-skip preview, not the post-apply pad/fade path. Not a CI substitute for the owner listen.

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
| Too aggressive, not enough left in | Raise `min_filler_cluster` to `3`; lower `max_cut_risk_score` to `0.5` |
| Too timid, fillers not cut | Lower `min_filler_cluster` to `1`; raise `max_cut_risk_score` to `0.75` |
| Fluent “like” still proposed | Keep `discourse_markers`; raise `discourse_pause_sec` or lower `discourse_confidence_max` |

Always `propose-edits` → listen → approve. For video-linked or “don’t ripple” work, `propose_edits(..., edit_mode="mute")` / `--edit-mode mute`. Do not tune on apply alone.

## Docs

- [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) — selection, risk model, breath handling, pause floor, golden-ear protocol
- [docs/inaudible-cuts.md](../../../docs/inaudible-cuts.md) — boundary optimizer and fade vs crossfade join modes
