# Inaudible cut boundaries

Cut-producing operations run a shared boundary optimizer by default so joins stay smooth: word-safe anchors on dialogue, waveform snapping on all tracks, and micro-fades at clip edges.

Implementation: `edits/inaudible_cuts.py`. Defaults: `.agents/defaults/pipeline.yaml` → `inaudible_cuts`.

This is **not** effect/plugin smoothing — it only moves cut boundaries and fade lengths at timeline joins. Cleanup analysis and FFmpeg presets are separate (see `.agents/skills/podcast-audio-cleanup/SKILL.md` and `analysis.heuristics` in defaults).

## Behavior

- **Dialogue tracks** — anchor to legal transcript word boundaries, then search locally for low-energy / near-zero-cross points. `min_word_margin_ms` prevents snaps from landing too close to retained words.
- **Short filler / NL cuts** (`duration ≤ short_cut_max_sec`) — if the cut end still sits in hot / non-quiet waveform energy (ASR often ends “um” early while the voiced blob continues), extend `end` to the **quietest** RMS hop between the naive end and the start of the next transcript word, capped by `trailing_energy_extend_ms`. This skips shallow local troughs inside a nasal coda. When that window is still hot (filler overlaps the next word’s onset), chew further within the extend budget to clear the blob. Room-tone pacing still inserts `replace_gap_sec`, but does **not** clamp away a trailing-energy extend past the next word’s ASR start.
- **Trailing silence absorb** — after boundary snap, if the next transcript word is within `absorb_trailing_silence_max_sec` and the intervening audio is quiet, extend `end` to `next_word_start − absorb_trailing_silence_retain_sec` (default 0.4s breath). Prevents restart/ripple joins from leaving a double-breath of leftover dead air. Distant next words are skipped so multitrack ripple medians stay safe.
- **Non-dialogue tracks** (music, sfx, intro, outro) — waveform-only snapping; no transcript dependency.
- **Joins** — per-clip `join_in_mode` controls render behavior (see **Fade vs crossfade** below).

## DAW snap overlay

Sharecut Studio paints a **quiet wash** from the loaded peak-pyramid tiles (max-pooled per CSS pixel over the mounted tile range, at 8 px/s and above) and **snap ticks** from `GET /api/waveform-snap` / guest `daw/waveform-snap` (`EditService.waveform_snap_window`). That reuses `preview_inaudible_cut` and windowed `silence_islands_from_hops` — not a second snapper. Blade/trim/pending-edge drag magnets to those ticks (`snap=true` on `UpdatePendingEdit` is the same optimizer). View-only guests get the wash; `suggest`/`edit` get ticks + magnet. Ticks load around the dragged trim edge, else the blade hover inside the clip, else the paused playhead inside it, after an 80 ms debounce; a playing playhead does not fetch ticks. Overlay fetches abort when that focus moves and must not stall pointer or play.

## Fade vs crossfade

Each clip stores `join_in_mode` for how it meets the previous clip on the same track:

| Mode | `join_in_mode` | Render | Timeline cost |
|------|----------------|--------|---------------|
| Fade (default dialogue) | `fade` | Hard concat; per-segment `afade` declick | 0 |
| Crossfade (opt-in overlap) | `crossfade` | FFmpeg `acrossfade` blend | Consumes overlap |
| Hard cut | `cut` | Plain concat, no fades | 0 |

Normal dialogue **ripple** cuts from tighten, NL, and focus set `join_in_mode=fade`. Mute-in-place (`tighten.edit_mode: mute`) does not split clips or change joins — it writes `Clip.mute_regions` and renders silence with ≤5 ms fades (see [filler-cut-quality.md](filler-cut-quality.md) § Mute vs cut).

**When to use which:**

| Situation | Tool / behavior |
|-----------|-----------------|
| Normal dialogue cuts (tighten, focus, ripple, NL) | Automatic — `join_in_mode=fade`; no extra call |
| Cuts still clicky | `fade_joins_tool` / `podcast edit fade-joins` / Sharecut Studio clip inspector |
| Per-clip join mode | `set_join_mode_tool` / Sharecut Studio join control (`fade` \| `crossfade` \| `cut`) |
| Re-render old project / fix multitrack sync | `fade_joins_tool` then `assemble_timeline` |
| Music bed, intro/outro blend, explicit overlap soften | `crossfade_joins_tool` / `podcast edit crossfade-joins` |
| Harsh boundaries from analyze | `recommend_fades_tool` → `apply_fade_recommendations_tool` (fade mode) |

