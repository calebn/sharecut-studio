---
name: podcast-pipeline-tune
description: >-
  Read and edit the shared Sharecut Studio pipeline working set (steps + params), run
  heuristic Analyze, then pipeline_run with those visible values. Use when
  configuring production settings in the GUI or via MCP before a run — not for
  an unattended full run with defaults (podcast-pipeline-run).
---

# Pipeline tune (visible params)

**Contract:** What the Pipeline pane shows is what `pipeline_run` uses. Agents and the GUI share the same in-memory working set for a project path.

## Flow

1. **Get** — `pipeline_get_config_tool(project_path)`  
   Returns `config`, `enabled_steps`, `unattended`, step metadata (`depends_on`, components), curated `params`, and `whisper_models` (catalog with `cached`). In the GUI, `transcribe.model` is a catalog picker; missing weights open a confirm Dialog that downloads via host bootstrap (`whisper` only). Pipeline **Run** (Sharecut Studio / MCP / CLI) does not download: missing weights with `transcribe_tracks` selected fail fast (HTTP 409 / tool error). Download via the picker Dialog, first-run wizard, or `podcast bootstrap --component whisper --whisper-model …`.
   `transcribe.vad.enabled` (common) skips silence before Whisper; advanced `transcribe.vad.*`, `transcribe.decode.*` (`temperature` is yaml / `config_json` only) and `transcribe.silence_filter.*` (`enabled`, `peak_dbfs`) tune hallucination handling (`suspect_hallucination` words are flagged, never deleted). Quiet same-room voice or bleed lost: lower `transcribe.vad.threshold` (or turn VAD off); looping lines: `transcribe.decode.condition_on_previous_text: false`. Whisper's prompt always leads with a fixed punctuation-priming sentence (`transcript_context.DEFAULT_PROMPT_PRIMER`), even with no Terms/Guest names set, so one track's first decode window losing all punctuation/casing does not lock that style in for its whole length (#769); the step summary flags "low punctuation rate on `<track>`" when a track still lands far below its peers.
   `transcribe.overwrite` (advanced param) persists "always re-run ASR"; `pipeline_run(force_transcribe=true)` does the same for one run only and is never saved.
   `transcribe.forced_alignment.enabled` (advanced; **on by default when the word aligner is downloaded**, unavailable otherwise, #780) re-times words with a local aligner so word-level cuts land on the voice; English only. `pipeline_get_config_tool` returns the resolved state as `forced_alignment` (`enabled`, `requested`, `installed`, `blocked`, `reason`) beside `components["word-aligner"]` (`opt_in: true`). In Studio the checkbox is checked by default when installed. If a saved explicit `true` is blocked by a missing model, it stays checked and can be turned off; the unset missing-model default stays unchecked and unavailable. **Download word aligner** is offered beside the field until `podcast bootstrap --component word-aligner` has run. Set the field to `false` to keep Whisper's times with the model installed; setting it to `true` without the model makes the run fail with the download command instead of silently keeping Whisper's times. The step summary and `transcript_timing.json` → `forced_alignment.reason` say which state a run resolved to. `transcribe.forced_alignment.min_word_score` (advanced, default 0.01) is the aligner evidence floor: a word below it is flagged `suspect_hallucination` (never deleted) only when its own track is quiet over the word (`evidence_speech_margin_db`, 12 dB above the noise floor) or another track is louder there (`evidence_bleed_margin_db`, 3 dB), so short real words ("um", "to") that score low are left alone (#780); raise the floor to catch more noise or bleed hallucinations; 0 turns it off (turning `forced_alignment.enabled` off alone does not: stored scores keep flagging). `pipeline_run(retime_words=true)` re-times stored transcripts from the ASR cache for one run only (no Whisper; hand-edited transcripts are skipped and reported) — Studio's **Re-time words** button does the same after confirming any edited tracks. Re-transcribe (`force_transcribe`) also re-times, by re-running ASR. Measured cost/accuracy (#715, 2-min/3-track excerpt): +21.6% median wall time on `transcribe_tracks` (54.8 s → 66.6 s) for roughly half the boundary MAE vs native Whisper timestamps (82.3 ms → 43.0 ms on LibriSpeech) — see [docs/testing.md § Shipped pass results (#715)](../../../docs/testing.md#shipped-pass-results-715).
   `prosody.enabled` (common, **on by default**) toggles the `analyze_prosody` step (pitch/rate/energy/boundary profile for `audition_context`); `prosody.pitch_floor_hz`/`pitch_ceiling_hz`/`segment_gap_sec`/`pause_min_sec` (advanced) tune it — see [docs/pipeline.md § Prosody profile](../../../docs/pipeline.md#prosody-profile).
2. **Optional Analyze** — `pipeline_analyze_tool(project_path, apply=true|false)`  
   Heuristics from cleanup/health (hum, noise floor, gate overreach, bleed, clipping, pre-aligned equal-duration dialogue, digital-silence dialogue stems) → proposed patches. Each `reasons[]` entry carries `evidence` (the measured numbers plus the threshold compared against) — read it before deciding whether to apply. `report_summary.tracks` lists per-track health numbers even when nothing fires. A `digital_silence_skipped` value means that track was not measured, not that it is clean. With `apply=true`, merges the *patches* onto the working set as it is when the scan finishes (a config edit made meanwhile is kept), same as GUI **Analyze** — `apply` never touches `enabled_steps`. GUI **Analyze** runs as a cancellable pipeline-slot job with live per-track progress; `pipeline_analyze_tool` is a synchronous call that reports the same `health` / `digital_silence` phases. A `pre_aligned` reason instead carries `suggested_skip_steps: ["align_tracks"]`: the agent applies that itself via `pipeline_set_config_tool(enabled_steps_json=...)` (or unchecks the step in the GUI) — `apply` does not act on it. Do not treat Analyze as a full production run.
   CLI equivalents: `podcast pipeline analyze --project P [--set k=v ...] [--json]` (prints reasons + evidence + a ready `pipeline run --set ...` line that carries your analyze `--set` values plus the patches) and `podcast pipeline config [--set k=v ...] [--json]` (previews the effective config without running anything) — CLI `--set` rejects unknown keys and preset names; `config_json` only filters top-level keys.
3. **Set** — `pipeline_set_config_tool(...)`  
   Pass `config_json`, `enabled_steps_json`, and/or `unattended`. Enabling a step expands `depends_on`. `reset=true` restores yaml defaults.
4. **Run** — `pipeline_run(project_path, unattended=..., use_working_set=true)`  
   Or pass `config_json` / `skip_steps_json` explicitly. GUI Batch mode = `unattended=true` (waive align + refine gates when their modes are `waive_unattended`). Leave-gates = `unattended=false`; if align or refine blocks, clear that gate then resume `--from` the next step.
   To re-score locked align stems (`hold`/`manual`), pass `config_json='{"align": {"realign": true}}'` (MCP equivalent of CLI `--realign`).

## Modes

| Mode | `unattended` | Behavior |
|------|--------------|----------|
| Batch | `true` | Waive `require_align_accept` (small moves only: it stops on a move, held candidate or unlocked drift above `align.large_move_sec`) and refine gates when mode is `waive_unattended` (scorer still ran) |
| Leave gates | `false` | Gates can block; agent/human clears align (`podcast align done`) / refine, then resume |

Align params live under `align.*` (accept mode, max offset, bleed/gap knobs). Uncheck
**Align tracks** when clips are not one conversation — the accept gate follows via `depends_on`.

Do **not** expect the GUI to “summon” an agent. MCP is pull: you call tools.

## Related

- Full step order: **podcast-pipeline-run**
- Align listen/nudge: **podcast-align-audio**
- Audio diagnostics: **podcast-audio-cleanup**, [docs/audio-engineering.md](../../../docs/audio-engineering.md)
- GUI: Pipeline tab / phone More → Pipeline (master-detail checklist + param inspector)
