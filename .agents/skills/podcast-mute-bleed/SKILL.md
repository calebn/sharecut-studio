---
name: podcast-mute-bleed
description: >-
  After transcript reconcile, gate dialogue stems to non-suppressed word intervals
  so bleed is muted acoustically. Use when transcript bleed is fixed but wrong-mic
  audio is still audible in stems or premix — not for changing suppression flags
  (podcast-transcript-reconcile).
---

# Mute bleed (transcript-gated stems)

**Prerequisite:** [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md) — `overlap_duplicates_tool` → `text_match_count == 0` on the pairs `echo_risk` names and combined transcript is clean. Identical words on a pair with no measured path, and words on a one-way pair whose onsets do not fit the measured lag, are two people talking and stay after reconcile (#774); they do not block this skill.

This skill applies **waveform** gating derived from reconciled transcript metadata. It does not change word text or suppression flags.

## When to use

- `audition_context_tool` / `podcast play context` reports **`echo_risk`**: one mic carries another speaker's voice at one consistent lag far more often than the same pair time-shifted (evidence names `source_track_id`, `bleed_track_id`, `lag_ms`, `level_db`, `consistent_rate` against `null_consistent_rate`, `examples`). Suppressing the bleed words in the transcript does not remove that doubled voice from the mix; this skill does. Reconcile already used the same measurement to keep the source mic's words and drop the bleed mic's copies on that pair (`reason: echo_twin`), so the gate below mutes audio the transcript no longer claims. The transcript-side lag can differ from `lag_ms`: on the lab's Zoom host track the copy lands ~150 ms *before* the co-host's own network-delayed track. **Confirm before gating**: listen with the `suggested_listen` compose entry at the strongest example, or check the per-pair evidence (a real same-room path is several times its null; a remote participant has none). Only then gate the `bleed_track_id` stem. Never gate a track on the code alone.
- Transcript search/NL edits are clean but `play --compare` still shows bleed on the wrong mic.
- Pass-1 or post-FX stems exist under `artifacts/tracks/`.
- Reconcile has run and `suppressed` words mark bleed on the off-mic track.
- `analyze_cleanup_tool` reports `high_bleed_warning` on a track (`bleed_ratio` ≥ `analysis.heuristics.bleed_ratio_warn_threshold`, default `0.2`) — this is a strong signal the session has genuine multi-mic bleed (not isolated crosstalk), where transcript suppression alone leaves the wrong-mic audio audible. If the off-mic capture is *louder* than the direct mic on flagged words (compare `own_rms_db` vs the dominant track's RMS in `audibility_map_tool`), also flag mic gain-staging/placement to the user for future recordings — that's a source-side problem this workflow can't fully fix, only mask.

## Tools

| Tool | Use |
|------|-----|
| `apply_transcript_gate_tool` | Dry-run shows per-track interval counts; apply sets `transcript_gate` + rewrites stems (windowed when start/end given) |
| `overlap_duplicates_tool` | Confirm transcript bleed is already zero before muting audio |
| `play_audio_tool` | Audition gated vs raw in the bleed window |
| `play_compose_tool` | Hear the two-mic relationship at once (no music / extra mics) |

**CLI:** `podcast edit apply-bleed-mute` (`--dry-run` to preview; `--track` / `--speaker` to scope)

## Workflow

1. Confirm transcript reconcile: `overlap_duplicates_tool` → `text_match_count == 0` on the `echo_risk` pairs (co-speech elsewhere stays, #774).
2. Ensure stems are fresh **and not longer than the session timeline** (`render_dialogue_stems` or `assemble_timeline`). Bleed mute skips stems that fail `stem_is_fresh` (hash or overlong duration).
3. `apply_transcript_gate_tool` with `dry_run=true` — review `interval_count` per track; check `skipped` for stale stems.
   If apply fails with "another render of this project is in progress", an export or Refresh holds the render lock: retry when it finishes.
4. Apply on one track or both; audition with `play_compose_tool` (both mics at once) or `play --compare` in the bleed window.
5. Re-run mix/premix after gating (never pad gates to a longer source-length file).

## Design

- Gating uses `word_intervals`, which maps each non-suppressed word's **source-media span through `SessionTimeline` to timeline seconds** before gating the (timeline-clock) stem. Only **non-suppressed** words stay audible on each track. This is why gated intervals land correctly even after upstream cuts compress the timeline — the mute windows are the mapped positions, not raw word times.
- Apply sets `track.transcript_gate = true` (snapshotted in history). Stem WAVs are rewritten for immediate mix use; undo clears the flag and segment/`--rerender` play rebuilds ungated audio. `play_ab` across before/after history indices therefore differs.
- Optional `start_sec`/`end_sec` mute only that timeline window; audio outside the window is left unchanged.
- Do **not** run before reconcile — without suppression metadata, gating would be wrong.

See [docs/transcript-reconcile.md](../../docs/transcript-reconcile.md#acoustic-follow-up-mute-when-not-talking).
