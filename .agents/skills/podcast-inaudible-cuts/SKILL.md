---
name: podcast-inaudible-cuts
description: >-
  Default cut-boundary optimizer: local word-safe / waveform snap (~±80ms) and
  ~0.4s trailing-silence absorb, plus join QA. Use when cutting, tightening,
  ripple-deleting, or debugging clicky joins. Not a multi-second transition
  planner — for leave-a-beat / clean-up-the-transition / punchline-to-pivot use
  suggest_handoff_cut_tool and lock bounds with use_inaudible_opt=false
  (see Narrative handoffs in this skill and podcast-edit-natural-language).
---

# Inaudible cut boundaries

Cuts are optimized by default. Read **`docs/inaudible-cuts.md`** for behavior, config keys, and overrides. Mute-in-place tighten (`tighten.edit_mode: mute`) does not ripple — see **podcast-tighten-dialogue**.

## When to use

- Any cut, tighten, ripple delete, or shorten-gaps workflow (not `strip_silence` — islands stay as-is; its `use_inaudible_opt` flag is ignored)
- User hears clicks or harsh joins after edits, or a word that starts or ends chopped (`speech_crosses_cut` from `play context` / a `speech` row from `join-sweep`)
- Need exact boundaries for debugging (opt out per call)
- Clean up a transition / leave a beat / punchline→pivot — use Narrative handoffs below (not default absorb alone)

## MCP

- `preview_inaudible_cut_tool` — dry-run boundary shift, mode, confidence
- `suggest_handoff_cut_tool` — silence-island OUT/IN for narrative handoffs (timeline clock); returns `use_inaudible_opt: false`
- `join_quality_tool` / `join_qa_sweep_tool` — perceptual splice risk (pass/review/fail) scored on the two clip edges the render abuts, at every edge placement within ±3 ms (`join_continuity.edge_tolerance_ms`); the riskiest placement decides and the reason `worst edge placement +0/+3 ms` names it, so a few-ms nudge cannot flip a verdict and re-running a check gives the same answer; each sweep row carries `speech` (voiced speech cut through at the join: `clipped_onset` / `clipped_tail`, `removed_ms`, `suggested_source_sec`); not a human-ear guarantee
- `audition_context_tool` — `speech_crosses_cut` for every splice in a window (the same measurement, with the transcript words either side and `asr_disagrees`), plus `echo_risk`; see **podcast-play-audition** § Ears
- `trim_clip_edge_tool` — move the flagged clip edge to its `suggested_source_sec` (in-point back to restore a clipped onset, out-point forward for a clipped tail); later clips ripple
- `join_label_tool` — record explicit A/B pass/fail labels for the join ranker
- Cut tools: optional `use_inaudible_opt=false` to skip optimization once

## CLI

```bash
podcast edit preview-cut --project episode.project.json --track host --start 1.0 --end 2.0
podcast edit suggest-handoff-cut --project ... --track host --keep-left-end 2154.0 --keep-right-start 2167.0
podcast edit join-quality --project tests/fixtures/join_continuity --track host --join 1.0
podcast edit join-sweep --project tests/fixtures/join_continuity
podcast edit join-label --project tests/fixtures/join_continuity --track host --join 1.0 --verdict fail --note "click"
podcast edit cut-range --project ... --no-inaudible-opt   # exact boundaries
```

Defaults: `.agents/defaults/pipeline.yaml` → `inaudible_cuts`, `join_continuity`, `render`.

Use the short in-repo fixture (`tests/fixtures/join_continuity/`, ~3 s stems) for join QA demos — not huge external episode trees.

Dialogue cuts default to **fade joins** (`join_in_mode=fade`) — butt splice with micro-fades, no overlap. Use `set_clip_join_tool` to set one join's mode and fades together (`set_join_mode_tool` changes the mode only). Use `fade_joins_tool` if joins click; `crossfade_joins_tool` only for explicit overlap blend.

Quiet air after a cut end is absorbed up to the next word (leaving ~0.4s breath) when that gap is ≤2s — see `absorb_trailing_silence*` in defaults. This stops restart/ripple joins from leaving a double-breath. It is the **wrong** tool for “leave a beat between punchline and closing” — absorb **removes** that beat.

Sharecut Studio shows the same optimizer on the wave: quiet wash from visible tiles plus snap ticks from `preview_inaudible_cut` / windowed islands (`GET /api/waveform-snap`). Blade and trim magnet to those ticks. See [docs/inaudible-cuts.md](../../../docs/inaudible-cuts.md) § DAW snap overlay.

## Narrative handoffs

Default inaudible opt ≠ handoff planner:

| Mechanism | What it does | Handoff use |
|-----------|--------------|-------------|
| `preview_inaudible_cut` / inaudible opt | Local snap (~±80 ms) + absorb retain ~0.4s | Tighten fillers / restarts — not multi-second transition planning |
| `suggest_handoff_cut_tool` | Retain ~1s on each keep, snap to RMS silence islands (not transcript gaps); refuse if a bound is still audible | “Clean up the transition”, “need a beat”, punchline→pivot |

Checklist:

1. `search_transcript` for keep-left punchline end and keep-right pivot start (use **timeline** clocks for ripple).
2. `suggest_handoff_cut_tool` (or CLI `podcast edit suggest-handoff-cut`).
3. Ripple `[cut_start, cut_end]` with `use_inaudible_opt=false` so local snap does not pull onto speech / um blobs.
4. `render_preview` → `play context` on the join (required: it flags `speech_crosses_cut` when a clip edge sits in voiced speech, which word times cannot show) → play ~10–15s around the join before resolving review comments.
5. Prefer keeping **existing room tone**; do not “fix” with `insert_gap` of pure silence unless the user asks. When `filler_pad_mode: room_tone`, pads prefer a recorded `track.room_tone` bed from the lobby capture, then stolen stem air, then skip.

See [docs/inaudible-cuts.md](../../docs/inaudible-cuts.md).
