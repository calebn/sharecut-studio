# CLI progress indicators

CLI adapter for the shared progress framework. Spec: [progress.md](progress.md).

Long-running CLI operations report progress on **stderr** so stdout stays clean for JSON and piping. The Typer app wraps every command in `progress_task` after registration (`install_cli_progress`).

## Flags

| Flag | Effect |
|------|--------|
| `--progress` / `--no-progress` | Rich bar/spinner when stderr is a TTY (default: on) |
| `--json-progress` | One JSON object per line on stderr (for automation / GUI) |
| `PODCAST_PROGRESS=0` | Disable progress (same as `--no-progress`) |

When stderr is **not** a TTY and `--json-progress` is off, there is no CLI consumer → `NullProgress` (progress stays silent). Use `--json-progress` in pipes when you want machine-readable events.

The root callback's reporter is scoped to one invocation (`ctx.call_on_close(reset_progress)`), so in-process callers such as `CliRunner` never leave a reporter bound to a stderr stream they have since closed.

Adapters compose sinks with `compose_progress` (CLI + optional in-process GUI SSE). See [progress.md](progress.md) § Consumer fan-out.

## Event schema (`--json-progress`)

```json
{
  "kind": "start|update|end|heartbeat|message|fail|cancel",
  "task_id": "reconcile",
  "label": "Reconciling transcript",
  "current": 1200,
  "total": 9551,
  "elapsed_sec": 4.2,
  "message": "optional detail",
  "phase": "optional_stable_id"
}
```

Results and structured command output remain on **stdout**. Progress never writes to stdout.

`update` lines are time-coalesced to at most 4/s per task (see [progress.md § Update cadence](progress.md#update-cadence)); `start`, a `total` change and reaching `total` always emit.

### Contract tests (do not golden Rich ANSI)

- `--json-progress` lines include `kind`, `task_id`, `elapsed_sec`; optional `phase` / `message`
- `total` is omitted (`null`) when unknown — never invent a percent
- Piped / `PODCAST_PROGRESS=0` → `default_progress_enabled()` is false and the consumer is `NullProgress`
- TTY Rich output is best-effort; tests assert JSON + stderr/stdout separation, not escape sequences
- Rich-mode tests use the `fake_rich_progress` fixture (`tests/conftest.py`, fake in `tests/progress_helpers.py`) and never build a real `rich.progress.Progress`: its daemon refresh thread writes to whatever `sys.stderr` is live, so an unclosed reporter leaks escape codes into later tests' capture. Tests of the plain-stderr path pin `sys.stderr.isatty` to `False`.

## Determinate vs indeterminate

The Rich view renders on **stderr** (`Console(stderr=True)`), never stdout.
Indeterminate tasks (`total=None`) pulse with a spinner and elapsed time and
never show a stuck 0% bar. A phase/`message()` call replaces the row's own
description text instead of printing a separate stderr line. The command-wrap
row is labelled with the command as typed (`podcast pipeline run`); its
`task_id` stays the dotted op id (`pipeline.run`). The 5s-of-silence
heartbeat (one line per sink, for the innermost open task) is silent in Rich
mode — the spinner and `TimeElapsedColumn` already show the run is alive; it
still prints for the plain (non-Rich) stderr fallback.

| Mode | When | UI |
|------|------|-----|
| Determinate | `total` known | Bar with `current/total` |
| Indeterminate | `total` omitted | Spinner + phase headline + elapsed heartbeat |

For `pipeline run`, each step emits `Running {step}` / `Completed {step}: {summary}`. Summaries are stored on `PipelineStepLog.message` and shown in the DAW Pipeline tab. Progress lines like these go to stderr; `pipeline run`'s own result — per-step summaries, the `Export QC:` verdict when this run exported, and the final `Pipeline complete. Last step: …` line — is always on stdout, TTY or not (see [pipeline.md § CLI result and --strict](pipeline.md#cli-result-and---strict)).

### Common `task_id` values

| `task_id` | Parent operation | Nested? |
|-----------|------------------|---------|
| `pipeline.run` (and generally `<group>.<cmd>`) | CLI command wrap | wrap (label `podcast <group> <cmd>`) |
| `pipeline` | Full or partial pipeline run | wrap |
| `precorrect` | Orchestrator (3 sub-passes) | wrap / leaf (`prefer_parent=True`) |
| `precorrect-glossary` | Glossary replacement scan | child |
| `precorrect-cross-track` | Cross-track text sync | child |
| `speaker-enroll` | Profile enrollment | child under precorrect; leaf under CLI enroll |
| `speaker-attribute` | Bleed window scoring | child |
| `transcribe` | Per-track transcription | wrap / leaf |
| `transcribe_audio` | Whisper decode of one track | child; audio seconds, `segment.end / duration` |
| `audibility` / `low-audibility` / `gate-overreach` | Word-scale audit | child (not the wrap’s unit scale) |
| `master_loudnorm` | Loudness measure + normalize | child; media seconds over measure + normalize, total = 2 × duration |
| `master_qc_measure` | Post-master loudness re-measure | child; media seconds |

Common ids in the table are **child** ids when nested. They collapse onto the wrap id only for wrap/leaf entrypoints that pass `prefer_parent=True`.

## Domain code

1. Use `progress_task` / `set_phase` / `advance`, or `resolve_progress_task(..., prefer_parent=True)` for wrap/leaf entrypoints so work updates the choke-point / pipeline child — **do not** `reporter.start("transcribe")` (orphan ids). Nested multi-phase work (audibility under render, enroll then attribute) uses `prefer_parent=False` so a named child owns that unit scale.
2. Do **not** hardcode `NullProgress()` at MCP/CLI edges.
3. Do **not** add a parallel `@timed_command`-style path — the CLI wrap already opens a task.
4. Exemptions require user approval in `contracts/progress-exemptions.json` — see [progress.md](progress.md).
