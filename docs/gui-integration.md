# GUI integration

Guide for building a desktop or web editor on top of Podcast MCP services and MCP tools.

## Architecture

- **State:** `episode.project.json` is the source of truth for clips, pending edits, FX chains, and `editorial.edit_log`.
- **Mutations:** Route all timeline changes through `EditService` / MCP tools or typed document commands (`POST /api/document/command` — never bare domain calls). Each mutation creates history snapshots. On the web client, `api.ts` exposes `submitDocumentCommand`; `services/commandQueue.ts` persists and orders host/guest edits, handles replay and conflicts, and applies successful results only for the active project. `api/documentTransport.ts` posts the command to the host or guest endpoint.
- **Sharecut Studio today:** comments (incl. Ask threads on pending edits), pipeline, History Undo/Redo, pending Approve/Reject (incl. Impact bulk + host **Tighten** review of `filler:`/`pause:`/`repetition:`/`restart:` hits with an Intensity preset + Find hits (pipeline `analyze_fillers_pauses` only)), pending nudge, Current/Suggested/A/B audition, applied source MUTE Restore and Open History for cuts, clip fades / join mode, Track FX bypass, Transcript Edit-mode correct/suppress/ignore, chapter/social marker CRUD, blade/delete, project/track/audio ingest via document commands, host **Menu → Share…** (live links, mint, revoke), host **Menu → Record room…** (lobby/consent/Start + full-quality recording + mix-minus), and host **Menu → Connect agent…** (local Streamable HTTP MCP URL) — [daw-editing.md](daw-editing.md), [share-tokens.md](share-tokens.md), [recording-session.md](recording-session.md).
- **Host MCP (local Streamable HTTP):** `gui/host_mcp.py` mounts the same `MCPServer` as stdio at `http://127.0.0.1:8765/mcp` (official `mcp` SDK). Tools apply to the open episode (`app.state.served_project`). See § Local host MCP.
- **Remote MCP (share tokens):** `gui/routes/remote_mcp.py` + `services/remote_mcp/` — capability-scoped guest tools over JSON-RPC; mutations still go through `ShareService` / `DocumentSyncService` (no forked domain logic). See [host-online-relay.md](host-online-relay.md) § Remote MCP.
- **Audio:** Rendered stems and premix live under `artifacts/`; undo restores project JSON only — call `render_preview` or `history_undo(rerender=true)` after undo.

## Clocks

| Clock | Use for | Tools |
|-------|---------|-------|
| **Source** | Cut decisions, transcript words | `cut_*`, `search_transcript` `start`/`end` |
| **Timeline** | Play, chapters, ripple by time | `play_audio_tool`, `play_compose_tool`, `ripple_delete_tool`, `list_applied_edits_tool` |

`search_transcript_tool` returns both clocks on each match.

### Ripple trim previews

`gui/web/src/edit/ripplePreview.ts` mirrors `edits/ripple.py` for trim drafts
and drag arrows. An edge-moving lane identifies one anchor and classifies each
whole follower against that anchor's original bounds. The edited lane and a lane
with a moving peer use the same rule. A lane without a moving edge uses the
existing time-splice preview. The shared cases in
`contracts/ripple-scope.json` check saved geometry, clip and recording identity,
source ranges, arrows, and cuts in Python and Vitest.

## Undo / history

- Interactive edits: two snapshots per action (`before …` / `after …`).
- `history_list` returns flat `entries` plus grouped `groups` for mutation pairs.
- `history_diff_tool` / `podcast history diff` — structured clip/decision/mix delta between indices.
- `history_goto_tool` / `podcast history goto` — jump cursor without stepping undo/redo.
- Pipeline steps record one snapshot per changed editable state (`after {step}`). Progress alone adds no History row. The shared comparison ignores `render_last_completed_step`; snapshots still store that cursor for undo and redo.
- **Sharecut Studio History tab:** Undo / Redo buttons call document commands `UndoHistory` / `RedoHistory` → `HistoryService` (same as MCP/CLI). Applied snapshots carry `history.groups` so the list stays current after targeted TRACKS/COMMENTS patches. With `rerender: true`, a failed render or a merge clash after the move is saved answers **409** (`conflict: true`; a WS `Error`) with the message that says to re-render the preview instead of repeating the move.

After undo, check `render_status_tool` — `needs_rerender` when stems or premix are stale; only stems whose track the undo changed go stale, a mix-only undo stales just the premix.

## Applied-edit provenance

Committed cuts are archived in `editorial.edit_log` (not deleted with `edit_decisions`).

- `list_applied_edits_tool` / `podcast edit list-applied` — filter by track or timeline window.
- Each record includes `reason`, source/timeline ranges, and tool `params`.
- `ripple_delete_clips` / `delete_clips` records carry no clip ranges after the clips are gone, so they store `params.cut_spans` (`{track_id: [[start, end], ...]}`, timeline seconds) for `edit_impact_report`.

## Read APIs for inspectors

| API | Purpose |
|-----|---------|
| `list_clips_tool` | Full clip rows incl. `join_in_mode`, `source_id`, required `source_duration_sec` (`number | null`) and `recording_key` (`string | null`) for the clip's own recording, which the DAW's `trim_edge_limits` mirror stops at (`recording_key` is an opaque identity, `rec_` plus a hash, shared by clips that play the same file; it names no file, so a share guest learns no file name), `origin_track_id` and the effective join render (`join_left_clip_id`, `join_render_mode`, `join_crossfade_ms`, `join_crossfade_blocked`; computed by the same functions render uses) |
| `list_edit_decisions_tool` | Pending cuts |
| `list_applied_edits_tool` | Committed cut provenance |
| `edit_impact_report_tool` | Seconds cut (once per cut, per track in `by_track_sec`) and applied-edit count, from approved edits in `editorial.edit_log` plus any applied decisions still in `edit_decisions`; mutes count as applied but remove no time |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `reconciliation_status_tool` | Transcript/audio drift flag |

Mutation tools return **JSON** with `operation`, echoed input params, and summary fields (`clip_count`, `affected_tracks`, …).

## Progress

Shared contract: [progress.md](progress.md). CLI adapter flags: [cli-progress.md](cli-progress.md).

`POST /api/pipeline/run` accepts a run-only `force_transcribe` (Studio **Re-transcribe** sends it) that re-runs ASR over existing transcripts without persisting `transcribe.overwrite`; Re-transcribe also sends `overwrite_edited` (replace hand-edited transcripts even in Batch mode; warned and counted as "N edited overwritten"; the run's "before pipeline run" undo entry restores them) only after the user accepts a prompt naming the tracks in `edited_tracks` from `GET /api/transcript/vocabulary`; declining starts no run, and with no edited tracks it sends `false`; ordinary runs reuse stored transcripts. A run-only `retime_words` (Studio **Re-time words** next to the Pipeline tab's Precise word boundaries field) re-times reused transcripts from their ASR cache without re-running Whisper — it also turns on `transcribe.forced_alignment.enabled` for that run — and sends the same `overwrite_edited` confirmation for any edited tracks before starting. The DAW viewer runs the pipeline in-process via `POST /api/pipeline/run` and streams progress over SSE (`GET /api/pipeline/events`) using the same `ProgressReporter` protocol (step `current/total`, live `message` headline, per-step elapsed, `fail`/`cancel`). During quiet steps the SSE stream also emits ~1s `status` snapshots (fresh `elapsed_sec`). Those keepalives **do not** bump `last_progress_at` — only domain events (`start` / `update` / `message` / `heartbeat`) and the job reporter’s `ElapsedProgressMixin` heartbeat (one event on the innermost open task after 5 s of silence) do. The viewer keeps a session-wide subscription (`usePipelineJob`) so the **Pipeline tab**, **StatusBar**, and **phone Listen chip** stay live — there is **no separate progress log panel**. Job SSE is the progress plane only: the project changes a run saved reach the tabs as an `ExternalMutate` document event emitted by `PipelineService.run` when the run ends ([session-sync.md](session-sync.md)), so the Tighten table and Impact panel update at job done without a refetch. `usePipelineJob` runs no status poll while its attached job's SSE stream is open, falls back to a 1s `GET /api/pipeline/status` poll only while that stream is down (from `onerror`, or 5s without any frame since the server sends a 1s keepalive, until a reconnected stream delivers a frame; a status result (down poll, stream-down re-check, or the refetch after a `done` frame) or pending reconnect that lands after any stream has attached is dropped, so it never replaces the live stream), and separately runs a 5s discover poll that keeps `activityJob` and the running count current for jobs started elsewhere. A frame on the attached stream updates `activityJob` only when no other job is the live primary, so while another job (for example an agent job) is primary, its StatusBar chip, including its move to `ok` / `error`, refreshes at that 5s discover cadence rather than every second. Starting render preview, bounce, export or **Analyze** from Studio seeds `activityJob` with the job's start snapshot, so that new foreground work becomes the primary even over a live agent job; later stream frames follow the rule above. Phone Listen reuses StatusBar `status-pipeline` chrome. Chrome follows the progress rubric:

- **Headline / phase** from `message` (primary when a bar would be dishonest)
- **Determinate bar** only when `total` is set (`role="progressbar"` + `aria-valuenow` / `aria-valuemax`); otherwise a pulse + `role="status"` live summary (no `n/?` fake units)
- **Elapsed** as a companion; Cancel remains on the Pipeline tab
- **Failed** vs **cancelled** are distinct status labels
- **Stale:** if `now − last_progress_at > 15s` while running, chip/panel show “last update Ns ago” next to the headline (dim companion, not accent). The pulse stays; elapsed still ticks as a companion; no determinate bar movement. A new domain event or job-reporter heartbeat clears the copy. Pipeline tab live region does not include the ticking stale string (one-shot stall/resume announce only). `last_progress_at` is wall-clock `time.time()` on the Studio host vs client `Date.now()` — same-machine Studio is fine; a remote client clock ahead by more than 15s can show false stale.

Fan-out of in-process **host MCP** onto this job/SSE plane uses `compose_progress`. Studio `create_app` registers a wrap-level **agent job** sink next to the publish-only SSE sink: the first `update` / `message` / heartbeat or elapsed ≥ 1s creates a `kind=agent` job (`tool_id`, headline) so StatusBar / phone chip show it without a prior `POST /api/pipeline/run`. Instant tools never flash a chip. Host MCP `pipeline_run` in the Studio process goes through `PipelineJobManager.start()` (same single-flight lock as `POST /api/pipeline/run`; busy is an error). Other agent jobs do not take that lock; the manager may hold one pipeline-slot job (`pipeline` / `render_preview` / `bounce` / `export` / `analyze`) plus N agent jobs. StatusBar shows the most recent running job and a count badge (“2 activities”) when more than one is live. Chip copy is **Pipeline** only for `kind=pipeline`; otherwise **Activity**. The Pipeline tab lists pipeline jobs in the summary; while bounce/export/`render_preview` occupy the slot it disables Run, shows Cancel, and a slot-busy notice (no Cancel surface for agent jobs); while **Analyze** (`kind=analyze`) runs it disables Run and shows Cancel plus Analyze's own progress (phase headline, `n/N tracks` bar, elapsed) instead of the notice. `fail` shows a short first-line headline (no stack traces or host paths). Typer `install_cli_progress` is not installed by the GUI — **cross-process CLI adopt remains ROADMAP**; GUI-started pipeline/bootstrap jobs are live today.

Guest-initiated long work (remote MCP / guest tools) does **not** use host `/api/pipeline/events`. `install_guest_tool_progress` composes MCP `notifications/progress` (when `params._meta.progressToken` is set — Streamable HTTP SSE, then the JSON-RPC result) with a live guest-WS sink keyed by **that** share token. Sharecut Studio share mode demuxes `plane: "progress"` on `daw/ws` into the StatusBar activity job (phone Listen shows the chip for guests; the chip is non-interactive because the Pipeline tab is host-only). Payloads are whitelisted (no host paths); updates coalesce ≤4/s; instant tools never flash.

## MCP progress

Host MCP installs a choke-point wrap on `add_tool` / `call_tool` so every tool opens `progress_task` and binds a reporter (best-effort `notifications/progress` when MCP Context is available). When Studio is in-process, that wrap also fans into the job manager as above. Guest remote MCP (`/mcp/{token}/mcp`) reads `params._meta.progressToken` and, when set, streams `notifications/progress` over Streamable HTTP SSE before the JSON-RPC result, plus the token-scoped guest WS plane — not host SSE. Domain code uses `resolve_progress()` / `progress_task` — do not hardcode `NullProgress()` at MCP edges. See [progress.md](progress.md).

## Render preview and history

`render_preview` records history snapshots (`operation: render_preview`) so envelope changes from `mix_with_music` are undoable.

## Suggested GUI flows

1. **Load project** → `list_clips` + `render_status` + `history_list`.
2. **Edit** → mutation MCP tool → refresh clips + history groups.
3. **Inspect step** → `history_diff` on selected group indices.
4. **Undo** → `history_undo(rerender=true)` → `render_status`.
5. **Why was this cut?** → `list_applied_edits` at playhead time.

## Read-only DAW viewer

Local web UI for inspecting an episode without mutating state.

### Frontend foundation

The Bounce dialog groups Source, export options, and its action footer with
theme spacing tokens. Radio and checkbox labels share aligned control/text
columns and a `--touch-min` hit target; long labels wrap beside the control.
Its scoped layout preserves the shared dialog's focus trap and scrolling body.
The Export deliverables dialog reuses that layout for its Files fieldset and
footer, and on the phone shell it rises as a bottom sheet (`Dialog`
`phoneSheet`) with Export, Cancel export or Done pinned in the footer.

Sharecut Studio (`gui/web/`) uses plain CSS + React (no Tailwind/shadcn). Semantic theme tokens live in `gui/web/src/styles/theme/` (light/dark via `data-theme` + `prefers-color-scheme`; transport toggle + `localStorage`). Shared chrome is the **Sharecut Studio UI library** under `gui/web/src/ui/` (Button, CommandButton, Dialog, Menu, Field, …) — charter and command-bus bridge: [`gui/web/docs/ui-library.md`](../gui/web/docs/ui-library.md). Comment UI is shared from `gui/web/src/comments/`. Domain CSS is split into `@import` partials from `gui/web/src/styles/daw.css`. See [`gui/web/README.md`](../gui/web/README.md).

### Launch

`services.app` owns the shared CLI/MCP viewer launch path. Host binding auth lives in `services.session_sync`; GUI routes keep the FastAPI request wrappers.

```bash
uv sync --extra gui
cd gui/web && npm install && npm run build && cd ../..
podcast gui --project /path/to/episode.project.json
```

