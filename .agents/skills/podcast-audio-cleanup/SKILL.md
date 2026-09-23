---
name: podcast-audio-cleanup
description: >-
  Apply per-track audio cleanup via processing presets: noise reduction, de-ess,
  gate, EQ. Use when the user wants cleaner dialogue before mix or export.
  Analyze whether effects helped or hurt before committing. Not LUFS balancing
  (podcast-balance-levels), vocal compression (podcast-vocal-compression), or
  music beds (podcast-mix-music).
---

# Audio cleanup (processing chains)

## Tools

**Apply effects**
- `add_effect_tool(project_path, speaker=…, preset=…)` — presets: `noise_reduction`, `noise_reduction_rnnoise`, `deess`, `gate`, `eq_presence`, `eq_clarity`, `podcast_standard`
  - Preset definitions live in `effects/presets.py` (`_BUILTIN_PRESETS`); `effects:` in pipeline defaults YAML only adds new presets or overrides one by name (see [audio-engineering.md](../../docs/audio-engineering.md#effect-presets-source-of-truth)).
  - `deess` uses FFmpeg's native `deesser` filter (`intensity`/`frequency` params). For a manual EQ notch instead, use `add_effect_tool(effect="bandreject", params_json='{"f": 6500, "w": 3000}')`.
  - `noise_reduction_rnnoise` uses FFmpeg's `arnndn` filter (a small recurrent-network denoiser); needs a one-time `podcast bootstrap --component rnnoise` to fetch its model. Often a real upgrade over `noise_reduction`/`afftdn` for room noise/HVAC hiss.
- `remove_effect_tool`, `list_effects_tool`
- `set_effect_bypass_tool(project_path, effect_index=…, bypass=…, speaker=…)` — A/B without removing the chain entry (Sharecut Studio Track inspector Bypass toggles use the same path via `SetEffectBypass`)
- `fill_with_room_tone_tool` — fill clip gaps with room tone from the track
- `check_loudness_tool` — measure LUFS on export/premix

**Analyze before/after (heuristics-first)**
- `analyze_cleanup_tool` — full report: gate risk, low-audibility words, bleed flags, fade recommendations, reconciliation staleness, and per-track `health` (astats + hum, see below)
- `audio_diagnostics_tool(project_path, track_id=…, start_sec=…, end_sec=…)` — spectrogram PNG + waveform PNG + `astats` health + mains-hum flag for one track or window. This is the tool to reach for when you need to actually **see** a track (hum, sibilance, room tone, clipping) rather than just read RMS numbers. Full guide: [docs/audio-engineering.md](../../../docs/audio-engineering.md).
- `audibility_map_tool` — per-word RMS across all tracks (bleed + inaudible classification)
- `flagged_words_tool` — words flagged for suppression (inaudible or cross-track bleed)
- `reconciliation_status_tool` — check if transcript reconciliation is stale after audio changes
- `reconcile_transcript_tool` — run reconciliation (flag status, suggest, or apply suppressions per `transcript_mode`)
- `gate_overreach_tool` — syllable clipping / gate too aggressive
- `low_audibility_words_tool` — legacy single-track low-RMS list
- `recommend_fades_tool` — harsh clip joins or gaps needing fade-to-silence
- `apply_fade_recommendations_tool` — apply fade JSON from recommendations
- `fade_joins_tool` — declick butt-splice fades at all abutting joins (default dialogue mode)
- `crossfade_joins_tool` — opt-in overlapping crossfade (music beds, explicit blend)
- `apply_low_audibility_suppression_tool` — targeted suppression by word keys
- `bleed_words_tool` / `apply_bleed_suppression_tool` — bleed-only suppress (not inaudible)
- `overlap_duplicates_tool` — overlapping cross-track word pairs in a time window

**CLI:** `podcast edit analyze-cleanup`, `audio-diagnostics`, `audibility-map`, `flagged-words`, `bleed-words`, `suppress-bleed`, `overlap-duplicates`, `reconciliation-status`, `reconcile-transcript`, `recommend-fades`, `fade-joins`, `crossfade-joins`, `low-audibility`, `suppress-low-audibility`, `gate-overreach`

Progress is automatic on MCP/CLI (relay tool headlines; do not invent status). Spec: [docs/progress.md](../../docs/progress.md). CLI: `--no-progress` to silence or `--json-progress` for automation.

**Cut boundaries:** `docs/inaudible-cuts.md` — `preview-cut` / `preview_inaudible_cut_tool` for dry-run metadata (separate from cleanup effect analysis).

## When to use each effect

| Effect | Use when | Avoid when |
|--------|----------|------------|
| `noise_reduction` | Steady hiss/hum between words — confirm with `audio_diagnostics_tool`'s `hum` field or spectrogram before reaching for this | Already clean studio; risk of dull/underwater tone |
| `noise_reduction_rnnoise` | Room noise/HVAC hiss that `noise_reduction` (`afftdn`) doesn't fully clear | No model bootstrapped yet (`podcast bootstrap --component rnnoise` first) |
| `deess` | Harsh sibilance on host/guest (visible as dense 4-9kHz energy on the spectrogram) | No sibilance problem; can hollow out presence |
| `gate` | Constant room noise between sentences | Quiet speakers, soft consonants, or gate after compression |
| `eq_clarity` / `eq_presence` | Muddy or dull dialogue | Already bright; stacking EQ with heavy denoise |
| Boundary fades | Cut joins click or level jumps | Overlap crossfade already matches intent |

**Typical order:** denoise → EQ → (optional gate) → compression → master. Gate **before** compression, not after.

## How to tell if processing helped or hurt

1. Run `render_preview` — reconciliation runs automatically by default (`reconcile_on_render: true`). Check `reconciliation_status_tool` only if stems may be stale; use `analyze_cleanup_tool` for a full report (processed stems in `artifacts/tracks/`).
2. **Gate overreach signs:** missing word starts (“ello”), chopped endings, pumping between words. Fix: lower threshold, increase hold (~80–120 ms) and release (~200–400 ms).
3. **Denoise hurt signs:** underwater/metallic voice, loss of air. Fix: lighter `noise_reduction` or remove preset.
4. **Boundary issues:** clicks or level jumps at edits. Fix: `fade_joins_tool` or `recommend_fades_tool` → `apply_fade_recommendations_tool`. Use `crossfade_joins_tool` only when overlap blend is intended (music, explicit user request).
   - Global cut optimizer is already active; override boundaries only when timing intent is stricter than smoothness.
5. **Bleed / low audibility:** use `bleed_words_tool` + `apply_bleed_suppression_tool` for overlap duplicates (transcript-only). Use `flagged_words_tool` / `reconcile_transcript_tool` for inaudible+bleed together. If the aligned premix sounds fine, do not chase acoustic bleed removal — reconciliation fixes text attribution only.
   - If `analyze_cleanup_tool` reports `high_bleed_warning` (bleed words are a large share of a track, default threshold 20%), transcript suppression alone won't remove it from the audio — see **podcast-mute-bleed** to gate stems acoustically.
6. Audition: `play_audio_tool` with `processed:<track>` vs `track:<track>` on flagged ranges.

## Confidence model

- **Default:** heuristics in `.agents/defaults/pipeline.yaml` → `analysis.heuristics`
- **Optional:** `analysis.ml_backend` (off by default) for future non-intrusive quality scoring
- **Objective health stats:** `measure_astats`/`detect_mains_hum` (both FFmpeg/numpy-based, no ML) back the `health` block in `analyze_cleanup_tool` and `audio_diagnostics_tool` — use these numbers, not just listening, to justify a recommendation. Details: [docs/audio-engineering.md](../../../docs/audio-engineering.md).
- Suppression runs automatically with default `transcript_mode: reconcile`; use `--dry-run` to preview. Targeted bleed-only: `apply_bleed_suppression_tool` or `apply_low_audibility_suppression_tool`

## NL examples

- “Is the gate too strong on the guest?” → `gate_overreach_tool(speaker="guest")`
- “Check cleanup on the whole episode” → `analyze_cleanup_tool`
- “Fix harsh cuts” → `fade_joins_tool` or `recommend_fades_tool` → `apply_fade_recommendations_tool`
- “Add noise reduction to the guest” → `add_effect_tool(speaker="guest", preset="noise_reduction")`

Re-render with `render_preview` after chain changes.
