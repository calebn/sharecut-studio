---
name: podcast-transcript-reconcile
description: >-
  Align per-track transcripts with audible audio: cross-track bleed detection,
  inaudibility gating, staleness, reconciliation after FX/gain/mute/render.
  Use when bleed words appear on the wrong track, after cleanup, or when
  transcript and rendered audio may have drifted. Flags text only — for acoustic
  stem gating after bleed is fixed use podcast-mute-bleed. Hub: podcast-transcript-workflow.
---

# Transcript reconciliation

Hub: [podcast-transcript-workflow](../podcast-transcript-workflow/SKILL.md). This skill is **layer 1 (acoustic)** — suppress bleed/inaudible metadata only; **no text fixes**.

**Pipeline:** `reconcile_transcript` runs twice in full pipeline — after `render_dialogue_stems` (pass 1) and after `assemble_timeline` (pass 2, post-FX). If stems are absent on a first pass, audibility and directed bleed-path analysis use raw media projected through `SessionTimeline`; each clip uses its selected source file on its current lane, and any unavailable selected file or required samples invalidate the whole lane cache.

The transcript is a **derived view** of audio. Reconciliation measures word-level RMS on every dialogue track and updates suppression metadata — it never modifies waveforms or word text.

**Guards:** words longer than `analysis.heuristics.max_word_audibility_sec` (default 2 s) are `deferred` (ASR stretch — do not mean-RMS or text-match suppress). Zero-duration words between normal neighbors stay in the combined transcript (`sandwiched_zero_duration_word`).

## Tools

| Tool | Use |
|------|-----|
| `audibility_map_tool` | Read-only per-word classification: audible, inaudible, bleed |
| `flagged_words_tool` | Words that would be suppressed (inaudible or bleed) |
| `reconciliation_status_tool` | Is reconciliation stale after audio changes? |
| `reconcile_transcript_tool` | Run reconciliation; behavior set by `analysis.transcript_mode` in pipeline defaults |
| `bleed_words_tool` | Bleed-tagged words only (acoustic dominance) |
| `apply_bleed_suppression_tool` | Suppress bleed on wrong track; optional time range and exclude word keys |
| `overlap_duplicates_tool` | Read-only overlapping word pairs with text-match hints |
| `apply_transcript_gate_tool` | Gate stems to non-suppressed words (acoustic follow-up; see podcast-mute-bleed) |
| `analyze_cleanup_tool` | Includes flagged/bleed counts and staleness in full cleanup report |

**CLI:** `podcast edit audibility-map`, `flagged-words`, `bleed-words`, `suppress-bleed`, `overlap-duplicates`, `reconciliation-status`, `reconcile-transcript` (applies by default; `--dry-run` to preview), `apply-bleed-mute`

Progress is automatic on MCP/CLI (relay tool headlines; do not invent status). Spec: [docs/progress.md](../../docs/progress.md); CLI `--json-progress`: [docs/cli-progress.md](../../docs/cli-progress.md).

## transcript_mode policy

| Mode | Behavior |
|------|----------|
| `off` | No audibility analysis |
| `reconcile` (default) | Update audibility metadata, suppress inaudible/bleed words, rebuild combined |
| `flag` | Update `audibility_status` on words; do not suppress |
| `suggest` | Like flag; `analyze_cleanup` includes suppression word keys |

## User decisions survive reconcile (#768/#781)

`set_word_suppressed_tool`, an applied `apply_bleed_suppression_tool` / `suppress-bleed` with an explicit word list, and `apply_low_audibility_suppression_tool` with an explicit word list mark the word `audibility_locked: true` alongside `suppressed` — naming the words is a decision, not a heuristic pick, so only the explicit-list form locks. Every reconcile pass — acoustic and text-match, pass 1 and pass 2 — skips a locked word entirely, the same way it already skips `ignored` words, so a later re-render or manual reconcile can't flip a person's or agent's explicit call back. Speaker attribution (`run_speaker_attribution`, the home-speaker gate) is an automatic writer too: it routes its `suppressed` decision through `TranscriptWord.resolve_auto_suppression`, so it can't flip a locked word either. See [docs/episode-format-v2.md](../../docs/episode-format-v2.md) for the field.

## Automatic sync (default)

Reconciliation runs **without a separate tool call** when:

- **`render_preview`** completes (`reconcile_on_render: true` by default)
- **`run_mutation`** changes audio state and rendered stems are already fresh for affected tracks
- **Full pipeline** reaches the `reconcile_transcript` step after `assemble_timeline`

Default `transcript_mode: reconcile` applies suppressions automatically (history/undo safe). Use `--dry-run` on CLI tools to preview first.

## When to run manually

1. **After transcript cleanup** — triage bleed on raw audio before FX (`audibility_map_tool` on both tracks).
2. **Stems stale** — `reconciliation_status_tool` reports stale after FX/edits before render; run `render_preview` or `reconcile_transcript_tool`.
3. **Preview only** — `reconcile_transcript_tool` with `dry_run=true` or `transcript_mode: flag` when tagging without suppress.
4. **Before export** — confirm `reconciliation_status_tool` is fresh; re-run if needed.

## Bleed detection (operational)

Bleed requires the **other track's RMS to exceed own-track RMS by ≥ `bleed_dominance_db`** (default **6.0 dB**) while the dominant track is above **`bleed_min_other_rms_db`** (−50 dB), **and a measured bleed path from that track into this one** (the `echo_risk` pairs, next paragraphs; #774). This is acoustic dominance — ASR text need not match. On a pair with no measured path a quieter word is two people talking and keeps its own audibility (`audible`, or `inaudible` below the floor); `audibility_map_tool` still shows every mic's level in `track_rms_db`. On the lab tape that restored caleb "hello" / "Stay" / "I", audra "She's" / "Keep", and lana's words under caleb: all own speech by pitch and spectrogram.

