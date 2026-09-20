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
4. require_align_accept — hard agent gate (`podcast align done` / waive; auto-waive if `--unattended`)
5. merge_transcript
6. render_dialogue_stems — pass-1 stems for audibility
7. reconcile_transcript — **pass 1** (suppress bleed/inaudible)
8. precorrect_transcript — glossary, cross-track sync, report
9. require_transcript_refine — hard agent gate (`refine-done` / waive; auto-waive if `--unattended`)
10. analyze_focus_cuts (`focus.enabled` in pipeline.yaml)
11. focus_from_transcript (no-op unless `focus.auto_apply: true`)
12. analyze_fillers_pauses (no-op unless `tighten.enabled: true`)
13. tighten_from_transcript (no-op unless `tighten.enabled: true`)
14. clean_audio
15. balance_tracks
16. compress_tracks
17. assemble_timeline — final stems (edits + FX)
18. reconcile_transcript — **pass 2** (post-FX audibility refresh)
19. mix_with_music
20. master_loudness
21. export_deliverables

**Alignment:** After ASR, `align_tracks` places whole-file dialogue clips on one session clock (see **podcast-align-audio**). Unattended runs keep the scorer result and waive `require_align_accept` when `align.accept.mode` is `waive_unattended`. Agents clear the gate with listen + `podcast align done`.

Human review for focus cuts: after `analyze_focus_cuts`, use `list_edit_decisions_tool` /
`approve_edits_tool` (see **podcast-focus-episode**), then resume `--from analyze_fillers_pauses`.

Resume notes: `--from reconcile_transcript` starts at **pass 1**. For pass 2 only, use `--from assemble_timeline`.

`podcast pipeline run` and `podcast render-preview` report progress automatically (stderr / `--json-progress`). MCP tools inherit the same progress framework — relay tool headlines to the user; do not invent status. Spec: [docs/progress.md](../../docs/progress.md).

**Unattended:** `podcast pipeline run --unattended` or `PODCAST_BATCH=1` auto-waives the align and refine gates when `align.accept.mode` / `analysis.transcript_refine.mode` are `waive_unattended` (default). Agents in MCP sessions leave this unset and clear gates with **podcast-align-audio** / **podcast-transcript-refine**.

**Performance:** `analyze_fillers_pauses`, `assemble_timeline`/`render_dialogue_stems`, and `export_deliverables` parallelize their internal per-track/per-candidate/per-format work by default (`performance.max_workers` in `pipeline.yaml`, `0` = auto). Step order itself never changes. Set `max_workers: 1` for deterministic single-threaded reproduction while debugging a specific cut/render issue. Details: [docs/pipeline.md#performance](../../../docs/pipeline.md#performance).

## Commands

```bash
podcast pipeline list
podcast pipeline run --project episode.project.json
podcast pipeline run --project episode.project.json --unattended
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --from tighten_from_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline
podcast pipeline run --project episode.project.json --only transcribe_tracks
```

## After automation

1. Listen to `artifacts/premix.wav` or `export/{name}.wav`
2. Tweak `edit_decisions`, `gain_db`, or `automation_envelopes` in project JSON
3. Re-run from the affected step

## MCP

Agents can call `pipeline_run`, `render_preview`, and `render_final` with the project path.
To edit visible steps/params (same as Sharecut Studio Pipeline pane), use **podcast-pipeline-tune**
(`pipeline_get_config_tool` → optional `pipeline_analyze_tool` → `pipeline_set_config_tool` → `pipeline_run`).

## Episode workspace layout

```
episode/
├── episode.project.json
├── raw/
├── transcripts/
├── artifacts/
└── export/
```
