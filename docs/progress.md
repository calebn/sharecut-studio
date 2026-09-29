# Progress framework

Cross-adapter contract for user-facing progress on long-running work. CLI flags and JSON event shape for stderr live in [cli-progress.md](cli-progress.md) (adapter detail). This file is the **source of truth**.

## Goals

Users should be able to answer:

1. Is it still working? (indeterminate motion + heartbeat)
2. What is it doing right now? (phase / headline)
3. How far — only when the total is real (honest units; never a fake %)
4. How long have I been waiting? (elapsed companion)
5. Wait, leave, cancel, or act?

**Determinate:** set `total` → bar + units. **Indeterminate:** omit `total` → spinner/pulse + phase + elapsed + heartbeat. Elapsed alone never satisfies compliance.

Narration must map to real work (no LLM filler). Brand: calm status chrome ([ux/pages/brand.md](../ux/pages/brand.md)).

## API

Domain and pipeline steps use a contextvar reporter. Adapters inject it at choke points.

```python
from podcast_mcp.util.progress import (
    progress_task,
    current_progress,
    current_progress_task,
    resolve_progress,
    resolve_progress_task,
)

with progress_task("align_tracks", "Aligning conversation", total=n_clips) as p:
    p.set_phase("search_bleed", "Scoring bleed windows…")
    p.advance(1, message="Clip host_1")
    with p.child("refine", "Refinement pass 2 of 2"):
        ...

# Engines: update the bound wrap/step task (or open a child). Never orphan start("transcribe").
with resolve_progress_task("transcribe", "Transcribing tracks", total=n, prefer_parent=True) as p:
    p.set_phase("track", f"Track {track_id}")
    p.advance(1)
```

| Call | Role |
|------|------|
| `progress_task` | Context manager: `start` / `end`; on exception `fail` then re-raise; cooperative cancel → `cancel` |
| `set_phase` | Stable phase id + user headline (immediate emit) |
| `advance` | Honest unit progress |
| `message` / `child` | Extra headline / nested task |
| `current_progress()` / `resolve_progress(progress)` | Read bound reporter; engines should prefer `resolve_progress` over `NullProgress()` |
| `current_progress_task()` / `resolve_progress_task(...)` | Innermost handle. **`prefer_parent=True` only at a wrap/leaf entry** (choke-point wrap or pipeline step) so phases/`advance` update that task. Nested multi-phase work (audibility under render, enroll then attribute) must open a **named child** (`prefer_parent=False`, the default) or use `set_phase` only — never stack a different unit scale on the parent. Borrowed parents lock `total`; child ids `start`/`end` themselves. |

`ProgressEvent` kinds: `start` \| `update` \| `message` \| `heartbeat` \| `end` \| `fail` \| `cancel`. Optional `phase` field for stable ids.

### Update cadence

`advance` / `advance_to` coalesce to **at most 4 updates/s per task**
(`PROGRESS_UPDATE_MIN_INTERVAL_SEC = 0.25`), with the latest value and the latest non-`None`
message winning over anything skipped in between (a `None` message never clears a pending
one: the CLI / JSON / job / guest WS sinks keep the current headline on a `None` message —
for guest WS the ReviewApp / share-mode reducer `guestProgressToJob` keeps the running task's
last message and shows the label only on a `start`, a new `task_id`, or after a terminal —
while the MCP sinks — `McpNotificationProgress` and the remote MCP bridge — fall back to the
task label, because every MCP notification carries a full message). The first update, a `total`
change, and reaching `total` always emit immediately. A pending coalesced update is
flushed before `set_phase` / `message` / `child` / the terminal `end` / `fail`
/ `cancel`, so those always see the final count. Coalescing therefore relies on the task being
closed: use `progress_task(...)` / `prog.child(...)` as a context manager (or call `end` /
`fail` / `cancel`), or the last throttled value is never sent. `advance*` may be called from
several threads; counts and sends for one task are serialized. Direct `reporter.update(...)`
calls (for example the pipeline runner's `Completed {step}` line, which drives
the GUI step parser) are **not** throttled — only the `ProgressTask.advance*`
path is. Domain loops may still gate by count (`if done % 50 == 0: ...`) to
save the cost of computing progress, but must not rely on that gate alone for
rate limiting; the per-task time coalesce is what caps the emitted events. Guest WS progress
passes through two ≤4/s layers in a row (this per-task coalesce, then `GuestWsProgressReporter`'s
own, which shares the same interval constant); the guest sink publishes its pending value before
a terminal, so the final count always reaches the ReviewApp.

## Choke points (cannot skip)

Wrap **before** registrars run — do not copy opt-in decorators like `notify_after_mutation`.