**Zero-duration ASR junk** (`start == end` / sub-5ms) cannot be RMS-measured and is tagged `inaudible` (`reason: zero_duration_word`) so reconcile suppresses it out of `combined.json`. If ghost fragments like `much, Victoria` remain after a prior reconcile, re-run `reconcile_transcript_tool` (or scoped CLI) after this classification is available.

**Identical overlap text:** only on a mic pair with a measured bleed path (next paragraph). When both tracks of such a pair transcribe the same word in an overlap window but dominance is below threshold, reconcile also suppresses the loser via `bleed_text_match_enabled`, except when either word exceeds `max_word_audibility_sec`; on a pair with bleed both ways the winner is audibility + confidence + RMS. The loser verdict overrides the acoustic verdict for that word, so the two never fight: a repeat reconcile on an unchanged project reports `0 suppressed, 0 unsuppressed, 0 reattributed, 0 status updates` (#782); non-zero counts on a re-run mean audio, text, or clips changed. A `track_id` / `start_sec` / `end_sec` scope bounds only what the pass writes: it judges every identical-text pair by the partner's computed target even when the partner is out of scope, so alternating full and scoped passes (per-track auto-reconcile after an edit, then a pipeline or render pass) also reports 0 after the first pass (#805). Pairs are judged independently, so a loser to a word that itself loses is still a loser; on a three-way chain the first two copies are suppressed and the last kept. **Success gate:** `text_match_count == 0` after reconcile on bleed pairs (stretched ASR pairs may remain, and so may co-speech on a one-way bleed pair, next paragraph); identical words on a pair with no measured path are two people and both stay (#774: the lab's three-person "Bye." with the remote participant).

**Bleed pairs (#774):** reconcile first runs the `echo_risk` measurement (the one `audition_context_tool` reports) on the timeline-clock audio in its cache. It uses stems when available and mapped raw media when stems are absent. On a pair with a measured one-way bleed path the loudness rule is off: the bleed mic's word with the same text as a source-mic word, starting at the path's lag (estimated from the identical-text twins themselves; −150 ms on the lab's Zoom host track, whose copies arrive *before* the co-host's network-delayed own track) ± 150 ms, is the copy and loses with `reason: echo_twin`, overlap or not. A source word the acoustic verdict already suppresses anchors no copy, so the word keeps one place in the transcript. Identical words at any other spacing are two people talking (a shared sign-off) and both stay, so `text_match_count` can stay above zero on such a pair after a clean reconcile. A pair flagged both ways keeps the loudness rule; a pair with no measured path gets no text-match suppression. Detail: [docs/transcript-reconcile.md § Bleed pairs](../../docs/transcript-reconcile.md#bleed-pairs-the-source-wins-by-lag-not-by-loudness-774).

**Preview matches apply (#791):** `dry_run=true` computes the same per-word target an apply would write, text-match override included, so it never previews an unsuppress the apply won't make. `flag`/`suggest` mode tags a text-match loser's `audibility_status`/`dominant_track` as `bleed`/the winner's track without suppressing it — the tag reflects the real target even though the word stays in the combined transcript.

**If bleed count is zero during known cross-talk:**

0. Check `audition_context_tool` → `echo_risk` for the pair: with no measured path in that direction nothing is tagged `bleed`, whatever the dominance (#774).
1. Measure dominance at the overlap (guest RMS − host RMS must clear 6 dB).
2. Render fresh stems when possible (`assemble_timeline` / `render_preview`). Without stems, reconcile measures from raw media projected through `SessionTimeline`; clear stale `artifacts/` after raw WAV changes.
3. Audition both tracks before lowering heuristics.

**Validated synthetic recipe** (see `tests/fixtures/synthetic_bleed_60s/`): duck host −30 dB in bleed window + inject guest into host at −10 dB. Regenerate: `python3 scripts/build_synthetic_bleed_fixture.py`.

Full tuning guide: [docs/transcript-reconcile.md](../../docs/transcript-reconcile.md). Manual listen-through: [docs/e2e-fixture-manual.md](../../docs/e2e-fixture-manual.md#bleed-debugging) or `./scripts/run_bleed_debug_battery.sh`.

**E2e note:** `aligned_dialogue` uses `transcript_mode: flag` (no suppressions). Bleed fixtures use `reconcile` via `synthetic_bleed_e2e_pipeline.yaml`.

## Bleed workflow

1. `bleed_words_tool` or `audibility_map_tool` on the affected track; optional `--start` / `--end` time scope.
2. `overlap_duplicates_tool` for overlapping pairs with text-match hints (read-only).
3. Audition ambiguous spans with `play_compose_tool` (both mics at once) or `play_audio_tool` solos — keep real speech on the off-mic track when dominance mis-tags it.
4. `apply_bleed_suppression_tool` (applies by default; bleed-only, not inaudible). Use `dry_run=true` to preview. `exclude_words_json` for keep-words; scope with `start_sec` / `end_sec`.
5. Re-attribution: bleed on track A dominant on track B → suppress on A only (B already has Whisper output).

**When premix sounds fine:** leave audio unchanged; fix transcript metadata only. Gates trim silence between words, not speech-overlap bleed.

## Transcript first, audio second

Reconcile fixes **transcript metadata** (`suppressed`, combined rebuild). Wrong-mic bleed may still be audible on stems until you run **[podcast-mute-bleed](../podcast-mute-bleed/SKILL.md)** (`apply_transcript_gate_tool` / `apply-bleed-mute`) after `text_match_count == 0`.

See [docs/transcript-reconcile.md](../../docs/transcript-reconcile.md) and [docs/architecture.md](../../docs/architecture.md).
