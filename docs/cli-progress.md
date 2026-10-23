# CLI progress indicators

CLI adapter for the shared progress framework. Spec: [progress.md](progress.md).

Long-running CLI operations report progress on **stderr** so stdout stays clean for JSON and piping. The Typer app wraps registered commands after registration (`install_cli_progress`, in `cli/progress.py` with `cli_progress_task`). Registered commands and default `podcast play` use `cli_progress_task` to bind CLI and live adapter sinks for one canonical task. Selected play subcommands open only their own command task.

## Flags

| Flag | Effect |
|------|--------|
| `--progress` / `--no-progress` | Rich bar/spinner when stderr is a TTY (default: on) |
| `--json-progress` | One JSON object per line on stderr (for automation / GUI) |
| `PODCAST_PROGRESS=0` | Disable progress (same as `--no-progress`) |
| `--no-input` | Never prompt; a command that needs a missing model prints its install command and exits 1 (see [A missing model](#a-missing-model)) |

When stderr is **not** a TTY and `--json-progress` is off, there is no CLI consumer → `NullProgress` (progress stays silent). Use `--json-progress` in pipes when you want machine-readable events. A command handed to a running Studio (`docs/gui-integration.md`) is not on a TTY either, so it draws no bars; `--json-progress` events still reach the caller.

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

`podcast ingest suggest` keeps the overall operation indeterminate while it reports each
guest's candidate scoring in a determinate child task. That child's work units are that
guest's sweep starts, each a `(guest, session-start)` candidate. Content-offset estimates,
drift checks, and optional waveform rendering remain visible phases on the overall task;
the scoring bar completes before those follow-up stages begin.

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

For `pipeline run`, each step emits `Running {step}` / `Completed {step}: {summary}`. Summaries are stored on `PipelineStepLog.message` and shown in the DAW Pipeline tab. Progress lines like these go to stderr; `pipeline run`'s own result — per-step summaries, the `Export QC:` verdict when this run exported, and the final `Pipeline complete. Last step: …` line — is always on stdout, TTY or not; a not-ok verdict exits 1 unless `--no-strict` (see [pipeline.md § CLI result and --strict](pipeline.md#cli-result-and---strict)).

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
| `master_loudnorm` | Loudness measure + normalize or limit | child; media seconds over measure + first render, total = 2 × duration (a limiter re-drive or trim holds it full) |
| `master_qc_measure` | Post-master loudness re-measure | child; media seconds |
| `bootstrap.bytes` | One model download inside `podcast bootstrap` or a Studio bootstrap job (label is the component id) | child; bytes, `total` from the server's `Content-Length` or the hub's dry run, `null` when the source gives none (an unpinned Whisper size) |

Common ids in the table are **child** ids when nested. They collapse onto the wrap id only for wrap/leaf entrypoints that pass `prefer_parent=True`.

## `podcast bootstrap`

Each model downloads under a `bootstrap.bytes` child of the command task, so the Rich bar on a TTY counts bytes with no extra code. Off a TTY the rule above holds and no bar is drawn. Instead the command prints a line before each model, `[get] <id> (<size>)`, and one after it, `[ok] <id>: <path>` or `[fail] <id>: <reason>`, on stdout and stderr as before. The `[get]` line prints only for a model that will install (not for one already cached unless `--upgrade`). The `[fail]` reason is plain text and never names a path, URL or environment variable (the `[ok]` line still prints the install path); `--json-progress` still carries the byte events. A pipe gets component-level updates only: a byte-level line stream would be a new non-TTY sink for every command.

## A missing model

A command that needs a model that is not installed stops with `Error: needs <label> (<size>); run `podcast bootstrap --component <id>` (code model_needed)`. When stdin and stderr are both a terminal and `--no-input` is not given, it first asks `Download <label> (<size>)? [y/N]:` on stderr. `--json-progress` does not turn the prompt off; only `--no-input` does. `y` or `yes`, in any case, downloads: the model installs the way `podcast bootstrap --component <id>` installs it (the same byte bar on the command task, and the same `[ok]` or `[fail]` line), then the command runs again from its start. Enter, `n`, any other answer, end of input or Ctrl+C declines, and the command ends with the line above and exit 1. A failed download prints its `[fail]` line and then the same line. A pipe, a redirected stdin or `--no-input` gets that one line with no prompt and no download. A command handed to a running Studio forwards `--no-input` and is never on a terminal, so it is not prompted either. A model that is installed but out of date (`update_needed`) is not offered; its line names the `--upgrade` command (`cli/model_offer.py`).

**Rerun caveat.** The offer fires wherever the command raised the missing-model refusal, which is not always before the command's first side effect. After a yes, the whole command runs again from its start, so any work it did before the refusal happens twice. Pipeline runs resume from stored state; for another command, check its output before relying on a single run. Pass `--no-input` to skip the offer and keep the old behavior.

## Domain code

1. Use `progress_task` / `set_phase` / `advance`, or `resolve_progress_task(..., prefer_parent=True)` for wrap/leaf entrypoints so work updates the choke-point / pipeline child — **do not** `reporter.start("transcribe")` (orphan ids). Nested multi-phase work (audibility under render, enroll then attribute) uses `prefer_parent=False` so a named child owns that unit scale.
2. Do **not** hardcode `NullProgress()` at MCP/CLI edges.
3. Use `cli_progress_task` for executable group callbacks after their subcommand guard. Registered commands inherit the same scope from the installer.
4. Exemptions require user approval in `contracts/progress-exemptions.json` — see [progress.md](progress.md).
