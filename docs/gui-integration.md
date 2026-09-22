# GUI integration

Guide for building a desktop or web editor on top of Podcast MCP services and MCP tools.

## Architecture

- **State:** `episode.project.json` is the source of truth for clips, pending edits, FX chains, and `editorial.edit_log`.
- **Mutations:** Route all timeline changes through `EditService` / MCP tools or typed document commands (`POST /api/document/command` — never bare domain calls). Each mutation creates history snapshots.
- **Sharecut Studio today:** comments (incl. Ask threads on pending edits), pipeline, History Undo/Redo, pending Approve/Reject (incl. Impact bulk + host **Tighten** review of `filler:`/`pause:` hits), pending nudge, Current/Suggested/A/B audition, applied Restore, clip fades / join mode, Track FX bypass, Transcript Edit-mode correct/suppress, chapter/social marker CRUD, blade/delete, project/track/audio ingest via document commands, host **Menu → Share…** (live links, mint, revoke), host **Menu → Record room…** (lobby/consent/Start + local keepers + mix-minus), and host **Menu → Connect agent…** (local Streamable HTTP MCP URL) — [daw-editing.md](daw-editing.md), [share-tokens.md](share-tokens.md), [recording-session.md](recording-session.md).
- **Host MCP (local Streamable HTTP):** `gui/host_mcp.py` mounts the same `MCPServer` as stdio at `http://127.0.0.1:8765/mcp` (official `mcp` SDK). Tools apply to the open episode (`app.state.served_project`). See § Local host MCP.
- **Remote MCP (share tokens):** `gui/routes/remote_mcp.py` + `services/remote_mcp/` — capability-scoped guest tools over JSON-RPC; mutations still go through `ShareService` / `DocumentSyncService` (no forked domain logic). See [host-online-relay.md](host-online-relay.md) § Remote MCP.
- **Audio:** Rendered stems and premix live under `artifacts/`; undo restores project JSON only — call `render_preview` or `history_undo(rerender=true)` after undo.

## Clocks

| Clock | Use for | Tools |
|-------|---------|-------|
| **Source** | Cut decisions, transcript words | `cut_*`, `search_transcript` `start`/`end` |
| **Timeline** | Play, chapters, ripple by time | `play_audio_tool`, `play_compose_tool`, `ripple_delete_tool`, `list_applied_edits_tool` |

`search_transcript_tool` returns both clocks on each match.

## Undo / history

- Interactive edits: two snapshots per action (`before …` / `after …`).
- `history_list` returns flat `entries` plus grouped `groups` for mutation pairs.
- `history_diff_tool` / `podcast history diff` — structured clip/decision/mix delta between indices.
- `history_goto_tool` / `podcast history goto` — jump cursor without stepping undo/redo.
- Pipeline steps record one snapshot per step (`after {step}`).
- **Sharecut Studio History tab:** Undo / Redo buttons call document commands `UndoHistory` / `RedoHistory` → `HistoryService` (same as MCP/CLI). Applied snapshots carry `history.groups` so the list stays current after targeted TRACKS/COMMENTS patches.

After undo, check `render_status_tool` — `needs_rerender` when stems or premix are stale.

## Applied-edit provenance

Committed cuts are archived in `editorial.edit_log` (not deleted with `edit_decisions`).

- `list_applied_edits_tool` / `podcast edit list-applied` — filter by track or timeline window.
- Each record includes `reason`, source/timeline ranges, and tool `params`.

## Read APIs for inspectors

| API | Purpose |
|-----|---------|
| `list_clips_tool` | Full clip rows incl. `join_in_mode`, `source_id`, `origin_track_id` |
| `list_edit_decisions_tool` | Pending cuts |
| `list_applied_edits_tool` | Committed cut provenance |
| `edit_impact_report_tool` | Aggregate removed duration |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `reconciliation_status_tool` | Transcript/audio drift flag |

Mutation tools return **JSON** with `operation`, echoed input params, and summary fields (`clip_count`, `affected_tracks`, …).

## Progress

Shared contract: [progress.md](progress.md). CLI adapter flags: [cli-progress.md](cli-progress.md).

The DAW viewer runs the pipeline in-process via `POST /api/pipeline/run` and streams progress over SSE (`GET /api/pipeline/events`) using the same `ProgressReporter` protocol (step `current/total`, live `message` headline, per-step elapsed, `fail`/`cancel`). During quiet steps the SSE stream also emits ~1s `status` snapshots (fresh `elapsed_sec`). Those keepalives **do not** bump `last_progress_at` — only domain events (`start` / `update` / `message` / `heartbeat`) and the job reporter’s 5s `ElapsedProgressMixin` heartbeat do. The viewer keeps a session-wide subscription (`usePipelineJob`) so the **Pipeline tab**, **StatusBar**, and **phone Listen chip** stay live — there is **no separate progress log panel**. Phone Listen reuses StatusBar `status-pipeline` chrome. Chrome follows the progress rubric:

- **Headline / phase** from `message` (primary when a bar would be dishonest)
- **Determinate bar** only when `total` is set (`role="progressbar"` + `aria-valuenow` / `aria-valuemax`); otherwise a pulse + `role="status"` live summary (no `n/?` fake units)
- **Elapsed** as a companion; Cancel remains on the Pipeline tab
- **Failed** vs **cancelled** are distinct status labels
- **Stale:** if `now − last_progress_at > 15s` while running, chip/panel show “last update Ns ago” next to the headline (dim companion, not accent). The pulse stays; elapsed still ticks as a companion; no determinate bar movement. A new domain event or job-reporter heartbeat clears the copy. Pipeline tab live region does not include the ticking stale string (one-shot stall/resume announce only). `last_progress_at` is wall-clock `time.time()` on the Studio host vs client `Date.now()` — same-machine Studio is fine; a remote client clock ahead by more than 15s can show false stale.

