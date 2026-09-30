---
name: podcast-mute-bleed
description: >-
  After transcript reconcile, reduce independently verified foreign-only audio
  while preserving overlapping owner speech and uncertain audio, with local retained-bleed alignment. Use when transcript bleed is fixed but wrong-mic
  audio is still audible in stems or premix — not for changing suppression flags
  (podcast-transcript-reconcile).
---

# Mute bleed (transcript-gated stems)

**Prerequisite:** [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md) — `overlap_duplicates_tool` → `text_match_count == 0` on the pairs `echo_risk` names and combined transcript is clean. Identical words on a pair with no measured path, and words on a one-way pair whose onsets do not fit the measured lag, are two people talking and stay after reconcile (#774); they do not block this skill.

This skill applies **waveform** gating derived from reconciled transcript metadata. It does not change word text or suppression flags.

Reconcile can measure bleed from mapped raw media when stems are absent. Applying this skill still requires fresh rendered stems.

## When to use

- `audition_context_tool` / `podcast play context` reports **`echo_risk`**: one mic carries another speaker at a consistent lag above the same pair's time-shifted null. Reconcile may already tag those copies as suppressed `bleed`, but this acoustic operation verifies candidates independently from ungated selected media. A measured pair is a reason to inspect the gate preview, not permission to mute every untranscribed sample. Confirm the named relationship with `suggested_listen` or per-pair evidence, then inspect `attenuation_count` and `gate_reasons`. Network delays and room coloration may prevent the conservative verifier from removing any audio.
- Transcript search/NL edits are clean but `play --compare` still shows bleed on the wrong mic.
- Pass-1 or post-FX stems exist under `artifacts/tracks/`.
- Reconcile has run and `suppressed` words mark bleed on the off-mic track.
- `analyze_cleanup_tool` reports `high_bleed_warning` on a track (`bleed_ratio` ≥ `analysis.heuristics.bleed_ratio_warn_threshold`, default `0.2`) — this is a strong signal the session has genuine multi-mic bleed (not isolated crosstalk), where transcript suppression alone leaves the wrong-mic audio audible. If the off-mic capture is *louder* than the direct mic on flagged words (compare `own_rms_db` vs the dominant track's RMS in `audibility_map_tool`), also flag mic gain-staging/placement to the user for future recordings — that's a source-side problem this workflow can't fully fix, only mask.

## Tools

| Tool | Use |
|------|-----|
| `apply_transcript_gate_tool` | Dry-run shows per-track interval counts; apply sets `transcript_gate` + rewrites stems (windowed when start/end given) |
| `align_retained_bleed_tool` | Preview or apply supported local corrections for retained bleed; select the bleed lane and timeline window |
| `set_retained_bleed_alignment_mode_tool` | Persist manual/declined timing decisions, including preview proposals; auto resets a decision |
| `overlap_duplicates_tool` | Confirm transcript bleed is already zero before muting audio |
| `play_audio_tool` | Audition gated vs raw in the bleed window |
| `play_compose_tool` | Hear the two-mic relationship at once (no music / extra mics) |

**CLI:** `podcast edit apply-bleed-mute` (`--dry-run` to preview; `--track` / `--speaker` to scope)

## Workflow

1. Confirm transcript reconcile: `overlap_duplicates_tool` → `text_match_count == 0` on the `echo_risk` pairs (co-speech elsewhere stays, #774).
2. Ensure stems are fresh **and not longer than the session timeline** (`render_dialogue_stems` or `assemble_timeline`). Bleed mute skips stems that fail `stem_is_fresh` (hash or overlong duration).
3. `apply_transcript_gate_tool` with `dry_run=true` — review `attenuation_count` and `gate_reasons` per track; check `skipped` for stale stems. `interval_count` is a compatibility count of retained transcript spans, not a measure of justified acoustic removal.
   If apply fails with "another render of this project is in progress", an export or Refresh holds the render lock: retry when it finishes.
4. Inspect the default `alignment` preview. Preserve both speakers during overlap. Only supported complete direct phrases move; uncertain mixed audio stays intact. Unsupported regions remain in `skipped`. Do not describe them as aligned. Save a different user choice with `set_retained_bleed_alignment_mode_tool`, using the proposal's decision ID and the same window. Saved manual/declined choices survive reopening and take priority. Saved choices also follow the same recording when a track move pins it to an equivalent source reference. Manual recorder locks survive splitting and trimming the same recording; a scoped override leaves other fragments protected; `auto` releases the saved timing hold for future planning; it does not undo an applied move. An explicit scoped `override_placement_lock` permits correction past a legacy recorder lock but does not override a saved choice.
5. Apply on one track or both; audition with `play_compose_tool` (both mics at once) or `play --compare` in the bleed window.
6. Re-run mix/premix after gating (never pad gates to a longer source-length file).

## Design

- The acoustic gate defaults to unity gain. Retained owner words protect connected raw activity; missing transcript words and unresolved audio remain audible. Suppression alone never authorizes acoustic removal. Automatic candidates must be suppressed `bleed` words with another dominant track, independently supported by matching ungated raw audio and an absolute PCM16 residual guard.
- Coarse evidence uses 8 kHz raw media; bounded 48 kHz window reads verify the proposed copy residual across the wider band; they do not independently detect owner activity. Automatic verification currently supports mono PCM16 WAV sources at up to 48 kHz. Unavailable or unsupported evidence causes abstention, reported in `gate_reasons`.
- Apply sets `track.transcript_gate = true` and persists `transcript_gate_scope` in project history. Optional `start_sec`/`end_sec` selections map through `SessionTimeline` into source ranges and identities, follow selected media after edits, and survive reopening. Repeated applies rebuild from ungated media; they do not multiply an existing fade.
- The same absolute attenuation envelope drives full and segment renders. Fades lie inside verified foreign regions, so a segment boundary does not introduce a new fade. Source proxies abstain when the lane selects other media than its primary raw source.
- Crossfade layouts abstain from gate reconstruction and alignment when raw placements and rendered clocks can diverge. Inspect their explicit skip reason.
- Local correction uses each clip's selected recording and its matching transcript, including secondary recordings. Missing direct phrase evidence, implicit timelines without editable clips, and conflicting correction footprints produce explicit unresolved reasons. Delay measurement reads bounded local context for lag and shifted-null checks, rather than whole recordings.
- Batch corrections preserve every measured reference region. Interacting moves abstain, including reciprocal and secondary-reference dependencies. Duplicate seeds expanding into the same complete phrase produce one correction. Unsupported measured interior probes block whole-phrase approval.
- Local correction requires independent, consistent delay probes and quiet phrase boundaries. It never shifts a whole track to resolve one section or stretches voiced audio. Sampled residual agreement does not prove samplewise perfect alignment or a unique room path.
- Room coloration and network delays may prevent every candidate from passing verification. A successful apply or enabled flag does not prove useful bleed reduction. Check `attenuation_count`, compare actual audio before/after, and report an unchanged result honestly.
- Do **not** run before reconcile — without suppression metadata, there are no justified automatic candidates.

See [docs/transcript-reconcile.md](../../../docs/transcript-reconcile.md#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed).
