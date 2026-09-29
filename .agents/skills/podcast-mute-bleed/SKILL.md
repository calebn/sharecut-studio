---
name: podcast-mute-bleed
description: >-
  After transcript reconcile, reduce independently verified foreign-only audio
  while preserving owner and uncertain speech. Use when transcript bleed is fixed but wrong-mic
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
| `overlap_duplicates_tool` | Confirm transcript bleed is already zero before muting audio |
| `play_audio_tool` | Audition gated vs raw in the bleed window |
| `play_compose_tool` | Hear the two-mic relationship at once (no music / extra mics) |

**CLI:** `podcast edit apply-bleed-mute` (`--dry-run` to preview; `--track` / `--speaker` to scope)

## Workflow

1. Confirm transcript reconcile: `overlap_duplicates_tool` → `text_match_count == 0` on the `echo_risk` pairs (co-speech elsewhere stays, #774).
2. Ensure stems are fresh **and not longer than the session timeline** (`render_dialogue_stems` or `assemble_timeline`). Bleed mute skips stems that fail `stem_is_fresh` (hash or overlong duration).
3. `apply_transcript_gate_tool` with `dry_run=true` — review `attenuation_count` and `gate_reasons` per track; check `skipped` for stale stems. `interval_count` is a compatibility count of retained transcript spans, not a measure of justified acoustic removal.
   If apply fails with "another render of this project is in progress", an export or Refresh holds the render lock: retry when it finishes.
4. Apply on one track or both; audition with `play_compose_tool` (both mics at once) or `play --compare` in the bleed window.
5. Re-run mix/premix after gating (never pad gates to a longer source-length file).

## Design

- The acoustic gate defaults to unity gain. Retained owner words protect connected raw activity; missing transcript words and unresolved audio remain audible. Suppression alone never authorizes acoustic removal. Automatic candidates must be suppressed `bleed` words with another dominant track, independently supported by matching ungated raw audio and an absolute PCM16 residual guard.
- Coarse evidence uses 8 kHz raw media; bounded 48 kHz window reads protect activity outside that evidence band. Automatic verification currently supports mono PCM16 WAV sources at up to 48 kHz. Unavailable or unsupported evidence causes abstention, reported in `gate_reasons`.
- Apply sets `track.transcript_gate = true` and persists `transcript_gate_scope` in project history. Optional `start_sec`/`end_sec` selections map through `SessionTimeline` into source ranges and identities, follow selected media after edits, and survive reopening. Repeated applies rebuild from ungated media; they do not multiply an existing fade.
- The same absolute attenuation envelope drives full and segment renders. Fades lie inside verified foreign regions, so a segment boundary does not introduce a new fade. Source proxies abstain when the lane selects other media than its primary raw source.
- Room coloration and network delays may prevent every candidate from passing verification. A successful apply or enabled flag does not prove useful bleed reduction. Check `attenuation_count`, compare actual audio before/after, and report an unchanged result honestly.
- Do **not** run before reconcile — without suppression metadata, there are no justified automatic candidates.

See [docs/transcript-reconcile.md](../../../docs/transcript-reconcile.md#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed).