Fan-out of in-process **host MCP** onto this job/SSE plane uses `compose_progress`. Studio `create_app` registers a wrap-level **agent job** sink next to the publish-only SSE sink: the first `update` / `message` / heartbeat or elapsed ≥ 1s creates a `kind=agent` job (`tool_id`, headline) so StatusBar / phone chip show it without a prior `POST /api/pipeline/run`. Instant tools never flash a chip. Host MCP `pipeline_run` in the Studio process goes through `PipelineJobManager.start()` (same single-flight lock as `POST /api/pipeline/run`; busy is an error). Other agent jobs do not take that lock; the manager may hold one pipeline-slot job (`pipeline` / `render_preview` / `bounce` / `export`) plus N agent jobs. StatusBar shows the most recent running job and a count badge (“2 activities”) when more than one is live. Chip copy is **Pipeline** only for `kind=pipeline`; otherwise **Activity**. The Pipeline tab lists pipeline jobs in the summary; while bounce/export/`render_preview` occupy the slot it disables Run, shows Cancel, and a slot-busy notice (no Cancel surface for agent jobs). Chip/Listen open the Pipeline tab only for slot jobs; agent chips are inert until an activity drawer exists. `fail` shows a short first-line headline (no stack traces or host paths). Typer `install_cli_progress` is not installed by the GUI — **cross-process CLI adopt remains ROADMAP**; GUI-started pipeline/bootstrap jobs are live today.

Guest-initiated long work (remote MCP / guest tools) does **not** use host `/api/pipeline/events`. `install_guest_tool_progress` composes MCP `notifications/progress` (when `params._meta.progressToken` is set — Streamable HTTP SSE, then the JSON-RPC result) with a live guest-WS sink keyed by **that** share token. ReviewApp (no `view`) opens `WS /api/review/{token}/progress/ws` and announces status/message in a visually-hidden live region (no elapsed ticks); the shared `PipelineStatusChip` sits outside it. Sharecut Studio share mode demuxes `plane: "progress"` on `daw/ws` into the StatusBar activity job (phone Listen shows the chip for guests; the chip is non-interactive because the Pipeline tab is host-only). Payloads are whitelisted (no host paths); updates coalesce ≤4/s; instant tools never flash.

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

Sharecut Studio (`gui/web/`) uses plain CSS + React (no Tailwind/shadcn). Semantic theme tokens live in `gui/web/src/styles/theme/` (light/dark via `data-theme` + `prefers-color-scheme`; transport toggle + `localStorage`). Shared chrome is the **Sharecut Studio UI library** under `gui/web/src/ui/` (Button, CommandButton, Dialog, Menu, Field, …) — charter and command-bus bridge: [`gui/web/docs/ui-library.md`](../gui/web/docs/ui-library.md). Comment UI is shared from `gui/web/src/comments/`. Domain CSS is split into `@import` partials from `gui/web/src/styles/daw.css`. See [`gui/web/README.md`](../gui/web/README.md).

### Launch

```bash
uv sync --extra gui
cd gui/web && npm install && npm run build && cd ../..
podcast gui --project /path/to/episode.project.json
```

On **loopback**, `--project` is optional: omitting it serves the host **home** (New / Open project, **Connect agent…**). The home screen also runs a **first-run bootstrap wizard** when FFmpeg/Whisper are missing (`/api/bootstrap/*`). The wizard includes a Whisper **speech model** picker (default `large-v3-turbo`; smaller sizes optional). `GET /api/project` (and create/open) pins `served_project` for host MCP; home calls `POST /api/project/close` to unpin. Non-loopback still requires `--project` (pinned; switching projects is loopback-only) and does **not** mount `/mcp`.

Navigating the browser to `/?project=<other>` while a project is pinned returns a friendly recovery page (HTTP 403 HTML) naming the served project with links to open it or choose a different project. The recovery page is rendered only for requests that accept `text/html`; API clients receive the JSON `403 {"detail":"project path not allowed for this server instance"}`. On a non-loopback strict-auth server, the request must carry the launch `session_token` before the page reveals served-project metadata, and both recovery links retain that token.

The loopback GUI is a **privileged local RPC** (not “safe because localhost”). Host/Origin binding rejects DNS-rebind forged `Host` headers on host APIs. Treat `127.0.0.1:8765` like a local agent with full project open/create and pipeline powers.

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
| `POST /api/project/create` · `POST /api/project/open` · `POST /api/project/close` | Host loopback — create empty episode, open existing `episode.project.json` (basename required; workspace **directory** also accepted), or unpin `served_project` (home / New project). CLI `--project`, MCP, and `open_project` still load any JSON path. |
| `POST /api/project/pick` | Host loopback — OS file dialog (Finder / Explorer / zenity); returns a path without pinning `served_project`. Browse / Mod+O use this then `open`. Overlapping pick returns **409**. Cancelled responses may include `detail` (timeout). Paste path remains when the dialog is unavailable. |
| `POST /api/media/upload` | Host — stream audio into `raw/` (allowlisted extensions; size via `PODCAST_GUI_MEDIA_*`) |
| `POST /api/review/{token}/daw/media/upload` | Guest **`edit`** — chunked upload (relay JSON body cap); same assembler |
| Document commands `AddTrack` / `SetTrackMedia` / `SetTrackMeta` / `RemoveTrack` | JSON mutations via existing document command routes (never file bytes) |