Crossfade curve for overlap mode only: `render.crossfade_curve` (default `tri`).

Future cuts only — existing committed edits are not retroactively re-optimized.

## Covered operations

- Transcript cuts: `cut_time_range`, `cut_text_match`, `cut_utterance`, `cut_words`, `apply_edit_plan`.
- **Filler/pause tighten** — proposals and apply both use waveform optimization when `tighten.inaudible_opt: true` (default). Lexicon membership is in [filler-cut-quality.md](filler-cut-quality.md); discourse markers (`like`, `you know`, …) are demoted there and are not cut from fluent speech.
- Timeline cuts: `ripple_delete`, `ripple_delete_text`, `shorten_gaps`, clip split/rejoin.
- `strip_silence` rebuilds speech islands from silence detection (padding from silence interiors). It does **not** run `optimize_source_cut_range`; `--inaudible-opt` / `use_inaudible_opt` on strip are accepted for API compatibility and ignored. Joins still get micro-fades via `recommend_micro_fades`.

NL editing tools and CLI commands are listed in [nl-editing.md](nl-editing.md).

## Narrative handoffs

The default optimizer is a **local** boundary tool — not a multi-second transition planner:

| Mechanism | Behavior | Wrong for handoffs because… |
|-----------|----------|------------------------------|
| `preview_inaudible_cut` / default opt | Snap within ~`max_shift_ms` + word-safe anchors | Does not search silence islands or plan a beat |
| `absorb_trailing_silence` | Extends cut end through quiet air, **retaining ~0.4s** before the next word | Actively removes the room-tone beat between punchline and closing pivot |
| Word-aligned OUT/IN | OUT at soft-coda start, IN at pivot word start | Can nick quiet “um” blobs; feels abrupt |

**Prefer:** keep about 1s of existing air after the punchline and before the pivot (`keep_left + retain` / `keep_right − retain`, snapped to local quiet), then lock bounds with `use_inaudible_opt=false`.

Helper: `edits/silence_islands.py` → `suggest_handoff_cut` / MCP `suggest_handoff_cut_tool` / CLI `podcast edit suggest-handoff-cut`. Given timeline `keep_left_end` + `keep_right_start`, it places `cut_start` / `cut_end` at the requested beat on each keep (clamped if the gap is shorter) and snaps onto a **measured RMS silence island** on the stem. Transcript word gaps are not silence — um, chair noise, and bleed with no token still block a join if they sit at the retain target. Audible junk *between* the bounds is removed with the ripple. If a bound is still in energy after snap, the suggestion is not ok.

Do **not** loosen global `absorb_trailing_silence_retain_sec` for this — handoffs opt out by locking suggested silence bounds.

Audition ~10–15s around the join before resolving review comments. Prefer existing room tone over `insert_gap` of pure silence unless the user asks.

**Pad source order** when `filler_pad_mode: room_tone`: (1) recorded `track.room_tone` bed from the lobby capture (abutting tiles if the pad is longer than the bed: fade-in on the first tile, fade-out on the last); (2) stolen stem air that is free of own-track words and peer-track speech; (3) skip the pad rather than tiling dialogue, bleed, or digital silence. Default `filler_pad_mode` stays **`silence`**. A near-silent recorded bed (below `room_tone_min_rms_db`) is treated as missing.

## Configuration

