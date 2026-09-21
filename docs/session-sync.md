# Session sync engine

All writers — **agent (MCP)**, **CLI**, **local DAW**, and **future remote web users** — are the same kind of **client** of one server-authoritative sync engine.

Sharecut Studio also has a **frontend command bus** (`gui/web/src/commands/execute`) for local UX ids (`transport.togglePlay`, `tool.blade`, …). That catalog is **not** the session SyncCommand API — keys/buttons call `execute`, which then mutates Zustand and/or submits document/session wire commands. Agents keep using MCP / typed SyncCommand / DocumentCommand.

Session/document WebSockets are the **result plane** (project state + transport), not the long-running **progress plane**. Pipeline/bootstrap progress uses job SSE; guest-initiated work uses a token-keyed `plane: "progress"` event (ReviewApp `WS /api/review/{token}/progress/ws`, Studio share mode on `daw/ws`) — see [progress.md](progress.md) and [gui-integration.md](gui-integration.md) § Progress.

## Model

Inspired by [Figma multiplayer](https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/) (per-property last-writer-wins with server total order), not Google Docs OT/CRDT text (that is for ordered sequences; see [OT vs CRDT](https://www.taskade.com/blog/ot-vs-crdt)).

```
Client ──submit(command)──► SessionSyncService
                              │ append → sqlite log (server_seq)
                              │ materialize → per-field LWW snapshot
                              ▼
                         WebSocket fanout (Applied)
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                 DAW tabs            other peers
```

| Concept | Meaning |
|---------|---------|
| `client_id` | Stable id per tab / agent / CLI process |
| `client_seq` | Per-client monotonic seq (idempotency key with `client_id`) |
| `server_seq` | Global order assigned on append |
| `role` | `agent` \| `viewer` \| `cli` (metadata, not a separate code path) |
| Typed commands | `SetPlayhead`, `SetRegion`, `PlayOsAudio`, `AuditionInViewer`, … |

**`PlayOsAudio`** (real `podcast play` / MCP play with speakers): seek + highlight only — `is_playing=false` so the browser does not double-play.  
**`AuditionInViewer`** (`dry_run=true`): region + browser transport.

## On disk

| Path | Role |
|------|------|
| `artifacts/session/sync.db` | Authority: command log + snapshot + presence |
| `artifacts/session_state.json` | Materialized mirror for legacy readers |

## HTTP / WS API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/session/state` | Materialized snapshot (+ `clients[]`) |
| `GET /api/session/meta` | `server_seq` / mtime for fallback poll |
| `POST /api/session/command` | Submit typed command (agent = viewer = cli) |
| `POST /api/session/state` | Compat: viewer blob → typed commands |
| `WS /api/session/ws?path=&client_id=` | Push `Applied` / `Snapshot`; client may send `Command` / `Ack` / `Presence` |

**Playhead while playing:** viewer HTTP heartbeats use `PresenceHeartbeat` (ephemeral `clients[]` playhead). Do **not** journal continuous `SetPlayhead` — that fans out Applied events, the DAW re-seeks `HTMLAudioElement`, and audio stutters. Durable `SetPlayhead` is for paused scrub only.

**Transport authority (Figma-like):**

| Source | May drive local play/pause / seek? |
|--------|-------------------------------------|
| Role `agent` (`SetRegion`, `AuditionInViewer`, `SetPlaying`, …) | Yes |
| Same tab’s own Applied echoes | No (advance ack cursor only) |
| Other `viewer` `SetPlaying` / playhead | No — each tab owns its clock |
| Other `viewer` selection / mode / mute | Yes (discrete UI sync) |

Local DAW **Play** clears any leftover agent `playUntil` auto-stop so a prior audition region cannot halt free scrubbing. Prefer `clients[]` playhead for “what am I hearing?” while transport is rolling.

## Presence plane

Live roster, ghost cursors, selection, playhead, and viewport are **ephemeral**. They live only in the `clients.meta` JSON column of `artifacts/session/sync.db` — never in the command log, snapshot transport fields, or `session_state.json`.

**Client → server** `Presence` frame (`type` must be the first JSON key for the relay prefix match):

```json
{
  "type": "Presence",
  "client_seq": 12,
  "playhead_sec": 12.34,
  "label": "Caleb",
  "meta": {
    "display_name": "Caleb",
    "cursor": { "t_sec": 12.9, "track_id": "host", "lane_pos": 1.4 },
    "selection": { "kind": "clip", "id": "c1", "track_id": "host" },
    "viewport": { "start_sec": 0, "end_sec": 60 },
    "transport": { "playing": true, "playhead_sec": 12.34, "rate": 1 },
    "following": null,
    "ui": {
      "tab": "transcript",
      "audition": "mix",
      "viewer_mute": [],
      "solo": []
    }
  }
}
```

Chrome cursors (headers, Mix/FX/Raw, tabs, transcript words) use an anchor plus fractions instead of time:

```json
{ "cursor": { "anchor": "track:host:mute", "x": 0.5, "y": 0.4 } }
```

Meta keys merge (null clears a key). Server assigns `color_index` (0–7) and stamps `transport.stamped_ns`. `followers` is the count of live clients whose `meta.following` equals this `client_id`. Fanout is coalesced to ≤10 Hz per project.

**Rates:** cursor ≤10 Hz; transport 200 ms while playing and on play/pause/seek edges; viewport 100 ms throttle; `ui` 100 ms (tab / mobile mode / audition flush immediately); selection/following on change. Idle peers publish a 10 s keepalive so `last_seen_ns` stays inside the 30 s live window. `mobile_mode` is the live phone-shell mode on phones regardless of active pointer. On desktop/tablet it is a coarse-pointer compatibility hint derived from the active tab; fine-pointer shells publish `null`.

**Guest WS** (`/api/review/{token}/daw/ws`) accepts **Presence frames only** (view cap). Command frames stay rejected. Host WS still accepts Command / Ack / Presence. Disconnect calls `remove_client` and republishes. The share socket rewrites the query `client_id` to `guest-{token[:8]}-{suffix}` and echoes that assigned id on every session-plane message (`Snapshot` / `Presence` / `Applied`) so the guest overlay can hide its own cursor. The connect query keeps the tab’s original `viewer-*` id so reconnects stay stable.

**Follow:** the follower publishes `meta.following` (agents/CLI may still send `FollowUser`) and clears copied `transport` / `viewport`. Independent cursor still publishes (Figma observation: mouse is yours; camera is not). Followers still publish `meta.ui`. While following, the GUI also omits `playhead_sec` / `is_playing` from durable HTTP snapshots and from Presence frames so others never see a ghost needle lagging the leader. Audio is loose (~100–300 ms): each client plays locally and corrects drift from stamped transport. Overlay skips playhead ghosts for any client with `meta.following`.

### Follow scope

Every GUI surface is classified once as **Look**, **Hear**, or **Do** (`presence` on [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json); see [entry-points.md](entry-points.md) rule 6).

| Class | Mirrored while following | Examples |
|-------|--------------------------|----------|
| **Look** | Yes | Viewport + zoom, transport/playhead, active tab / phone mode, transcript scroll, inspector selection (`envelopePoint` is `{ kind, track_id, time }` — sorted volume time, not a transcript `word_index`) |
| **Hear** | Yes if the follower can; otherwise the banner says what the leader hears | Audition Mix/FX/Raw, viewer mute, solo. Guests stay Mix. Host-only tabs (History, Impact, Pipeline) stay on the follower’s last available tab with a banner like “· in Pipeline (host-only)” |
| **Do** | Never | Tool mode, comment mode, drafts, menus/dialogs/palette, focus mode, sheet, layer toggles, ingest, theme |

**Cursor** is independent of follow: drawn over any surface with a resolvable `data-presence-anchor` (or a timeline `t_sec` + `lane_pos`). If the anchor is not in this DOM, draw nothing. Never guess a Y position (unknown `track_id` without `lane_pos` used to snap to lane 0).

**Break follow** (Live Share style): only strong navigation — seek/play/stop, zoom/scroll, tab or phone-mode switch, manual transcript scroll. Mute/solo/audition/selection do not unfollow.

**Limits:** phone skips viewport follow (Ferrite center needle) but still maps the leader tab onto Listen/Text/More. A leader's phone `mobile_mode` takes precedence over its tab, so Listen and Timeline follow faithfully; desktop/tablet coarse-pointer hints derived from the tab provide the fallback. Timeline lanes stay time-based because zoom differs per client; other surfaces use `anchor` + fractional `x`/`y`. Raw `clientX`/`clientY` is never sent.

**Anchor ids** (via `presenceAnchor(...)`): `track:<id>`, `track:<id>:mute|solo`, `transport:play|stop`, `audition:mix|fx|raw`, `tab:<id>`, `mobile-nav:<mode>`, `transcript:turn:<i>`, `transcript:word:<track>:<i>`, `inspector`, `ruler`, `markers`, `comment:<id>`.

**Prior art:** [Figma Spotlight](https://help.figma.com/hc/en-us/articles/360039957614-Follow-along-and-spotlight-in-files) (does not share toolbar/sidebar actions), [tldraw user following](https://tldraw.dev/examples/sync-custom-user-presence) (camera + page; local pan/zoom/page breaks follow), [VS Code Live Share follow](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/vscode#follow-a-participant) (active file + scroll; only strong signals break follow), [Miro attention management](https://help.miro.com/hc/en-us/articles/360017572294-Attention-management), [Liveblocks presence](https://liveblocks.io/docs/ready-made-features/multiplayer/presence) (cursor `null` off-surface).

**Person vs session (deferred):** `client_id` is one tab today (anonymous share viewers match Figma; two host tabs look like two people). When an optional account provider is installed, split a stable **person id** from the per-tab connection used for WS and command seq. Roster and follow key off person; camera follows that person’s live connection.

## MCP / CLI

- `get_session_state_tool` / `podcast session status` → snapshot  
- `get_session_presence_tool` → flattened live roster (cursor, selection, viewport, transport, follow, `ui`)  
- `seek_session_tool`, `set_session_*` → typed commands via `SessionControlService`  
- `PlayService.play` → `PlayOsAudio` or `AuditionInViewer`

**DAW first Snapshot:** apply agent transport (seek/region/mode) **before** recording `command_id` as applied — otherwise the client dedupe guard skips an in-flight agent play when a tab connects mid-command.

## Planes

1. **Transport / presence** (this doc) — playhead, region, mode, who is connected.  
2. **Document** (typed commands) — same submit → log → echo shape, **separate** sqlite log at `artifacts/session/document.db`, dispatch via handler registry → existing `*Service` / `ProjectWorkspace.mutate`. Do not mix playhead heartbeats into document ops.

### Document plane API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/document/comments` | Document snapshot (`server_seq`, `comments`, `history` groups) |
| `POST /api/document/command` | Typed commands (see table below) |
| `WS /api/document/ws` | Hello shell `Snapshot`, then fanout `Applied` |

### Document command types

Handlers live in `services/document_sync/handlers/` (registry in `__init__.py`).
**Payload schemas** are Pydantic models in `services/document_sync/payloads.py`
(discriminated on `type`). Published JSON Schema:
[`schemas/document-commands.schema.json`](../schemas/document-commands.schema.json)
(regenerate with `make schema-export`; CI: `make schema-check`).
Human-readable catalog (auto-generated):
[https://docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands)
(source pack: [`docs-site/`](../docs-site/README.md)).

Host/guest HTTP, document WS, host MCP, and remote MCP validate against the same
models before `DocumentSyncService.submit`.

#### Contract source of truth (automated)

| Layer | Where it lives | How it stays in sync |
|-------|----------------|----------------------|
| Code models | `services/document_sync/payloads.py` | Edit here first |
| Checked-in schema | `schemas/document-commands.schema.json` | `make schema-export`; stale → `make schema-check` / pre-commit `document-command-schema` / `make ci` fail |
| Public docs catalog | `docs-site/pages/document-commands.md` + `docs-site/schemas/` | Same `make schema-export` / `schema-check`; operators publish the generated pack from their deployment repository. |
| Live OpenAPI | Host GUI `GET /openapi.json` (`POST /api/document/command`); disable with `PODCAST_GUI_OPENAPI=0` | Generated from the same Pydantic models; `tests/test_document_command_boundary.py` asserts `oneOf` command set matches the published schema |
| Guest OpenAPI artifact | `docs-site/schemas/guest-share.openapi.json` | Static export only — **not** served as Swagger on the relay |
| Guest MCP `inputSchema` | `guest_submit_document_command` | Loaded via `document_command_json_schema()`; unit test equality vs export |
| Human docs | This table + route tables in [host-online-relay.md](host-online-relay.md) | Update when adding a command type or changing caps; payload field detail stays in the schema / docs site (do not duplicate every field here) |
| Boundary tests | `tests/test_document_command_boundary.py` | Invalid payload must fail on host HTTP (422), guest HTTP (422), document WS (`Error`), host MCP (`ValidationError`), guest MCP (`-32602`) |

Do **not** expose Swagger on the public relay (`docs_url=None`). Host OpenAPI defaults on for local DX; set `PODCAST_GUI_OPENAPI=0` for any non-loopback bind. Static guest OpenAPI lives on docs.sharecut.studio.

| Type | Service | Payload |
|------|---------|---------|
| `AddComment`, `UpdateComment`, `ResolveComment`, `DeleteComment`, `AddReply`, `SetActionDone`, `AddAction` | `CommentService` | Comment fields |
| `UndoHistory`, `RedoHistory` | `HistoryService` | optional `rerender` |
| `ApproveEdits`, `RejectEdits` | `EditService` | `ids: string[]` |
| `UpdatePendingEdit` | `EditService.update_pending` | `id`, `start`, `end`, `snap?` (source clocks) |
| `RestoreAppliedEdit` | `EditService.revert_applied` | `id` (applied log id) |
| `SetClipFade` | `EditService.set_clip_fade` | `clip_id`, `fade_in_ms`, `fade_out_ms` |
| `SetJoinMode` | `EditService.set_join_mode` | `clip_id`, `join_in_mode` (`fade` \| `crossfade` \| `cut`) |
| `ApplyFadeRecommendations` | `EditService.apply_fade_recommendations_for_track` | `track_id?` (null = all tracks) |
| `SetEffectBypass` | `EditService.set_effect_bypass` | `track_id`, `effect_index`, `bypass` |
| `CorrectTranscriptWord` | `EditService.correct_word` | `track_id`, `word_index`, `text` |
| `CorrectTranscriptPhrase` | `EditService.correct_phrase` | `track_id`, `start_word_index`, `end_word_index`, `text` |
| `SetTranscriptWordSuppressed` | `EditService.set_word_suppressed` | `track_id`, `word_index`, `suppressed` |
| `SetEnvelope` | `PipelineService.set_envelope` | `track_id`, `points: [{time, value}]` |
| `AddChapter` | `EditService.add_chapter` | `time`, `title` (timeline clocks) |
| `UpdateChapter` | `EditService.update_chapter` | `old_time`, `old_title`, `time`, `title` |
| `DeleteChapter` | `EditService.delete_chapter` | `time`, `title` |
| MCP `remove_chapter_tool` / `podcast edit remove-chapter` | `EditService.remove_chapter` | `title` only (removes every marker with that title) |
| `AddSocialClip` | `ClipService.add_manual` | `track_id`, `start`, `end`, `title?` (timeline clocks) |
| `UpdateSocialClip` | `ClipService.update_times` | `id`, `start`, `end` |
| `DeleteSocialClip` | `ClipService.reject` | `id` |
| `SuggestPendingEdit` | `EditService.suggest_pending_edit` | `track_id`, `start`, `end`, `reason?` (source clocks) |
| `SplitAtTime` | `EditService.split_at_time` | `at_time`, `track_ids?`, `reason?` — host/`edit` applies; `suggest` proposes `type: split` |
| `DeleteClip` | `EditService.delete_clips` | `clip_id` or `clip_ids` — punch hole; suggest → pending remove |
| `RippleDeleteClip` | `EditService.delete_clips(ripple=True)` | same payload — session ripple; suggest → pending remove |
| `DuplicateSegment` | `EditService.duplicate_segment` | `source_start`, `source_end`, `insert_at` — same-track paste from live timeline |
| `MoveSegment` | `EditService.move_segment` | `source_start`, `source_end`, `insert_at` — cut+relocate in one mutate (all dialogue tracks) |
| `MoveClips` | `EditService.move_clips` | `clips: [{clip_id, timeline_start, track_id}]` — reposition clips (gaps/overlap OK); pins `source_id` on inter-track; not a range shuffle |
| `PasteSegment` | `EditService.paste_segment` | `insert_at`, `duration`, `extracts[]` — paste clipboard extracts after cut |
| `RippleDeleteRange` | `EditService.ripple_delete` | `start`, `end` — clipboard cut (host/`edit` apply-only) |

**Structural apply vs propose:** `services/document_sync/policy.py` (`resolve_structural_mode`). Host (`caps is None`) and `edit` apply immediately (History undo). `suggest` only appends pending decisions; Approve/Reject via existing Pass 1 commands.

REST `/api/comments*` still mutates via `CommentService` and best-effort notifies the document hub (`notify_comments_changed` → `COMMENTS` projection). New GUI mutations (history, edits, transcript, envelopes, markers) use the document command path only. Host: `POST /api/document/command`. Guest shares: `POST /api/review/{token}/daw/document/command` with `authorize_document_command` (`edit` / `suggest` allowlists in `services/document_sync/capabilities.py`, plus structural commands under `policy.py`). **Remote MCP** guests use the same allowlists via `guest_submit_document_command` ([host-online-relay.md](host-online-relay.md) § Remote MCP). Authz: same `authorize_client` as session WS for host (strict mode + token for non-loopback).

**Applied snapshot:** document `Applied` / WS `Snapshot` use a **named projection** of `ProjectView` (`SHELL` / `DETAIL` / `TRACKS` / `CLIPS` / `FX` / `ENVELOPES` / `COMMENTS` / `FULL` — enum in `services/document_sync/projection_types.py`; construction/dump in `gui/assembler.py`, the ProjectView seam). Comment commands omit `snapshot.project` and send `snapshot.comments` only; `ReorderTrack` / `SetTrackMeta` send `snapshot.patch.tracks`; transcript word/phrase/suppress commands send a `DETAIL` `snapshot.patch` (transcript + `words[]`); `SetClipFade` / `SetJoinMode` / `ApplyFadeRecommendations` send `snapshot.patch.clips` plus `tracks` / `render_status` (stem freshness); `SetEffectBypass` sends `snapshot.patch.effects_by_track` plus freshness; `SetEnvelope` sends `snapshot.patch.envelopes` plus freshness; structural, undo/redo, and other mutations send a `SHELL` `snapshot.project` (no `words[]`). `FULL` is reserved for explicit `GET ?phase=full` hydrate. The client overlays previous `words[]` onto incoming SHELL utterances by `track_id` + source `start`/`end` when utterance `text` matches, remapping word `timeline_*` clocks; a text mismatch or unmatched row stays wordless and `meta.hydration.transcript_words` stays false (host then refetches `?phase=detail`). Every Applied snapshot also sends lean `snapshot.history` (`cursor`, undo flags, `groups` — no flat `entries`) so the History tab list updates after TRACKS/COMMENTS patches without a DETAIL refetch. The client marks `meta.hydration.history_groups` when those groups arrive, so a later shell poll keeps them. `document_snapshot` takes the per-workspace submit `RLock` so hello WS / comments GET cannot tear `server_seq` vs history against a concurrent submit. MCP/CLI `ExternalMutate` (`after_agent_mutation` / `notify_document_changed`) defaults to **shell**; the client still merges top-level `snapshot.history` over a shell `project`. REST comments reuse the current `server_seq` (no log append). Host `useDocumentSync` merges via `applyDocumentSnapshot`: skip Echo and own-HTTP (`client_id`), but **still apply** peer / `ExternalMutate` / comments-projection snapshots at the current seq, and **always apply** `snapshot.resync` (hub overflow drain) even when the command is own-client. Seq is reset when the project path changes. Initial WS Snapshot is **shell**-shaped (no `words[]` in `project`; history groups ride on `snapshot.history`). `useProjectPoll` fires on mtime/size change and refetches `GET /api/project?phase=shell` unless local seq is already *newer* than `meta.server_seq` (equal seq and `server_seq === 0` still reload).

Hub backpressure uses a shared [`FanoutHub`](../src/podcast_mcp/services/fanout_hub.py) (`session_sync/hub.py` `SessionHub` and the guest progress hub are separate instances so planes cannot mix). Subscriber queues are bounded (`maxsize=256` for session/document). Document `Applied` / `Snapshot` overflow **drains** that subscriber queue and enqueues one event with `snapshot.resync` so the peer refetches `?phase=shell` (sparse patches are not a full supersede; merging oldest+newest would stomp fresher slices still in the queue). Session-plane events **drop-oldest** as latest-wins. Guest progress overflow drops non-terminal / last-value-coalesces per `task_id` so a slow client cannot lose `end`/`fail`/`cancel`.

### Guest dual-plane WebSocket

Share guests with the `view` capability connect to:

`WS /api/review/{token}/daw/ws`

- **Auth:** opaque share token (`lookup_share` + `authorize_share_token`); `view` required. Close `4403` on failure; `4429` when `PODCAST_GUEST_WS_CONCURRENT` is exceeded.
- **Planes:** one socket carries session and document hub events, each tagged `plane: "session" | "document"`, plus guest-initiated **progress** (`plane: "progress"`) for work **this** token started. Host pipeline jobs never appear here.
- **Receive-only:** guests never publish over WS. Mutations stay on `POST /api/review/{token}/daw/document/command` (cap-gated).
- **Sanitization:** document events pass through `sanitize_guest_document_event` (`services/share.py`) — `command` reduced to `{"type": ...}`, `snapshot.project` via `sanitize_guest_project_view`, `snapshot.history` dropped (groups can embed local paths). Session transport payloads are not path-sensitive and fan out with the plane tag only. Progress payloads are a whitelist (no host paths); coalesced ≤4/s.
- **Frontend:** `useGuestSync` demuxes planes into the same store paths as host hooks (progress → StatusBar `activityJob`); reconnects after 2s; while the socket is down it HTTP-polls `/daw/project` every 1.5s (in addition to `useProjectPoll` mtime). Presence events update the status-bar roster.
- **ReviewApp (no `view`):** commenters cannot open `daw/ws`. They subscribe to `WS /api/review/{token}/progress/ws` (valid review token only) and render the same Activity chip.
- **Remote guests:** relay terminates `wss` and bridges via tunnel frames `ws_open` / `ws_data` / `ws_close` ([host-online-relay.md](host-online-relay.md)).
- **Offline queue:** share-guest document commands persist `(command_id, client_seq)` in IndexedDB before send; retries reuse the same seq. Offline structural commands demote to `structural_mode=propose` (suggestion branch). Conflicts return HTTP 409 (`conflict: true`) and land in the guest **Needs attention** banner (`GuestAttentionBanner` / IndexedDB `conflicts:{token}`). Successful project + proxy manifest loads merge into `snap:{token}` so a later offline boot can hydrate from IndexedDB when bootstrap fetch fails. `DocumentSyncService.submit` serializes apply+append per workspace so same-seq retries cannot double-apply.

## Multi-user (Phase 3 hooks)

Phases 1–2 run the authority inside `podcast gui` (localhost). Remote humans are the same `viewer` clients on WebSocket — **no new command types** for scrub/seek/mode. Share guests use the dual-plane guest WS above (not the host `/api/session/ws` / `/api/document/ws` paths).

| Hook | Status |
|------|--------|
| `FollowUser` command | Shipped — presence meta `following`; GUI follow slaves viewport + tab + transcript + monitor state (when the follower is capable) |
| Account-scoped presence | Deferred — person id vs connection id when an optional account provider is installed |
| `authorize_client` | Default allow; `PODCAST_SESSION_AUTHZ=strict` + `PODCAST_SESSION_TOKEN` for non-loopback |
| Guest share WS | Shipped — inbound **Presence** only (`view`); unique `guest-{token[:8]}-…` ids |
| Shared host / relay | Shipped MVP — see [host-online-relay.md](host-online-relay.md) |

## Document plane

`DocumentSyncService` + `document.db` + handler registry. Broader OT/CRDT concurrent cut editing remains out of scope. Passes 0–8 shipped history through markers, full-project WS fanout, agent selection, MCP notify, blade/delete, and track/media ingest — see [daw-editing.md](daw-editing.md) and [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up) for remaining polish.

## Recording session

Record rooms reuse this sqlite file — **no new DB, no sidecar JSON.** Spec:
[recording-session.md § Where state lives](recording-session.md#where-state-lives).

| Data | How |
|------|-----|
| Roster, consent, take clock, `pauses[]`, `host_offline_since_wall_ms`, live `pause_reason` | Prefixed tables `record_commands` / `record_snapshot` / `record_clients` plus `record_participants` (lease hashes). Envelope `{type:"Record"}` / `{plane:"record"}`. Hub key `record:{workspace}`. No playhead heartbeats on the record plane. `Join` is stored as `record-join:{connection_id}:{client_id}` so a tab reload is not an idempotent no-op. Last host Leave while REC/PAUSED stamps `host_offline_since_wall_ms`; host Join after ≥ 10 s forces `paused` with `pause_reason: "host_reconnect"`. |
| WebRTC Signal | Ephemeral hub event `{type:"Signal"}`. Not stored. |
| Local keeper WAV | Guest/host origin-private OPFS (`Sharecut Recordings/…`). Not sqlite. |
| Chunk ACK | `record_upload_parts` / `record_upload_files` in this DB (`join_offset_ms`, `landed_ns`); part files under `artifacts/record/`; landing copies ACK'd WAV into `raw/` + clips. |
| Live comments | `record_live_comments` in this DB (PK `session_id, comment_id`); snapshot attaches unlanded rows; landing writes `review.comments[]` |

Do not mix playhead heartbeats into record ops. Share registry + `shares.json`
hold token `kind` / `session_id` / role; this DB holds the live room.

## References

- [How Figma’s multiplayer technology works](https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/)
- [Understanding sync engines (Liveblocks)](https://liveblocks.io/blog/understanding-sync-engines-how-figma-linear-and-google-docs-work)
- [Local-first software (Ink & Switch)](https://www.inkandswitch.com/local-first/)
- [OT vs CRDT 2026](https://www.taskade.com/blog/ot-vs-crdt)