Sharecut Studio arrange is the import surface: drop on a lane (replace that track’s media), drop below tracks / empty session (new tracks), **Menu → Import Audio…** / **New Track**, inspector Import/Replace. One frontend path: `gui/web/src/ingest/ingestFiles.ts` → upload then `submitDocumentCommand`. Permissions: `canIngestMedia` / `canManageProjects` in `shareMode.ts`. Details: [daw-editing.md](daw-editing.md) § Pass 8.

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

### Layout (Reaper-style)

| Region | Content |
|--------|---------|
| Transport | Play/Pause, audition mode (Mix / FX / Raw), playhead, duration, render-health, layer toggles, zoom; secondary controls in overflow on narrow / decluttered desktop. The overflow uses menuitem, menuitemradio, and menuitemcheckbox semantics for keyboard and assistive-technology navigation. At compact widths every row, including audition radios and layer checkboxes, has `min-block-size: var(--touch-min)` (44px); browser coverage verifies their roles, selected state, arrow-key navigation, touch targets, and axe. |
| Track headers | Label, role, gain strip, viewer **M**ute/**S**olo, FX badge, stem freshness. On arrange, headers live inside `.timeline-scroll` as a sticky identity column (`flex-wrap: nowrap` — not Every Layout Sidebar wrap) so they share vertical scroll with lanes and stay fixed while panning time. Pane width via `@container timeline` switches gutter (`4rem`, mixer chrome hidden) vs mid/full rail; phone Timeline uses the same `headerSlot` path with CapCut fixed-center playhead. |
| Timeline | Full-session auto-fit on load; clips; volume envelopes; pending/applied edit overlays; chapter + social markers; playhead; pinch / Ctrl-wheel zoom claimed on the timeline only (non-passive listeners so browser page-zoom does not fight); phone shell uses fixed-center playhead scrub |
| Inspector | Selection details (clip, pending with Current/Suggested/A/B + Ask thread, track FX, chapter, social); unmapped pending list when idle; phone/tablet peek via bottom sheet. Pending approval errors remain visible while the selected edit is refreshed; changing selection clears the prior edit's error. |
| Bottom tabs | Transcript (consecutive same-speaker utterances grouped into turns; **click** seeks the turn start, **double-click a word** seeks that word; host **Edit** toggle selects a word into the inspector for correct/suppress without stealing seek; timeline-only follow/seek; cut-away hidden by default with **Show cut away**; **Follow** centers the active word; unlock via toggle or manual scroll; large transcripts virtualize variable-height turns while preserving presence/follow/selection anchors), **History** (human-readable step titles; click a mutation for a prose summary, optional raw JSON), edit impact, **pipeline** (run + progress). Volume envelopes stay on the Levels overlay plus the selected-point inspector. |
| Status bar | Pending review, unmapped edits, removed duration, social clip count, premix/rerender/reconcile, pipeline status shortcut — chips jump to the matching tab |

### Responsive shells

Phone (`<768`), tablet (`768–1100`), and desktop (`>1100`) share domain components but not the same chrome. Phone uses Listen / Timeline / Text / More modes + selection sheets. Full map, wireframes, and desktop back-apply: [gui-mobile.md](gui-mobile.md).

Host and guest shells reserve a banner row for offline command attention on all three sizes. Host pending edits remain visible there until replay; host and guest 409 conflicts appear in the same **Needs attention** list and can be dismissed. The guest share-mode label stays guest-only.

### Live project reload

The viewer polls `GET /api/project/meta` (~1.5s; includes document `server_seq`). When `mtime_ns` / `size` change and local seq is behind, it re-fetches `GET /api/project?phase=shell` and merges into the timeline **without a browser refresh**. Playhead, zoom, and selection are preserved. JSON responses are gzip-compressed (`GZipMiddleware`); document WebSocket uses permessage-deflate (`ws_per_message_deflate=True` on uvicorn). Do not gzip audio `FileResponse`.

Host tabs also subscribe to `WS /api/document/ws`. On accept the server sends a hello `Snapshot` with `document_snapshot(projection="shell")` (same shell `ProjectView` as HTTP `phase=shell`); `Applied` events then carry a **command-typed slice** (comments, tracks/clips/FX/envelopes patches, DETAIL transcript patch, or SHELL `project`) so peer GUI edits and MCP cuts update the timeline without waiting on the poll. The client overlays hydrated `words[]` onto SHELL utterances by source clocks. Guests with `view` subscribe to `WS /api/review/{token}/daw/ws` (session + document + guest-initiated `plane: "progress"`, Presence inbound, sanitized snapshots) via `useGuestSync`; session messages echo the assigned `guest-{token}-…` `client_id` so ghosts do not treat the guest as someone else. ReviewApp (no `view`) uses `WS /api/review/{token}/progress/ws` for the Activity chip only. `useProjectPoll` remains the mtime safety net for both.

### Progressive project load

First paint is three phases so the DAW grid does not wait on transcript `words[]` or history groups:

1. **Chrome** — as soon as `?project=` (or a guest `view` share) is known, mount `DawProvider` + `DawApp` with `project === null`. Transport, header column, timeline well, inspector, and tabs render as disabled/skeleton chrome. This is **not** the ingest empty-session (“Drop audio files”) path.
2. **Shell** — whichever arrives first: `GET /api/project?phase=shell` (default when `phase` is omitted), or the hello `Snapshot` on `WS /api/document/ws`. Both are tracks, clips, duration, utterances without `words[]`, comments, empty `history.groups`, `meta.hydration` flags false. `project === null` chrome lasts only until that first shell.
3. **Detail** — Host `GET /api/project?phase=detail` merges `words[]` and `history.groups` via `mergeProjectPatch` (does **not** call store `hydrate()`, which would clear waveform LRU). Share guests **skip the DETAIL request** (`useProjectBootstrap` returns after shell). HTTP `?phase=detail` on a share still exists for OpenAPI/tools and is assembled without `words[]` or history (`dump_project_projection(..., audience="guest")`); sanitize then only strips host paths.

`phase=full` remains an explicit escape hatch for tests and one-shot tools. Closed projection names (`ViewProjection`, `parse_view_projection`) live in [`projection_types.py`](../src/podcast_mcp/services/document_sync/projection_types.py); HTTP `?phase=` and WS slice assembly still dump via [`gui/assembler.py`](../src/podcast_mcp/gui/assembler.py) (ProjectView seam — see [architecture.md](architecture.md)).

Guest playback prefers **proxy media** when `GET /api/review/{token}/daw/proxy/manifest` returns tracks (`useProxyTransport` + Web Audio clip scheduler). Otherwise `useAudioTransport` streams WAV as before. See [host-online-relay.md](host-online-relay.md) § Proxy media.

### Audio transport

When the timeline / transport / track headers **or the Transcript tab** are focused (including after selecting transcript text):

| Control | Behavior |
|---------|----------|
| **Space** | Play / pause from the playhead (timeline clock) |
| **← / →** | Nudge playhead ±1s (Shift = ±5s) |
| **Mix** | Stream `artifacts/premix.wav` (full mix). Mute/solo switches to stem mix. |
| **FX** | Stream processed stems (`artifacts/tracks/{id}.wav`) — edits + effects |
| **Raw** | Stream source media (`raw/…`) — no FX; gain in the browser. Playhead stays on the **timeline** clock; each track’s `HTMLAudioElement` seeks via clip `timeline→source` (same dual-clock math as `SessionTimeline` / `clip_timeline_point_to_source`). Mix/FX keep media and playhead aligned (timeline-length stems/premix). |
| **M / S** | Viewer-local mute/solo (does not write `track.muted` to the project) |

Audio is served by `GET /api/audio?path=&kind=premix|stem|raw&track_id=` with HTTP Range support and an `ETag` (mtime+size) so Range revalidation can hit the browser cache. Optional `start_sec`/`end_sec` (capped at 8s) returns a short PCM extract via `PlayService.extract_waveform_window` for compressed raw media. Resolution of full files goes through **`PlayService.resolve_transport_path`**. Optional `rerender=true` matches CLI `--rerender`. The Sharecut Studio FX transport passes `rerender=true` (plus a cache-bust `v=`) when a track’s stem is stale — e.g. after Track inspector **Bypass** toggles — so A/B audition hears the new chain.

### Waveforms (overview + client detail)

Zoom knobs live in [`contracts/timeline-zoom.json`](../contracts/timeline-zoom.json) (min/max/step, `overview_bins_per_sec`, DPR headroom). Python: `podcast_mcp.util.timeline_zoom`. GUI: generated `gui/web/src/utils/timelineZoom.generated.ts` (`make schema-export`).

| Layer | What |
|-------|------|
| **Overview** | Uint8 peaks JSON at `overview_bins_per_sec` (16 Hz) from 8 kHz FFmpeg (`-threads 1`). Same file for host `GET /api/peaks/{track_id}` and guest share (no extra coarsen). Written under `artifacts/peaks/{id}.json`. Pipeline `ingest_tracks` still generates inline; `add_track` / `set_track_media` **schedule** generation on a one-worker background thread so HTTP returns before the sidecar exists. |
| **Detail tiles** | Visible source window only, at `min(zoom × paintDpr, max_zoom × dpr_headroom)`. Discrete `ZOOM_STEP` rates and 2s tiles; LRU; global extract cap (~2); WAV Range → stem WAV → windowed PCM → overview. Guests reuse `ProxyEngine` PCM when present and never Range-fetch host WAV through the tunnel. Without a proxy engine, guests stay on the overview file — the scheduler does not enqueue detail jobs. |
| **Edit-focus loupe** | ~`edit_focus_sec` (0.2s) around playhead / trim / blade at a higher bin rate, still windowed. |
| **Paint** | Viewport + overscan canvases, range-max downsample, rAF, skip late frames / offscreen clips. **Shift+ArrowUp/Down** amplitude-zoom at paint (`view.waveformZoomIn` / `Out`). |
| **Snap overlay** | Quiet wash from visible uint8 tiles; ticks from `GET /api/waveform-snap` (`EditService.waveform_snap_window` → `preview_inaudible_cut` + windowed islands). Magnet for blade/trim. View-only guests get wash only. Theme: `--color-waveform-quiet`, `--color-waveform-snap`. |

Waveforms never block play, seek, edit, scroll, or `add_track`. Full job/SSE fan-in for peaks stays on the ROADMAP.

**Budgets (CI):** Vitest 2–3 hour synthetic clip geometry (`drawWaveform.test.ts`); pytest `add_track` returns before peaks (`test_episode_service_add_track_returns_before_peaks`); Playwright `e2e/waveform.spec.ts` (overview byte size, no full-file WAV, canvas ≈ viewport). Guest overview payload is the same uint8 file (`share_daw_peaks` / `test_guest_peaks_are_overview_not_coarsened`); view-only guests cannot fetch snap ticks.

Pending **Suggested** audition is a transport **skip** over `[timeline_start, timeline_end)` (pad-before, jump, pad-after) on Mix/FX (host) and guest proxy — not a bounced mix. **A/B** plays Current, ~0.4s gap, then Suggested. Splits and track-scope punches stay Current-only. Host agent/CLI: `play_pending_preview_tool` / `podcast play pending-preview`. Share guests (human skip in the browser; agent HTTP twin): `GET /api/review/{token}/daw/pending-preview` + `guest_pending_preview` (`play`+`view`; relative URLs, not host speakers).

### Shared session state (agent ↔ DAW)

Agent, CLI, local DAW tabs, and future remote web users are **clients** of one sync engine (`SessionSyncService`). Authority: sqlite `artifacts/session/sync.db` (append-only command log + per-field LWW snapshot). `artifacts/session_state.json` is a materialized mirror for legacy readers. Full design: [session-sync.md](session-sync.md).

| Endpoint | Purpose |
|----------|---------|
| `GET /api/session/meta` | `server_seq` / mtime (or `exists: false`) |
| `GET /api/session/state` | Materialized snapshot + `clients[]` (404 if empty) |
| `POST /api/session/command` | Submit typed command (agent = viewer = cli) |
| `POST /api/session/state` | Compat: viewer blob → typed commands |
| `WS /api/session/ws?path=&client_id=` | Push `Applied` / `Snapshot`; primary DAW transport |

**Agent → DAW:** `PlayService.play()` emits `PlayOsAudio` (speakers only — DAW seeks/highlights) or `AuditionInViewer` (`dry_run=true` — browser plays). `SessionControlService` / MCP session tools submit the same typed commands; optional `selection` / `set_session_selection_tool` highlights a modifier in the inspector. WebSocket fanout updates open tabs; HTTP snapshot poll is fallback.

**DAW → agent:** presence (cursor, viewport, live playhead) publishes over **WebSocket** `Presence` frames. Durable deltas (mode, selection, mute) still `POST /api/session/state`. Continuous playhead while playing must not emit durable `SetPlayhead` Applied events (that re-seeks the browser audio and stutters). Followers omit `playhead_sec` / `is_playing` from that HTTP snapshot.

**Transport authority (Figma-like):** each DAW tab owns its own play/pause clock. Agent commands (`SetRegion` / `AuditionInViewer` / `SetPlaying` from role `agent`) may drive transport; other viewers’ `SetPlaying` / playhead echoes are ignored (ack cursor only). Local Play clears any leftover agent `playUntil` auto-stop so a prior audition region cannot halt free scrubbing. Agents call `get_session_state_tool` (or `podcast session status`) before “cut from here”; prefer the viewer entry in `clients[]` for the live playhead while transport is rolling.

**First Snapshot:** the DAW applies agent transport from the connect snapshot **before** recording `command_id` as applied (see `gui/web/src/session/dedupe.ts`), so an in-flight agent play still seeks/highlights when a tab opens mid-command.

Keep the viewer pointed at the same `episode.project.json`.

### Presence (avatars and ghosts)

The transport **avatar stack** (max three + overflow menu; collapsed bar and phone **More** list the same people) shows live clients. Click an avatar to follow. Ghost cursors, remote playheads, and clip selection boxes render on the timeline (`pointer-events: none`, `aria-hidden`). Display names come from `meta.display_name` (role badge from server `role`). The followed person sees a follower **count** only. While you are following, copied **playhead / viewport** are not broadcast (Figma still shows an independent mouse; a DAW playhead that lags 100–300 ms behind the leader would draw a second needle). Overlay also ignores leftover playhead on any client with `meta.following`. Independent cursor still publishes. Guests adopt the server-assigned `client_id` before drawing the roster; until that id is known, ghosts stay hidden so a followed guest never sees their own cursor.

### Follow mode

Click an avatar (desktop) or **Menu / More → People** (tablet/phone) to follow.

| Shell | Look | Hear | Degradation |
|-------|------|------|-------------|
| Desktop / tablet | Viewport (zoom + pan), tab, transcript scroll, selection, canvas ghosts (no duplicate playhead) | Audition Mix/FX/Raw, mute, solo | — |
| Phone | Tab → Listen/Text/More mapping; playhead at the Ferrite center needle. Zoom/scroll is **not** copied. | Same as desktop when capable | Host-only tabs stay More-hub-unavailable; banner names the tab |
| Guest share | Transcript / Comments tabs only | Mix only | Banner: “· in Pipeline (host-only)”, “· auditioning FX”; “· Listening in Mix” when Mix is forced |

Guests stay on Mix at the store (`setAuditionMode`), TransportBar, `transport.audition`, Follow (`planFollowUi` always applies Mix), and session snapshots (force Mix; never copy host mute/solo). Track inspector **Play FX around start** goes through `transport.audition` and is disabled for guests.

A banner and colored timeline border show who you are following. Strong local navigation unfollows: scroll, zoom, seek (including phone Listen scrub / ±15s), play/stop, tab / phone-mode switch, or **Escape**. Mute, solo, audition, and selection do **not** unfollow. Phone unfollow is also the banner **Stop following** control (44pt). Guests stay on Mix; capable hosts mirror the leader’s audition. Hit targets use `min-block-size: var(--touch-min)` (`2.75rem`) under `@container app` (banner, More hub) and `@container transport` (Menu rows) at `inline-size < 68.75rem` — not `@media` viewport queries. Rubric and prior art: [session-sync.md](session-sync.md) § Follow scope.

### Comments tab (review feedback)

Timeline comments from `review.comments[]` (session clock). Hideable pins/range bars, transport **Comment** mode (click/drag ruler), Comments tab list with action-item check-off and resolve. A comment with `edit_decision_id` still pointing at a pending cut opens the pending inspector (Ask thread) instead of the generic comment inspector. Mutations via `POST/PATCH /api/comments` (same `CommentService` as CLI/MCP; optional `edit_decision_id` on create). See [timeline-comments.md](timeline-comments.md).

### Pipeline tab (orchestration)

Configurable production spine — **visible params are the source of truth for Run** (same working set as MCP `pipeline_get_config_tool` / `pipeline_set_config_tool`). Master-detail checklist + param inspector; optional **Analyze** seeds heuristic patches into the form (not a hidden auto-run).

`GET /api/pipeline/config` includes `whisper_models[]` (`id`, `label`, `size`, `description`, `cached`). The **Whisper model** control (`transcribe.model`) is a catalog `<select>` with **Downloaded** / **Needs download** chrome. Choosing a missing model opens a confirm Dialog (**Download** / **Use without downloading** / **Cancel**). **Download** reuses host-only `POST /api/bootstrap/run` with `components: ["whisper"]` and SSE progress (same job manager as first-run setup) — no second downloader. **Run** (Sharecut Studio, `POST /api/pipeline/run`, MCP `pipeline_run`, and CLI) does **not** download weights. If `transcribe_tracks` is selected and the working-set model is missing, the run fails fast (HTTP **409** / tool error). Download via the Pipeline picker Dialog, first-run wizard, or `podcast bootstrap --component whisper --whisper-model …`. **Use without downloading** still saves the model choice; Run stays blocked until bootstrap finishes. Guest/share cannot hit `/api/bootstrap` or pipeline config mutation. `components.whisper.ok` is true only when the working-set model’s weights are cached.

| Endpoint | Purpose |
|----------|---------|
| `GET /api/pipeline/steps` | Ordered step names |
| `GET /api/pipeline/config?path=` | Effective config, enabled steps, step metadata, param schema, component status |
| `PUT /api/pipeline/config` | Body `{ path, config?, enabled_steps?, unattended?, reset? }` — session working set |
| `POST /api/pipeline/analyze` | Body `{ path, apply? }` — heuristic proposals (`reasons`, `patches`); `apply` writes working set |
| `GET /api/pipeline/status` | Current / last job snapshot, scoped to the served project |
| `POST /api/pipeline/run` | Body `{ path, from_step?, only_step?, skip_steps?, enabled_steps?, unattended?, config?, use_working_set? }` — 409 if busy |
| `POST /api/pipeline/cancel` | Body `{ job_id? }` — cancel between steps |
| `POST /api/pipeline/render-preview` | Body `{ path }` — background `PipelineService.render_preview` (same job queue; 409 if busy) |
| `POST /api/export/bounce` | Body `{ path, track_ids?, start_s?, end_s?, formats? }` — starts a `kind=bounce` job (`BounceService` → `export/bounces/`); returns `{ job_id, job }` immediately (400 on validation; 409 if a pipeline-slot job is running). Paths are on the terminal snapshot `result.paths`. Host GUI seeds Activity chrome from `job` then polls (viewer already owns SSE). Cancel between bounce phases is cooperative; a cancel that lands after files are written keeps `result.paths` on the cancelled snapshot. |
| `POST /api/export/deliverables` | Body `{ path, formats? }` — `kind=export` job via `PipelineService.export_audio`; `{ job_id, job }`; `result.paths` on the terminal snapshot. Guest render path is unchanged. |
| `GET /api/shares?path=` | Host share list (presented rows + review versions). Online extension. |
| `POST /api/shares` | Body `{ path, role?, with_mcp?, review_version_id? }` — mint a link share (`ShareService.create_for_host`; publishes a review mix if none exists) |
| `POST /api/shares/{token}/revoke` | Body `{ path }` — revoke + cooldown (`ShareService.revoke`) |
| `GET /api/pipeline/events?job_id=` | SSE stream of progress + per-step timings |

**Modes:** Batch (`unattended: true`) waives align and refine when policy allows; Leave-gates keeps those gates — clear via skill/CLI (`podcast align done` / `podcast transcript refine-done`), then resume From step. Ambient agent presence is optional UX only (MCP is pull).

**Stale render UX:** Transport **Stale render** pill (hover/focus) highlights **cause regions** from `render.invalidations[]` (timeline bands for cuts/clips; header chips + light lane edge for whole-track FX/gain/mute). Premix → Mix audition cue; reconcile → StatusBar **Reconcile**. Host or Docs Editor may **click** the pill or press **Mod+B** (`render.refreshMix`) to rebuild stems/premix (clears per-track invalidations when stems go fresh). View/comment/suggest shares get the same hover highlight only. Refresh start/result is announced via a polite StatusBar live region (`statusAnnouncement`). Invalidations are diagnostic (what changed since last fresh stem); stems remain whole-artifact.

A project with no source media or timeline clips stays **Fresh** despite empty-track creation invalidations; it does not show an audio error for the absent premix. The project view includes a non-sensitive `has_source_audio` track flag so guest shares still identify playable media after local media paths are redacted, including when source duration is unknown. Opening a different project resets per-project transport and error state; refreshing the same project preserves it. A refresh started for an earlier project cannot apply its result to the currently open project or clear that project's refresh progress.

UI shows determinate progress (`current/total`), total elapsed, and a per-step table with runtime plus a short **summary** (counts of fixes/changes from each step’s return value — e.g. reconcile suppress counts, tighten cuts applied). Concurrent runs are rejected. Skill: **podcast-pipeline-tune**.

Passes 0–8: History Undo/Redo, pending Approve/Reject (bulk + nudge), applied Restore, clip fades/join, FX bypass, transcript correct/suppress, envelope points, chapter/social markers, blade/delete structural tools, and project/track/audio ingest via `POST /api/document/command`, plus document WS command-typed Applied slices (SHELL/DETAIL/TRACKS/CLIPS/FX/ENVELOPES/COMMENTS; client overlays `words[]` by source clocks) and agent selection sync. Guest shares with `suggest`/`edit` use `POST /api/review/{token}/daw/document/command` — see [daw-editing.md](daw-editing.md).

### Timeline layers (bottom → top)

1. **Clips** — waveform peaks, fade triangles, crossfade border, width-tiered role/duration labels  
2. **Levels** — volume automation polyline from `envelopes[]` (toggle)  
3. **Edits** — applied ticks under pending regions (visual markers; dense stacks are
   non-interactive for WCAG 2.5.8); `remove` hatch vs `mute` solid (toggle)  
4. **Markers** — chapter diamonds + social clip regions above lanes (toggle)

Default zoom **fits the full `timeline_duration_sec`** into the measured timeline viewport (fractional `px/sec` allowed — waveform canvases are capped separately). Manual −/+ sets a `userZoomed` flag; **Fit** (or double-click the ruler) clears it and re-fits. Container resize re-fits only while not user-zoomed. Session length stays clip-based (`timeline_duration_sec`) for Fit, Home/End, and the transport duration readout. When zoomed out so the session is narrower than the time column, the visible canvas and ruler extend to the viewport with ticks through empty time past the last clip (playhead may seek there); zoomed in, canvas width stays session-based and does not stretch past the last clip. Tick labels stay clipped inside the canvas (`overflow: hidden` / end-aligned last tick).

**Tools:** Select / Blade / Comment are exclusive icon tools in the transport (pointer / razor / bubble cursors on the time column). Fit and Menu stay as icon actions. Host **Menu → Share…** opens the share dialog (`ShareService` list/create/revoke; FOSS collaboration extension). Desktop/tablet bottom Transcript–Pipeline tabs are drag-resizable (`role="separator"`, `ns-resize`, persisted as `sharecut.tabsHeight`); double-click resets to the CSS default. The sticky track-header column stretches to the timeline well floor (surface plane under empty space below the last track).

Pinch-to-zoom and Ctrl/Cmd+wheel zoom are claimed only while the pointer is over `.timeline-scroll` (spatial intent — no prior click required). Zoom keeps the **time under the cursor** (or the midpoint of a two-finger pinch) stable. Listeners use `{ passive: false }` so `preventDefault()` can own trackpad pinch (`wheel` + `ctrlKey`) and Safari `gesture*` events; plain two-finger scroll still pans. Typing in an input/textarea skips claiming. A successful gesture sets `timelineFocused` so keyboard zoom works afterward.

Keyboard **`=` / `+` / `-` / `\`** (zoom in / out / fit) require **`timelineFocused`**. `=` / `-` anchor at the last pointer X over the timeline when available (else viewport center). Transport ± and these keys share `applyAnchoredZoom` with pinch. On phone fixed-playhead mode, zoom still anchors under the pinch/cursor and the playhead follows the new viewport center. Page zoom remains available outside the timeline; bare keys avoid fighting browser Cmd±.

### HTTP API (localhost)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Smoke check |
| `GET /api/project?path=` | Bootstrap JSON (`ProjectView`). Default `phase=shell`; `phase=detail` hydrates words+history; `phase=full` is the full dump. Loopback also pins `served_project` for host MCP |
| `POST /api/project/close` | Loopback — unpin `served_project` (host home / New project) |
| `GET /api/project/meta?path=` | `{ mtime_ns, size, server_seq }` for live reload |
| `GET /api/audio?path=&kind=&track_id=&rerender=` | Stream premix / stem / raw via `PlayService` (Range + ETag). Optional `start_sec`/`end_sec` windowed PCM |
| `GET /api/peaks/{track_id}?path=` | Uint8 overview peaks JSON (contract `overview_bins_per_sec`) |
| `GET /api/waveform-snap?path=&track_id=&start=&end=` | Windowed inaudible-cut ticks + islands for the snap overlay |
| `GET /api/history/diff?path=&from_index=&to_index=` | Snapshot delta |
| `POST /api/document/command?path=` | Typed document commands (`UndoHistory`, `SetClipFade`, `TrimClipEdge`, `SetEnvelope`, `AddChapter`, …) |
| `POST /api/review/{token}/daw/document/command` | Guest document commands (capability-gated; see [host-online-relay.md](host-online-relay.md)) |
| `GET /api/review/{token}/daw/pending-preview` | Guest listen-first Current/Suggested/A/B WAV (`play`+`view`) |
| `GET /api/review/{token}/daw/pending-preview-image` | Guest waveform/spectrogram of that extract |
| `GET /api/review/{token}/daw/proxy/{track_id}/{hash}/{i}` | Local proxy chunk fallback when object storage unset |
| `POST /api/review/{token}/comments/{id}/actions/{aid}/done` | Guest action-item toggle (`action` cap; MCP twin) |
| `GET /api/pipeline/steps` | Pipeline step names |
| `GET /api/pipeline/config` | Working-set config + step/param metadata |
| `PUT /api/pipeline/config` | Update working set |
| `POST /api/pipeline/analyze` | Heuristic Analyze proposals |
| `GET /api/pipeline/status` | Pipeline job snapshot |
| `POST /api/pipeline/run` | Start pipeline (mutates project on disk) |
| `POST /api/pipeline/cancel` | Cancel running job between steps |
| `POST /api/pipeline/render-preview` | Start render-preview job (stems + premix) |
| `GET /api/pipeline/events` | SSE progress for the active/last job |
| `POST /api/review/{token}/daw/render-preview` | Guest Docs Editor (`edit`) — same `PipelineJobManager` as host (wait or 409); paths sanitized |
| `POST /api/comments` | Create timeline comment (`CommentCreateRequest`) |
| `PATCH /api/comments/{id}` | Resolve or update body |
| `POST /api/comments/{id}/actions/{action_id}/done` | Check/uncheck action item with `by` |
| `DELETE /api/comments/{id}?path=` | Remove comment |
| `GET /api/shares?path=` | Host share list (collaboration extension) |
| `POST /api/shares` | Mint a link share (`ShareService.create_for_host`) |
| `POST /api/shares/{token}/revoke` | Revoke a live share |
| `GET /api/record/state?path=` | Host record-room snapshot (404 if no room) |
| `POST /api/record/command` | Host record command (`Start` / `Pause` / `Resume` / `Stop`) |
| `GET /api/record/upload?path=` | Host keeper ACK status for **all** participants |
| `POST /api/record/upload` | Host `p_host` keeper chunks (5 MB part cap) |
| `POST /api/diagnostics/bundle` | Host-only sanitized diagnostics zip (`DiagnosticsService`; default `~/Downloads`; unique nonce in the filename) |
| `GET /api/diagnostics/bundle/{name}` | Download a zip registered by this Studio session (filename allowlist; not a scan of `~/Downloads`) |
| `GET /api/diagnostics` | Public distribution metadata (`support_url`, `privacy_url`, `repository_url`, optional `release_manifest_url`) for Help and other product links |

`ProjectView.comments` lists all timeline comments for markers + Comments tab.

Pending edits and combined transcript utterances in `/api/project` include **dual clocks** (`source_*` / `start`·`end` plus mapped `timeline_*` / `timeline_spans` / `mappable`) via `SessionTimeline` — the UI must not plot raw source times on the timeline ruler or seek the playhead with source clocks after cuts. Utterances also carry `words[]` (per-track tokens including suppressed, with `word_index` / `confidence` / `suppressed` and timeline clocks) for seek and **Correct**-mode selection; on-disk `combined.json` is unchanged.

`pending_edits[].join_risk` is optional view metadata for tighten proposals (`filler:` / `pause:`). It maps propose-time reason suffixes (`:risky`, `:join_review`) through `gui/mapper.py` — **not** a live `EditService.join_quality` sweep on every ProjectView snapshot. Verdicts are `review` when those suffixes are present; otherwise the field is `null`. Use `join_quality_tool` for a per-decision live score. The host Tighten tab treats `review_required`, `join_risk.verdict` `fail`/`review`, and `:risky` as harsh (excluded from apply-all when Avoid harsh cuts is on).

**Transcript display is non-destructive:** cut-away (`mappable === false`) utterances stay in on-disk `combined.json` with source clocks. The DAW hides them by default and can show them dimmed (non-seekable); export already omits unmapped lines. Follow/active/seek use **timeline spans only** (no fallback to source `start`/`end`).

**Applied edits:** legacy `editorial.edit_log` rows missing `timeline_*` are remapped for the view from source clocks (first `track_ids` entry) in the assembler — view-only; the on-disk edit log is not rewritten.

`ProjectView` also includes `social_clips` (timeline-clock candidates from `social.clip_candidates`) and `envelopes` for lane-level volume curves.

Implementation: [`src/podcast_mcp/gui/`](../src/podcast_mcp/gui/) (`server.py` wires routers; handlers live in `gui/routes/`), frontend [`gui/web/`](../gui/web/) (Zustand slices under `gui/web/src/state/`, session dedupe in `gui/web/src/session/`).

## Static assets and guest surfaces

- `GET /favicon.svg` is served from the built `gui/web/dist` root (not only `/assets`).
- Hashed files under `/assets/*` use `Cache-Control: public, max-age=31536000, immutable`; HTML (`/`, `/r/{token}`, `/rec/{token}`) stays `no-cache`.
- JSON responses (project, peaks, …) are gzip-compressed when the client accepts encoding (`GZipMiddleware`). Document `/api/document/ws` (and guest dual-plane WS) negotiate permessage-deflate.
- Guest Sharecut Studio (`share:{token}`) does **not** poll `/api/pipeline/*` — pipeline status is host-only.
- Guest `daw/project` keeps a zeroed `edit_impact` stub (StatusBar-safe), empties
  `social_clips`, and strips transcript `words[]`; guest peaks are the same uint8 overview as the host.
- ReviewApp registers optional WebMCP tools (`play_pause`, `seek_timeline`, `add_comment`) when the browser exposes `navigator.modelContext`.
- Record lobby (`/rec/{token}`) fetches `GET /api/rec/{token}/bootstrap` then
  connects `WS /api/rec/{token}/ws` (Join / Consent / roster / WebRTC Signal)
  and, with `join`, `GET`/`POST /api/rec/{token}/upload` for keeper resume
  plus `DELETE` to revoke an ACK'd room-tone bed.
  Host DAW subscribes to the record plane on `WS /api/session/ws` and exposes
  `GET /api/record/state` + `POST /api/record/command` plus
  `GET`/`POST`/`DELETE /api/record/upload`. Mix-minus plays remote
  tracks only (`gui/web/src/audio/mixMinus.ts`). It never loads `/api/review/`.
