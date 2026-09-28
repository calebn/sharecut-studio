---
name: podcast-pipeline-run
description: >-
  Run the full Podcast MCP processing pipeline or resume from a step. Use for
  automated episode production after tracks are added — not for editing the
  shared steps/params working set first (podcast-pipeline-tune).
---

# Pipeline run

**Whisper weights:** If `transcribe_tracks` will run and the selected model is not cached, `pipeline_run` / `podcast pipeline run` fail fast (no silent Hugging Face pull). Download first via `podcast bootstrap --component whisper --whisper-model …`, the Sharecut Studio first-run wizard, or the Pipeline tab picker.

## Full pipeline order

Transcript hub: **podcast-transcript-workflow** — [docs/transcript-workflow.md](../../docs/transcript-workflow.md).

1. ingest_tracks
2. transcribe_tracks
3. align_tracks — conversation clock (bleed/gaps); default on; skip for unrelated clips
4. require_align_accept — hard agent gate (`podcast align done` / waive; auto-waive small moves if `--unattended`, never moves above `align.large_move_sec`)
5. merge_transcript
6. render_dialogue_stems — pass-1 stems for audibility
7. reconcile_transcript — **pass 1** (suppress bleed/inaudible)
8. precorrect_transcript — glossary, cross-track sync, report
9. require_transcript_refine — hard agent gate (`refine-done` / waive; auto-waive if `--unattended`)
10. analyze_prosody (`prosody.enabled` in pipeline.yaml, **on by default**) — caches a per-track prosody profile (pitch, rate, energy, prominent words, boundaries) for `audition_context` to read; runs after `precorrect_transcript` (a standalone `--only analyze_prosody` needs reconcile/precorrect done first); a no-op with a clear summary if `praat-parselmouth` (the `prosody` extra) is not installed. See [docs/pipeline.md § Prosody profile](../../docs/pipeline.md#prosody-profile).
11. analyze_focus_cuts (`focus.enabled` in pipeline.yaml) — an outline (`artifacts/focus_outline.md`), **not a cut list**; when off it writes nothing and only reports `skipped (focus.enabled=false)`
12. focus_from_transcript (no-op unless `focus.auto_apply: true`)
13. analyze_fillers_pauses (no-op unless `tighten.enabled: true`)
14. tighten_from_transcript (no-op unless `tighten.enabled: true`)
15. clean_audio
16. compress_tracks
17. balance_tracks
18. assemble_timeline — final stems (edits + FX)
19. reconcile_transcript — **pass 2** (post-FX audibility refresh)
20. mix_with_music
21. master_loudness
22. export_deliverables

**Alignment:** After ASR, `align_tracks` places whole-file dialogue clips on one session clock (see **podcast-align-audio**). Unattended runs keep the scorer result and waive `require_align_accept` when `align.accept.mode` is `waive_unattended`. Agents clear the gate with listen + `podcast align done`.

Human review for focus cuts: after `analyze_focus_cuts`, use `list_edit_decisions_tool` /
`approve_edits_tool` (see **podcast-focus-episode**), then resume `--from analyze_fillers_pauses`.

Resume notes: `--from reconcile_transcript` starts at **pass 1**. For pass 2 only, use `--from assemble_timeline`.

## Long raw sessions: content cut before tighten

The default pipeline cuts no content: focus and tighten are off, so a raw session exports at full length. Before any tighten on a long raw session:

1. **Content cut** (after sign-off; it usually exceeds the 15% guard). Remove off-topic runs and meta talk, then the dead start, on every dialogue track with **podcast-edit-natural-language**. Work from the end of the episode toward the start; the dead start (`--start 0`) is always last:
   ```bash
   # each off-topic run / meta talk, latest first
   podcast edit suggest-handoff-cut --project episode.project.json --track <id> --keep-left-end <L> --keep-right-start <R>
   podcast edit ripple-delete --project episode.project.json --start <cut_start> --end <cut_end> --no-inaudible-opt
   # last: the dead start shifts everything after it
   podcast edit search --project episode.project.json --query "<first kept line>"   # timeline_start
   podcast edit ripple-delete --project episode.project.json --start 0 --end <timeline_start-0.5>
   ```
   MCP: `suggest_handoff_cut_tool`, `ripple_delete_tool`, `search_transcript_tool`.
2. **Re-clear the refine gate after each ripple.** Dropped words make the waive stale: `podcast transcript refine-status` shows `"stale": true`, and the next edit raises `TranscriptRefineRequiredError`.
   ```bash
   podcast transcript refine-waive --project episode.project.json --reason "content cut: structural edit"
   ```
   MCP: `transcript_refine_waive_tool` (or `refine-done` / `transcript_refine_done_tool` after a real refine pass).
3. **Tighten the kept range:** `podcast propose-edits --project episode.project.json` (**podcast-tighten-dialogue**). Removed words are gone, so proposals fall only in kept material. Reject tighten proposals made before the cut (`podcast edit reject --ids …`).
4. `analyze_focus_cuts` is an outline, not a cut list (see step 11 above). Use **podcast-focus-episode** for the editorial judgment.

Rationale and details: [docs/pipeline.md § Long raw sessions](../../../docs/pipeline.md#long-raw-sessions-content-cut-before-tighten).

`podcast pipeline run` and `podcast render-preview` report progress automatically (stderr / `--json-progress`). MCP tools inherit the same progress framework — relay tool headlines to the user; do not invent status. Spec: [docs/progress.md](../../docs/progress.md).

**Unattended:** `podcast pipeline run --unattended` or `PODCAST_BATCH=1` auto-waives the align (small moves only; a move or held candidate above `align.large_move_sec`, or unlocked drift above it, stops the run) and refine gates when `align.accept.mode` / `analysis.transcript_refine.mode` are `waive_unattended` (default). Agents in MCP sessions leave this unset and clear gates with **podcast-align-audio** / **podcast-transcript-refine**.

**Performance:** `analyze_fillers_pauses`, `assemble_timeline`/`render_dialogue_stems`, and `export_deliverables` parallelize their internal per-track/per-candidate/per-format work by default (`performance.max_workers` in `pipeline.yaml`, `0` = auto). Step order itself never changes. Set `max_workers: 1` for deterministic single-threaded reproduction while debugging a specific cut/render issue. Details: [docs/pipeline.md#performance](../../../docs/pipeline.md#performance).

## Commands

```bash
podcast pipeline list
podcast pipeline list --json
podcast pipeline run --project episode.project.json
podcast pipeline run --project episode.project.json --unattended
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --from tighten_from_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline
podcast pipeline run --project episode.project.json --only transcribe_tracks
podcast pipeline run --project episode.project.json --force   # re-run ASR over existing transcripts
podcast pipeline run --project episode.project.json --no-strict  # report a failed QC verdict but still exit 0
```

Existing transcripts are reused (a second run does not call Whisper). On seeded projects use `--from merge_transcript` or rely on the skip. `--force` / MCP `force_transcribe=true` re-transcribes; if a hand-edited transcript would be replaced (forced, or its audio changed) and the run is unattended, it fails with `TranscriptOverwriteRefused` naming each track and reason — rerun attended, or have the user click Studio Re-transcribe and accept its replace prompt (the only path that confirms replacing edits in Batch mode).

`pipeline list` shows each step's enabled / no-op / disabled state under the effective config; `--json` for scripting. After `pipeline run`, read the `Export QC:` line on stdout (ok/FAILED, issue count, path) before treating an export as shippable (MCP `pipeline_run` returns the same lines after `Completed through …`) — a run that exported with a not-ok verdict exits 1 by default (`--no-strict` exits 0 and leaves the call to you).

## After automation

1. Listen to `artifacts/premix.wav` or `export/{name}.wav` (where `{name}` is a
   safe export stem; for example `My Episode: Part 1/2` becomes
   `My_Episode_Part_1_2.wav`)
2. Tweak `edit_decisions` or `automation_envelopes` in project JSON; change a
   track's level with `track_set_volume_tool` and mute it with
   `track_set_mute_tool` (saved mix, undoable; only re-mixes on refresh)
3. Re-run from the affected step

## MCP

Agents can call `pipeline_run`, `render_preview`, and `render_final` with the project path.
To edit visible steps/params (same as Sharecut Studio Pipeline pane), use **podcast-pipeline-tune**
(`pipeline_get_config_tool` → optional `pipeline_analyze_tool` → `pipeline_set_config_tool` → `pipeline_run`).
CLI equivalents: `podcast pipeline analyze --project P [--set k=v ...]`, `podcast pipeline config [--set k=v ...]`,
and `podcast pipeline run ... --set k=v` (repeatable, run-only override never saved — e.g. `--set focus.enabled=true`).

## Episode workspace layout

```
episode/
├── episode.project.json
├── raw/
├── transcripts/
├── artifacts/
└── export/
```