| Key | Role |
|-----|------|
| `enabled` | Master switch (default `true`) |
| `search_window_ms` | Local search radius around each boundary |
| `max_shift_ms` | Maximum allowed boundary shift |
| `min_word_margin_ms` | Minimum distance from retained word boundaries after snap |
| `micro_fade_ms` | Default fade length at optimized joins |
| `short_cut_max_sec` | Only apply trailing-energy end extend when cut ≤ this (default `1.2`) |
| `trailing_energy_extend_ms` | Max forward search / chew when end is mid-filler energy (default `350`) |
| `trailing_energy_hot_db` / `trailing_energy_quiet_db` | RMS thresholds for “still speaking” vs quiet enough to stop / skip |
| `absorb_trailing_silence` | Extend cut end through quiet air before the next word (default `true`) |
| `absorb_trailing_silence_retain_sec` | Breath left before the next word (default `0.4`) |
| `absorb_trailing_silence_max_sec` | Only absorb when next word is within this gap (default `2.0`) |
| `absorb_trailing_silence_quiet_db` | Max RMS in the gap to treat as absorbable silence (default `-45`) |
| `weights.energy` / `zero_cross` / `continuity` | Candidate scoring weights |

## CLI

```bash
podcast edit preview-cut --project episode.project.json --track host --start 32.4 --end 34.8
podcast edit suggest-handoff-cut --project ... --track host --keep-left-end 2154.0 --keep-right-start 2167.0
podcast edit join-quality --project ... --track host --join 12.5 --timebase timeline
podcast edit join-sweep --project ...
podcast edit cut-range --project ... --track host --start 32.4 --end 34.8   # optimized by default
podcast edit cut-range --project ... --no-inaudible-opt                    # exact requested boundaries
```

Cut-producing commands that accept `--inaudible-opt` / `--no-inaudible-opt`: `cut-range`, `cut-text`, `cut-utterance`, `ripple-delete`, `shorten-gaps`. (`strip-silence` still accepts the flag for compatibility but ignores it.)

## Join continuity (perceptual splice QA)

Join detection shares one 50 ms tolerance (`JOIN_GAP_TOLERANCE_SEC`) and one
predicate (`clips_abut` / `abutting_pairs` in `edits/clips_ops.py`) across
clip editing, audio audit, and timeline rendering. Gaps at or below the
tolerance are treated as joins; larger gaps remain intentional timeline space.
Render-side consequences (gap closing, crossfade overlap) are in
[filler-cut-quality.md § Render joins](filler-cut-quality.md#render-joins).

FOSS multi-detector join scoring (`edits/join_continuity.py` + paper reimpl in
`edits/join_cost_spectral.py`): click, level, spectral flux, MFCC/LSF/MCA join
costs (Vepa & King), noise floor, F0, onset, bicoherence proxy, late-energy /
RIR proxy. Optional neural layer (`joinqc` extra: NISQA discontinuity + WavLM
continuity) may only elevate risk. Explicit A/B labels → numpy ranker; tighten
gate (`tighten.join_continuity_gate`) skips proposed cuts with verdict `fail`.

Every report includes a disclaimer — not PEAQ/POLQA and not a human-ear guarantee.
Fusion rule of thumb: ≥2 detectors with score ≥ 0.65 → at least `review`.

**Audio for harvest / demos:** use the in-repo short fixture
`tests/fixtures/join_continuity/` (~3 s stems). Do not point tools at huge
external episode trees; copy short clips into that fixture’s `raw/` if needed.
`scripts/harvest_join_labels.py` refuses paths outside the podcast_mcp repo root.

See also [filler-cut-quality.md](filler-cut-quality.md) for gate + re-enable criteria.

## MCP

- `preview_inaudible_cut_tool` — dry-run: shifted boundaries, mode, confidence.
- `suggest_handoff_cut_tool` — retain ~1s on each keep, snap to quiet, for narrative handoffs (timeline clock); prefer with `use_inaudible_opt=false`.
- `join_quality_tool` / `join_qa_sweep_tool` — score one join or sweep non-abutting clip boundaries (default timebase `timeline`).
- `join_label_tool` — record explicit pass/fail A/B labels into `artifacts/join_labels.jsonl`.
- `update_pending_edit_tool` — nudge a pending decision’s source range; `snap=true` (default) runs `optimize_source_cut_range` before save (Sharecut Studio drag/inspector uses the same path via `UpdatePendingEdit`).
- Cut tools accept optional `use_inaudible_opt=false` to skip optimization for one call.

## Skills

- Tighten / NL cuts: `.agents/skills/podcast-tighten-dialogue/SKILL.md`, `.agents/skills/podcast-edit-natural-language/SKILL.md`
- Join QA: `.agents/skills/podcast-inaudible-cuts/SKILL.md`
