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
- **Repetitions and restarts** — propose local exact word repeats, repeated phrase prefixes (up to four words), and explicitly marked partial-word cut-offs. Complete filler-lexicon phrases stay in the filler path. These hits always require listen-first, individual approval because emphasis or a meaning change can resemble a restart. They remain separate decisions during coalescing.
- **Acoustic gap fillers (`filler:acoustic`)** — with `tighten.acoustic_gap_filler.enabled` (default true), propose also flags short voiced runs inside ASR word gaps that the transcript missed. These are **review-only and listen-first**: never auto-applied, never coalesced into neighbouring cuts, and bounded to the detected run (no gap-wide pacing pad). The detector can mistake a breath, laugh, cough, or a missed real word for a filler, so audition each one with `play_pending_preview_tool` before `approve_edits_tool`. Flat hum/rumble and gaps where a peer is speaking are skipped; skip reasons appear as `acoustic:*` in `skip_counts`. The audition context raises an `acoustic_gap_filler` hypothesis per pending hit. Tuning and limits: [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Acoustic gap candidates.
- **Leave risky cuts in** — `tighten.leave_in_if_risky: true` (default). Low-confidence boundaries, harsh joins, or low ASR filler confidence → skip the cut. See `docs/filler-cut-quality.md`.
- **Join continuity gate** — `tighten.join_continuity_gate: true` skips candidates whose `assess_proposed_cut` verdict is `fail`. Use `join_quality_tool` / `podcast edit join-sweep` to audit splices.
- Max pause to cut: ~1.2s between words (`tighten.max_pause_sec`). Retain floor depends on context: ~0.18s when a peer is speaking in the gap (`min_retained_pause_sec`); ~0.55s for solo same-speaker pauses (`min_retained_solo_pause_sec`) so thinking / list-restart air is not crushed.
- **Filler pacing** — `tighten.min_gap_after_filler_sec` (~0.28s). Default `filler_room_tone_replace: true` removes the hesitation between flanking words and inserts a paced pad after apply (`filler_pad_mode: silence` by default; `room_tone` opt-in). Set replace `false` to shrink the cut and keep original air instead. NL cuts use the same policy.
- **Speech-energy guard** — If another dialogue track is speaking in the cut window, do not session-ripple; default punches silence on the filler track only (`speech_energy_guard.on_conflict: track_local`).
- **Mute vs ripple** — default `tighten.edit_mode: ripple`. `mute` proposes `MUTE` filler hits (pause candidates skipped) and apply writes `Clip.mute_regions` without moving the timeline. See `docs/filler-cut-quality.md` § Mute vs cut.
- **Waveform boundaries** — `tighten.inaudible_opt: true` (default). Proposals snap to low-energy points; apply uses the same optimizer on batch ripple.
- **Per-cut fades** — `recommend_cut_fade_ms` sets each decision's `crossfade_ms` (fade-length hint). Apply sets `join_in_mode=fade` with per-join clip fades capped by `render.join_fade_max_ms` (default 40 ms). Render uses butt splice + `afade`, not overlap.
- **Breath co-removal** — adjacent breath energy is included in filler/pause cuts when detected (`tighten.breath_handling.enabled`, default true). Detection defaults to an RMS-percentile heuristic; `tighten.breath_handling.vad_backend: silero` opts into Silero-VAD-based detection instead (zero extra install — bundled with `faster-whisper`), with automatic fallback to the heuristic if unavailable. See [docs/audio-engineering.md](../../../docs/audio-engineering.md#silero-vad-breath-detection-opt-in).
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
3. Propose (does not apply):

```bash
podcast propose-edits --project episode.project.json
podcast propose-edits --project episode.project.json --intensity light
```

MCP `propose_edits` returns `{operation, edits, skip_counts, summary}`
(`operation` is `propose_edits`; not a bare array). Report `skip_counts`
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
6. For NL cuts by topic, use skill **podcast-edit-natural-language**.
7. Do **not** run pipeline from `tighten_from_transcript` on production while
   `tighten.enabled` is false / the golden-ear bar is unmet.
8. Owner golden-ear (Shot of Truth): `make golden-ear ARGS='build --project … --out DIR'` (add `--intensity <tier>` to evaluate a tier) then `score --answers listen/answers.csv` — see [docs/filler-cut-quality.md](../../../docs/filler-cut-quality.md) § Golden-ear protocol. Listen under `listen/`; do not open `key.json`. `propose_tighten` is gated by transcript refine (`_require_refine_clear`). Suggested audio is the pending-skip preview, not the post-apply pad/fade path. Not a CI substitute for the owner listen.

## Undo

Tightening changes are non-destructive. Snapshots are taken before `propose-edits`. Use `podcast undo` or MCP `history_undo` to revert edit decisions; re-render from `assemble_timeline` afterward.

## Rules for agents

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