When the web build is missing (a source tree before `npm run build`, or a wheel built without it), `podcast gui` prints one startup warning, `GET /` returns a 503 HTML page with the build steps, and `open_gui_tool` returns `static_built: false` with the same text as `hint`; the API and `/mcp` keep working. See [setup.md](setup.md#web-build-in-wheels).

First-run setup checks FFmpeg readiness and downloads model assets only. The wizard offers Whisper and optional RNNoise. Audio-tool failures link to reinstall or source setup instead of offering an FFmpeg download.

On **loopback**, `--project` is optional: omitting it serves the host **home** (New / Open project, **Connect agent…**). The home screen also runs a **first-run bootstrap wizard** when audio tools or Whisper are unavailable (`/api/bootstrap/*`). The wizard includes a Whisper **speech model** picker (default `large-v3-turbo`; smaller sizes optional). `/api/bootstrap/status` also reports the opt-in `word-aligner` (`opt_in_components`); the wizard never downloads it. `GET /api/project` (and create/open) pins `served_project` for host MCP; only Studio **New project** (`project.new`) calls `POST /api/project/close` to unpin (then opens `/?home=1`; if the unpin fails or has not answered within 10 s, Studio stays open and reports it in the status line; after a timeout it also re-pins the open project (best effort: the server may still finish the stalled unpin late, leaving host MCP unpinned until the next project load); a repeat New while it waits is ignored; New and Open are refused while this tab is recording, in a browser as well as the desktop app, and if a leave-page prompt keeps the page after New, New works again after 5 s); creating or opening a project re-pins. Home itself never unpins. While a project is pinned, a bare `/` (no `project`, `review` or `home` param) 307-redirects a host-authorized browser to `?project=<served>` (a query-only relative `Location`, so a mount prefix or path-rewriting proxy keeps its path; other params such as `sc_close_guard` kept), so a bookmark, tab restore or preview tool can't unpin it; `/?home=1` shows home without unpinning. Non-loopback still requires `--project` (pinned; switching projects is loopback-only) and does **not** mount `/mcp`.

Navigating the browser to `/?project=<other>` while a project is pinned returns a friendly recovery page (HTTP 403 HTML) naming the served project with links to open it or choose a different project (`/?home=1`, home without unpinning). The recovery page is rendered only for requests that accept `text/html`; API clients receive the JSON `403 {"detail":"project path not allowed for this server instance"}`. On a non-loopback strict-auth server, the request must carry the launch `session_token` before the page reveals served-project metadata, and both recovery links retain that token. The recovery page is an owner surface gated by the host role (`require_host`), so relay-tunneled requests (`x-sharecut-relayed`) get the JSON `403` and never see the served project's path, even from loopback or in non-strict mode.

The loopback GUI is a **privileged local RPC** (not “safe because localhost”). Host/Origin binding rejects DNS-rebind forged `Host` headers on host APIs. Treat `127.0.0.1:8765` like a local agent with full project open/create and pipeline powers. Owner GUI routes also require the **host role** (`gui/routes/deps.require_host`): a loopback peer, or `PODCAST_SESSION_TOKEN` under strict authz — never relay-tunneled traffic, even from loopback. See [host-online-relay.md § Security notes](host-online-relay.md#security-notes).

`GET /api/tunnel/status` (host role; feature `tunnel.status`) reports what every `podcast tunnel` on this machine last wrote under the cache: `state` (`online`, `connecting`, `reconnecting`, `offline`, `off`, `not_set_up`), `phase`, `reason`, `reason_kind`, `relay_host`, `public_base_url`, `share_count` and `retry_at` (epoch seconds of the next reconnect try). The Share dialog polls it every 5 s while open and shows one line in plain words (nothing for `not_set_up`), counting down to `retry_at` while reconnecting; it carries no token. See [host-online-relay.md § Tunnel status](host-online-relay.md#tunnel-status).

**Native shell (optional):** Tauri 2 under [`gui/desktop/`](../gui/desktop/) spawns `podcast gui` and opens a WebView on the same URL. Packaging boundaries: [desktop-packaging.md](desktop-packaging.md).

**From an agent (MCP):** `open_gui_tool(project_path=…)` starts the viewer in the background (or reuses a healthy server on `:8765`), opens the browser, and returns the URL. CLI equivalent: `podcast gui --project … --background`. Skill: `podcast-open-gui`.

### Local host MCP

While `podcast gui` is running, the DAW is a spec-compliant MCP server (Streamable HTTP, official Python SDK). Open an episode, then **Menu → Connect agent…** and paste:

```json
{
  "mcpServers": {
    "sharecut": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Keep Sharecut Studio running. Host `tools/call` applies to the **pinned** episode (`served_project`); with no pin they return an error to open one first. The host transport is stateless: requests do not retain MCP sessions and the server does not issue or require a sticky `Mcp-Session-Id` header. The host endpoint accepts POST; GET and HEAD return `405 Allow: POST` because a standalone SSE stream cannot receive events from another stateless request. A legacy cancellation notification sent in a separate POST cannot stop an in-flight call; [issue #151](https://github.com/calebn/sharecut-studio/issues/151) tracks that compatibility gap. `/mcp` is mounted only on loopback binds. This is not OAuth and not a share token — loopback + Origin/Host DNS-rebinding checks only. Guest/collaborator agents still use `{base}/mcp/{token}/mcp` ([host-online-relay.md](host-online-relay.md) § Remote MCP), and contributor stdio `podcast-mcp` keeps its session behavior.

Dev mode (API `:8765`, Vite `:5173` with `/api` proxy):

```bash
podcast gui --project /path/to/episode.project.json --dev --no-open
cd gui/web && npm run dev
# open http://127.0.0.1:5173/?project=/absolute/path/to/episode.project.json
# or omit ?project= for host New/Open home (loopback API)
```

### Project / track / audio ingest (Pass 8)

Host and share **`edit`** guests may add tracks, attach/replace audio, edit track meta, and remove tracks. **New / Open project** is host-only.

| Path | Role |
|------|------|
| `POST /api/project/create` · `POST /api/project/open` · `POST /api/project/close` | Host loopback — create empty episode, open existing `episode.project.json` (basename required; workspace **directory** also accepted), or unpin `served_project` (Studio New project). CLI `--project`, MCP, and `open_project` still load any JSON path. |
| `POST /api/project/pick` | Host loopback — OS file dialog (Finder / Explorer / zenity); returns a path without pinning `served_project`. Browse / Mod+O use this then `open`. Overlapping pick returns **409**. Cancelled responses may include `detail` (timeout). Paste path remains when the dialog is unavailable. |
| `POST /api/media/upload` | Host — stream audio into `raw/` (allowlisted extensions; size via `PODCAST_GUI_MEDIA_*`) |
| `POST /api/review/{token}/daw/media/upload` | Guest **`view` + `edit`** (`edit_commands_allowed`) — chunked upload (relay JSON body cap); same assembler |
| Document commands `AddTrack` / `SetTrackMedia` / `SetTrackMeta` / `RemoveTrack` | JSON mutations via existing document command routes (never file bytes) |
| Document commands `SetTrackFader` / `SetTrackMute` | Saved mix (#386): a track's volume (`fader_db`, −60 to +12 dB on top of the staging `gain_db`) and mix mute; host and Editors only (`canEditMix`). Applied as the `mix` projection (`tracks` + `render_status`) |

Sharecut Studio arrange is the import surface: drop on a lane (replace that track’s media), drop below tracks / empty session (new tracks), **Menu → Import audio…** / **New track**, inspector Import/Replace. One frontend path: `gui/web/src/ingest/ingestFiles.ts` → upload then `submitDocumentCommand`. Permissions: `canIngestMedia` / `canManageProjects` in `shareMode.ts`. Details: [daw-editing.md](daw-editing.md) § Pass 8.

### Transcript speaker editing

Speaker labels in the transcript open a name editor for hosts and shares with the `edit` capability. Enter a new name or choose an existing speaker, then select **Save speaker** or press Enter. The change applies to every turn on that track through the same `SetTrackMeta` command as the Track inspector. It preserves source audio, word timing, and track identity. **Cancel** or Escape discards the draft. History Undo restores the previous speaker. The adjacent timecode seeks the turn. Queued saves immediately update the visible speaker labels and announce that delivery is pending. Rejected saves restore the previous view only if the originating project and optimistic snapshot are still active.

### Transcript refine recovery

The host-only `POST /api/transcript/refine/waive` endpoint accepts `{path,
reason}` and records the waiver through `TranscriptRefineService` with source
`user`. The GUI exposes it only when an approval receives the transcript-refine
gate error. Share guests cannot use this recovery path; waiving never approves
the pending edit automatically.
The document-command gate responds with HTTP 409 and
`X-Sharecut-Error-Code: transcript_refine_required`; the GUI uses that stable
code to show recovery guidance without exposing the CLI-oriented server hint.
The waiver route is host-origin protected and serializes its project save with
document commands.

An Approve click made while another live host command from the same tab (or this tab's offline-queue drain) is still in flight waits for it (up to 5 s in total, `HOST_SEND_WAIT_MS`) and then posts, so the typed 409 reaches the inspector. If the earlier work is still running after 5 s, the approval stays queued for the drain: the Pending edit inspector, the Impact panel and the Tighten Apply / Skip commands show a **Still sending** status instead of treating it as done (it clears once the project's command queue is empty), and a refusal of the later replay appears in the **Needs attention** banner.

### Busy project (503)

Any HTTP route that does not map `project_commit_lock` / `render_lock` contention itself falls through to an app-wide FastAPI exception handler (`gui/routes/deps.py::project_busy_exception_handler`, installed on `Timeout` in `create_app()`), which returns HTTP 503 with `X-Sharecut-Error-Code: project_busy` and a fixed, path-free message (`util.project_state.busy_message`). `document.py`'s own `Timeout` / sqlite-busy mapping (same `busy_message` text for a lock timeout, so a render-busy command keeps its render advice) and the `/api/audio` render-busy path keep their existing, more specific contracts; the app-wide handler only covers routes (such as `/api/comments`) that would otherwise surface a raw 500 (#488). Routes that catch broad errors themselves map a lock timeout the same way before their generic fallback: guest review, recording, waveform, and upload routes (`gui/routes/guest_errors.py` over the shared `tool_refusal` policy, including chained SQLite busy errors), owner waveform routes (`waveform_call`, which does not log it as a fault), and owner media-upload routes. `PUT /api/transcript/vocabulary` maps a transcript-context lock timeout to the same 503 `project_busy` code, keeping its own `TRANSCRIPT_CONTEXT_BUSY_MESSAGE` text. The app-wide HTTP handler does not handle WebSockets. Guest review and recording adapters explicitly classify contention as `project_busy`: admission or setup closes with transient `1013`, while recording commands send `invalid_state` with `error_code=project_busy` and leave the socket usable. Owner WebSocket handling is unchanged. Edits reach the project through the HTTP command routes (`POST /api/document/command`, guest `POST /api/review/{token}/daw/document/command`), which are covered. See [architecture.md § Staleness](architecture.md#staleness) and [persistence.md](persistence.md) for the underlying locks.

### Keyboard clip handles

Focused timeline fade and trim handles accept Left/Right arrows through the shared command bus. Fade steps are 1 ms (Shift 10 ms); trim steps are 10 ms (Shift 100 ms), without snapping. Right grows fade-in, Left grows fade-out; Right advances either source boundary. Holding a key previews repeated steps and releasing that arrow saves once, so one Undo restores the gesture. Normal blur also saves; Escape, pointer cancellation, unmount, or changed project/clip geometry discards the preview. An in-flight save blocks another handle gesture. Fades preserve the opposite edge and clamp to the track cap and remaining clip length; trims preserve minimum span and neighbor bounds. A handle that retains native focus after a project reload edits the fresh clip. Removing the focused handle releases keyboard ownership. Arrow keys outside a focused handle retain playhead navigation.

Fade gestures capture both saved fades and submit that pair with `SetClipFade`.
The server refuses a stale pair before history capture, including a draft made
while an Undo reply was delayed. The current project shows "This clip changed.
Nothing was saved. Adjust the fade again." Timeline handles and phone nudges
announce it visibly; Clip Inspector shows it inline. A fresh gesture uses the
restored pair. On a coded `clip_fade_changed` refusal, the shared command queue
refreshes the current project through `refreshDocumentProject` before reporting
the refusal, even when a peer's WebSocket projection is delayed. This also applies
to host and guest offline replay. The rejected command keeps its original
baseline and identity, leaves the queue permanently, and remains in **Needs
attention**. A failed refresh preserves the original refusal. A delayed refresh
cannot apply to a switched project or a reopened project generation.

### Pointer draft ownership

A clip body keeps its existing pointer selection and focus policy. Its key
handler exists only for the admitted pointer gesture: Escape cancels it;
arrow, endpoint and activation keys stay local until release. Every terminal
path removes the handler. This is the component Escape exception to keyboard
listener governance and dispatches no global command. Timeline admission permits
one body owner, and move/range cancellation checks its own draft before clearing
shared preview state. Chapter and social marker keys remain on their focused
buttons. Project path and epoch key their marker lifetime, so an identical
marker in another project cannot inherit a held gesture. Cancellation compares
the actual serialized painted geometry. These previews create no document
History.

The panel separator reports measured height to assistive technology even when
CSS chooses the responsive default and its preference remains unset. Its title
exposes arrows, Shift for larger steps, Escape cancellation and Enter reset.
The measured pointer strip remains 10 px high; keyboard resizing is the available
alternative, and physical touch comfort remains a manual validation gap.

### Crowded timeline targets

Small timeline targets compete through one shared hit resolver instead of CSS
z-order: a press on a target with two or more targets in reach is replayed on
the best-ranked one, and a held touch on a crowded spot opens a target
chooser. Data shape, ranking, routing and the
chooser contract: [touch-editor-decisions.md](touch-editor-decisions.md#shared-hit-resolver-1051).
Each target kind's input rules (its drag axes, whether a long press arms it,
its strip nudges, soft boundaries, keys, command and the kinds it outranks,
so a grab at a join rolls it) live in one table, `HIT_KINDS` in
`gui/web/src/timeline/inputContract.ts`; the router reads it, and generated
conformance tests check every kind against it. A long press arms a target, a long press on empty space opens the create menu, and armed
drags detent at soft boundaries ([round 4b](touch-editor-decisions.md#touch-grammar-round-4b-1051)).

### Clip join fields

`list_clips` / the project view give every clip row the effective render of its incoming join as flat fields: `join_left_clip_id` (null for a track's first clip), `join_render_mode`, `join_crossfade_ms` and `join_crossfade_blocked` (`not_abutting` | `no_fade_out` | `no_fade_in`). They come from `edits/clips_ops.py` (`join_render_fields`, the same functions render uses), so the inspector states what render will do. The inspector's Join control and the timeline join popover set a join with the `SetClipJoin` document command (mode plus both fades, one undo step); `SetJoinMode` changes the mode only and returns the same `join_*` fields, so a caller sees when a crossfade has nothing to blend.

### Layout (Reaper-style)

| Region | Content |
|--------|---------|
| Transport | Wide layout is three zones: project name; Play/Pause, Stop (Stop returns the playhead to where playback last started, clamped to the timeline; Pause keeps it; any playhead move while stopped or paused (seek, seek link, follow, agent seek) becomes the new start, a seek during playback does not), timecode, and audition mode (Full mix / Edited stems / Original) centered; render health, tools, Fit, a **View** menu (a text button, not an icon — Layers, **Zoom**, layout, theme), and the project **Menu** (Project, Media, host-only **Markers** → Add chapter at playhead, Help, with shortcuts) on the right. The center stays centered while the right zone fits in half the spare room; when status pills widen it, the center shifts left and the project name truncates rather than overlapping (below 85rem the zones simply flow left to right: only the project name gives way, the right zone keeps its content width and caps a session-region pill at 8rem, and the timecode visually hides its `/ total` suffix, which screen readers still announce and its tooltip still shows). Collapsed widths keep one combined menu. The overflow uses menuitem, menuitemradio, and menuitemcheckbox semantics for keyboard and assistive-technology navigation. At compact widths every row, including audition radios and layer checkboxes, has `min-block-size: var(--touch-min)` (44px); browser coverage verifies their roles, selected state, arrow-key navigation, touch targets, and axe. |
| Track headers | Label, a subtitle (role and speaker, each shown only when it differs from the name), an **Out** text readout of the output gain (`Out −3.0 dB`, a title explains staging vs. volume; not a real fader — that lives on the inspector's `TrackFader`), viewer **M**ute/**S**olo (named "Mute `<track>`" / "Solo `<track>`", each tooltip leading with the action and its shortcut, e.g. "Mute (M). Mutes the track in the mix, for everyone"), FX badge, a stem-freshness icon (check when up to date, refresh when stale, both with an accessible name so colour is never the only signal) with full-word stale-reason chips (Envelope, Other, FX, Cut, Clip, Gain, Mute, or "Some regions" for a regional-only track). The reorder handle is a tab stop: click it or press Enter/Space to select the track, then ↑/↓ move it (its tooltip names both paths); dragging still works the same way. Space and Enter on any header button (open, reorder handle, **M**, **S**) activate that button and never reach the window keymap, so they do not toggle playback or apply a tighten hit; Mod/Alt chords still do. On arrange, headers live inside `.timeline-scroll` as a sticky identity column (`flex-wrap: nowrap` — not Every Layout Sidebar wrap) so they share vertical scroll with lanes and stay fixed while panning time. Pane width via `@container timeline` switches gutter (`4rem`, mixer chrome hidden) vs mid/full rail; phone Timeline uses the same `headerSlot` path with CapCut fixed-center playhead. |
| Timeline | Full-session auto-fit on load; clips; volume envelopes; pending/applied edit overlays; chapter + social markers; playhead; pinch / Ctrl-wheel zoom claimed on the timeline only (non-passive listeners so browser page-zoom does not fight); phone shell uses fixed-center playhead scrub |
| Inspector | Selection details (clip, pending with Current/Suggested/A/B + Ask thread, track FX, chapter, social); **Edits in removed audio** list when idle; phone/tablet peek via bottom sheet. Pending approval errors remain visible while the selected edit is refreshed; changing selection clears the prior edit's error. |
| Bottom tabs | Transcript (consecutive same-speaker utterances grouped into turns; **click** seeks the turn start, **double-click a word** edits it inline for hosts (seeks for guests); host **Correct** toggle selects a word into the inspector for correct/suppress/ignore without stealing seek; **Select** builds a range for cut/copy or Ignore/Restore (#633: struck through and muted at render, no cut — a hover/focus-visible **Restore** control follows each ignored run, always shown under `pointer: coarse`); under **Annotate**, **Previous / Next** walk the low-confidence words in order, wrapping at both ends (#634; seek + scroll, and in Correct mode the word also opens in the editor); a one-line mode hint under the toolbar says what each mode does to audio; timeline-only follow/seek; cut-away hidden by default with **Show cut away**; **Follow** centers the active word; unlock via toggle or manual wheel / touch / scrollbar / scroll-key input — programmatic and re-measure scrolls never unlock; transcripts with ≥200 turns (back off below 150) virtualize variable-height turns and keep the active, selected, focused, inline-edited, and scroll-request turns mounted so presence/follow anchors resolve and focus survives scrolling; tradeoff: browser find-in-page, screen-reader browse mode, and text selection only reach mounted turns — the list exposes `role="list"` with `aria-setsize`/`aria-posinset` so assistive tech knows it is partial), **History** (human-readable step titles; click a mutation for a prose summary, optional raw JSON; only the latest diff load applies, and a selected step that leaves the list (redo tail dropped, history reloaded) clears its selection, diff and pending load; lists of ≥200 steps (back off below 150) virtualize through the shared `useVirtualRows` hook and keep the selected and focused steps mounted, exposing `role="list"` with `aria-setsize`/`aria-posinset`; tradeoff: Tab / Shift+Tab reach off-screen steps because focus scrolls the list and the overscan mounts the next rows, but a fast burst of presses can outrun the mounted window and move focus out of the list), edit impact, **pipeline** (run + progress). Volume envelopes appear on the Volume envelope overlay and in the track volume workspace. Select a track, then choose Add/Edit volume envelope (View volume envelope on shares). |
| Status bar | **Presence: You + N guests** (share guests only, `guest-…` ids or role `guest`; other hosts and agents listed separately; the roster names are in the tooltip), pending review, **Edits in removed audio (N)**, **Cut m:ss of m:ss** (longest dialogue-track source length minus the latest dialogue clip `timeline_end`, so ripple, trim and structural cuts count, not only remove decisions, and a music bed longer than the talk (cut or not) neither inflates nor hides it; with no dialogue media it uses the longest track and `timeline_duration_sec`, as it does when those tracks have no clips; gaps or clips moved past the source end offset it; hidden without source media), social clip count, **Render: fresh/stale** (same `staleRenderBreakdown` as the transport pill, so the two never disagree), **Transcript: needs sync** only while reconciliation is stale, pipeline status shortcut — chips jump to the matching tab |

Keyboard word actions: in Navigate mode, Enter on a focused timed word seeks
through its native button action. F2 opens inline correction for a hydrated
host project. F2 does nothing in Correct or Select mode, on guest shares, or
while a correction is saving. Enter retains the native Correct/Select word
action in those modes; Enter in the inline editor saves and Escape cancels.

### Responsive shells

`MobileShell` and `StudioShell` are memoized live adapters over the props-only
`MobileShellView` and `StudioShellView`. The views own shell layout, navigation,
guest visibility, ingest chrome, and sheet rendering. The adapters retain DAW
selectors, runtime content, viewport and gesture effects, focus/presence refs,
commands, sheet eligibility, and timeline header memoization. Catalog fixtures
use bounded pure regions and representative transport controls rather than the
full DAW page. See [shell chrome](design-system.md#shell-chrome).


Shared dialog close buttons and Share actions/checkbox labels use the tokenized
44px touch floor. Reading forms also enlarge shared actions and supporting labels
without changing dense editor controls. The [component consistency audit](design-system-audit.md)
records the verified phone examples and outstanding composition work.

Phone (`<768`), tablet (`768–1100`), and desktop (`>1100`) share domain components but not the same chrome. Phone uses Listen / Timeline / Text / More modes and one Inspector or Mix sheet. More → Mix shows all tracks in project order with saved Volume and capability-dependent M; S stays local. Opening Mix exits inspection, and navigation or new selection invalidates it. Close, Escape, and its scrim return to More. The timeline rail remains identity-only at phone width. Touch long-press selects clips, words, comments, and tracks; swipe left resolves an eligible host comment; double-tap a word opens correction. Full map, wireframes, and desktop back-apply: [gui-mobile.md](gui-mobile.md).

On a touch screen the phone and tablet shells are `position: fixed` and pad themselves with `env(safe-area-inset-*)` (`index.html` sets `viewport-fit=cover`). The page under them never scrolls. iPhone Safari gives a page no way to hide its bars, so the Home Screen app (`display-mode: standalone`, from `public/assets/app/manifest.webmanifest`) is the phone's full-screen path; a Safari tab shows a dismissible Add to Home Screen banner once per browser. A phone held sideways (at most 40rem tall) gets 72px touch lanes and no empty marker row, and the tool rail carries **Undo** and **Redo** on both touch shells. Detail: [gui-mobile.md § Browser chrome](gui-mobile.md#browser-chrome-safe-areas-and-home-screen-1077).

Host and guest shells reserve a banner row for offline command attention on all three sizes. Host pending edits remain visible there until replay; host and guest 409 conflicts appear in the same **Needs attention** list and can be dismissed. The guest share-mode label stays guest-only.

The desktop/tablet shell is a single-column grid with named areas `banners / follow / transport / main / tabs / status`; the phone shell uses `banners / follow / transport / main / nav`. Banner rows are always `auto` (0 when empty), and layouts change only the `main` / `tabs` track sizes, so a banner or layout never shifts another child. Guarded by `gui/web/src/layout/shellGrid.test.ts`. Desktop/tablet layouts are switched by the transport layout control, View › Layout, and `Mod+1`–`4`; a Restore chip in the transport exits any non-default layout (see `docs/gui-mobile.md` § Desktop — layouts).

### Live project reload

The viewer sanity-polls `GET /api/project/meta` every 30 s and when the tab regains focus (`SANITY_POLL_MS` in `gui/web/src/state/syncCadence.ts`; includes document `server_seq`; #662). Other processes' journal writes normally arrive sooner, over the socket, via the server's cross-process watcher (`services/document/cross_process_sync.py`, #695); this poll is the sanity net. `project_meta` is stat + `document.db` read, no project parse, never creates `document.db`. When `mtime_ns`, `size` or `server_seq` change (a `server_seq` change counts only between two readings; a response without `server_seq` is skipped) to a file this client has not already applied (from the document socket or its own command result) and local seq is behind, it re-fetches `GET /api/document/state?phase=shell` and merges into the timeline **without a browser refresh**. Playhead, zoom, and selection are preserved. JSON responses are gzip-compressed (`GZipMiddleware`); document WebSocket uses permessage-deflate (`ws_per_message_deflate=True` on uvicorn). Do not gzip audio `FileResponse`.

Host tabs subscribe once to `WS /api/host/ws` for session, document and recording planes. Document edits go through `POST /api/document/command`. A grant revoked by the 30 s authz recheck closes `4403`, which is terminal for the tab: `useHostSync` stops reconnecting until reload. A handshake refused at connect is closed before accept, so the browser sees `1006` and the tab retries with capped exponential equal jitter. On accept the server sends a hello `Snapshot` with `document_snapshot(projection="shell")` (same shell `ProjectView` as HTTP `phase=shell`); `Applied` events then carry closed deltas of their named projection against the installed sequence and state token so peer GUI edits and MCP cuts update the timeline without waiting on the poll. The client overlays hydrated `words[]` onto SHELL utterances by source clocks. Guests with `view` subscribe to `WS /api/review/{token}/daw/ws` (session + document + guest-initiated `plane: "progress"`, Presence inbound, sanitized snapshots) via `useGuestSync`; session messages echo the assigned `guest-{token}-…` `client_id` so ghosts do not treat the guest as someone else. `useProjectPoll` remains the 30 s sanity net for writes the socket did not deliver (writes that advance no journal seq, or a watcher read error; guests run it only while their socket is live).

### Progressive project load

First paint is three phases so the DAW grid does not wait on transcript `words[]` or history groups:

1. **Chrome** — as soon as `?project=` (or a guest `view` share) is known, mount `DawProvider` + `DawApp` with `project === null`. Transport, header column, timeline well, inspector, and tabs render as disabled/skeleton chrome. This is **not** the ingest empty-session (“Drop audio files”) path.
2. **Shell** — whichever arrives first: `GET /api/document/state?phase=shell` (default when `phase` is omitted), or the hello `Snapshot` on `WS /api/host/ws`. Both carry tracks, clips, duration, utterances without `words[]`, comments, and history groups in a sequenced envelope. `project === null` chrome lasts only until that first shell.
3. **Detail** — Host `GET /api/document/state?phase=detail` merges `words[]` and `history.groups` via `mergeProjectPatch` (does **not** call store `hydrate()`, which would clear waveform LRU). Detail requires the captured sequence and state token. A concurrent document change retries hydration against the current authority. Share guests request DETAIL only when `rangeEditMode` (`shareMode.ts`) is `suggest` (Commenter) or `edit` (Editor) (#6); `GET /api/review/{token}/daw/document/state?phase=detail` then keeps timed `words[]` minus suppressed words (`guest_selects_transcript_words` asks the document-command gate whether the share may submit `EditSelectedRange`). View/play/comment guests skip it and keep untimed utterance rows. Guest deltas are diffed on word-free views, so the client applies them to a word-free basis and re-overlays words by source clocks, refetching DETAIL when a row changed. HTTP `/daw/project?phase=detail` on a share still exists for OpenAPI/tools and is assembled without `words[]` or history (`dump_project_projection(..., audience="guest")`); sanitize then only strips host paths. Guest utterance rows deliberately keep `ignored_word_indices` and `edge_suppressed_word_indices`, which are per-track integer word indices with no text, timings or paths (#633, #752). `guest_transcript` (`gui/mapper.py`) drops `suppressed_only` rows (#758) and suppressed words, whose text guests never see.

`phase=full` is used for host predecessor recovery as well as tests and one-shot tools. Closed projection names (`ViewProjection`, `parse_view_projection`) live in [`projection_types.py`](../src/podcast_mcp/services/document_sync/projection_types.py); HTTP `?phase=` and WS slice assembly still dump via [`gui/assembler.py`](../src/podcast_mcp/gui/assembler.py) (ProjectView seam — see [architecture.md](architecture.md)).

Guest playback prefers **proxy media** when `GET /api/review/{token}/daw/proxy/manifest` returns tracks (`useProxyTransport` + Web Audio clip scheduler). Otherwise `useAudioTransport` streams WAV as before. See [host-online-relay.md](host-online-relay.md) § Proxy media.

### Audio transport

Track headers include a sample-peak playback meter with the shared dBFS zones
and peak hold. A clip light latches at -1 dBFS until **Clear clip light** is
activated, including after Pause, Stop, seeking, or switching responsive shells.
Wide headers keep that reset button. Narrow identity rails show a passive clip
indicator and expose the labeled reset in track details, so the reset target
does not overlap track entry. It resets for a different project or a removed track. These are track-output measurements before the
premix/master, not a loudness or true-peak measurement.

Proxy playback measures after each track's output gain and fades. Local
playback keeps its existing audible player path; silent synchronized track
monitors provide the individual readings while a premix plays. Missing or
loading monitor audio reports an unavailable meter rather than digital silence.
Guests using the premix-only fallback have unavailable per-track readings.
Meter sampling stops with playback. Reduced motion freezes the moving bars and
peak markers while clip detection remains active. The **Volume envelope** layer
still controls automation curves independently of playback meters.

Inspector sheets scroll as one region, including their header, actions, fields,
errors, related commands, and footer. The envelope workspace retains its draft
through view sizing and scrolling. On short phone screens, use ordinary scrolling
and the visible **Expand** action to reach complete controls. Opening the workspace
does not expand the sheet automatically. Focus transitions reveal the current
control within its sheet or desktop inspector; they do not scroll the page or
timeline. Desktop modifier inspectors scroll as one aside, with fields and
errors in natural flow.
See [responsive inspector evidence](https://github.com/calebn/sharecut-studio/pull/963#issuecomment-5998148488) for the text-size profiles
and owner acceptance limits.

The track’s **Add volume envelope** or **Edit volume envelope** action opens
`EnvelopeWorkspace` and shows the layer without creating automation. Its point
list selects by immutable ID; **Add point** and **Edit point** open numeric time
and level drafts. Time and Level use decimal text fields so wheel scrolling
does not step the draft values; the existing numeric validation reports errors.
**Save point**, **Delete point**, and removing the last point
use `SetEnvelope` with the exact ordered saved baseline and one undoable change.
Cancel, form Escape, and unchanged saves write nothing. A conflict preserves the
draft and offers **Discard draft and reload points**. Editor links edit volume envelopes as the host does; Commenter and Viewer
links expose **View volume envelope** without mutation controls. Timeline point drags retain
their local pointer ownership and cancellation behavior.

When the timeline / transport / track headers **or the Transcript tab** are focused (including after selecting transcript text):

| Control | Behavior |
|---------|----------|
| **Space** | Play / pause from the playhead (timeline clock) |
| **← / →** | Nudge playhead ±1s (Shift = ±5s) |
| **Mix** | Stream `artifacts/premix.wav` (full mix). A listen-only mute or solo, or a premix mixed before a volume/mute change (`render_status.premix.stale_vs_mix`), switches to the stem mix so the change is heard before a refresh. |
| **FX** | Stream processed stems (`artifacts/tracks/{id}.wav`) — edits + effects |
| **Per-track levels** | Stem and raw players play each track at its output gain (`gain_db + fader_db`). Media elements can't boost past volume 1, so when a track is boosted above 0 dB every track is lowered by that boost: the balance matches the mix. A saved-muted track's boost doesn't count (the premix leaves it out); solo and listen-only mutes do, so toggling them keeps levels steady. Players are rebuilt only when their sources change (the premix file, or each stem's render hash), so a volume or mute change applies while playing without stopping it, and a later edit to a stale stem still reloads it. |
| **Raw** | Stream source media (`raw/…`) — no FX; output gain in the browser. Playhead stays on the **timeline** clock; each track’s `HTMLAudioElement` seeks via clip `timeline→source` (same dual-clock math as `SessionTimeline` / `clip_timeline_point_to_source`). Mix/FX keep media and playhead aligned (timeline-length stems/premix). |
| **M** | Saved mix mute (`SetTrackMute` writes `track.muted`) for the host and Editors: solid chip; play, the premix (after Refresh) and bounce leave the track out for everyone. A saved mute beats solo. For other guests M is a listen-only mute (dashed chip, `viewerMute`); a saved mute shows to them read-only and M says why. If an editor still has a listen-only mute (from a saved session or a followed guest), M clears it too. Held keys don't repeat M or S. A saved mute is a mix setting, not access control: guests with `play` can still fetch a muted track's audio. |
| **S** | Listen-only solo for everyone (AFL-style; never saved, never exported). Tracks your solo silences show a dashed "implied mute" on M — its tooltip reads "Mute (M). Not muted: silent because you soloed another track, and only you hear it that way" — and they go grey like a saved mute, as DAWs grey a muted region (`mute-implied`): the header row, lane and phone Mix row take `--color-track-muted`, clips paint `--color-clip-muted` over their lane colour without the sheen (the label stays white at AA), and the waveform turns grayscale at `--mute-waveform-opacity`. No text fades. Solid = saved in the mix; dashed = only you hear it that way, so a listen-only or implied mute also dashes the row's identity stripe, the phone initials chip and the Mix tile outline, while a saved mute keeps them solid. One source drives every surface: `trackMuteState` through `useTrackMuteState`, mapped to classes by `MUTE_STATE_ROW_CLASS`. While any track is soloed a **Solo on · Clear solo** button (`track.clearSolo`) sits in the corner above the track headers, at the ruler row, on desktop and tablet (where DAWs put solo-clear, and clear of the transport title); a narrow (tablet) rail stacks "Solo on" over "Clear solo". On phone it sits in the status row above every mode body and at the top of the Mix sheet. Solo turning on or off is announced in the live region ("Solo on. Other tracks are silent for you only." / "Solo off. Every track plays again."). |
| **Volume** | Track inspector fader: saved `fader_db` (`track.setVolume` → `SetTrackFader`), −60 to +12 dB on top of the staging gain the pipeline's balance step writes (balance never touches it). Below the fader, Balance status says not measured, current or stale and shows the last measured LUFS plus “ungated” when speech gating fell back. Each step shows and plays at once (the premix is marked behind, so Mix switches to stems); the last value of a burst is saved 300 ms after it (one undo step). Mix changes send one at a time; an unsaved or queued value stays shown over server snapshots until it lands, and undo, redo and hiding the page send it first. Double-click or **Reset** sets 0 dB. Read-only without `edit`, with the reason shown under it. The header's **Out** readout shows the output gain. |

Audio is served by `GET /api/audio?path=&kind=premix|stem|raw&track_id=` with HTTP Range support and an `ETag` (mtime+size) so Range revalidation can hit the browser cache. Resolution of full files goes through **`PlayService.resolve_transport_path`**. Optional `rerender=true` matches CLI `--rerender`. A premix re-render merges its save (`ProjectWorkspace.save_merged`). If a concurrent edit changed the same value, the route answers 409 with the "re-run it" message instead of serving audio. The Sharecut Studio FX transport passes `rerender=true` (plus a cache-bust `v=`) when a track’s stem is stale — e.g. after Track inspector **Bypass** toggles — so A/B audition hears the new chain. While another render holds the render lock, a rerender request serves the existing premix/stem with `X-Sharecut-Render-Busy: 1`, or returns 503 `project_busy` when there is none. The header is an API signal for scripts and agents: the Sharecut Studio transport loads audio through `<audio src>` and does not read response headers. A busy fallback does not rebuild the stem, so its hash stays stale (`stem_is_fresh: false`) and the Mix out of date indicators stay until a later Refresh or rerender succeeds. Generated audition WAVs in `artifacts/play_cache/` are retained for at least one hour after creation or reuse, including during count-based cleanup; cache maintenance and reuse serialize across processes with a cache lock. Last use is the file's atime, so an external reader (Spotlight, a backup or sync agent) also counts as use and can keep an unserved WAV ahead of more recently served ones during count-based cleanup; the file-count caps still bound the cache.

#### Decision: Mute is saved mix state; solo is listen-only

<!-- decision
id: D-mute-saved-solo-listen-only
status: accepted
date: 2026-09-24
decided-by: calebn
evidence:
- #386 owner: "Volume is saved." and "S stays listen-only for everyone, like Pro Tools' AFL/PFL solo"
- #386 owner: listen-only solo "avoids the known 'exported while soloed' trap"
- #414 browser QA: the fader saves to the file, Cmd+Z reverts M, solo shows the implied mute
- #936 phone Mix sheet: an independent verifier passed 16 of 16 live cases
- #1102: tracks your solo silences go grey (row, lane, clips, waveform), and a Solo on · Clear solo button sits above the track headers on desktop and tablet and in the status row on phone. Pressing it moves focus to the soloed track's S button (the first S button if several were soloed; the tracks region or phone body if none is on screen), so keyboard focus never drops to the page (before/after screenshots on the PR)
enforced-by:
- tests/test_track_mix.py::test_output_gain_adds_the_fader_to_the_staging_gain
- tests/test_track_mix.py::test_only_the_host_and_editors_may_change_the_mix
- gui/web/src/tracks/TrackMuteSoloButtons.test.tsx::marks solo as listen-only
- gui/web/src/tracks/TrackMuteSoloButtons.test.tsx::shows a track silenced by your solo as an implied mute
- gui/web/src/tracks/TrackHeader.test.tsx::dims the row your solo silences, with the same state as its M
- gui/web/src/commands/solo.test.ts::clears every solo in one step and announces it
- tests/test_brand_color_roles.py::test_muted_track_keeps_text_contrast
- docs-sync: decision-track-mix
-->

Volume and M follow the DAW convention: they are the saved mix, so the host
and `edit` guests change them for everyone, and each change is undoable. S
never changes the saved mix or an export, because a saved solo in a shared
session would silence tracks for every collaborator and every export. A solid
chip means saved; a dashed chip means only this listener hears it that way.
The 2026-09-24 decision called that style "dim"; #414 shipped only the dashed
M, and #1102 added the dim: a track your solo silences goes grey like a saved
mute, dashed rather than solid. The global Solo on button clears every solo
in one step. The owner chose not to add a separate listen-only mute
for editors.

### Waveforms (pyramid tiles)

Clip waveforms come from a min/max/RMS **peak pyramid** per media file (`.wfpk`, [waveform.md](waveform.md)), which the host builds when tracks are added, re-pointed, ingested or landed, and when stems render. Knobs live in the `waveform` block of [`contracts/timeline-zoom.json`](../contracts/timeline-zoom.json) (generated into `gui/web/src/utils/timelineZoom.generated.ts`).

| Layer | What |
|-------|------|
| **Refs and status** | Each clip draws one media ref: in FX mode the lane's `stem:<id>` while the stem is fresh, otherwise `source:<source_id>` or `track:<origin track>` (`waveform/mediaRef.ts`). `waveform/statusStore.ts` polls `GET /api/waveform/status` once per (project, kind). It backs off 1 → 2 → 4 s while anything is generating, stops otherwise, and polls again at once when the media signature changes (`WaveformStatusSync`, mounted by `TimelineView`) or after a tile 404. |
| **Data** | `waveform/pyramidStore.ts` fetches data tiles (visible before overscan before prefetch, in runs of up to 16), never aborting on zoom or scroll. When a ref becomes ready, it prefetches the coarsest levels. At deep zoom the host adds `(min, max)` PCM blocks (`waveform/pcmStore.ts`); guests stop at pyramid level 0, and raw samples never go to guests. |
| **Render tiles** | `timeline/WaveformLayer.tsx` (memo, primitive props) splits a clip into 512-CSS-px tiles anchored to the media. Tile `k` covers media seconds `[k·512/zoom, (k+1)·512/zoom)`, so moving, trimming or splitting a clip only moves tiles and never re-rasterizes. Tiles mount for the view plus 512 px of overscan per side, from a selector that returns the tile range as a string. Each `canvas.clip-waveform-tile` covers only its part inside the clip, at paint DPR `min(round(dpr·8)/8, 2)`. The layer (`.clip-waveform`) and its snap-tick and mute overlays sit on the clip's border box, so waveform x matches ruler x. Clips narrower than 6 px draw no layer. |
| **Raster** | A worker rasterizes each tile with WebGL2 on an `OffscreenCanvas`, falling back to the CPU after a context loss or without WebGL2. The main thread runs `drawImage`, and turns a CPU tile's transferred pixels into its bitmap (a worker never builds one; see [waveform.md](waveform.md)). A crashed worker is restarted up to twice (re-armed after 64 finished tiles), and layers ask again for the tiles it held; a tile that keeps failing is retired until reload. Once the restarts are spent the backend is `none`. The look is two-tone: the RMS body in the lane's core tint and the peak envelope in its edge tint (`waveformStyle`, `timeline/waveformTheme.ts`). Both backends shade from the same column geometry. `.timeline-area` carries `data-waveform-backend` (`webgl2`, `cpu-worker`, `none`). Bitmaps live in an LRU with a 128 MB budget (48 MB on the phone shell) that calls `close()` on eviction. While a tile's exact bitmap is pending, the nearest-zoom cached bitmap that overlaps it stands in, or a render from a coarser level that is already loaded. **Shift+ArrowUp/Down** or View › Waveform amplitude −/+ sets amplitude zoom (`view.waveformZoomIn` / `Out`). View › Waveform scale picks Auto (dialogue lanes in dB with a −54 dB floor, other roles linear), Linear or Log. **Show waveforms post-fader** scales each lane by `gain_db + fader_db`, rounded to 0.5 dB. The scale, amplitude and post-fader flag are remembered per project in this browser (`sharecut.waveformView`, `utils/waveformViewPref.ts`; not a durable store). Past 50 ms per column the peak envelope is dimmed so the RMS body leads. A theme flip re-tints. |
| **Snap overlay** | The quiet wash comes from max-pooled pyramid columns at CSS-px resolution, at 8 px/s and above. Snap ticks come from `GET /api/waveform-snap` (`EditService.waveform_snap_window` → `preview_inaudible_cut` + windowed islands), around the dragged trim edge, else the blade hover inside the clip, else the paused playhead inside it (`hooks/useSnapTicks.ts`). Ticks still load around the trim edge, the blade hover or the paused playhead (magnet for trim, blade and body moves), but **draw only while trimming or in blade mode**. Ticks show only while the focus stays in the window they were loaded for (same project and track). Each focus loads around its position snapped to a 0.5 s source grid, so a moving trim edge or blade hover still gets ticks and refetches only when it crosses a step. They magnetize blade and trim. View › Layers **Silence shading** and **Snap points** (with colour swatches) hide the wash and the tick lines; hiding them doesn't turn snapping off. Pending edges use the same snap ticks when dragged. Hiding tick lines does not disable their magnet. View-only guests get the wash only. Theme: `--color-waveform-quiet`, `--color-waveform-snap`. |

| Route | Response | Notes |
|-------|----------|-------|
| `GET /api/waveform/status?path=&kind=raw\|stem` | JSON `{format_version, media: {ref: entry}}` | `ready` (key, sample rate, channels, frames, level table) / `generating` / `unavailable` (`no-media`, `decode-failed`, `unsafe-id`); missing pyramids are queued. `no-store` |
| `GET /api/waveform/tiles/{key}?path=&ref=&level=&start=&count=` | octet-stream | Concatenated bins of data tiles `[start, start+count)` (1–16), clipped at the level end; no project parse. Immutable |
| `GET /api/waveform/pcm/{key}?path=&ref=&block=` | octet-stream | Host only: int16 `(min, max)` per frame for one 65,536-frame block; **409** when `key` is not the ref's current key; **503** + `Retry-After` when every compressed-media decode slot is busy. Immutable |

Errors send `Cache-Control: no-store`. Guests get raw-media status and tiles under `/api/review/{token}/daw/waveform/…` ([host-online-relay.md § Guest Sharecut Studio APIs](host-online-relay.md#guest-sharecut-studio-apis-token-scoped)).

Waveforms never block play, seek, edit, scroll, or `add_track`. `TrackLane` shows a "Generating waveform…" hint while any ref its clips draw is generating. It shows "Waveform unavailable" when every ref is known and none has a pyramid. The hint is `.lane-waveform-status`, and the lane carries `data-waveform-status`.

**Budgets (CI):** Vitest covers the tile geometry, envelope reductions, shading, stores and layer (`src/waveform/*.test.ts`, `timeline/WaveformLayer.test.tsx`, and `timeline/WaveformLayer.raster.test.tsx` (the real raster client with two layers: drop and crash re-requests)). Playwright `e2e/waveform.spec.ts` checks that tiles come from `/api/waveform/tiles/` (at most 384 KiB per response). It also checks that no `/api/audio` window is requested, that tile canvases are painted and that the tile count stays within the view plus overscan. It also crashes the raster worker through the E2E hook and checks that a new one renders and paints tiles. On Chromium it expects `data-waveform-backend="webgl2"` and `rasterParity() ≤ 2/255`. Guests draw through the share route with no PCM. The compat matrix accepts `webgl2` or `cpu-worker`, and `e2e-compat/deep-zoom.spec.ts` checks ruler, tile, envelope and scroll geometry at the one-hour ceiling (15 M px) on Chromium and WebKit.

Pending **Current / Suggested / A/B** audition plays the server's rendered pending preview for every pending edit, the same render as `play_pending_preview_tool` / `podcast play pending-preview`. Current is the project as it is around the edit. Suggested is the edit approved on a snapshot (ripple, `replace_gap_sec` paced pad, fades, mute), so the editor hears what approving ships. Both mix their window from per-track segment renders at the headroom trim the premix gets for the current mix, so a fader or mute change re-measures the mix peak instead of re-mixing the premix ([daw-editing.md § Listen-first pending preview](daw-editing.md#listen-first-pending-preview)). **A/B** is one WAV: Current, ~0.4s gap, then Suggested. The pending inspector footer and Tighten **Preview** (`tighten.previewHit`) both go through `audio/pendingPreview.ts`: the host fetches `GET /api/pending-preview`, a share guest with `play` the token route `GET /api/review/{token}/daw/pending-preview` (agent twin: `guest_pending_preview`; relative URLs, not host speakers). The WAV plays as a source preview owned by `pending:{edit_id}` until its length (read from the WAV header) runs out. A host approval or Suggested preview held by changed cut scope returns HTTP 400 with `X-Sharecut-Error-Code: cut_scope_changed` and names the held cut. Source geometry also checks operation lanes: parked MUSIC holds as `operation_scope`, while voiced parked media still needs fresh speech evidence. Suggested uses its private snapshot. Saved approval adds its unchanged-batch assurance only after history and registered editable/render recovery complete; an uncertified restore preserves the original failure and forces authoritative workspace reload. The pending view's `suggest_reason` disables Suggested and A/B with its reason: splits have no Suggested side, and an edit off the current timeline (or a stale exact range) cannot play at all. Mutes and track punches render Suggested.

### Shared document state

The DAW installs document input through `document/applyDocumentUpdate.ts`. Its authoritative server view is separate from bounded pending display drafts. Ordinary command results carry closed deltas against a sequence and opaque state token. Missing predecessors recover through `GET /api/document/state`, with one request and a required sequence head. Bootstrap, polling, HTTP replies, sockets, and detail hydration share the same project-generation guard. Guest state uses the matching share endpoint and sanitized deltas. See [session-sync.md](session-sync.md) for the protocol and cache contract.

### Shared session state (agent ↔ DAW)

Agent, CLI, local DAW tabs, and future remote web users are **clients** of one sync engine (`SessionSyncService`). Authority: sqlite `artifacts/session/sync.db` (append-only command log + per-field LWW snapshot) is the only session store; read it through `get_session_state_tool` / `SessionSyncService`. Full design: [session-sync.md](session-sync.md).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/session/meta` | `server_seq` / mtime (or `exists: false`) |
| `GET /api/session/state` | Materialized snapshot + `clients[]` (404 if empty) |
| `POST /api/session/command` | Submit typed command (agent = viewer = cli) |
| `POST /api/session/state` | Viewer blob → typed commands (Ack, presence heartbeat, durable deltas); socket-down fallback |
| `WS /api/host/ws?path=&client_id=&document_client_id=` | Session, document and recording planes on one host connection; independent initial snapshots and cursors; inbound session transport, presence and recording commands; document edits remain HTTP |

**Agent → DAW:** `PlayService.play()` emits `PlayOsAudio` (speakers only — DAW seeks/highlights) or `AuditionInViewer` (`dry_run=true` — browser plays). `SessionControlService` / MCP session tools submit the same typed commands; optional `selection` / `set_session_selection_tool` highlights a modifier in the inspector. WebSocket fanout updates open tabs immediately for in-process writers (host MCP, GUI routes); a separate process (stdio MCP, `podcast session` / `podcast play`) reaches tabs within the 30 s sanity poll, or at once on focus.

**DAW → agent:** presence (cursor, viewport, live playhead) publishes over **WebSocket** `Presence` frames. The server fans that out as per-client `PresenceDelta`s, not a full roster resend (`docs/session-sync.md` § Server → client: `Presence` / `PresenceDelta` / `RosterRequest`); MCP's `get_session_presence_tool` still reads the flattened live roster regardless. Durable deltas (mode, selection, mute) go over the socket as one `ViewerState` frame per debounced change while it is live; `POST /api/session/state` is the fallback when the socket is down, the server rejects the frame, or no `Echo` arrives within 1.5 s of the oldest unechoed frame. Continuous playhead while playing must not emit durable `SetPlayhead` Applied events (that re-seeks the browser audio and stutters). Followers omit `playhead_sec` / `is_playing` from that snapshot.

**Transport authority (Figma-like):** each DAW tab owns its own play/pause clock. Agent commands (`SetRegion` / `AuditionInViewer` / `SetPlaying` from role `agent`) may drive transport; other viewers’ `SetPlaying` / playhead echoes are ignored (ack cursor only). Local Play clears any leftover agent `playUntil` auto-stop so a prior audition region cannot halt free scrubbing. Agents call `get_session_state_tool` (or `podcast session status`) before “cut from here”; prefer the viewer entry in `clients[]` for the live playhead while transport is rolling.

**First Snapshot:** the DAW applies agent transport from the connect snapshot **before** recording `last_command_id` as applied (see `gui/web/src/session/dedupe.ts`), so an in-flight agent play still seeks/highlights when a tab opens mid-command.

Keep the viewer pointed at the same `episode.project.json`.

### Presence (avatars and ghosts)

The transport **avatar stack** (max three + overflow menu; collapsed bar and phone **More** list the same people) shows live clients. Click an avatar to follow. Ghost cursors, remote playheads, and clip selection boxes render on the timeline (`pointer-events: none`, `aria-hidden`). Display names come from `meta.display_name` (role badge from server `role`). The followed person sees a follower **count** only. While you are following, copied **playhead / viewport** are not broadcast (Figma still shows an independent mouse; a DAW playhead that lags 100–300 ms behind the leader would draw a second needle). Overlay also ignores leftover playhead on any client with `meta.following`. Independent cursor still publishes. Guests adopt the server-assigned `client_id` before drawing the roster; until that id is known, ghosts stay hidden so a followed guest never sees their own cursor. Remote playhead ghosts advance between presence frames from the server-stamped transport and its playback rate. Paused ghosts hold their position. Unstamped or invalid transport falls back to the first finite of `meta.transport.playhead_sec` and top-level `playhead_sec`, clamped to `[0, timeline_duration_sec]` on the receiver (`remotePlayheadSec` → `clampToSession` in `utils/time.ts`, shared with transport seek, the ruler and pointer-to-time; the upper clamp is skipped while the duration is unknown); when neither is finite nothing is drawn. A remote playhead's avatar chip sits at the top of the lanes just right of its needle, clear of the marker rows.

### Follow mode

Follow correction reads the active player's timeline position every 250 ms without subscribing React to each playhead tick. Publication also reads that live clock, so frame delays do not become transport drift. Play, pause, and rate changes apply immediately. Leaders publish transport once per second during steady playback and immediately on play, pause, seek, or rate changes. Same-position seeks still cancel owned source preview.

Click an avatar (desktop) or **Menu / More → People** (tablet/phone) to follow.

| Shell | Look | Hear | Degradation |
|-------|------|------|-------------|
| Desktop / tablet | Viewport (zoom + pan), tab, transcript scroll, selection, canvas ghosts (no duplicate playhead) | Audition Full mix/Edited stems/Original, mute, solo | — |
| Phone | Tab → Listen/Text/More mapping; playhead at the Ferrite center needle. Zoom/scroll is **not** copied. | Same as desktop when capable | Host-only tabs stay More-hub-unavailable; banner names the tab |
| Guest share | Transcript / Comments tabs only | Mix only | Banner: “· in Pipeline (host-only)”, “· auditioning FX”; “· Listening in Mix” when Mix is forced |

Guests stay on Mix at the store (`setAuditionMode`), TransportBar, `transport.audition`, Follow (`planFollowUi` always applies Mix), and session snapshots (force Mix; never copy host mute/solo). Track inspector **Preview effects at track start** goes through `transport.audition` and is disabled for guests.

A banner and colored timeline border show who you are following. Strong local navigation unfollows: scroll, zoom, seek (including phone Listen scrub / ±15s), play/stop, tab / phone-mode switch, or **Escape**. Mute, solo, audition, and selection do **not** unfollow. Phone unfollow is also the banner **Stop following** control (44pt). Guests stay on Mix; capable hosts mirror the leader’s audition. Hit targets use `min-block-size: var(--touch-min)` (`2.75rem`) under `@container app` (banner, More hub) and `@container transport` (Menu rows) at `inline-size < 68.75rem` — not `@media` viewport queries. Rubric and prior art: [session-sync.md](session-sync.md) § Follow scope.

### Comments tab (review feedback)

Timeline comments from `review.comments[]` (session clock). Hideable pins/range bars, transport **Comment** mode (click/drag ruler), Comments tab list with action-item check-off and resolve. A comment with `edit_decision_id` still pointing at a pending cut opens the pending inspector (Ask thread) instead of the generic comment inspector. Mutations via `POST/PATCH /api/comments` (same `CommentService` as CLI/MCP; optional `edit_decision_id` on create). See [timeline-comments.md](timeline-comments.md).

### Pipeline tab (orchestration)

The determinate Pipeline progress bar preserves its height inside short scrolling
panels. Its fill keeps the existing width transition only when motion is allowed;
reduced motion has no width transition. Profiling and its visibility regression
are documented in [testing.md](testing.md).

Configurable production spine — **visible params are the source of truth for Run** (same working set as MCP `pipeline_get_config_tool` / `pipeline_set_config_tool`). Master-detail checklist + param inspector; optional **Analyze** seeds heuristic patches into the form (not a hidden auto-run).

Pipeline and Tighten edits fetch the latest working set before each save, then reapply the requested change. Reset remains a direct `{ reset: true }` PUT. The endpoint has no revision check, so another client can still write between the GET and PUT.

`GET /api/pipeline/config` includes `whisper_models[]` (`id`, `label`, `size`, `description`, `cached`). The **Whisper model** control (`transcribe.model`) is a catalog `<select>` with **Downloaded** / **Needs download** chrome. Choosing a missing model opens a confirm Dialog (**Download** / **Use without downloading** / **Cancel**). **Download** reuses host-only `POST /api/bootstrap/run` with `components: ["whisper"]` and SSE progress (same job manager as first-run setup) — no second downloader. **Run** (Sharecut Studio, `POST /api/pipeline/run`, MCP `pipeline_run`, and CLI) does **not** download weights. If `transcribe_tracks` is selected and the working-set model is missing, the run fails fast (HTTP **409** / tool error). Download via the Pipeline picker Dialog, first-run wizard, or `podcast bootstrap --component whisper --whisper-model …`. **Use without downloading** still saves the model choice; Run stays blocked until bootstrap finishes. Guest/share cannot hit `/api/bootstrap` or pipeline config mutation. `components.whisper.ok` is true only when the working-set model’s weights are cached.

The **Precise word boundaries** checkbox (`transcribe.forced_alignment.enabled`) shows the host's resolved state from `GET /api/pipeline/config` → `forced_alignment` (`enabled`, `requested`, `installed`, `blocked`, `reason`; #780). With the aligner downloaded, it is checked by default when config is unset and remains switchable. When the model is missing, an unset request is unchecked and disabled; an explicit saved `true` stays checked and can only be switched off, which writes `false` through the normal config update. The blocked status explains that recovery action, and the field still offers the download. Under it the field always shows the `components["word-aligner"]` readiness (`opt_in: true`, size, a hint when missing; `pin_mismatch: true` when the snapshot fails its sha256 pin, and the field then says to download it again, which the same **Download word aligner** does). **Download word aligner** reuses `POST /api/bootstrap/run` with `components: ["word-aligner"]` and SSE progress through the shared `useBootstrapDownload` hook — the same one the Whisper dialog uses (`gui/web/src/hooks/useBootstrapDownload.ts`). Once downloaded and the field is on, the same slot shows **Re-time words**, which reads `GET /api/transcript/vocabulary`'s `edited_tracks`, confirms replacing any hand-edited ones (`confirmReplaceEdited`, the same helper Re-transcribe uses), then runs from `transcribe_tracks` with the run-only `retime_words` flag (plus `overwrite_edited` when confirmed) — same Whisper-weights gate as any run that includes `transcribe_tracks`, because that run still transcribes any dialogue track with no stored transcript. A second click while the re-time is starting is dropped by the shared `useSingleFlight` hook (`gui/web/src/hooks/useSingleFlight.ts`, also behind `useBootstrapDownload`). While the re-time request starts, the button reads **Re-timing…** with `aria-busy`, matching **Downloading…**. The missing-components list (`blockedComponents`) shows the aligner only when an explicit request is blocked by the missing model (`forced_alignment.blocked`, which a run refuses); other missing components are always listed.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/pipeline/steps` | Ordered step names |
| `GET /api/pipeline/config?path=` | Effective config, enabled steps, step metadata, param schema, component status |
| `PUT /api/pipeline/config` | Body `{ path, config?, enabled_steps?, unattended?, reset? }` — session working set |
| `POST /api/pipeline/analyze` | Body `{ path, apply? }` — starts a `kind=analyze` pipeline-slot job (`PipelineJobManager.start_analyze` → `analyze_working_set`) and returns `{ job }` (409 if a pipeline-slot job is running). `GET /api/pipeline/events?job_id=` streams the `health` then `digital_silence` phase headlines, with `current`/`total` counting dialogue tracks per phase (`analyze_health`, `analyze_silence`). StatusBar / phone chip copy reads `Activity: running · <headline> · n/N tracks`. `POST /api/pipeline/cancel` stops it between tracks (`cancelled`, `Analyze cancelled`, nothing applied); a cancel that lands after `apply` merged the patches keeps `result` (`applied: true`) on the cancelled snapshot, and the Pipeline tab shows it as applied. Switching projects mid-Analyze (or aborting `analyzePipeline`'s signal, even while the start POST is in flight) cancels the job, so an abandoned scan never holds the process-wide slot. The terminal snapshot's `result` is the Analyze response: heuristic proposals (`reasons`, `patches`); each reason carries `evidence` (measured values + threshold) and, for `pre_aligned`, `suggested_skip_steps` (a hint `apply` does not act on); `report_summary.tracks` lists per-track health numbers even with no reasons; `apply` merges only `patches` onto the working set as staged when Analyze finishes (config only, never `enabled_steps`), so an edit made during the scan is kept. When a GUI write starts while Analyze runs, the Pipeline tab does not trust Analyze's `config`: it re-reads `GET /api/pipeline/config` once that write settles (the **Analyze** button is available again as soon as the scan result is shown), so the pane matches the working set `pipeline_run` uses. After that re-read, a field stays highlighted only while it still holds Analyze's patched value. The Pipeline tab lists each reason with its `evidence` as a key=value line, offers an **Uncheck <step>** button for each `suggested_skip_steps` entry that is still enabled (once that write is the one applied, focus moves to that step's **Enable** checkbox), and shows `report_summary.tracks` in a collapsible **Per-track measurements** list. Another Studio tab or host viewer that saw the Analyze job running follows that job's own event stream (`waitForPipelineJob`), so an agent job that takes the Activity primary before Analyze finishes does not hide its end, and renders the same reasons and per-track rows from the terminal snapshot's `result` once per job id (a scan cancelled before a result renders nothing and leaves earlier results alone). For an applied result it re-reads `GET /api/pipeline/config` once any in-flight config write from that tab settles and highlights only fields that still hold Analyze's patched value; for an unapplied result (`apply: false`) the list is headed **Analyze suggestions (not applied)**, nothing is highlighted and the config is not re-read. A viewer that never saw the job running renders nothing. A project switch stops following it and another project's pane never adopts it; switching back to the job's project while it still runs follows it again. |
| `GET /api/pipeline/status` | Current / last job snapshot, scoped to the served project. A finished `kind=pipeline` run that reached `export_deliverables` carries this run's QC verdict on `result.export_qc` (`ok`, `issues`, `warnings`) and `result.export_qc_path` (same verdict as CLI `pipeline run` / MCP `pipeline_run`); `result` is null when the run did not export. The Pipeline tab does not render it yet. |
| `POST /api/pipeline/run` | Body `{ path, from_step?, only_step?, skip_steps?, enabled_steps?, unattended?, config?, use_working_set?, force_transcribe?, retime_words?, overwrite_edited? }` — 409 if busy; `force_transcribe` with `retime_words` is 400 |
| `GET /api/transcript/vocabulary?path=` | Host project terms, guest names, `show_title`, `prompt_limit` (null when prompting is disabled), `prompt_primer` (the domain punctuation primer), `revision`, and whether any stored transcript used a different vocabulary revision, and `edited_tracks` (track ids with `user_edited` transcripts, which Re-transcribe asks before replacing) |
| `PUT /api/transcript/vocabulary` | Body `{ path, terms, guest_names, base_revision }` — save per-project vocabulary; 409 when `base_revision` is stale (another editor saved first), 400 for invalid or prompt-overflowing vocabulary, 503 when the context lock is busy; Pipeline offers a run from `transcribe_tracks` when an existing transcript needs it |
| `POST /api/pipeline/cancel` | Body `{ job_id? }` — cancel between steps |
| `POST /api/pipeline/render-preview` | Body `{ path }` — background `PipelineService.render_preview` (same job queue; 409 if busy) |
| `POST /api/export/bounce` | Body `{ path, track_ids?, start_s?, end_s?, formats? }` — starts a `kind=bounce` job (`BounceService` → `export/bounces/`); returns `{ job_id, job }` immediately (400 on validation; 409 if a pipeline-slot job is running). Paths are on the terminal snapshot `result.paths`. Host GUI seeds Activity chrome from `job` then follows that job's own SSE stream (each subscriber has its own queue). Cancel between bounce phases is cooperative; a cancel that lands after files are written keeps `result.paths` on the cancelled snapshot. `BounceDialog` runs it through `runAnnouncedJob` (`state/runAnnouncedJob.ts`): `expectJobResult` before seeding the chip, then `announceJobResult` on success, so `useJobStatusAnnouncement` (desktop `StatusBar` and phone `MobileShell`) speaks "Bounced N file(s)…" instead of the generic Activity "ok" headline, never both (#704). Closing the dialog aborts only the follow: the server bounce keeps running, unannounced. |
| `POST /api/export/deliverables` | Body `{ path, formats? }` — `kind=export` job via `PipelineService.export_audio`; `{ job_id, job }`; `result.paths` and `result.master` (`master_qc.json`: the configured `target_integrated_lufs` / `target_true_peak_db` and the measured master; the progress message ends with the same one-line summary) on the terminal snapshot. The export reads the Pipeline tab's staged `master.*` (`run_defaults_for`), and re-masters when it changed since the last master. Guest render path is unchanged. `export.deliverables` (`commands/host.ts`, **Mod+Shift+E**, Menu → Project) opens `ExportDialog` instead of starting a render. The dialog loads the Pipeline working set (`GET /api/pipeline/config`) and shows the files first: the mastered WAV when `export.wav` is on (fixed; the Pipeline tab turns it off), each configured `export.formats` entry checked, and FLAC offered unchecked; it also shows the `master.*` loudness target. Export sends the checked specs as `formats`. While the job runs, the dialog shows the Activity chip's own snapshot (headline, `current/total` steps bar, elapsed, stale copy) and **Cancel export** posts `POST /api/pipeline/cancel` with the job id; cancel is cooperative: it stops the export before mastering, or before or during encoding (the running ffmpeg is stopped); a cancel during mastering takes effect once the master is ready. `export.audio.write_audio_formats` writes every deliverable to a temp and replaces `export/` only after all of them finish, so a cancel or failure leaves an earlier export untouched. Afterwards the dialog lists the written files and the measured master (`result.master.measured`), or names the failure with **Try again**, or says "Export cancelled. Files from an earlier export are unchanged.". A cancel that reaches the job after its files were written still ends `cancelled`; the dialog and the announcement then say "Cancel came too late. Exported N files to export/" and list them (`JobCancelledError.job` carries the terminal snapshot). The job runs through `runAnnouncedJob`, so its "Exported N files to export/" copy is the announcement too (#704). Closing the dialog leaves the export running on the Activity chip; reopening shows its progress. A project switch stops following it (`state/projectScopedSignal.ts`) and returns the dialog to settings; the server job is not cancelled and is never announced. A second export while one runs gets the server's 409 as the failure. |
| `GET /api/shares?path=` | Host share list with review versions and record invite closure (`invite_closed`, null for review links). Collaboration extension. |
| `POST /api/shares` | Body `{ path, role?, with_mcp?, review_version_id? }` — mint a link share (`ShareService.create_for_host`; publishes a review mix if none exists) |
| `POST /api/shares/{token}/revoke` | Body `{ path }` — revoke + cooldown (`ShareService.revoke`) |
| `POST /api/shares/record/{source_token}/replace` | Host-only body `{ path }`; replace a closed, usable record invite in its original room with the same role and expiry (`ShareService.replace_closed_record_invite`). Existing participant leases remain valid. |
| `GET /api/pipeline/events?job_id=` | SSE stream of progress + per-step timings |

The vocabulary editor shows the draft Whisper prompt character budget before Save. It strips and deduplicates the show title, terms, and guest names, then joins them with `, `. The count includes the punctuation primer when the configured limit can hold it. Smaller limits count vocabulary alone, matching the domain fallback. Counts use Unicode code points. Save is disabled above the limit and describes how to shorten the list. Disabled prompting leaves vocabulary available for refinement. Successful refreshes clear load and transient save errors, including busy responses. Validation and conflict messages remain visible.

**Modes:** Batch (`unattended: true`) waives align and refine when policy allows; Leave-gates keeps those gates — clear via skill/CLI (`podcast align done` / `podcast transcript refine-done`), then resume From step. Ambient agent presence is optional UX only (MCP is pull).

**Mix out of date UX:** Transport **Mix out of date** pill (hover/focus) highlights **cause regions** from `render.invalidations[]` (timeline bands for cuts/clips; header chips + light lane edge for whole-track FX/gain/mute). Premix → Mix audition cue; reconcile → StatusBar **Reconcile**. Host or Docs Editor may **click** the pill or press **Mod+B** (`render.refreshMix`) to rebuild stems/premix (clears per-track invalidations when stems go fresh). The wide-bar pill is one pill for everyone, which keeps the transport within 1280px: **Mix out of date** (hosts and Editors read **· Refresh** after it), or **No mix yet** when nothing is rendered, whether it was never rendered or a failed render left none (the guest wording has no Refresh, since a guest cannot take it); Full mix's tooltip and description add that Full mix is silent until the mix is refreshed; the refresh action is in its tooltip, its accessible name (…“Refresh mix.”), **Mod+B**, and the collapsed Menu's **Mix out of date · Refresh** item. Viewers and Commenters get the same hover highlight only, and their pill's name omits “Refresh mix”. Refresh start/result is announced via a polite StatusBar live region (`statusAnnouncement`). Invalidations are diagnostic (what changed since last fresh stem); stems remain whole-artifact.

A project with no source media or timeline clips stays **Mix up to date** despite empty-track creation invalidations; it does not show an audio error for the absent premix. The project view includes a non-sensitive `has_source_audio` track flag so guest shares still identify playable media after local media paths are redacted, including when source duration is unknown. Opening a different project resets per-project transport and error state; refreshing the same project preserves it. A refresh started for an earlier project cannot apply its result to the currently open project or clear that project's refresh progress.

While a coupled join change is still saving, competing clip fade, trim, roll, and move gestures wait. The existing join save flag guards gesture starts and commits, including commits after an asynchronous boundary read. This prevents an older individual fade from overwriting one side of a coupled crossfade.

Clip labels use the originating speaker when available, otherwise a human track label or role, followed by a readable duration such as `Avery · 17m 26s`. Accessible names include identity, timeline position, and full duration. The Clip inspector title includes identity and timeline bounds. Its details show the internal clip ID once. Delete and Ripple delete follow the constructive controls in a separate group.

Clip Inspector fade ranges preview a paired fade value and send one `SetClipFade` when the pointer or keyboard gesture ends, or when focus leaves ordinarily. Escape and pointer cancellation discard the preview. **Incoming transition** names the join from the previous clip into the selected clip. **Track actions → Smooth all joins** runs the existing track-wide recommendation command. The seam line rolls the join below its top badge. Pending hatch regions cover the complete lane height.

In Pending edit Inspector, **Snap to silence** starts checked without a write. Turning it off changes no bounds. Checking it again immediately submits one `UpdatePendingEdit` for the stored bounds with snapping enabled. **Apply timing** uses the current checkbox value. Approve remains a separate review action.

`GET /api/pending-edits/{edit_id}/cut-suggestion?path=` reads a pending source-clock cut or mute through `EditService`. It returns original and optimized bounds for the complete stored interval without a project or history mutation. The guest counterpart needs a Commenter or Editor link. The inspector shows both ranges, endpoint shifts, and signed duration change. It preserves timing drafts while loading and discards stale responses after project, selection, or bounds changes. **Use suggestion** applies exactly the displayed bounds through `UpdatePendingEdit` with `snap=false`; typed timing must be applied first. A changed exact range clears the prior optimizer boundary mode and confidence. Splits do not have this suggestion. Comparisons retain submillisecond precision. Timing saves carry the saved track, type, clock, and bounds, so a changed decision is rejected rather than overwritten. While a timing save is queued, further timing and review actions wait; replay conflicts appear in **Needs attention**.

Each track in the project view carries `fade_max_ms`: the longest edge fade the server accepts for clips on that track (`render.join_fade_max_ms` for dialogue tracks, `null` for other roles). The fade drag and the clip inspector clamp to it, to the clip length and to what the other edge's fade leaves before sending `SetClipFade`. This is the rule `set_clip_fade` enforces (`SetClipFade`, MCP `set_clip_fade`, CLI; `join_modes.clamp_clip_fades`). The batch fade writers (`fade_joins`, `recommend_and_apply_fades` / Smooth all joins, approve-time join fades, `apply_fade_recommendations`, split micro-fades) only cap dialogue fades at the track cap via `cap_fade_ms` (`crossfade_joins` is uncapped); they do not bound a fade by the clip length or the other edge, so a clip shorter than both fades can show overlapping fades until the next `SetClipFade` clamps it. It is a display copy: the writer re-reads the cap when it writes, and every TRACKS/CLIPS slice (including the one after each `SetClipFade`) rebuilds it.

UI shows determinate progress (`current/total`), total elapsed, and a per-step table with runtime plus a short **summary** (counts of fixes/changes from each step’s return value — e.g. reconcile suppress counts, tighten cuts applied). Concurrent runs are rejected. Skill: **podcast-pipeline-tune**.

Passes 0–8: History Undo/Redo, pending Approve/Reject (bulk + nudge), applied source MUTE Restore and Open History for cuts, clip fades/join, FX bypass, transcript correct/suppress, envelope points, chapter/social markers, blade/delete structural tools, and project/track/audio ingest via `POST /api/document/command`, plus closed document WS deltas from named projections (including TRANSCRIPT_AUDIO; compatible shell rows retain hydrated words) and agent selection sync. Guest shares with `suggest`/`edit` use `POST /api/review/{token}/daw/document/command` — see [daw-editing.md](daw-editing.md).

### Timeline layers (bottom → top)

1. **Clips** — pyramid waveform tiles (two-tone peak + RMS), quiet wash and snap ticks, fade curves (straight gain ramps with the attenuated side dimmed) and a fade handle at each non-cut top corner that slides inward with the fade length, with a live ms readout under it while dragged; trim strips on the clip edges and zero-length fade corners show only on hover (fine pointers), keyboard focus or selection and stay in the tab order while hidden, a join badge button at the top of each drawn join (opens the join popover: mode, length, Audition join; one open at a time; 24 px wide hit area inside the gutter, `--join-hit-min` px so it holds at any root font size) (inside the lane's top gutter above the clips, `--clip-inset-top` px so it holds at any root font size, clear of the fade corners, roll seam line and marker lane) (`TrackLane`; `|` cut, `╲╱` fade, `✕` crossfade; abutting neighbours both at least 24 px wide), crossfade border, width-tiered role/duration labels
2. **Volume envelope** — volume automation polyline from `envelopes[]` (toggle)  
3. **Pending edits** — applied edits draw as narrow, non-interactive seam/edge ticks with a
   top notch, above the clips (`.applied-edit-layer`, z above `.clip-block`; dense
   stacks are non-interactive for WCAG 2.5.8). They are projected client-side
   through the lane's current clips (`timeline/appliedEditTicks.ts`, #527), so
   later ripples, trims and splits move a tick to the post-edit join instead of
   drawing the record's stale pre-edit range. Records that no longer map to a
   clip appear only in **Impact → Applied edits**. A removal binds to the adjacent
   clip pair whose join carries its source clocks, and ties between clips that
   share a source edge go to the record's stored `timeline_*`. Every server
   `operation` has an explicit case (pinned by `tests/test_gui_readiness.py`).
   Ticks carry no hover title (the layer is `pointer-events: none`); labels live
   in Impact. The layer clips to the canvas, so a tick can never widen the
   scroll range. Pending `remove` regions stay hatched and `mute` regions stay
   solid (toggle). Each pending region fills its lane, while the minimum hit
   target stays inside the canvas and the visible hatch remains on its true
   timeline range. Only a source edit's true outer endpoints are
   keyboard-focusable drag handles; each moving edge snaps to current waveform
   ticks and clamps inside its matching source clip while preserving the other
   edge. Timeline commits use the exact displayed bounds. A clipped or
   ambiguous source endpoint disables that affected edge; another eligible
   outer edge remains adjustable. Selection exposes Approve/Reject beside the
   region; narrow labels and actions are anchored in a viewport overlay so they
   do not widen timeline scroll or cover the handles. The action panel stays
   above sticky track headers and below sheets. It scrolls when its contents
   exceed the free space above or below the region, and hides when neither side
   has room; the inspector remains available. Tiny unselected regions
   show their floating label on hover or keyboard focus, preventing dense cuts
   from stacking unreadable chips. Floating surfaces remeasure after timeline
   movement, zoom, and viewport resize. Changing projects or the underlying
   source clip placement cancels an uncommitted drag.
4. **Markers** — chapter diamonds, each with its title beside it (cut short to the room before the next chapter, hidden when there is none; full title on hover), + social clip regions above lanes (toggle)
5. **Prosody** (host only, off by default; View › Layers, #719) — per-segment bands from the `analyze_prosody` cache (tinted where energy falls), a stepped energy contour from the three stored energy thirds (scaled per track), phrase-boundary ticks (height = boundary strength; the segment end dashed) and a dot per prominent word. `pointer-events: none`. A `stale` profile draws dimmed with a lane label; `missing` / `unavailable` show only the label. Lane labels are plain text; one sr-only `role="status"` in the timeline summarises the non-fresh lanes ("Prosody: no profile on 2 tracks"). No pitch contour: the profile stores per-segment F0 statistics only. Data: `GET /api/project/prosody`, fetched once per project change, pipeline or host-MCP agent job start/end, or when the layer is turned back on (the way to pick up an `analyze_prosody` run from another process, e.g. a terminal `podcast pipeline run`; cross-process job adopt is on the ROADMAP) and shared with the transcript (`prosody/useProsodyOverlay.ts`); after a clip edit the timeline hides the layer until the refetch lands (the payload is tied to the clip layout it was mapped against), while the transcript keeps its word emphasis

Default zoom **fits the full `timeline_duration_sec`** into the measured timeline viewport (fractional `px/sec` allowed — waveform tiles stay 512 CSS px at any zoom). Manual −/+ sets a `userZoomed` flag; **Fit** (or double-click the ruler) clears it and re-fits. Container resize re-fits only while not user-zoomed. Session length stays clip-based (`timeline_duration_sec`) for Fit, Home/End, and the transport duration readout. When zoomed out so the session is narrower than the time column, the visible canvas and ruler extend to the viewport with ticks through empty time past the last clip (seeks still clamp to the session); zoomed in, canvas width stays session-based and does not stretch past the last clip. The phone's fixed playhead is the exception: its canvas is exactly the session and the lead pads fill the view (`docs/gui-mobile.md`). Tick labels stay clipped inside the canvas (`overflow: hidden` / end-aligned last tick).

**Zoom range:** 0.05 to 48,000 px/s, with a session-aware ceiling: content never passes `max_content_px` (15 M px), so an hour-long session stops near 4,167 px/s (`effectiveMaxZoomPxPerSec`, `clampZoomPxPerSec(zoom, sessionSec)`; [waveform.md § Deep zoom](waveform.md#deep-zoom)). A session-length change re-clamps around the view centre. Ruler steps run from 0.1 ms to 1 h (`niceTimeStep`, at least 70 px apart), and labels are `m:ss` for whole-second steps and `m:ss.f` to `m:ss.ffff` below that (`formatRulerTime`: `ceil(−log10 step)` decimals, 0–4), also used for the ruler's `aria-valuetext`, which truncates (`formatRulerTime(sec, step, "floor")`) so it never announces a time the playhead has not reached. Only the 2048 px chunks that meet the viewport mount ticks, and the Volume envelope layer draws the same way, so deep zoom never builds millions of px of DOM or SVG.

Horizontal scroll policy lives in `timeline/useFixedPlayheadScroll.ts` beside the vertical metrics module. The parent hook selects only store actions and uses the canonical scroller ref, fixed mode, measured viewport, committed session duration, zoom, and following client as render inputs. It owns lead registration and cleanup, canvas sizing, the shared DOM writer and echo marker, scroll classification, and the pointer zoom gate. Its immutable render binding supplies `TimelineScrollSync` and `FixedPlayheadRecenter`, separate child components in the same module. The sync leaf selects scroll and zoom and writes in a layout effect after canvas commit. The recenter leaf selects transport intent and recording state and preserves its passive effect. `TimelineView` retains measurement, gesture attachment, the loading zoom adapter, and desktop region reveal. Recording preview extent stays independent of the committed canvas and seek bounds.

**Lane geometry:** lanes default to a fixed height, `DEFAULT_LANE_HEIGHT_PX` (104px, equal to `COMPACT_LANE_HEIGHT` — the smallest height with the full header layout), not the stage fit. A per-browser preference at `sharecut.laneHeight` (`{"mode":"fixed"|"fit","px":number}`, read/written through `utils/laneHeightPref.ts` via `utils/storage.ts`, like `sharecut.tabsHeight`) remembers fixed vs. fit and the fixed px; it is not a durable project store (`docs/persistence.md` is unaffected). The UI slice holds `laneHeightMode` / `laneHeightPx` and the actions `setLaneHeightMode`, `toggleFitTracksHeight`, `stepLaneHeight`, all of which persist back to that key; it also holds `drawnLaneHeightPx`, the height the mounted `TimelineView` last resolved (null with no timeline, not persisted). **Fit tracks to window height** (command `view.fitTracksHeight`, a checkbox in the View menu and, on the wide transport bar, an icon beside Fit) switches to fit mode: lanes grow between `LANE_HEIGHT` (72px) and `MAX_FIT_LANE_HEIGHT` (240px) when every track fits, or stay at 72px and scroll with more tracks. The **Alt+= / Alt+-** step commands (`view.trackHeightIncrease` / `view.trackHeightDecrease`, `LANE_HEIGHT_STEPS`: 72/104/144/192/240px) always leave fit mode. From fit mode they step from the drawn (fitted) height, `drawnLaneHeightPx`, so Increase never shrinks the lanes and Decrease never grows them; from fixed mode they step the saved fixed height. `timeline/timelineMetrics.ts` `resolveLaneHeight({ mode, fixedPx, availablePx, trackCount, fit })` picks the lane height for the current mode (`fitLaneHeight` only runs in fit mode), bounded by `fit` (`LaneFit`): `pointer` keeps it as is, `touch` (a coarse pointer or the phone's fixed playhead) raises it to 104px, and `touchShort` (a screen at most 40rem tall whose primary pointer is coarse, `hooks/useShortTouchScreen.ts`; the capability, not the last pointer used, so a first touch never resizes lanes) uses the compact lane, `shortTouchFloorPx` (72px, or 3.25rem when large text grows the 2.75rem identity chip past it), for any fixed height, and fit mode never fills below it (#1077). On a short touch screen `markerLaneHeight` drops the empty lane's quiet row. Below `COMPACT_LANE_HEIGHT` (104px) `.timeline-area` carries `data-lane-density="compact"` and each desktop track header puts its name and M/S on one row with the **Out** readout under them, so nothing is clipped at 72px; the fixed default sits exactly at that floor, so it always shows the full header layout. One `ResizeObserver` (`ui/useResizeObserver`) on `.timeline-scroll` and its header column triggers both fits (the time viewport, `clientWidth` minus the headers → fit zoom, refit only for a new width or session length; height → lane height in fit mode only; in fixed mode the observer records the height but skips the refit, and a mode or fixed-height change re-resolves without waiting for a resize), measured first in a layout effect so the first frame is already fitted; the timeline re-renders only when the whole-px lane height changes, and desktop `.timeline-scroll` keeps a vertical scrollbar present so the fit cannot oscillate as tracks gain or lose vertical overflow. It uses the default scrollbar gutter so short lanes can reach the horizontal end; phone fixed-playhead mode scrolls vertically only when needed. The ruler and marker lane stay pinned at the top of `.timeline-scroll` while track lanes scroll vertically. Both pan horizontally with the track content; matching track-header chrome stays pinned above the header column. The marker lane shows one `MARKER_ROW_HEIGHT` (24px) row per layer with content (chapters, social clips, comments, and a `clipping` row of recording clip flags from `ClipRow.clipping_regions`, one per region per track; click selects the track and seeks; Markers layer), or one quiet row when empty; `TimelineView` computes those rows once and hands them to `MarkerLane`. Ruler, marker-row, lane and marker-lane heights are CSS px from `gui/web/src/utils/layout.ts`: `TimelineView` sets `--ruler-height`, `--marker-row-height`, `--lane-height` and `--marker-lane-height` on `.timeline-area` and timeline.css reads them, so rows line up with the code and the header chrome at any root font size. Overlays and headers read the live heights from `useTimelineMetrics()`, so the header column renders inside `TimelineView` (`headerSlot`) whenever a timeline is drawn, including a zero-track project viewed without ingest rights. Only the loading skeleton (which reserves the same default ruler + marker room as the header chrome) and the host's empty-session drop target keep it outside. While a clip move, trim, fade, roll or envelope drag is active, the drawn geometry (lane height, marker rows) is held (`useHoldTimelineMetrics`), so a collaborator's update — or a mode/height change — cannot move lanes under the pointer; it applies on release. A clip move drops on the lane its ghost showed rather than hit-testing again at pointer-up.

**State composition:** `gui/web/src/state/dawStore.ts` composes project, transport, presence, and UI slices into one Zustand store, wrapped in `state/writeBatch.ts`'s `dawWrites.middleware` (exported as `batchDawWrites`): every `set()` call made inside a `batchDawWrites(fn)` folds into one pending state instead of writing straight through, `get()`/`getState()` inside `fn` see the pending writes, and listeners fire once at the outermost batch's exit. It must stay the store's only middleware, since it swaps `setState`/`getState` in place. `hydrate()` keeps project-switch resets and zoom reclamping in one update; `applyAgentSession()` likewise updates the session, transport, and selection together. The mounted timeline/lanes DOM nodes and fixed-playhead lead pad are kept in `state/timelineViewportRegistry.ts` rather than reactive store state. `TimelineView` clears the registered elements on unmount; its `useFixedPlayheadScroll` hook clears the lead and clamps negative logical scroll to zero. Presence and zoom measure the registered nodes when needed.

**Inbound sync frames:** `useHostSync` owns the host session, document and recording planes. `useGuestSync` owns guest delivery. Both use `sync/inboundQueue.ts` for ordered state work and reject retired socket lifetimes. Clock sampling and the host's own ViewerState echo deadline remain at receipt. DAW writes batch once per animation frame, with a timeout while hidden. Full presence rosters can coalesce; durable updates and incremental presence patches cannot. Host recording snapshots commit the monitor roster synchronously before subsequent signals. Own-client HTTP document results flush prior inbound work first. `FakeWebSocket.emit()` delivers and flushes; `deliver()` leaves work queued for ordering tests.

**Render isolation:** components read the DAW store through `useDaw(selector)` / `useDawStore(selector)` (never the whole store; `state/storeGovernance.test.ts`). Use module-scoped `pickDaw("field", ...)` selectors for plain field sets. Governance checks their literal keys against the hot-field allowlist and rejects computed arguments. Use a custom `useDaw` selector for conditional projections of store values; build derived arrays and objects with `useMemo` outside selectors. Per-frame fields (`playheadSec`, `scrollLeft`, `sessionClients`, `pointerTrackId`, `bladeHoverSec`, `timelineViewportWidth`) are selected only by leaf components; the server clock offset is module state outside the store (`presence/clock.ts`'s `serverNowMs()`), read directly rather than selected; `presence/useLivePresenceClients.ts` reads it once per render, filters the roster to the live remote clients once at that time (returning `{ nowMs, others }`, with `others` memoised on the roster and its live ids so a clock tick or an unrelated prop change hands callers the same array; `PresenceOverlay`'s join/leave announcer keys its effect on those ids by value) and, while any is live, re-renders its caller every 5 s (`useIntervalTick`), so `PresenceOverlay`, `AvatarStack` and `PresenceGhostLayer` drop a peer that stops heartbeating without waiting for a roster update; handlers read them with `useDawStore.getState()` at call time, and `dawApp.tsx`, the shells, `TimelineView`, `TrackLane` and `ClipBlock` may not select them. `timelineViewportWidth` holds the current shell's estimate (as `measureTimelineViewport` falls back to) until `TimelineView` measures and again after it unmounts; a zero-width measure also stores the estimate, and a shell breakpoint change re-stores it from the live timeline (or the new shell's estimate), so it is never 0 or a previous shell's estimate. The leaves are `TransportEngine` / `FollowEngine` (playback and follow hooks, render nothing), `Playhead` (writes its `transform` from a store subscription), `TransportTimecode` (the transport bar's and Listen mode's playhead readout, `showTotal` toggling the `/ total` suffix), `PresenceStatus` (the status bar's presence chip), the `TimeRuler` root (while playing, its slider value, and so `aria-valuenow` / `aria-valuetext`, steps in quarter seconds and can trail the playhead by up to 250 ms; arrow-key seeks read the live playhead), `CommentPlaybackBubble` (the active comment id), `PresenceOverlay` (the roster), `WaveformLayer` (its tile range, as a string), `useVisibleChunks` (the on-screen 2048 px chunk range, as a string, for the `TimeRuler` and `EnvelopeOverlay` adapters) and `useSnapTicks` (the blade hover or paused playhead inside the clip, else null, so a playing playhead never re-renders a clip), and `TimelineScrollSync` and `FixedPlayheadRecenter` in `timeline/useFixedPlayheadScroll.ts`, plus `BladeGuide` and `FollowPlayheadChip` in `timeline/TimelineLeaves.tsx`. A handler that only needs the value at click time (the blade-cut button's `atTime`, `OverlayLegend`'s add-chapter) reads `useDawStore.getState()` inside the click callback instead of selecting the field, so the component itself never re-renders on the frame. `state/storeGovernance.test.ts`'s `HOT_FIELD_ALLOWLIST` names every non-test file allowed to select a hot field directly, each with a reason (a leaf like the above, or non-component code — command context, store slices, pure scroll math — that legitimately reads live transport/presence state outside render); a whole-source scan fails on any other file that does (any `s.<field>` read, or a selector that reads one off its parameter under any name or destructures it, nested patterns included: an arrow or `function` (with or without a return-type annotation) passed inline to `useDaw`/`useDawStore`/`useShallow`, or a hoisted one whose parameter's type names `DawState`; brackets inside strings, template literals and comments are ignored), and an `it.each` fails a stale entry whose file no longer reads one. `PipelinePanel` selects `selectAgentPresent` (`presence/presenceSummary.ts`), a boolean, rather than the whole `sessionClients` array, for the same reason. `sessionClients` is `presence/roster.ts`'s `SessionRoster` (`Record<client_id, SessionClient>`, not an array): a `PresenceDelta` replaces only its own entry and every other client keeps its prior object identity, so `PresenceGhostLayer`'s `GhostRow` and `PresenceOverlayView`'s `PresenceOverlayRow` — each a `memo` component keyed on `client_id` — re-render only the client whose row changed. `presence/roster.ts`'s `sessionClientList(roster)` is the array view components that iterate the roster select (`AvatarStack`, `PresenceStatus`, the follow hooks): memoised per roster object identity, so an unrelated store update hands callers the same array.

`StudioShell`, `MobileShell`, `TimelineView`, `TrackLane` and `ClipBlock` are `memo` components. Shell adapters remain internal, while `MobileShellView`, `StudioShellView`, and `ClipBlockView` are props-only renderers. The plain timeline and lane components are exported as `*View`; lane callbacks take the track id first and clip callbacks the clip id first, each one stable (`utils/useStableCallback.ts`), and idle fallbacks share the frozen constants in `utils/empty.ts`. Document snapshots and projection patches keep unchanged tracks, clips, envelopes, pending edits and applied-edit records by identity (`document/reuseUnchanged.ts`: `reuseByKey` generalizes the old `reuseById`, keying envelopes by `track_id` + `parameter` since they carry no id, and comparing envelope points point by point on their own keys (key-order-insensitive, nothing serialized) and any other nested value with no identity-safe field — a pending edit's `timeline_spans`/`track_ids`, an applied record's `params`/`track_ids` — structurally via `jsonEqual` (`utils/jsonEqual.ts`, shared with the waveform status store) instead of by reference), so an edit re-renders the edited clip and its lane neighbours only. `TimelineView` then slices the three overlay arrays (envelopes, pending edits, applied-edit records; tracks and clips are already per-lane) into one array per track (`timeline/laneOverlaySlices.ts`'s `useByTrack`/`groupByTrack`), reusing a track's own slice by reference when nothing on that track changed even though the whole-project array is a new reference; `TrackLane` receives its own slice as `envelopes`/`appliedRecords`/`pendingEdits`, so a change on one track's envelope or pending edit does not re-render every other lane. The presence publisher sends from `useDawStore.subscribe` (the transport frame on a playhead, play-state, playback-rate or follow change), and the Transcript panel selects its highlight (active utterances and words) as one key, not the playhead. `useCommand` caches its per-render tracks-id join (`ui/useCommand.ts`'s `trackIdsKey`, memoized per tracks array by `utils/memoByRef.ts`, the `WeakMap` helper also behind the transcript anchor-turn index and the low-confidence walkthrough stops (`transcript/lowConfidence.ts`'s `selectLowConfidenceStops`)) so an unrelated store update does not re-scan every track.

`useStableCallback` updates its implementation during commit, before layout effects. Call it from a handler or effect. The source test in `utils/useStableCallback.test.tsx` rejects supported direct calls during the owning function's eager evaluation. Babel scope bindings resolve lexical shadows. Typed expression wrappers, synchronous inline IIFEs, React's `useMemo`, lazy `useState`, and `useReducer` initializers are covered. Method creation and instance fields are deferred, while computed keys, heritage, static fields, and static blocks are eager. Parameter defaults have bounded syntactic argument handling. The check does not follow aliases, named helpers, child props, dynamic member names, or async and generator execution. A passing test covers local forms only. See the [frontend testing contract](../gui/web/README.md#testing) for parameter limits and fixtures. The hook does not throw at runtime. Its runtime tests retain the old committed callback through a suspended transition and expose the latest value after commit.

The transcript highlight index sorts utterance and word activity bounds by
timeline start and stores the running maximum end. Two binary searches prune the
candidate window on each tick, including backward seeks. Results keep transcript
row order and use the shared active predicates for overlapping speakers, split
spans, and instant words. A long overlapping row can still widen that window.

**Tools:** Select / Blade / Comment are exclusive icon tools in the transport (pointer / razor / bubble cursors on the time column). Fit (session width), Fit tracks to window height (wide bar only) and Menu stay as icon actions. Host **Menu → Share…** opens the share dialog (`ShareService` list/create/revoke; FOSS collaboration extension). With no review mix yet, Create link publishes **Share mix** first. A project with no rendered mix returns the typed `no_mix` conflict (HTTP 409, `X-Sharecut-Error-Code`), and the dialog says "This project has no mix yet. Refresh the mix to create the link." A stale premix returns the typed `stale_mix` conflict. Both show **Refresh mix**, which runs the existing render job command (the one behind the **No mix yet · Refresh** pill) and retries the captured create request only after successful completion. Stale-master errors explain that re-mastering is required ([share-tokens.md § Operator quick path](share-tokens.md#operator-quick-path)). Desktop/tablet bottom Transcript–Pipeline tabs are drag-resizable (`role="separator"`, `ns-resize`, persisted as `sharecut.tabsHeight`). The owning pointer previews clamped height; release retains it. Escape, owner cancellation or lost capture, focus departure and unmount restore the prior preference while the preview still owns that value. An unset default stays unset after cancellation or a gesture returning to its origin. A newer independent resize remains intact. Finite stored heights outside current viewport bounds are normalized on initialization. During pointer ownership, the separator consumes its resize keys without changing the preview. After release, arrow keys resize, Home/End use the bounds, and Enter or double-click resets to the CSS default. The phone uses inspector Expand/Collapse instead of this separator. The sticky track-header column stretches to the timeline well floor (surface plane under empty space below the last track).

Pinch-to-zoom and Ctrl/Cmd+wheel zoom are claimed only while the pointer is over `.timeline-scroll`, outside the track headers (spatial intent — no prior click required). Zoom keeps the **time under the cursor** (or the midpoint of a two-finger pinch) stable. Listeners use `{ passive: false }` so `preventDefault()` can own trackpad pinch (`wheel` + `ctrlKey`) and Safari `gesture*` events; plain two-finger scroll still pans. Typing in an input/textarea skips claiming. A successful gesture sets `timelineFocused` so keyboard zoom works afterward.

Keyboard **`=` / `+` / `-` / `\`** (zoom in / out / fit session width) require **`timelineFocused`**. `=` / `-` (and View-menu / transport zoom) anchor on the playhead when it is inside the view, else at the last pointer X over the timeline, else the viewport center. Transport ± and these keys share `applyAnchoredZoom` with pinch. On phone fixed-playhead mode, pinch and Ctrl+wheel still anchor under the fingers or cursor, within the session, and the playhead follows the new viewport center (the lead pads let that anchor scroll before 0). Fit, Transport ± and these keys center on the playhead's time instead, so they keep it. Page zoom remains available outside the timeline; bare keys avoid fighting browser Cmd±. **Alt+= / Alt+-** (also `timelineFocused`) step the fixed track height instead (72/104/144/192/240px); they match by `key`, and on Apple platforms also by physical `code` (US positions) when `key` is not a printable ASCII character, since macOS Option+= / Option+- report `key` as `≠` / `–`; elsewhere Alt keeps the layout's `key`, so there is no `code` fallback.

### HTTP API (localhost)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Smoke check |
| `GET /api/document/state?path=` | Atomic bootstrap/recovery envelope with `server_seq`, `state_token`, and named projection. `phase=shell` is the default; `detail` hydrates words; `full` provides all fields. Loopback pins `served_project` for host MCP. |
| `GET /api/project?path=` | Compatibility projection API without a document sequence. The DAW uses the atomic state endpoint. |
| `POST /api/project/close` | Loopback — unpin `served_project` (Studio New project) |
| `GET /api/project/meta?path=` | `{ mtime_ns, size, server_seq }` for live reload; stat + `document.db` read, no project parse, never creates `document.db`; `server_seq` is 0 when `document.db` does not exist yet and is omitted when it cannot be read, so a transient read error never looks like a seq change |
| `GET /api/audio?path=&kind=&track_id=&rerender=` | Stream premix / stem / raw via `PlayService` (Range + ETag) |
| `GET /api/waveform-snap?path=&track_id=&start=&end=` | Windowed inaudible-cut ticks + islands for the snap overlay |
| `GET /api/project/prosody?path=` | Cached prosody profile per dialogue track mapped to the timeline via `SessionTimeline` (`PlayService.prosody_overlay`); reads the `analyze_prosody` cache only, never computes (#719) |
| `GET /api/history/diff?path=&from_index=&to_index=` | Snapshot delta |
| `POST /api/document/command?path=` | Typed document commands (`UndoHistory`, `SetClipFade`, `TrimClipEdge`, `SetEnvelope`, `AddChapter`, …) |
| `POST /api/review/{token}/daw/document/command` | Guest document commands (capability-gated; see [host-online-relay.md](host-online-relay.md)) |
| `GET /api/pending-preview` | Host full-mix Current/Suggested/A/B WAV; authenticated, every pending GUI preview |
| `GET /api/review/{token}/daw/pending-preview` | Guest listen-first Current/Suggested/A/B WAV (`play`+`view`); unavailable Suggested/A/B returns 400 with `pending_preview_unavailable` and its authored reason, including splits that do not change the mix |
| `GET /api/review/{token}/daw/pending-preview-image` | Guest waveform/spectrogram of that extract |
| `GET /api/review/{token}/daw/proxy/{track_id}/{hash}/{i}` | Local proxy chunk fallback when object storage unset |
| `POST /api/review/{token}/comments/{id}/actions/{aid}/done` | Guest action-item toggle (`action` cap; MCP twin) |
| `GET /api/pipeline/steps` | Pipeline step names |
| `GET /api/pipeline/config` | Working-set config + step/param metadata |
| `PUT /api/pipeline/config` | Update working set |
| `POST /api/pipeline/analyze` | Heuristic Analyze (cancellable pipeline-slot job) |
| `GET /api/pipeline/status` | Pipeline job snapshot |
| `POST /api/pipeline/run` | Start pipeline (mutates project on disk) |
| `POST /api/pipeline/cancel` | Cancel running job between steps |
| `POST /api/pipeline/render-preview` | Start render-preview job (stems + premix) |
| `GET /api/pipeline/events` | SSE progress for the active/last job: per-subscriber queue via `stream_job_events` (connect snapshot, live events, 1s keepalive snapshot, terminal `done`) |
| `POST /api/review/{token}/daw/render-preview` | Guest Docs Editor (`view` + `edit`, `edit_commands_allowed`) — starts a `PipelineJobManager` render and returns 202 with a job ID (409 if busy) |
| `GET /api/review/{token}/daw/render-preview/{job_id}` | Guest Docs Editor (`view` + `edit`) — polls status for this share's project; paths sanitized |
| `POST /api/comments` | Create timeline comment (`CommentCreateRequest`) |
| `PATCH /api/comments/{id}` | Resolve or update body |
| `POST /api/comments/{id}/actions/{action_id}/done` | Check/uncheck action item with `by` |
| `DELETE /api/comments/{id}?path=` | Remove comment |
| `GET /api/shares?path=` | Host share list, including record invite closure (collaboration extension) |
| `POST /api/shares` | Mint a link share (`ShareService.create_for_host`) |
| `POST /api/shares/{token}/revoke` | Revoke a live share |
| `POST /api/shares/record/{source_token}/replace` | Replace a closed record invite in the same room with its original role and expiry; host-only. |
| `GET /api/record/state?path=` | Host record-room snapshot (404 if no room) |
| `POST /api/record/command` | Host record command (`Start` / `Pause` / `Resume` / `Stop`) |
| `GET /api/record/upload?path=` | Host full-quality recording ACK status for **all** participants |
| `POST /api/record/upload` | Host `p_host` full-quality recording chunks (5 MB part cap) |
| `POST /api/diagnostics/bundle` | Host-only sanitized diagnostics zip (`DiagnosticsService`; default `~/Downloads`; unique nonce in the filename) |
| `GET /api/diagnostics/bundle/{name}` | Download a zip registered by this Studio session (filename allowlist; not a scan of `~/Downloads`) |
| `POST /api/diagnostics/submit` | Host-only consented report submission; forwards only a bundle registered by this Studio process to `PODCAST_REPORT_RELAY_URL` |
| `GET /api/diagnostics/report-status` | Host-only polling of a status URL returned by a submission in this Studio process; queued, published, `publish_uncertain`, or failed |
| `GET /api/diagnostics` | Public distribution metadata (`support_url`, `privacy_url`, `repository_url`, optional `release_manifest_url`) for Help and other product links |

`ProjectView.comments` lists all timeline comments for markers + Comments tab.

Pending edits and combined transcript utterances in `/api/project` include **dual clocks** (`source_*` / `start`·`end` plus mapped `timeline_*` / `timeline_spans` / `mappable`) via `SessionTimeline` — the UI must not plot raw source times on the timeline ruler or seek the playhead with source clocks after cuts. Utterances also carry `words[]` (per-track tokens including suppressed, with `word_index` / `confidence` / `suppressed` / `suspect_hallucination` / `audibility_locked` and timeline clocks) for seek and **Correct**-mode selection; `audibility_locked` (#768/#781) marks a word whose `suppressed` state was set directly by a person or agent decision rather than a heuristic pass — the transcript view shows a lock affordance on these words so a reviewer can tell a pinned decision from a heuristic suggestion; on-disk `combined.json` is unchanged.

`merge_transcripts` drops a suppressed word from `combined.json` entirely when it falls before, after, or between the non-suppressed utterance windows on its track (an utterance's first or last word, or a suppressed run between two utterances) — that word has no `[start, end)` window of its own to live in. `gui/mapper.py`'s `_edge_suppressed_word_indices` attaches each such word to exactly one same-track utterance (the nearest by source-time gap, ties to the earlier one) purely as a view concern: `combined.json` and `merge_transcripts` are unchanged, and the word keeps its own timeline clocks and `word_index`, so Correct and Unsuppress work on it like any other chip (#752). A row's own word listing, its `ignored_word_indices` and this coverage check share one predicate (`_covered_word_ordinals`), and a zero-length utterance window (which `merge_transcripts` emits for a lone zero-duration word) is padded like a zero-length word (`word_source_span`), both for that coverage and for the row's own `timeline_*` / `timeline_spans` / `mappable` mapping. So a zero-length row on kept audio is mappable and shows in the default transcript view, and a suppressed word straddling that window is listed on that row, not dropped. Each SHELL and DETAIL utterance row lists the words attached this way in `edge_suppressed_word_indices` (ascending, only when non-empty), so the client's SHELL word overlay refetches DETAIL when a row's attachment changes. Both projections also carry `locked_word_indices` for locked words in the row, including attached edge words and words in `suppressed_only` rows. A lock-only change invalidates the client word overlay so undo and redo reload the current lock state. Attachment is by source time only: a word nearest a cut-away (`mappable: false`) utterance attaches to that row and keeps its own timeline clocks, but, like the rest of the row, shows only when cut-away lines are shown.

A track whose words are **all** suppressed produces no utterance in `combined.json` at all, so it has no row to attach a chip to via `_edge_suppressed_word_indices`. `gui/mapper.py`'s `_suppressed_only_rows` fills that gap purely as a view concern: it adds one synthetic row per gap-run on that track — the same 0.8s split `merge_transcripts` uses (shared via `engines/utterance_runs.py`) — sorted into the transcript by source start (stable, so input rows win ties; runs from several all-suppressed tracks interleave by time), so a bleed track's words spread across the episode instead of landing in one giant turn at the top. `words[]` on such a row are the run's suppressed chips and `text` is their joined text (the same format a real combined utterance would carry), which keeps the SHELL word overlay's text guard meaningful for these rows too. The row also carries `ignored_word_indices` when relevant, but never `edge_suppressed_word_indices` (its words are already all attached to it). A track with any unsuppressed word, or one that already has a row in the input combined transcript, gets no synthetic rows; `combined.json` and export are unchanged either way. Every synthetic row carries `suppressed_only: true`, which Sharecut Studio renders dimmed and keeps out of the active highlight, follow scrolling, the low-confidence walkthrough and the toolbar utterance count (still counted as cut-away when unmapped, so **Show cut away** can reveal them). Correct → select chip → Unsuppress still works, because `findTranscriptWord` scans `utterance.words` regardless of the row's flag; after an Unsuppress, the rest of that gap-run's words become ordinary edge-suppressed chips on the real utterance that then exists (#752, #758).

`pending_edits[].author` is `share:` plus the authoring share's opaque id, or `null` for host and agent edits; guests compare it with their bootstrap `author` to offer Retime only on their own suggestions ([share-tokens.md § Roles and general access](share-tokens.md#roles-and-general-access)).

`pending_edits[].join_risk` is optional view metadata for tighten proposals (`filler:` / `pause:` / `repetition:` / `restart:`). It maps propose-time reason suffixes (`:risky`, `:join_review`) through `gui/mapper.py` — **not** a live `EditService.join_quality` sweep on every ProjectView snapshot. Verdicts are `review` when those suffixes are present; otherwise the field is `null`. Use `join_quality_tool` for a per-decision live score. `pending_edits[].harsh` is true for a tighten proposal with `review_required` or a join risk (`edits/tighten_hits.is_harsh_tighten_hit`); the host Tighten tab reads it and excludes those hits from apply-all when Avoid harsh cuts is on, and `approve_edits_tool(apply_all_safe=true)` uses the same rule.

**Transcript display is non-destructive:** displaying or hiding retained cut-away (`mappable === false`) utterances does not alter on-disk `combined.json` or its source clocks. The DAW hides them by default and can show them dimmed (non-seekable); export already omits unmapped lines. Follow/active/seek use **timeline spans only** (no fallback to source `start`/`end`).

Boundary word previews combine active cutaway words with `Transcript.archived_words` retained by cuts. Adjacent clips must resolve to the same source transcript; a join between unrelated recordings does not borrow same-timestamp words. All cutaway preview references carry their source identity and a negative `word_index`, which is not an active transcript mutation target. A roll or trim that restores the complete word span returns that word and its metadata to the active transcript before rebuilding combined text. Partial words remain archived. Older cuts with no stored archive still require History recovery. Precision-boundary limits use each clip's selected recording duration and compare neighboring source positions when both clips identify the same recording on a track, or when different source identities resolve to the same media path (including an explicit source that aliases primary media). The same source identity needs no media-path lookup for a source-clock contraction. A recording with no known duration cannot expand past its current out-point. A preview token covers the selected track's render state, selected media revisions, and source transcript metadata that a proposed expansion might restore. A stale Apply conflicts before history or project changes. See [episode-format-v2.md](episode-format-v2.md#transcripts-canonical-in-project-file).

The host `POST /api/boundary/context` and edit-share `POST /api/review/{token}/daw/boundary/context` accept a typed trim or roll target plus the clip geometry the editor displays. They return finite legal bounds and reject a changed visible clip with 409. A roll target whose clips have a gap between them is refused with HTTP 400, `X-Sharecut-Error-Code: roll_needs_abutting_clips` and plain copy as the detail (a `CodedValueError`; `bad_request_error` in `gui/routes/deps.py` sends the code on every route that maps one this way, so the drag error and the precision dialog show that text). Only the host can use `POST /api/boundary/audition`: it checks that context token, copies the saved project, and applies the existing timeline operation to the copy. `PlayService` transiently renders each complete affected track, applies its staging gain, fader and whole-track peak ceiling, then crops separate current and proposed playback windows. These WAVs include that track's edits, selected recordings, joins, fades and FX; they are labelled as track audio rather than the full episode mix. Bounded `artifacts/play_cache/` entries hold only the cropped exact-geometry windows; temporary full renders are removed after extraction. A host-authorized `GET /api/boundary/audition/{id}/{side}` serves only issued entries with HTTP Range support and rechecks the preview token. Rendered drafts do not write the project, history, document journal, stems or premix. Every `TrimClipEdge` and `RollClipJoin` command requires `expected_token`, checked within the workspace transaction before mutation or history. Quick drags obtain it from context using their captured visible geometry; CLI and MCP trim obtain it within their project transaction. An unchanged precision Apply leaves the saved project and history untouched, though its document command receives a normal journal acknowledgment.

**Applied edits:** legacy `editorial.edit_log` rows missing `timeline_*` are remapped for the view from source clocks (first `track_ids` entry) in the assembler — view-only; the on-disk edit log is not rewritten. The lane's applied-edit ticks do not use `timeline_*` at all (#527): they come from `params.per_track_source` (`ripple_delete`/`punch_delete`/`approve_edits`/`apply_prefix_edits`), `params.split_source_by_track` (`split_clips_at`/`approve_split`), or the record's own `source_start`/`source_end`, projected through the track's current clips.

`ProjectView` also includes `social_clips` (timeline-clock candidates from `social.clip_candidates`) and `envelopes` for lane-level volume curves.

Implementation: [`src/podcast_mcp/gui/`](../src/podcast_mcp/gui/) (`server.py` wires routers; handlers live in `gui/routes/`), frontend [`gui/web/`](../gui/web/) (Zustand slices under `gui/web/src/state/`, session dedupe in `gui/web/src/session/`).

Every review-link role holds `view`, so `/r/{token}` always opens Sharecut Studio. A review share without `view` (only a hand-built `ShareService.create(capabilities=…)` call makes one) has no page: bootstrap succeeds and the app shows "This link does not open the project." with the next step beneath it, "Ask the person who shared it for a new link." Guest sockets, comments and recovery are covered in [session sync](session-sync.md).

## Static assets and guest surfaces

- `GET /favicon.svg` is served from the built `gui/web/dist` root (not only `/assets`).
- Hashed files under `/assets/*` use `Cache-Control: public, max-age=31536000, immutable`; HTML (`/`, `/r/{token}`, `/rec/{token}`) stays `no-cache`.
- JSON responses (project, waveform status, …) are gzip-compressed when the client accepts encoding (`GZipMiddleware`). Document `/api/host/ws` (and guest dual-plane WS) negotiate permessage-deflate.
- Guest Sharecut Studio (`share:{token}`) does **not** poll `/api/pipeline/*` — pipeline status is host-only.
- Guest `daw/project` keeps a zeroed `edit_impact` stub (StatusBar-safe), empties
  `social_clips`, and strips transcript `words[]`; guest waveforms are the host's raw-media pyramid tiles (no stems, no PCM).
- Record lobby (`/rec/{token}`) fetches `GET /api/rec/{token}/bootstrap` then
  connects `WS /api/rec/{token}/ws` (Join / Consent / roster / WebRTC Signal)
  and, with `join`, `GET`/`POST /api/rec/{token}/upload` for full-quality recording resume
  plus `DELETE` to revoke an ACK'd room-tone bed.
  Host DAW subscribes to the record plane on `WS /api/host/ws` and exposes
  `GET /api/record/state` + `POST /api/record/command` plus
  `GET`/`POST`/`DELETE /api/record/upload`. Mix-minus plays remote
  tracks only (`gui/web/src/audio/mixMinus.ts`). It never loads `/api/review/`.
Transcript utterance mapping batches source-to-timeline word spans once per
track and indexes the words for repeated utterance overlap queries. The API
retains original transcript word order and indexes, including suppressed and
zero-duration words; views that omit words skip this work. Word spans map
through `SessionTimeline.map_word_spans`, the same helper export/doctor
timebase QC uses, so a zero-length word at a kept clip's source end is
mappable in both. Edit-boundary `cutaway_word_ids` ask the same helper and
leave out a zero-length word it maps onto the left clip, so they cannot drift
from the word views.

### Transcript find and replace

The host Transcript toolbar and command palette open a form to review literal replacements across source recordings. `POST /api/transcript/replacement-preview` delegates to `EditService`; the `ReplaceTranscriptMatches` document command revalidates the preview and applies the complete set as one Undo action. See [the find-and-replace guide](daw-editing.md#transcript-find-and-replace) for matching rules, source scope, timing warnings, and queued delivery.

### Exact-source word timing adapters

Host transcript word views include `timing_target` with the stored transcript's
`track_id`, nullable `source_id`, and `word_index`. This target identifies the
transcript that supplied the word, including suppressed-only rows. It does not
infer a recording from clip placement or word time.

`POST /api/transcript/word-timing-context` accepts `{path, target, expected_word}`.
`expected_word` contains the displayed `text`, `start`, and `end`. The host-only
route delegates to `EditService.word_timing_context` and returns authoritative raw
media, neighboring words, a source-clock window, and a stale dependency token.
A changed word returns 409. Missing raw media returns 404. Existing finite import
timings may be negative or reversed so the host can open their repair context.

`SetTranscriptWordTiming` accepts `{target, expected_token, start, end}` and saves
through `EditService.set_word_timing`. Its Applied delta includes changes to transcript words,
tracks, and render status through `TRANSCRIPT_AUDIO`. Stale timing dependencies
become document conflicts. Guest shares cannot submit this command.

`GET /api/audio` accepts optional `source_id` only for `kind=raw` or `kind=track`.
`PlayService.resolve_transport_path` resolves that exact recording through
`recording_audio_path`, with workspace containment. Omitting `source_id` selects
the track's primary media. Host authorization and HTTP Range streaming remain
part of the existing route.

### GUI audit refinements

Shared dialogs mount outside inert app chrome. On phones, Pipeline parameters
use the shared modal and suspend while model-download confirmation is open.
Guest status summaries for Impact and Pipeline remain readable without offering
unavailable host panels. Editable chapter and reply fields have persistent
accessible names; long comments, vocabulary terms, and inspector metadata wrap
within their panes. The guest review reading column stays within its shell;
native comment fields shrink within that column even when the browser gives
them a larger preferred width. Status pills and muted/resolved metadata use
readable text roles rather than reducing the opacity of the entire surface. See the
[GUI surface audit](gui-surface-audit.md) for tested states and limitations.

Transcript edit-boundary gestures freeze the starting source bounds and button
rectangle. The glyph retains its inline size and follows the raw horizontal
pointer movement. Hold Shift for fine motion of 1 ms per CSS pixel; switching
Shift during a drag keeps the accumulated source offset continuous. Legal source
bounds clamp the proposed offset and show limit feedback without pulling the
glyph away from the pointer.
A gapped pair's mark explains that this gap has no roll seam and that the mark
trims the left clip's end. The host precision dialog repeats this reason;
opening it only reads boundary context and does not change the project.
A bounded body portal displays roll/trim intent, precise delta, restored-word
side, legal limits, and cancellation instructions without changing transcript
flow. Focus departure, ancestor scroll, or resize cancels stale placement.
Dragging past the activation threshold commits on pointer up; a tap or native
keyboard activation opens the host-only precision dialog instead. The window
keymap leaves bare Space/Enter on a focused native button to that button;
Space on the timeline canvas still controls transport. It edits a
signed offset with 10 ms and 1 ms nudges and shows source positions, legal
bounds, and full versus partial archived-word restoration. Its **Listen current**
and **Listen proposed** controls play separately rendered windows of the affected
track through the existing transport. Changing the draft or closing the dialog
stops that local audio. Apply carries the audition revision so an intervening
change conflicts before save; an offline command is labelled queued for sync.
Cancel and an unchanged Apply create no project history. Pointer cancellation,
lost capture, window blur, Escape, and unmount discard a drag preview and
release capture, listeners, and drag locks.
Pending commits block another gesture on that handle and show saving feedback.
Rejected commits show a scrollable alert with Dismiss and focus restoration.
Focused component tests, live-project touch and geometry tests, and word-bearing
Storybook browser tests cover these behaviors at desktop and phone widths.

Pending edit review actions keep one state and command owner. On phones and
sideways compact layouts, the selected action card portals into the compact
inspector's pinned header, so Approve and Reject remain available while the
inspector body scrolls. Timing stays in the peek strip or expanded inspector.
Outside compact mode, the card floats beside the selected timeline region.
The card keeps the same portal host across relocation, preserving recovery
drafts and busy/error state. Relocation restores the currently focused control
only if it was inside the card; body and external control focus stay unchanged.
The host falls back to the body when compact chrome is absent and is removed
when the region unmounts.
Long supplementary errors scroll within the pinned card.

### Provisional recording timeline

A dedicated timeline leaf shows an aggregate current-take band and recording
needle while recording/paused, independent of the Record room panel and saved
track lanes. It uses the server's Land-compatible take origin and a monotonic
recording clock. Pause freezes it; Stop clears it; Land supplies real clips through
the existing document refresh. Its overflow is visual scroll extent only: the
ruler and seek bounds continue to describe saved media. On fixed-playhead
phones, users can pan to the provisional needle beyond the saved-media end;
that visual-only pan does not seek or recenter playback. See [Recording
session](recording-session.md#live-take-monitoring-on-the-timeline).

## Exact selected ranges

Exact selected range pending edits expose their canonical disjoint timeline footprint. Source timing controls do not retime them. Pending Suggested audio renders an ephemeral project through the exact range kernel; it preserves timeline gaps and unselected lanes.

`rangeSelection.ts` resolves timeline/transcript selections into sealed targets.
`rangeActions.ts` supplies the same five action descriptors, permission reasons
and live execution guards to the desktop bar and phone sheet. Numeric bounds and
explicit lanes share this path. Failed/stale actions retain selection with a
readable reason; in-flight mutations block duplicates. Play uses the owned
transport preview; Bounce captures a detached target with ordinary configuration.

The idle desktop inspector collapses and restores when an inspector object is
selected. **Edits in removed audio** in the footer opens Impact, where every
pending item remains selectable. The transport holds the single mix freshness
cue (**Mix out of date · Refresh** for hosts); the footer retains transcript,
pending, comment and job status. Select/Blade remain visible with disabled reasons.

Exact pending GUI previews use the same rendered pending preview as every other pending edit, preserving each island and the gaps between them. Target comparison ignores JSON object property order from the server while preserving every sealed value and ordered array. The adapter discards prepared audio, and says so inline, if the edit (exact target, or an ordinary edit's bounds), mix, project, or playback permission changes before it arrives, or the edit is approved or rejected meanwhile. Exact pending titles carry Cut/Mute without a duplicate Type fact, keeping the timeline intervals and selected track value above the phone preview footer. Review reasons for guests without `edit` remain readable beside the disabled controls on desktop and phone; pending labels wrap so their full identity and status stay visible. Exact proposal review controls are enabled for the host and `edit` guests and remain visible with a disabled reason for other guests; source timing and snap controls are absent. Applied exact Cut/Mute ticks retain every recorded timeline edge, including holes and repeated-source occurrences, rather than falling back to the first matching source clock.

While a guest owns a rendered source preview, the loaded proxy transport pauses
and yields playback, clock, and meter ownership to the existing HTML audio
transport. The proxy remains loaded and can resume after preview release. Preview
position stays local and does not move or publish the session playhead.

Exact pending Current/Suggested/A-B supports the full mix (`premix`); isolated
source requests reject before playback. Suggested cache identity includes every
track's current render and mix state. Guest range Play never renders stems and
requires a fresh published mix. Host isolated and guest full-mix extracts use
separate private paths and atomic publication.

Reviewed exact MUTE proposals require interactive host approval. Rendered pending previews and host processed timeline playback honor clip-local mute envelopes; guest source-proxy timeline playback currently omits them. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).


### Applied edit recovery

The Applied edit inspector offers **Restore** only for ordinary source MUTE archives with valid source clocks and edit access. Cuts and exact ranges show the whole-action History Undo guidance, including other edits in the action and the need to undo later actions first. **Open History** opens the current History tab without running Undo. Numeric source and timeline seam displays remain unchanged. The backend independently refuses unsupported local Restore before history starts. See [History](history.md#individual-restore-and-whole-action-undo).