| Surface | Install |
|---------|---------|
| Host MCP | `install_mcp_progress(mcp)` before `register_all` ([mcp/server.py](../src/podcast_mcp/mcp/server.py)) — wraps `add_tool` + `call_tool` (the `call_tool` wrap goes through the shared `util/mcp_call_tool.py::wrap_call_tool`, also used by `install_busy_errors` and host MCP project injection) (MCP notifications when Context exists) |
| CLI | `install_cli_progress(app)` after `apply_cli_extensions` ([cli/main.py](../src/podcast_mcp/cli/main.py)) |
| Pipeline | Runner opens parent `progress_task("pipeline")` + per-step children ([pipeline/runner.py](../src/podcast_mcp/pipeline/runner.py)) |
| GUI jobs | `_JobProgressReporter` + `bind_progress` ([gui/jobs.py](../src/podcast_mcp/gui/jobs.py)) |
| Guest remote MCP | `call_tool` dispatch wrap ([services/remote_mcp/tools.py](../src/podcast_mcp/services/remote_mcp/tools.py)) |

Extensions must register on the **host** `mcp` / Typer `app` instance. Private `MCPServer()` bypasses the wrap.

Skills do **not** get a second progress protocol — relay tool headlines; do not invent status.

## Terminal states

| State | Event | Adapter behavior |
|-------|-------|------------------|
| running | start / phase / update / heartbeat | live headline |
| ok | end | summary + next action when known |
| error | fail | first non-traceback line (paths stripped), else the phase name; exception re-raised; chip/stderr show that headline |
| cancelled | cancel | distinct from error |
| stale | (soft, adapter) | **Shipped:** StatusBar / Pipeline tab / phone chip show “last update Ns ago” when `last_progress_at` is older than 15s. That stamp lives on the live `PipelineJob` and is written only by `_JobProgressReporter._emit` (domain `start` / `update` / `message` / `heartbeat`, including the mixin heartbeat: one per sink after 5 s with no events, on the innermost open task; tasks on one reporter are assumed to nest). `_SsePublishReporter` is publish-only and does not stamp, so `compose_progress` SSE fan-in of domain kinds does not clear stale on the job. The SSE 1s keepalive snapshot also does not bump it. Pulse and elapsed companion stay; no fake moving bar. Same-machine Studio compares `time.time()` to `Date.now()`; a remote client clock ahead by more than 15s can show false stale. |

## Consumer fan-out

Domain emits once on the bound reporter. Adapters attach **only live sinks** via `compose_progress(...)`:

| Sink | Consumer exists when | Skip when |
|------|----------------------|-----------|
| CLI stderr | TTY or `--json-progress`, and `PODCAST_PROGRESS` on | Piped, `PODCAST_PROGRESS=0` |
| MCP | Request carries `progressToken` / Context `report_progress` | No token |
| GUI SSE | Studio `create_app` registered an in-process sink **and** a live job already has an SSE subscriber (per-subscriber queues; any number of concurrent EventSources each get the full stream) | No Studio process, no listeners, or no live job. Do **not** probe `:8765`. |
| GUI agent job | Studio `create_app` registered the job manager in this process (host `/mcp` wrap-level tasks) | No Studio process. Instant tools (no intra-op events and elapsed under 1s) never create a chip. Cross-process CLI adopt is ROADMAP. |
| Guest WS | Wrap is `install_guest_tool_progress` for **that** token (always attached so last-value can replay to a late ReviewApp) | Other tokens or host jobs. Payloads never include host paths. Instant tools (start+end only) never flash a chip. Coalesce ≤4/s. Slow clients keep terminals (drop non-terminal / last-value per `task_id`). |

Zero sinks → `NullProgress`. Same process with Studio job + launching TTY: both get events. Both host job SSE routes (`/api/pipeline/events`, `/api/bootstrap/events`) share `stream_job_events` (`gui/job_events.py`): connect snapshot, live events, 1s keepalive snapshot, `done` on terminal. Studio waiters (`waitForPipelineJob`, `waitForBootstrapJob`) follow their job's stream, re-check status on `onerror`, and re-check every 15s (`JOB_STREAM_RECHECK_MS` via the shared `startJobStatusRecheck` in `gui/web/src/api/pipeline.ts`) as a backstop for a stream that stays open but goes silent (both the `onerror` and the interval re-check act only on a terminal status, so a stale snapshot never rolls back SSE progress, and nothing reaches `onUpdate` once the wait has settled); only the pipeline waiter has a hard `timeoutMs`. The session-wide `usePipelineJob` hook likewise follows its attached job's stream with no status poll while the stream is open (1 s poll only while it is down, where 5 s without a frame also counts as down; 5 s discover poll for other jobs). In-process host MCP long work lazily creates a `kind=agent` job (`tool_id` + headline) on the same job/SSE plane as `POST /api/pipeline/run`. GUI bounce/export start `kind=bounce` / `kind=export` jobs on the pipeline-slot (return `{job_id, job}`; paths on the terminal `result`). StatusBar shows the most recent running job and a count badge when more than one activity is live; chip copy is **Pipeline** only for pipeline jobs. Host MCP `pipeline_run` takes the pipeline single-flight lock; other agent jobs do not. Typer CLI in another process is not adopted (ROADMAP). `GET /api/pipeline/status` `jobs` includes recent finished archives so poll waiters can resolve after a successor replaces the live slot job. Guest wraps compose MCP `notifications/progress` (when the remote JSON-RPC request carries `progressToken`, streamed as Streamable HTTP SSE `event: message` frames then the JSON-RPC result; requests without a token stay JSON) with a token-keyed guest WS sink (`plane: "progress"`) — ReviewApp uses `WS /api/review/{token}/progress/ws` (no `view` cap); Sharecut Studio share mode reuses the dual-plane `daw/ws`. Host jobs never fan to guests.

## Governance

| Rule | Detail |
|------|--------|
| Wrap everyone | New MCP/CLI/pipeline/guest ops inherit the choke-point wrap |
| No self-skip | Authors cannot classify Instant to opt out |
| Exemptions | [`contracts/progress-exemptions.json`](../contracts/progress-exemptions.json) only with explicit user `approved_by` (`none` or `minimal`) |
| Richness | [`contracts/progress-richness.json`](../contracts/progress-richness.json) lists ops that emit phases/units; checker requires **exempt or rich**. `podcast doctor --bundle` wraps `progress_task("diagnostics")` (collecting → redacting → zipping) and nests under a parent MCP task when present. That id is not a JobStore `kind`; Host Help shows a local **Creating…** busy control instead of StatusBar/SSE. `podcast doctor` without `--bundle` stays exempt. `pipeline.analyze` (CLI) and `pipeline_analyze_tool` (MCP) are rich: `services.pipeline_config.suggest_pipeline_tuning` reports a `health` phase, wrapping a named `analyze_health` child around `analyze_cleanup` (which advances once per dialogue track), then a `digital_silence` phase, advancing a named `analyze_silence` child once per dialogue track. `pipeline.config` (CLI `podcast pipeline config`) is a `minimal` exemption (`approved_by: "calebn"`, 2026-09-27) — instant preview computation, no I/O, no persistent store. Studio's GUI Analyze job (`kind=analyze`, `gui:analyze` in the checker) is rich too: its `_JobProgressReporter` counts the `analyze_health` and `analyze_silence` units as the job's `current`/`total`, and `cancel_check` stops the scan between tracks (`CancelledProgress`); Analyze, bounce, export and the pipeline runner all check it through `util.progress.raise_if_cancel_requested(cancel_check, message)`. |
| Soft then hard | `make progress-check` (default **warn**); `PODCAST_PROGRESS_COMPLIANCE=error` later after exemption set is approved |
| Dead exemptions / rich ids | Unknown ids fail even in warn mode |

```bash
make progress-check
PODCAST_PROGRESS_COMPLIANCE=error make progress-check
```

## Surfaces still to display

Sharecut Studio Pipeline tab / StatusBar / phone chip already follow the rubric (honest bar vs pulse while running, no log panel, **stale “last update Ns ago”** when domain heartbeats stop) — see [gui-integration.md](gui-integration.md) § Progress. Pipeline tab `aria-live` summarizes status / headline / units **without elapsed ticks and without ticking stale copy** (stale sits next to elapsed; a one-shot polite announce fires on stale enter/clear). The status live region (`useJobStatusAnnouncement`, mounted by `StatusBar` and the phone `MobileShellView`) keys off status / message / kind / job id. A job registered with `expectJobResult` (Bounce, Export) never gets the generic "ok" headline: its own result copy from `announceJobResult` is spoken once that job's chip is terminal, or at once if the chip has moved on to another job. Results that are ready in the same pass are joined into one announcement, and each is then dropped from `pendingJobResults`. Every spoken job id goes into a small bounded list in the store (`spokenJobResultIds`, last 16), so neither a later chip update for any spoken job nor a remount of the hook (desktop <-> phone shell) speaks the generic headline over it. A project switch (`hydrate`) clears both (#704). `compose_progress` fans to attached consumers (MCP token / CLI / in-process publish-only SSE when a live job has listeners / in-process agent jobs from host MCP / guest WS for the initiating share token). Studio draws waveforms from `.wfpk` pyramids: it polls `GET /api/waveform/status` (`waveform/statusStore.ts`, 1 → 2 → 4 s back-off while anything is generating) and shows a `.lane-waveform-status` lane hint while a pyramid builds (`waveform.build` runs on the two-worker pyramid pool, also with no progress sink). SSE fan-in for these builds stays on the ROADMAP. Remaining: MCP host notification polish, **cross-process CLI job adopt**, activity-history drawer — [ROADMAP.md](../ROADMAP.md).
