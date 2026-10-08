# Session sync engine

All writers — **agent (MCP)**, **CLI**, **local DAW**, and **future remote web users** — are the same kind of **client** of one server-authoritative sync engine.

Sharecut Studio also has a **frontend command bus** (`gui/web/src/commands/execute`) for local UX ids (`transport.togglePlay`, `tool.blade`, …). That catalog is **not** the session SyncCommand API — keys/buttons call `execute`, which then mutates Zustand and/or submits document/session wire commands. Agents keep using MCP / typed SyncCommand / DocumentCommand.

Session/document WebSockets are the **result plane** (project state + transport), not the long-running **progress plane**. Pipeline/bootstrap progress uses job SSE; guest-initiated work uses a token-keyed `plane: "progress"` event (Studio share mode on `daw/ws`) — see [progress.md](progress.md) and [gui-integration.md](gui-integration.md) § Progress.

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
| `client_id` | Stable id per tab or agent/CLI control stream |
| `client_seq` | Explicit positive per-client seq, or internal negative seq; idempotency key with `client_id` |
| `server_seq` | Global order assigned on append |
| `role` | `agent` \| `viewer` \| `cli` (metadata, not a separate code path) |
| Typed commands | `SetPlayhead`, `SetRegion`, `PlayOsAudio`, `AuditionInViewer`, … |

**`PlayOsAudio`** (real `podcast play` / MCP play with speakers): seek + highlight only — `is_playing=false` so the browser does not double-play.  
**`AuditionInViewer`** (`dry_run=true`): region + browser transport.
Both playback commands materialize the same ordered field set; only `is_playing`
and `dry_run` differ. This preserves per-field sequence metadata for clients.

Agent/CLI convenience commands keep stable client IDs, and the session SQLite log
allocates their next negative `client_seq` in the insert statement. Separate CLI
processes therefore cannot restart the same dedupe key. Explicit client sequences
from WebSocket/HTTP callers must be positive and remain unchanged for retries;
the separate ranges prevent collisions with newly generated commands. Older
`sync.db` logs can retain positive generated rows under the same stable ID.
For these upgraded logs, a repeated `(client_id, client_seq)` is a replay only
when `command_id` also matches. Session HTTP and WebSocket command adapters
derive a stable ID from the client, sequence, role, type, and payload when the
caller omits one, so identical requests remain retryable. A different command
ID (or different payload with an omitted ID) is rejected before it
can silently replay the historical command; the caller must use a fresh
positive sequence. This compatibility rule preserves existing command rows and
server sequence order. Old positive generated rows remain in their original
range, so clients that reuse those keys must handle this explicit collision.
The session authority enables this check only for session commands; the record
plane keeps its own retry contract, and document commands follow
[Command identity and retries](#command-identity-and-retries). The session
WebSocket reports such collisions as `Error` frames with
`code=client_seq_conflict` and stays open for a corrected command.

## Modules

| Module | Role |
|--------|------|
| [`session_sync/service.py`](../src/podcast_mcp/services/session_sync/service.py) | `SessionSyncService` — the sync authority only (`submit`, `snapshot`, `state_or_none` / `meta`; the shared `_is_empty_authority` helper is the single "empty authority" check). Module-level `session_meta` / `session_meta_at` serve `GET /api/session/meta` parse-free, from a project path or a `sync.db` path directly |
| [`session_sync/viewer.py`](../src/podcast_mcp/services/session_sync/viewer.py) | Blob adapters over that authority: `publish_viewer_snapshot` (`POST /api/session/state`, WS `ViewerState`) and `publish_agent_play` (`PlayService`) |
| [`session_sync/snapshot.py`](../src/podcast_mcp/services/session_sync/snapshot.py) | Typed-command handler registry applies per-field LWW values; unknown commands still advance envelope metadata for forward compatibility. `wire_snapshot` selects changed transport fields for the sparse durable-session `Applied` wire event |
| [`session_sync/presence_delta.py`](../src/podcast_mcp/services/session_sync/presence_delta.py) | `PresenceRosterTracker` diffs the live roster against what each project key last fanned out and returns one full `Presence` (join/leave, version bump) or one `PresenceDelta` per changed client (`row_changes` / `meta_changes`); `is_own_presence_echo` is what the host/guest WS pumps use to skip a socket's own cursor-only delta |
| [`session_control.py`](../src/podcast_mcp/services/collaboration/session_control.py) | `SessionControlService` — agent/CLI transport facade (seek, region, mode, selection, stop) |

## On disk

| Path | Role |
|------|------|
| `artifacts/session/sync.db` | Authority: command log + snapshot + presence |

## HTTP / WS API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/session/state` | Materialized snapshot (+ `clients[]`) |
| `GET /api/session/meta` | `server_seq` / mtime for the 30 s sanity poll (#662); the cross-process watcher reads the same seq server-side every `CROSS_PROCESS_POLL_S` while a socket is open, so this poll is the fallback net (#695). `mtime_ns` is the snapshot's `updated_at_ns`, not a WAL-aware file stat: the main `sync.db` file only moves at a WAL checkpoint, and presence heartbeats/Acks write the WAL without changing it. `size` is the byte length of the serialized snapshot row, not the file size, so a checkpoint of presence-only writes does not move it either. Stat + one row, no project parse, never creates `sync.db`. Store and path read errors (`OSError`, including a symlink loop, anywhere on the project or store path, and `sqlite3.DatabaseError`) report `exists: false`; project meta omits `server_seq` on the same errors (0 only means no `document.db` yet). Both go through `best_effort_meta`: transient errors log at debug; a corrupt store (a `sqlite3.DatabaseError` that is not an `OperationalError`) logs one warning per resolved store path, re-armed once a read of that store succeeds |
| `POST /api/session/command` | Submit typed command (agent = viewer = cli) |
| `POST /api/session/state` | Viewer blob → typed commands (bootstrap / non-command-log clients); socket-down fallback for `ViewerState` |
| `WS /api/host/ws?path=&client_id=&document_client_id=` | One host connection for session, document, and active recording planes. Session ingress accepts `Command` / `Ack` / `Presence` / `ViewerState` / `RosterRequest`; document commands remain HTTP. |

The `ViewerState` frame (`{"type":"ViewerState","snapshot":{…ViewerSessionSnapshot…}}`) is the WS twin of `POST /api/session/state`: the same `ViewerSessionSnapshot` model and `publish_viewer_snapshot` adapter, so both paths have identical semantics. The server ignores any `client_id` / `label` in the blob and forces the socket's own `client_id` and query `label` (a label-less socket publishes no label), so a socket cannot publish as another client or name. The server runs the adapter off the event loop (worker-thread dispatch, like the sync HTTP route) and, unlike the HTTP route, skips the `PresenceHeartbeat` (the socket carries its own `Presence` frames). It replies to the sender only with an `Echo` carrying `command.client_id`; the durable deltas it journals still fan out `Applied` to every peer through the hub, as with the HTTP route. A malformed blob or a service `ValueError` gets `{"type":"Error","code":"invalid_viewer_state",…}`, a store error gets `code: "viewer_state_failed"`, and the socket stays open, mirroring `client_seq_conflict`. `ViewerState` is host-socket only: `apply_ws_client_message`, which the guest share socket shares, ignores it.

**Sparse `Applied` / `Echo` (#598, #722).** Durable session wire events carry
snapshot envelope metadata and only transport fields attributed to the event's
sequence in `snapshot.fields`; transport fields not written by the command are omitted, and an
unknown command can have an empty transport patch. Explicit `null`, `false`, and
empty collections remain values, so clients merge only keys that are present.
The transport scope is `TRANSPORT_FIELDS`: `playhead_sec`, `is_playing`,
`audition_mode`, `region`, `source`, `track_id`, `query`, `match_index`, `selection`,
`viewer_mute`, `solo_tracks`, `tier`, `dry_run`, `wav`, and `compare_segments`.
`snapshot.clients` and `snapshot.fields` never travel on the sparse path. HTTP/MCP
`submit()` responses, `GET /api/session/state`, and hello WS `Snapshot` remain
full, including roster and field attribution.

Each sparse wire `Applied` / command `Echo` has top-level `server_seq` and `prev_seq` (the
immediately preceding sequence, `server_seq - 1`, or zero for an empty authority).
Clients merge a new delta only when `prev_seq` matches their applied cursor;
a discontinuity requires a full state resync. Cross-process watcher events
collapse commits into one head event with the latest values of fields changed
in `(after, head]`; `after=None` includes only fields attributed to the head.
They still advertise `prev_seq=head-1`, so a client missing intervening commands
fetches full state. ViewerState Echo remains a full snapshot with no `prev_seq`;
its individual commands fan out sparse Applied events. An idempotent command
retry also returns a full transport Echo with no `prev_seq`, omitting `clients`
and `fields`. Its command identifies the original acknowledgment, while its
top-level `server_seq` and snapshot describe the current head; it cannot be
interpreted as a historical delta for the old command row.

`author_client_id` equals `command.client_id`, and `roster_version` is the same
presence roster counter that `Presence` / `PresenceDelta` carry at commit time.
The host multiplexed envelope retains author attribution; clients deduplicate
by their plane's cursor and match acknowledgments by command identity.

**Playhead while playing:** viewer heartbeats publish WS `Presence` (ephemeral `clients[]` playhead) while the socket is live; the 200 ms HTTP heartbeat runs only while the socket is down. Do **not** journal continuous `SetPlayhead` — that fans out Applied events, the DAW re-seeks `HTMLAudioElement`, and audio stutters. Durable `SetPlayhead` is for paused scrub only.

The viewer's applied cursor advances from the publish result: the WS `ViewerState` `Echo` while the socket is live, or the HTTP response on the socket-down fallback. A delayed publish response cannot replace a newer Applied event's sequence or command ID, so its later echo remains deduplicated.
The fallback HTTP state poll also discards a response older than the applied cursor, even when that response carries a different command ID.

The session sanity poll runs every 30 s and on focus, and skips `GET /api/session/state` when `meta.server_seq` is no newer than the applied cursor (`sessionPollAlreadyApplied`, #662); while a socket is open the cross-process watcher already pushes another process's commits over it, so this poll rarely finds new work (#695).

While the socket is open, each debounced durable change is one `ViewerState` frame and there are zero POSTs. A reconnect republishes over the socket, and a drop republishes over HTTP. This is idempotent: `publish_viewer_snapshot` journals only changed fields. If the server answers `Error` (`invalid_viewer_state` / `viewer_state_failed`), or no own-client `Echo` arrives within 1.5 s of the oldest unechoed frame (a half-open socket or a dropped frame; each frame has its own deadline, so later sends do not extend the oldest one, and once the oldest is echoed the next-oldest frame's own 1.5 s window applies), the client republishes the latest snapshot over `POST /api/session/state`. The 1.5 s window is fixed, not scaled from round-trip time: on a live but slow link (a high-latency relay or tunnel) the Echo can land after the fallback, costing one redundant idempotent POST per debounced change.

`publish_viewer_snapshot` runs from both HTTP worker threads and the WS worker thread; `SyncStore` serializes every read and write under its `RLock` on one `check_same_thread=False` connection with `BEGIN IMMEDIATE` per write. Each changed field is its own command (no outer transaction, since `submit` fans out `Applied` per command); a publish that fails partway is repaired by the next one, which re-diffs the full blob.

A viewer publish with `is_playing=false` and a changed playhead applies
`SetPlaying` before `SetPlayhead`, so a pause-and-scrub updates the durable
playhead. An unchanged rolling heartbeat remains presence-only.

The viewer publish adapter reads the authority once to compare durable fields, then returns the snapshot already produced by its last typed command with a fresh response clock. A steady playhead heartbeat therefore reads the materialized snapshot twice (comparison and presence), rather than reading it again only for the HTTP response. It compares paused-scrub intent against the initial snapshot so a concurrent agent seek is not treated as a local scrub. `SessionSyncService` already obtains its `SyncStore` from the per-project cache; constructing the short-lived service adapter does not open a new SQLite connection for each heartbeat.

**Transport authority (Figma-like):**

| Source | May drive local play/pause / seek? |
|--------|-------------------------------------|
| Role `agent` (`SetRegion`, `AuditionInViewer`, `SetPlaying`, …) | Yes |
| Same tab’s own Applied echoes | No (advance ack cursor only) |
| Other `viewer` `SetPlaying` / playhead | No — each tab owns its clock |
| Other `viewer` selection / mode / mute | Yes (discrete UI sync) |

Local DAW **Play** clears any leftover agent `playUntil` auto-stop so a prior audition region cannot halt free scrubbing. Local DAW **Stop** (button / **K**) returns the playhead to where local playback last started (any playhead move while stopped or paused, including following someone and an agent seek applied through `applyAgentSession`, becomes the new start; a seek during playback, or an agent pause, does not). Agent/CLI stop (`stop_session_tool`, `podcast session stop`, `SessionControlService.stop`) pauses in place and clears the region, and an agent stop applied through `applyAgentSession` leaves the playhead where it is. Prefer `clients[]` playhead for “what am I hearing?” while transport is rolling.

### Host connection ownership

`gui/routes/host.py` owns the single host socket. `client_id` identifies session presence and transport commands; `document_client_id` retains the document HTTP/outbox identity. Both pass host admission, including relay denial and strict-token checks. Each outbound frame carries `plane: session|document|record`; `client_id` names the author when known, while existing command and `author_client_id` fields remain intact. Snapshot frames do not pretend the receiving client authored them. The former `/api/session/ws` and `/api/document/ws` routes are removed. Guest review/recording sockets and host HTTP endpoints keep their existing contracts.

Session and document subscribe to separate bounded hub queues before acquiring one cross-process watcher lease. Each initial snapshot precedes that plane's queued events; their cursors remain independent. Recording joins subscribe before joining, send the initial record Echo/Snapshot, then start their own pump. The shared `GuestWsGuard` serializes every accepted-socket frame and close, with the existing send deadline. A failed pump or revoked grant closes the connection; teardown stops all pumps, removes both subscriptions and recording membership, releases the watcher lease, and removes presence. Workspace loading, snapshots, ordered incoming mutations, recording attach/dispatch/disconnect and presence removal run off the event loop.

Recording attachment remains dynamic: each inbound session/record message checks the active room, detaches an old room, and joins the current room. Failed joins wait one second before another inbound frame can retry. Each socket generation has a distinct recording connection ID, so closing one tab cannot disconnect another tab's host participation. Session presence also claims a generation; retired connection cleanup cannot remove a replacement connection's roster row.

`useHostSync` owns one socket per project lifetime. Project epochs reset session cursors and local identity, retire prior callbacks and polling requests, and reconnect even after a batched A → B → A switch. Document and session cursors stay separate. Clock samples and own ViewerState echo deadlines run at receipt; state and recording work runs through the inbound queue.

## Presence plane

Live roster, ghost cursors, selection, playhead, and viewport are **ephemeral**. They live only in the `clients.meta` JSON column of `artifacts/session/sync.db` — never in the command log or snapshot transport fields.

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

A timeline cursor's `lane_pos` is in **lane units**, not px: the pointer's offset from the top of the lane stack divided by the sender's lane height (so `1.4` is 40% down the second lane). Lane height differs per viewer (lanes grow to fill each stage, 72–240px), so each receiver multiplies by its own lane height; clients that still draw fixed 72px lanes stay compatible.

Chrome cursors (headers, the Full mix / Edited stems / Original audition control, tabs, transcript words) use an anchor plus fractions instead of time:

```json
{ "cursor": { "anchor": "track:host:mute", "x": 0.5, "y": 0.4 } }
```

Meta keys merge (null clears a key). Server assigns `color_index` (0–7) and stamps `transport.stamped_ns`. `followers` is the count of live clients whose `meta.following` equals this `client_id`. Fanout is coalesced to ≤10 Hz per project.

**Server → client: `Presence` / `PresenceDelta` / `RosterRequest` (#598).** Per-tick full-roster fan-out scales as `clients²` (every client's row to every subscriber, on every tick); `PresenceRosterTracker` (`presence_delta.py`) instead keeps, per project key, the client rows it last fanned out and diffs the live roster against that base on every coalesced run (still ≤10 Hz):

- A **changed live client-id set** (join, `remove_client`, 30 s age-out) sends one full `Presence` (`{"type":"Presence","clients":[...],"roster_version","server_time_ns"}`) and bumps `roster_version`, a per-project-key monotonic counter that is never reset while the process runs (so versions do not repeat and do not reveal other projects' activity).
- Otherwise it sends one **`PresenceDelta`** per client whose row changed since the last run:
  ```json
  {
    "type": "PresenceDelta",
    "author_client_id": "viewer-a",
    "changes": { "last_seen_ns": 1730000000000000000, "meta": { "cursor": { "t_sec": 12.9 } } },
    "roster_version": 42,
    "server_time_ns": 1730000000000000000
  }
  ```
  `changes` holds only the top-level roster-row keys that changed (`row_changes`); `last_seen_ns` is always included, since liveness depends on it. `changes.meta` holds only the `meta` keys that changed (`meta_changes`); a `null` meta value means that key was removed.

**Client apply rule:** equal `roster_version` → apply the delta; older → drop it (stale, already superseded); newer, or an `author_client_id` this client's roster does not know yet → request the roster. A full `Presence` adopts its `roster_version` unless it is older than the local version (a `RosterRequest` reply skips the hub queue and can be overtaken by a newer hub roster); the hello `Snapshot` always adopts its `roster_version` (a server restart restarts the counters, and every socket reconnects through a hello). `gui/web/src/presence/roster.ts`'s `applyPresenceDelta` is this rule; `SessionRoster` is `Record<client_id, SessionClient>` so a delta replaces only its own entry and every other client keeps its prior object identity (per-client React `memo` components — `PresenceGhostLayer`'s `GhostRow`, `PresenceOverlayView`'s `PresenceOverlayRow` — re-render only the client that changed).

**`RosterRequest`** (`{"type":"RosterRequest"}`, no payload) is the client's out-of-band resync: the server replies to the sender only with a full `Presence`: the tracker's last fanned-out rows at their current version, read together under its lock, so the reply is exactly the base later deltas apply to (no version bump — nothing changed, this client just missed a delta or connected with a stale cached roster). When the tracker has no base for the key (before its first fan-out, or after a failed fan-out read dropped it), the reply reads the live rows at a bumped version, so it never reuses a version that already meant different rows; the next fan-out then sends a full `Presence` at a higher version still. `gui/web/src/session/rosterRequest.ts`'s `createRosterRequester` keeps at most one outstanding request, retried every 2 s until a `Presence` (or the hello `Snapshot`) arrives. Guests count a `RosterRequest` against the same rate limits as `Presence` (`is_presence_ws_text` in `podcast_relay/limits.py` also classifies it into the presence bucket), and every `RosterRequest` reply, host or guest, is throttled per client id (`host:{client_id}` / `guest:{assigned guest client id}`, so a reconnect does not reset the budget on either socket) by the `ws_roster_request` host limiter (`services/remote_mcp/limits.py`'s `ws_roster_request_allowed`: one per second by default, `PODCAST_WS_ROSTER_REQUEST_RPM` / `_BURST`, off with `PODCAST_RATE_LIMIT=0`); a throttled request gets no reply and the client's 2 s retry asks again.

**Own echoes:** the host and guest WS pumps skip a `PresenceDelta` authored by that socket's own `client_id` (`is_own_presence_echo`) — a plain cursor/viewport update the sender already applied locally — **unless** `changes` includes `followers` (nothing else tells a client its own follower count changed). A full `Presence` is never skipped: every subscriber, author included, needs the fresh roster to catch a version bump. Durable session `Applied` echoes are unaffected by this rule.

Each durable session command also schedules the coalesced roster fan-out (its author's row was touched). In steady state that adds at most one `PresenceDelta` per command window for the author (skipped on the author's own socket); only a key's first fan-out in a process sends a full `Presence` catch-up. Hub overflow collapses presence into one `PresenceResync` (see Overflow).

**Overflow:** when a subscriber's hub queue (256) overflows, `SessionHub` drops every buffered `Presence` / `PresenceDelta` for that socket and enqueues one `{"type":"PresenceResync"}` marker (never evicted itself); the client answers it with a `RosterRequest`, so a dropped delta cannot leave a peer's row stale. `PresenceResync` is handled by `applyPresenceFrame` and not coalesced.

**Playhead validation.** The top-level `playhead_sec` on Ack, `PresenceHeartbeat`, and `FollowUser` is validated on the server with the same rule as `meta.transport.playhead_sec` and the other presence times (`PresenceSec`: a JSON number, finite, `>= 0`; strings and booleans are rejected; `normalize_presence_playhead`). An invalid value is dropped, not rejected: the rest of the frame applies, a guest frame is not counted as malformed, and the last good playhead is kept. This is deliberate: `SyncStore.touch_client` treats `None` as "no change", so a client that only sends invalid playheads keeps its ghost at its last good position instead of clearing it (clearing would need a separate sentinel). Durable playhead writes follow the same rule: `SessionControlService.seek` raises `ValueError` for an invalid playhead and `SessionControlService.set_region` for an invalid `start_sec` / `end_sec`; `apply_command` keeps the previous snapshot playhead when a logged `SetPlayhead` or `SetRegion` carries an invalid one; the viewer blob adapter (`publish_viewer_snapshot`, WS `ViewerState` / `POST /api/session/state`) skips the paused-scrub `SetPlayhead` when the posted playhead is invalid, so nothing is journaled; and the playhead copied into the writer's `clients` row after an applied command is normalized. Clamping to the session length is done by the receiver (the overlay extrapolates valid stamped transport, falls back to the first finite of `meta.transport.playhead_sec` and top-level `playhead_sec`, and clamps with `clampToSession`), since a socket's loaded project can go stale after edits.

**Name validation.** The roster `label` (top-level on Ack, `PresenceHeartbeat` and `FollowUser`, including the owner WS `label` query param, `POST /api/session/command` and the `POST /api/session/state` viewer twin) follows the same rule as `meta.display_name`: `SessionSyncService` runs it through `sanitize_display_name`, which removes control and format characters (Unicode `Cc` / `Cf`), collapses whitespace, truncates to 40 characters, and, for a `guest-*` client, suffixes a reserved name (`Host`, `Agent`, `DAW`) with ` (guest)`. A blank label is dropped and the stored one kept (`touch_client` COALESCEs it). Clients render `meta.display_name || label || client_id`, so neither field can carry an unbounded or spoofed name.

**Viewport:** the time window a follower should show. A phone's fixed-playhead timeline scrolled before 0 publishes `[0, span]`, keeping the leader's span so followers keep its zoom, which can be wider than what is on that screen (`zoomScrollToViewport`). The span is never under `MIN_VIEWPORT_SPAN_SEC` (0.001 s, `min_viewport_span_sec` in `contracts/timeline-zoom.json`), so a near-sample zoom (up to 48,000 px/s) still publishes its window; the server rejects anything shorter. Hosts built before the 48,000 px/s zoom ceiling (#429) enforced 0.1 s and drop the whole Presence frame for a shorter span. The GUI is served by its host, so they always match; a desktop sidecar, relay or any other presence validator must be upgraded together with the host.

**Rates:** cursor ≤10 Hz; transport once per second while playing, with immediate play/pause/seek/rate edges; viewport 100 ms throttle; `ui` 100 ms (tab / mobile mode / audition flush immediately); selection/following on change. Idle peers publish a 10 s keepalive so `last_seen_ns` stays inside the 30 s live window. `mobile_mode` is the live phone-shell mode on phones regardless of active pointer. On desktop/tablet it is a coarse-pointer compatibility hint derived from the active tab; fine-pointer shells publish `null`.

**Guest WS** (`/api/review/{token}/daw/ws`) accepts **Presence and RosterRequest frames only** (view cap). Command frames stay rejected. Host WS still accepts Command / Ack / Presence / ViewerState / RosterRequest; a guest `ViewerState` frame is dropped as malformed. Disconnect calls `remove_client` and republishes. The share socket rewrites the query `client_id` to `guest-{token[:8]}-{suffix}` and echoes that assigned id on every session-plane message (`Snapshot` / `Presence` / `PresenceDelta` / `Applied`) so the guest overlay can hide its own cursor. The connect query keeps the tab’s original `viewer-*` id so reconnects stay stable.

**Follow:** the follower publishes `meta.following` (agents/CLI may still send `FollowUser`) and clears copied `transport` / `viewport`. Independent cursor still publishes (Figma observation: mouse is yours; camera is not). Followers still publish `meta.ui`. While following, the GUI also omits `playhead_sec` / `is_playing` from durable `ViewerState` snapshots (WS or HTTP fallback) and from Presence frames so others never see a ghost needle lagging the leader. Each client plays locally and corrects drift from stamped transport on a 250 ms timer, with immediate play/pause/rate updates and detected position jumps. Publication and correction read the active player's timeline clock directly, with the store position as fallback while audio is unavailable. After follow starts or playback resumes, it waits for a live audio clock and centers the initial phase with a bounded rate adjustment; later corrections keep the existing drift thresholds. The adjustment ends when the phase error crosses zero or its deadline expires. A large initial error seeks once before alignment. Pausing or leaving follow clears that wait. Both streamed HTML audio and cached proxy playback keep the leader's rate. Correction nudges by up to 3% above 80 ms drift, and seeks above 250 ms or after a nudge lasts more than one second. Remote timeline playheads extrapolate stamped transport every animation frame, including peers with no cursor. Overlay skips playhead ghosts for any client with `meta.following`.

### Follow scope

Every GUI surface is classified once as **Look**, **Hear**, or **Do** (`presence` on [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json); see [entry-points.md](entry-points.md) rule 6).

| Class | Mirrored while following | Examples |
|-------|--------------------------|----------|
| **Look** | Yes | Viewport + zoom, transport/playhead, active tab / phone mode, transcript scroll, inspector selection (`envelopePoint` is `{ kind, track_id, time }` — sorted volume time, not a transcript `word_index`) |
| **Hear** | Yes if the follower can; otherwise the banner says what the leader hears | Audition Full mix / Edited stems / Original (`mix` / `fx` / `raw`), listen-only mute, solo (saved mix mute and volume are document state, so followers already hear them). Guests stay in Full mix. Host-only tabs (History, Impact, Pipeline) stay on the follower’s last available tab with a banner like “· in Pipeline (host-only)” |
| **Do** | Never | Tool mode, comment mode, drafts, menus/dialogs/palette, layout, sheet, layer toggles, ingest, theme |

**Cursor** is independent of follow: drawn over any surface with a resolvable `data-presence-anchor` (or a timeline `t_sec` + `lane_pos`, in lane units, so it lands at the same spot in the same lane whatever each viewer's lane height). If the anchor is not in this DOM, draw nothing. Never guess a Y position (unknown `track_id` without `lane_pos` used to snap to lane 0).

**Break follow** (Live Share style): only strong navigation — seek/play/stop, zoom/scroll, tab or phone-mode switch, manual transcript scroll. Mute/solo/audition/selection do not unfollow.

**Limits:** phone skips viewport follow (Ferrite center needle) but still maps the leader tab onto Listen/Text/More. A leader's phone `mobile_mode` takes precedence over its tab, so Listen and Timeline follow faithfully; desktop/tablet coarse-pointer hints derived from the tab provide the fallback. Timeline lanes stay time-based because zoom differs per client; other surfaces use `anchor` + fractional `x`/`y`. Raw `clientX`/`clientY` is never sent.

**Anchor ids** (via `presenceAnchor(...)`): `track:<id>`, `track:<id>:mute|solo`, `transport:play|stop`, `audition:mix|fx|raw`, `tab:<id>`, `mobile-nav:<mode>`, `transcript:turn:<i>`, `transcript:word:<track>:<i>`, `inspector`, `ruler`, `markers:chapters|social|comments` (one per marker row, since rows collapse with each viewer's layer toggles; `markers` alone is the quiet empty lane), `comment:<id>`.

**Prior art:** [Figma Spotlight](https://help.figma.com/hc/en-us/articles/360039957614-Follow-along-and-spotlight-in-files) (does not share toolbar/sidebar actions), [tldraw user following](https://tldraw.dev/examples/sync-custom-user-presence) (camera + page; local pan/zoom/page breaks follow), [VS Code Live Share follow](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/vscode#follow-a-participant) (active file + scroll; only strong signals break follow), [Miro attention management](https://help.miro.com/hc/en-us/articles/360017572294-Attention-management), [Liveblocks presence](https://liveblocks.io/docs/ready-made-features/multiplayer/presence) (cursor `null` off-surface).

**Person vs session (deferred):** `client_id` is one tab today (anonymous share viewers match Figma; two host tabs look like two people). When an optional account provider is installed, split a stable **person id** from the per-tab connection used for WS and command seq. Roster and follow key off person; camera follows that person’s live connection.

## MCP / CLI

- `get_session_state_tool` / `podcast session status` → snapshot  
- `get_session_presence_tool` → flattened live roster (cursor, selection, viewport, transport, follow, `ui`)  
- `seek_session_tool`, `set_session_*` → typed commands via `SessionControlService`  
- `PlayService.play` → `PlayOsAudio` or `AuditionInViewer`

**Process boundary:** host MCP (`http://127.0.0.1:8765/mcp`) and GUI routes run in-process and fan out immediately over the socket. Stdio `podcast-mcp`, the `podcast session` / `podcast play` CLIs and `podcast record land` / `discard-take` run in a separate process; they journal to the shared `artifacts/session/` stores, and the GUI process's cross-process watcher pushes those rows to open tabs within about `CROSS_PROCESS_POLL_S` (0.5 s) while any document/session/guest socket is open (#695). The 30 s sanity poll and the focus/visibility check remain the net for a write that advances no journal seq, and for a watcher read error.

### Cross-process bridge (#695)

Each host document/session socket and the guest `/daw/ws` socket leases the process-wide `CrossProcessBridge` through the `cross_process_lease(ws)` async context manager. The socket enters it right after `hub.subscribe(...)` and before its hello snapshot, so a foreign write landing in between is either in that snapshot or published by the watcher. The context manager acquires off the event loop and releases in its own `finally`, even when another cleanup step raises or the socket task is cancelled mid-acquire. The lease is refcounted per workspace: one daemon thread polls a workspace's `sync.db` and `document.db` only while at least one socket holds a lease, and the last release stops it, so an idle project (no open tab) does no watcher work. The GUI app's lifespan calls `cross_process_bridge().stop_all()` on shutdown. The live-recording socket holds no lease, because only the GUI process writes record state and `podcast record land` writes through the session journal, which the session watcher already follows.

Each tick reads both journals' `server_seq` through the same parse-free, cached-store path as `GET /api/session/meta` / `GET /api/project/meta` (`session_server_seq_at` / `document_server_seq_at`, via `cached_sync_store_if_exists` + `best_effort_meta`); it never parses the project and never creates either store. `SessionHub` remembers the `server_seq` of every `Applied` this process published per hub key (the newest 1024, `_APPLIED_SEQ_MEMORY`), and `unpublished_seqs(key, after, head)` names the rows in `(after, head]` it did not publish. The watcher therefore publishes whenever another process wrote a row since its last tick, including a foreign row that an in-process write landed on top of within the same tick. Two locks close the remaining races: the document watcher publishes under `document_submit_lock` (the same in-process project lock every document writer holds through its publish), and the session watcher publishes under a new per-project `_publish_lock`, held by `SessionSyncService.submit` from its journal append through its hub publish. The client cursor dedupe (`document/cursor.ts`, `session/dedupe.ts`) stays as a second net either way. A failing publish is retried on the next tick, up to 3 ticks (`_PUBLISH_ATTEMPTS`), before its rows are left to the sanity poll; when the baseline read at lease time fails, the first good read publishes the head if this process did not; the idle cost is two single-row reads per `CROSS_PROCESS_POLL_S` per workspace with an open socket (none without one), so it scales with open workspaces, and a host holding hundreds open at once would want per-workspace backoff or one shared probe.

Foreign rows landing within one tick collapse into a single `Applied` at the journal head `server_seq`, carrying the session fields changed in `(after, head]` (only the head for `after=None`), with `prev_seq=head-1` for gap detection and full resync. Its `command` is the newest unpublished agent-authored row in the range, else the newest unpublished row, and the session snapshot's `last_command_id` / `last_client_id` / `last_role` / `origin` name that row. The client's authority check (`session/dedupe.ts` `shouldHandleWsMessage` / `shouldApplyRemote`) then applies an agent's play even when a viewer row is the head. The head row alone would be skipped as viewer transport, and its command id may already match the cursor. The document head always carries a SHELL snapshot (comments + history + `project`), since a narrower projection would drop a collapsed row's structural change, and it lets the client's `noteDocumentFile` adopt the file. Only the session and document planes are bridged — the record plane, cross-process presence, and a project-JSON save that advances no journal seq are unchanged, and stay covered by the 30 s sanity poll. A client that misses a foreign viewer-only discrete command (`SetSelection` / `SetMode` / `SetMuteSolo` / `ClearRegion`) before an in-process head event detects that gap through `prev_seq` and requests the full session state.

**DAW first Snapshot:** apply agent transport (seek/region/mode) **before** recording `last_command_id` as applied — otherwise the client dedupe guard skips an in-flight agent play when a tab connects mid-command.

## Planes

1. **Transport / presence** (this doc) — playhead, region, mode, who is connected.  
2. **Document** (typed commands) — same submit → log → echo shape, **separate** sqlite log at `artifacts/session/document.db`, dispatch via handler registry → existing `*Service` / `ProjectWorkspace.mutate`. Do not mix playhead heartbeats into document ops.

### Client apply model (GUI)

`useHostSync` and `useGuestSync` parse frames at receipt and reject stale socket lifetimes before applying clock or identity data. Host frames require a known plane. Clock samples and own-client ViewerState echo deadlines run at receipt. State changes enter `sync/inboundQueue.ts` and drain once per animation frame, or through `setTimeout(0)` while hidden. The queue batches DAW writes into one store commit. Full presence rosters may coalesce (`host:presence` / `guest:presence`); durable updates and PresenceDelta frames retain arrival order. Recording snapshots synchronously commit their React owner before the next signal job, so the monitor applies the current room and participant generations before SDP or ICE. Retired queued callbacks do nothing. Own-client HTTP results flush earlier socket work before entering the document authority.

### Document plane API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/document/comments` | Document snapshot (`server_seq`, `comments`, `history` groups) |
| `POST /api/document/command` | Typed commands (see table below) |
| `WS /api/host/ws` document plane | Initial shell `Snapshot`, then host-safe `Applied` frames. Document ingress is ignored; commands use `POST /api/document/command`. Host authorization is checked on connect, every 30 seconds and at most every 5 seconds on inbound frames. Revocation closes all planes with `4403`; failed pumps close with `1011`. |

### Exact-source timing commands

`SetTranscriptWordTiming` is a host-only document command. Its target contains the
exact stored transcript key and word ordinal. The context token guards the word
sequence and raw recording dependencies before the service saves source-clock
bounds. A stale token produces `DocumentConflictError`. Its `TRANSCRIPT_AUDIO`
Applied projection includes transcript words, tracks, and render status, so timing
changes to ignored words invalidate processed audio in the viewer.

`UpdatePendingEdit` accepts an optional `expected` baseline containing `track_id`,
`type`, `timebase`, `start`, and `end`. Inspector timing commands send the saved
baseline. The service checks it against the current unapplied decision under the
project transaction before creating history. A missing, applied, or changed target
returns HTTP 409 without changing the project, history, or command journal.
Offline replay keeps the baseline and reports a conflict in **Needs attention**.
Deliberate unconditional agent nudges can omit `expected`.

### Command identity and retries

An explicit `client_seq` (>= 1) plus `client_id` names one edit (#377).

- **Retry:** a command is a retry when it has the same `command_id`, or the same `type` and normalized `payload` (older clients send a new `command_id` per attempt). A retry returns the journaled row with `idempotent: true` and applies nothing.
- **Conflict:** a different edit on a used `(client_id, client_seq)`, or a reused `command_id` with a different edit, raises `DocumentSequenceConflictError`: HTTP 409 with `detail.conflict`. The client sends the new edit with a new sequence. A command whose target no longer exists is also a 409 `DocumentConflictError`: a refusal whose code is `*_not_found` or `track_has_no_media` (`names_missing_target` in `services/document_sync/errors.py`), decided by the code, never the message's wording (#1182). That covers a track, edit decision, comment, clip or transcript the command names that is gone, not a position or value the sender chose: `no_clip_at_time` (a split where no clip plays) and `word_index_out_of_range` stay plain bad requests.
- **Scope:** a `command_id` retry matches only the same `client_id`; another client reusing it gets the same conflict. Command ids must be unguessable (the GUI and `DocumentCommand` mint uuid4 hex).
- **Server-assigned:** omit `client_seq` (`null`) and the server assigns a negative sequence, starting at -1 per client. The host MCP/CLI helper and remote MCP guests use this, so separate processes never collide. An explicit `client_seq` of 0 or less fails validation (HTTP 422); it is not coerced.
- **Offline queue:** replays keep their `command_id` and `client_seq`.
- **Crash recovery (#575):** the same commit that applies a command also saves it as `document_sync.last_command` on the project. Before the retry check, `submit` reconciles: if the journal still stands at that record's `base_server_seq` and has no row for its `command_id`, it journals the row first, with `payload.result: null` since the handler's original reply was never saved (clients fall back to the snapshot). That row is committed in its own document.db transaction before the new command's apply, so the new command's `base_server_seq` is always a committed value, and a second crash or a failed COMMIT of the new command cannot roll the recovered row back; a crash inside that recovery transaction leaves no row, so the next submit recovers the command again. No `Applied` is published for the recovered row; the next command's snapshot carries the state. The recovered row keeps the saved command's own `client_id`, `role` and `causation_id`, not the submitter's (a guest's submit can journal a host's command), and its `ts_ns` is when it was journaled on recovery, not when the edit was applied; `payload.result: null` marks a recovered row. Only the last command is kept, so a reset or deleted `document.db` (whose `server_seq` no longer matches) never journals a stale record into a reused `(client_id, client_seq)`; `submit` logs a warning when it skips a saved record that is not in the journal. A handler that raises before its own commit lands leaves the previous record in place, so its own retry stays idempotent; when `submit` cannot tell whether that commit landed (the project file cannot be stat'ed), it drops the record from memory and re-reads the saved project, which holds it only if the commit landed; if that re-read fails too, the workspace has already forgotten the file's signature, so the next submit adopts the saved file. Recovery assumes the project JSON is replaced atomically: `save_project` writes a temp file and `os.replace`s it, so a killed process (SIGKILL, OOM kill) leaves the old or the new file, never a torn one, and `journal_saved_command` reads a complete record. `save_project` does not fsync, so a power loss right after a commit is outside this guarantee; `test_document_submit_crash_recovery.py` kills a submit (SIGKILL) at each of history/index write, project commit, journal INSERT, publish and journal COMMIT, and under project-lock contention (#571); power loss is not fault-injected.
- **History head:** a host or guest reply also carries `history_head_id`, the history entry the command left at the head (read in the same locked step as its apply), or null when history did not move; the retry reply above omits it. A tab's next own undo or redo expects that head. The GUI toast binds its Undo to that entry ([history.md § Guarded undo and redo](history.md#guarded-undo-and-redo-expected-head)). A refused command with a stable code (`history_stale`) sends it as `X-Sharecut-Error-Code` on the 409.
- **Busy:** when another process holds the project lock past 30 s (`filelock.Timeout`), or the `document.db` write lock stays busy past sqlite's busy timeout (`sqlite3.OperationalError` busy/locked), `POST /api/document/command` (and the guest `POST /api/review/{token}/daw/document/command`) returns 503 with `X-Sharecut-Error-Code: project_busy`. Retry the same command (same `command_id` / `client_seq`). Undo/redo with `rerender` holds the project lock and the `document.db` write lock for its render; every `document.db` writer takes the project lock first, so other writers wait on the 30 s project lock, not the sqlite busy timeout. `Applied` is published inside both locks: `FanoutHub.publish` only schedules delivery (`call_soon_threadsafe`) and must stay non-blocking. It goes out before the `document.db` COMMIT, so a client can see a `server_seq` whose row a crash rolls back; that is safe only because the project commit saved the command as `document_sync.last_command` first, so crash recovery re-journals the same command at the same `server_seq` (`test_document_submit_crash_recovery.py`, `mid_publish`). Keep the project commit ahead of the publish. Other adapters map the same busy lock their own way — CLI `BusyErrorGroup`, MCP `install_tool_errors` and guest remote MCP (both a structured `isError` tool result, `util/tool_refusal.py`) — see [architecture.md § Staleness](architecture.md#staleness) (#488).
- **Migration:** no `document.db` change. Legacy rows are compared without their stored `result`; old random positive MCP sequences stay as they are.

### Document command types

Handlers live in `services/document_sync/handlers/` (registry in `__init__.py`).
**Payload schemas** are Pydantic models in `services/document_sync/payloads.py`
(discriminated on `type`). Published JSON Schema:
[`schemas/document-commands.schema.json`](../schemas/document-commands.schema.json)
(regenerate with `make schema-export`; CI: `make schema-check`).
Human-readable catalog (auto-generated):
[https://docs.sharecut.studio/#/document-commands](https://docs.sharecut.studio/#/document-commands)
(source pack: [`docs-site/`](../docs-site/README.md)).

Host/guest HTTP, host MCP, and remote MCP validate against the same
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
| Boundary tests | `tests/test_document_command_boundary.py` | Invalid payload must fail on host HTTP (422), guest HTTP (422), host MCP (`ValidationError`), guest MCP (`-32602`) |

Do **not** expose Swagger on the public relay (`docs_url=None`). Host OpenAPI defaults on for local DX; set `PODCAST_GUI_OPENAPI=0` for any non-loopback bind. Static guest OpenAPI lives on docs.sharecut.studio.

| Type | Service | Payload |
|------|---------|---------|
| `AddComment`, `UpdateComment`, `ResolveComment`, `DeleteComment`, `AddReply`, `SetActionDone`, `AddAction` | `CommentService` | Comment fields |
| `UndoHistory`, `RedoHistory` | `HistoryService` | optional `rerender`; required `expected_head_id`, the history head the client saw (`root` before any entry; refused as invalid when missing, 409 `history_stale` unless it is still the head; [history.md § Guarded undo and redo](history.md#guarded-undo-and-redo-expected-head)) |
| `ApproveEdits`, `RejectEdits` | `EditService` | `ids: string[]`; Approve also takes `confirm_cut_speech?` (needed when a remove's ripple would cut other speech, checked at approval time) |
| `UpdatePendingEdit` | `EditService.update_pending` | `id`, `start`, `end`, `snap?`, `expected?` (saved track/type/clock/bounds) |
| `RestoreAppliedEdit` | `EditService.revert_applied` | `id` (applied log id) |
| `SetClipFade` | `EditService.set_clip_fade` | `clip_id`, `fade_in_ms`, `fade_out_ms` |
| `TrimClipEdge` | `EditService.trim_clip_edge` | `clip_id`, `edge`, `source_sec`, `mode` (`ripple` \| `gap`), required `expected_token` from a boundary context minted for that mode, `confirm_cut_speech?` |
| `RollClipJoin` | `EditService.roll_clip_join` | `left_clip_id`, `right_clip_id`, `delta_sec`, required `expected_token` from boundary context. The clips must abut (`clips_abut`); across a gap the command is refused, HTTP 400 with `X-Sharecut-Error-Code: roll_needs_abutting_clips`, before the token is checked |
| `SetJoinMode` | `EditService.set_join_mode` | `clip_id`, `join_in_mode` (`fade` \| `crossfade` \| `cut`) — mode only (fades untouched); the result adds the `join_*` render fields (`join_crossfade_blocked`) |
| `SetClipJoin` | `EditService.set_clip_join` | `left_clip_id`, `right_clip_id`, `mode` (`fade` \| `crossfade` \| `cut`), `length_ms?` (sets mode and both fades in one undo step; the GUI uses this) |
| `ApplyFadeRecommendations` | `EditService.apply_fade_recommendations_for_track` | `track_id?` (null = all tracks) |
| `SetEffectBypass` | `EditService.set_effect_bypass` | `track_id`, `effect_index`, `bypass` |
| `SetTrackFader` | `EpisodeService.set_track_volume` | `track_id`, `fader_db` (−60 to +12; saved volume on top of staging `gain_db`) |
| `SetTrackMute` | `EpisodeService.set_track_mute` | `track_id`, `muted` (saved mix mute) |
| `ReplaceTranscriptMatches` | `EditService.replace_transcript_matches` | `search`, `replacement`, `match_case`, `preview_token` (host-only; full source-keyed preview, one history action) |
| `CorrectTranscriptWord` | `EditService.correct_word` | `track_id`, `word_index`, `text`, `expected_text?` |
| `CorrectTranscriptPhrase` | `EditService.correct_phrase` | `track_id`, `start_word_index`, `end_word_index`, `text`, `expected_text?` |
| `SetTranscriptWordTiming` | `EditService.set_word_timing` | `target`, `expected_token`, `start`, `end` (source clock; host-only) |
| `SetTranscriptWordSuppressed` | `EditService.set_word_suppressed` | `track_id`, `word_index`, `suppressed`, `expected_text?` |
| `SetTranscriptWordAutomatic` | `EditService.set_word_automatic` | `track_id`, `word_index`, `expected_text?` — clears `audibility_locked` only (#824); `suppressed` waits for the next reconcile pass |
| `SetTranscriptWordsIgnored` | `EditService.set_words_ignored` | `track_id`, `start_word_index`, `end_word_index` (`ge=0`), `ignored`, `expected_text?` — text-and-audio hide (#633): words stay in the transcript, only their audio is muted at render; host-only, not in guest `EDIT_COMMANDS` |
| `SetEnvelope` | `PipelineService.set_envelope` | `track_id`, `points: [{time, value, id?}]`, and required `expected_points: [{time, value, id}]` baseline (unique IDs; each list ≤ 10 000 points); missing IDs on new points are generated before the command is journaled. Only the track's volume envelope (`parameter` `volume`/`gain`/unset, via `EpisodeProject.volume_envelope_for`) is compared and replaced; `pan` and other parameters are untouched. The handler reloads the project under the submit lock and rejects a stale baseline with a 409 before mutation/history/logging. Floats compare exactly, so clients must echo the server's points verbatim (never rounded or clamped). Host MCP `set_envelope` submits this same command (optional `expected_points`; default baseline is the envelope read at call time). |
| `AddChapter` | `EditService.add_chapter` | `time`, `title` (timeline clocks) |
| `UpdateChapter` | `EditService.update_chapter` | `old_time`, `old_title`, `time`, `title` |
| `DeleteChapter` | `EditService.delete_chapter` | `time`, `title` |
| MCP `remove_chapter_tool` / `podcast edit remove-chapter` | `EditService.remove_chapter` | `title` only (removes every marker with that title) |
| `AddSocialClip` | `ClipService.add_manual` | `track_id`, `start`, `end`, `title?` (timeline clocks) |
| `UpdateSocialClip` | `ClipService.update_times` | `id`, `start`, `end` |
| `DeleteSocialClip` | `ClipService.reject` | `id` |
| `SuggestPendingEdit` | `EditService.suggest_pending_edit` | `track_id`, `start`, `end`, `reason?` (source clocks) |
| `SplitAtTime` | `EditService.split_at_time` | `at_time`, `track_ids?`, `reason?` — host/Editor applies; Commenter proposes `type: split` |
| `DeleteClip` | `EditService.delete_clips` | `clip_id` or `clip_ids`, `mode` (`gap` punches a hole, `ripple` closes it on every dialogue track), `confirm_cut_speech?`; suggest → pending remove (`scope` `track` or `session`, a ripple records `cut_speech`) |
| `DuplicateSegment` | `EditService.duplicate_segment` | `source_start`, `source_end`, `insert_at` — same-track paste from live timeline |
| `MoveSegment` | `EditService.move_segment` | `source_start`, `source_end`, `insert_at` — cut+relocate in one mutate (all dialogue tracks) |
| `MoveClips` | `EditService.move_clips` | `clips: [{clip_id, timeline_start, track_id}]` — reposition clips (gaps/overlap OK); pins `source_id` on inter-track; not a range shuffle |
| `PasteSegment` | `EditService.paste_segment` | `insert_at`, `duration`, `extracts[]`, `mode` (`ripple` opens the time on every dialogue track; `gap` pastes over the pasted tracks in place); an unknown track or source or a bad range raises `PasteRejectedError` (`paste_*` code) before any write |
| `CutRange` | `EditService.cut_range` | `start`, `end`, `mode`, `track_ids?` (whose material the cut means; empty = every track), `confirm_cut_speech?` — clipboard cut (host/`edit` apply-only) |

`CorrectTranscriptWord` / `CorrectTranscriptPhrase` / `SetTranscriptWordSuppressed` / `SetTranscriptWordAutomatic` / `SetTranscriptWordsIgnored`'s `expected_text` is optional (#650, #744, #824): the word (or space-joined phrase) text the client saw at these indices, compared whitespace-collapsed and case-sensitive against the current transcript under the submit lock (`edits/transcript_correct.require_word_text`, shared by all five commands via `EditService._guarded_transcript_edit`). A mismatch is a 409 conflict before mutation, history, or the command log — the same contract as `SetEnvelope`'s `expected_points` (`DocumentSyncService._apply` maps every `STALE_TARGET_ERRORS` type to `DocumentConflictError`); indices or a track that no longer exist also count as a mismatch. Omitting it keeps today's unguarded behavior. Host MCP `correct_transcript_tool` / `correct_transcript_phrase_tool` / `set_word_suppressed_tool` / `set_word_automatic_tool` / `set_words_ignored_tool` take the same optional `expected_text`. All five stay host-only: a guest share (HTTP or remote MCP) gets 403 / `-32003` whatever the payload — omission from `EDIT_COMMANDS` / `SUGGEST_COMMANDS` in `services/document_sync/capabilities.py` is what keeps a new transcript command host-only without an explicit denylist.

**Structural apply vs propose:** `services/document_sync/policy.py` (`resolve_structural_mode`). Host (`caps is None`) and Editors apply immediately (History undo). Commenters only append pending decisions; Approve/Reject via existing Pass 1 commands.

**Speech confirmation:** a rippling `TrimClipEdge`, `DeleteClip`, `CutRange` or `ApproveEdits` that would cut another track's speech changes nothing and still answers 200. Its reply carries a top-level `needs_confirmation` (also in the journaled `result`, which marks it `unchanged`): `reason: "cuts_other_speech"`, the `message` to show, `confirm_label: "Cut anyway"`, `confirm_field: "confirm_cut_speech"`, and `speech` (removed `spans`, then per track its `words` with timeline times and `sound_spans`). The client sends the same command again with `confirm_cut_speech: true` as a new command. Guests (HTTP and `guest_submit_document_command`) get the same field. See [daw-editing.md § Edit modes](daw-editing.md#edit-modes-ripple-and-gap).

REST `/api/comments*` still mutates via `CommentService` and best-effort notifies the document hub (`notify_comments_changed` → `COMMENTS` projection). New GUI mutations (history, edits, transcript, envelopes, markers) use the document command path only. Host: `POST /api/document/command`. Guest shares: `POST /api/review/{token}/daw/document/command` with `authorize_document_command` (`ROLE_DOCUMENT_COMMANDS` in `services/document_sync/capabilities.py`: Commenters get the suggest set, Editors the edit set; `policy.py` chooses apply vs propose). **Remote MCP** guests use the same allowlists via `guest_submit_document_command` ([host-online-relay.md](host-online-relay.md) § Remote MCP). Authz: same `authorize_client` as session WS for host (strict mode + token for non-loopback); relayed share traffic is refused.

Host document-plane connection snapshots run in worker threads so project parsing does not block the socket event loop. Document ingress remains HTTP-only. Session, document and recording output share one serialized writer on `/api/host/ws`. `GET /api/project/meta`'s `document_server_seq` reads `document.db` directly (stat + one journal row) and does not parse the project at all, unlike the WS snapshot path above. `ProjectWorkspace.reload()` checks the project file's mtime, size, and file identity under the existing submit lock; it reuses the loaded project when unchanged and reads it again after an external write. Workspace save/mutate paths invalidate that signature after committing, so the next reload reads a fresh file before caching it.

Speaker changes update cached combined utterance labels inside the same `SetTrackMeta` history mutation. Source audio, words, and timing stay unchanged.

**Document state and deltas:** `gui/assembler.py` remains the sole constructor of named `ProjectView` projections. Ordinary commands compare their before and after projections and send `snapshot.delta`. The delta carries `base_seq`, `base_token`, `projection`, `audience`, and closed section operations. The envelope carries the resulting `server_seq`, `state_token`, `file`, and `file_before`. `SHELL`, `DETAIL`, `TRACKS`, `CLIPS`, `FX`, `ENVELOPES`, `MIX`, `TRANSCRIPT_AUDIO`, and `COMMENTS` still determine which fields a command projects. Word ignore and timing commands include audio freshness through `TRANSCRIPT_AUDIO`. History groups accompany commands even when the main projection is narrow.

Operations replace section metadata or splice and update ordered rows. Clips and effects are scoped to their track. Existing entity IDs identify rows where available. Envelopes use `(track_id, parameter)` and chapters use their existing value identity. Utterance matching is local to one comparison, not a new persisted identity. Word corrections splice the changed word and text inside the matched utterance. Regrouped utterances can reference bounded spans of predecessor text and words. No operation names an arbitrary JSON path. The client checks operation shape, predecessor counts, ranges, nesting, and total expansion before publishing a new view. Unchanged rows keep their object identity. Deltas over 256 KiB become a resync reference.

The implementation measurement on a 10,000-clip project produced 4,412-byte and 3,229-byte complete delta snapshots for consecutive single-clip moves. On that machine, before-projection capture took 1,129 ms CPU cold and 32 ms with a certified cache hit. Whole submits took 4,155 ms and 3,090 ms wall time. These are measured examples, not latency guarantees; projection and mutation work still run under project ownership. Tests cap the 10,000-clip move delta at 8 KiB and a 5,000-word correction at 4 KiB.

`DocumentSyncService` captures before, mutation, journal append, and after under project ownership and the SQLite write transaction. The scope-independent opaque state token certifies the project file, journal head, and assembler dependencies. Certificates include ctime as well as device, inode, size, and mtime. A same-size write with restored mtime therefore invalidates the delta basis. Dependencies include source files, render outputs and hashes, history index, and effective defaults. The bounded process-local cache retains immutable serialized projections, never live projects. It admits command results only after journal commit, under project ownership. An assembly whose dependencies change returns a resync reference.

`GET /api/document/state?path=...&phase=shell|detail|full` returns an atomic projection with its actual state sequence and token. The guest equivalent is `/api/review/{token}/daw/document/state`. Hello snapshots, Undo, Redo, external mutations, and cross-process advances use replacements. An idempotent retry acknowledges the original command sequence in `command.server_seq` and the top-level `server_seq`, but its replacement snapshot reports the current state head. The client never substitutes the old command sequence for the fresh snapshot sequence.

`document/applyDocumentUpdate.ts` owns one immutable authoritative view, sequence, token, and project generation. Bootstrap, HTTP results, WebSocket frames, polling, and detail hydration enter this boundary. Typed pending command drafts overlay the displayed view without changing the delta predecessor. Repeated fader, mute, metadata, and envelope drafts collapse by affected field. Command acknowledgment or failure clears only its draft and refreshes display even when the acknowledged state is older than an installed peer update. Host sockets can retire drafts by command identity. Guest sockets omit that identity for privacy, so guest HTTP/outbox outcomes retire their drafts. Actual store project changes invalidate the document generation synchronously, before React effects run. Socket lifetimes also track the project epoch, so a batched A → B → A switch reconnects. Retired socket callbacks cannot change document state, clock samples, or guest identity. Scope changes clear drafts and abort recovery. Bootstrap retries preserve the current socket generation. The durable outbox retains queued edits independently.

A delta requires the installed predecessor sequence and token. A gap, missing words, invalid operation, or mismatched token starts one snapshot recovery request. New frames raise its required head without creating an event backlog. A response below that head is retried. A late response from an earlier project generation is discarded, including a leave-and-return to the same path. Own HTTP results first flush already queued WebSocket frames. Duplicate deltas cannot advance the document twice.

Shell word overlays match utterance occurrences by track and source bounds, then require matching text, ignored, suppressed, and locked word indices, suppression status, mappability, and compatible placement spans. A uniform timeline translation remaps word clocks. Incompatible or unmatched rows remain wordless and trigger host detail hydration. Detail installs only at its captured sequence and matching state token. Guests retain their sanitized shell projection.

Out-of-band mutations still journal a real `ExternalMutate` row through `notify_document_changed` or `notify_comments_changed`. `PipelineService.run` calls `after_agent_mutation` when the run ends, including a failed or cancelled run whose earlier steps already saved. A finished GUI job, host MCP `pipeline_run` and `podcast pipeline run` therefore push their pending edits (Tighten **Find hits**, Impact, `analyze_*` proposals) to open tabs as one SHELL replacement, the way an interactive mutation does, instead of waiting for the 30 s sanity poll. REST comment mutations capture the project file revision before and after their save while holding project ownership. A comments projection carries `file_before` only when the notifier still sees that exact after-revision under its own project lock; an intervening project write omits it so clients do not claim a file they have not applied. A ready tab may apply a next-sequence comments-only snapshot without recovery only when `file_before` matches its known file; this advances the journal token and preserves the unchanged project view while adopting the comments. The cross-process watcher publishes a replacement when another process advances the journal. `useProjectPoll` remains a 30 s sanity check, also run on focus and visibility. It skips recovery when `{mtime_ns, size}` and the journal head already match the applied state. Unannounced writes still recover through the atomic state endpoint. A dropped host socket reconnects with capped exponential equal jitter, starting at 250–500 ms and capped at 15–30 s. Both initial session and document snapshots must apply before resetting the retry attempt. Guest sockets retain their 2 s retry.

Hub backpressure uses a shared [`FanoutHub`](../src/podcast_mcp/services/app/fanout_hub.py) (`session_sync/hub.py` `SessionHub` and the guest progress hub are separate instances so planes cannot mix). Delivery is scheduled per subscriber loop (`call_soon_threadsafe` once per distinct loop). Subscriber queues are bounded (`maxsize=256` for session/document). Document `Applied` / `Snapshot` overflow **drains** that subscriber queue and enqueues one event with `snapshot.resync` so the peer recovers through the atomic document state endpoint (sparse patches are not a full supersede; merging oldest+newest would stomp fresher slices still in the queue). Session-plane events **drop-oldest**; a missing sparse delta is detected by `prev_seq` and repaired through a full session state resync. Guest progress overflow drops non-terminal / last-value-coalesces per `task_id` so a slow client cannot lose `end`/`fail`/`cancel`.

Host and guest deltas are computed separately after guest sanitization. The in-process hub carries the guest variant privately. Host adapters remove that variant before sending. Guest adapters refuse an unsanitized host delta and request recovery instead.

### Guest dual-plane WebSocket

Share guests with the `view` capability connect to:

`WS /api/review/{token}/daw/ws`

- **Auth:** opaque share token (`lookup_share` + `authorize_share_token`); `view` required. Close `4403` on failure; `4429` when `PODCAST_GUEST_WS_CONCURRENT` is exceeded.
- **Service failures:** Admission, setup, and foreground crashes close with `1011`
  and fixed `internal error`, with a host traceback. Deliberate capability refusals
  keep `4403` and path-redacted detail. `gui/routes/guest_errors.py` uses the same
  refusal policy as guest HTTP and remote MCP. Shielded teardown releases queues,
  service identities, pumps, and the admission slot after a failure.
- **Shared admission:** `daw/ws` and `WS /api/rec/{token}/ws` both admit through `gui/routes/guest_ws_common.py`. `guest_ws_share_row` closes unknown, revoked, expired and wrong-kind tokens `4403 "invalid or revoked share token"`. `admit_guest_ws` takes the per-token `PODCAST_GUEST_WS_CONCURRENT` slot (`4429` when full). `GuestWsConnection.start` accepts, builds `GuestWsGuard` (30 s idle / 5 s on-frame share recheck, `4403` on revoke) and starts the recheck loop. `stop_tasks` / `release` tear down pumps, then the slot. Pump bookkeeping is `WsTaskSet` (same module), which the owner `/api/host/ws` also uses: `stop()` cancels and awaits every task, logs task failures, and re-raises an outer cancel (e.g. shutdown) that arrives while it is awaiting, once all tasks have finished; called from a `finally` that is already unwinding a cancel, it returns normally so the original `CancelledError` keeps propagating. New guest sockets must reuse this path, not copy it.
- **Guest worker ownership:** Guest admission and authorization resolve share/project/identity stores in awaited workers. Periodic and on-frame guard validation share one async lock and retain the completed decision, so another frame waits for an in-flight revocation check. The final recording send gate remains an immediate in-memory removal check. Each guest connection awaits session claim, heartbeat, snapshots, presence/roster handling, or recording join/commands in order; a slow service call leaves the event loop available to other sockets. Teardown shields its finite task-stop and worker cleanup sequence from AnyIO cancellation, then releases the admission slot. Session cleanup removes only the generation actually acquired by that connection. Recording service construction occurs inside the admitted lifetime, so rejected over-limit connections do not open its stores. Recording subscribes before Join but starts fanout only after the identity Echo and initial Snapshot have been sent.

- **Planes:** one socket carries session and document hub events, each tagged `plane: "session" | "document"`, plus guest-initiated **progress** (`plane: "progress"`) for work **this** token started. Host pipeline jobs never appear here.
- **Inbound is presence-only:** guests may send `Presence` (`usePresencePublisher`) and `RosterRequest` frames, nothing else — no `Command` / `Ack` / `ViewerState`. Document/structural mutations stay on `POST /api/review/{token}/daw/document/command` (cap-gated); a guest `Command` frame is dropped as an unknown/malformed type by `_handle_guest_presence_frame`.
- **Sanitization:** document events pass through `sanitize_guest_document_event` (`services/collaboration/share.py`) — `command` reduced to `{"type": ...}`, `snapshot.project` via `sanitize_guest_project_view`, `snapshot.history` reduced to the opaque `head_id` (groups and entries can embed local paths; a guest's undo must send the head it saw), `snapshot.file` / `snapshot.file_before` reduced to numeric `{mtime_ns, size}`. Session transport payloads are not path-sensitive and fan out with the plane tag only. Progress payloads are a whitelist (no host paths); coalesced ≤4/s.
- **Frontend:** `useGuestSync` demuxes planes into the same store paths as host hooks (progress → StatusBar `activityJob`); reconnects after 2s; until the socket first opens and while it is down it HTTP-polls `/daw/document/state` every 1.5s (`FALLBACK_POLL_MS`; deliberately not the 30 s `SANITY_POLL_MS`, because with the socket down it is the guest's only feed, #662); while it is live `useProjectPoll` runs the `/daw/meta` meta poll on the 30 s sanity cadence instead (`useGuestSyncAndProjectPoll` gates it on the `wsReady` value `useGuestSync` returns), so a guest runs one poll at a time (#657). Presence events update the status-bar roster.
- **Remote guests:** relay terminates `wss` and bridges via tunnel frames `ws_open` / `ws_data` / `ws_close` ([host-online-relay.md](host-online-relay.md)).
- **Offline queue:** document commands persist `(client_id, command_id, client_seq)` in IndexedDB before send. Share guests use `queue:{token}`; host commands use the project-path-namespaced `host-queue:{projectPath}` bucket, so the two modes never collide. Retries retain the original identity; host commands drain in persisted insertion order after document WebSocket reconnect or browser `online`, and new host commands wait behind older queued work. A live host command whose only queued predecessor is this tab's own in-flight send (`state/hostSendOrder.ts`) waits for that send, then posts itself if it became the queue head (using the persisted, possibly chained, payload) instead of returning `queued` with nothing to send it; the drain stops at any command this tab is still sending, so it is never posted twice, and drains again once that send settles (one wake-up per in-flight send, however many drains reach it). Drain requests (WebSocket reconnect, `online`, the 30 s sanity timer (`SANITY_POLL_MS`), and live commands left queued behind a predecessor) go through `requestHostDrain`, which runs one more pass when a request arrives mid-drain. Share-guest drain requests (WebSocket reconnect, `online`) go through `requestGuestDrain`, which coalesces the same way, so overlapping triggers never replay the guest queue twice at once. Both passes run one replay driver, `replayQueuedCommands` in `state/drainOfflineQueue.ts`. A per-namespace `ReplaySource` supplies the replay order (guest `client_seq`, host insertion order), the host-only live-send gate described below, and the host-only batched removal. Both passes skip a replay refused with a permanent 4xx (`isPermanentRejection`: any 4xx except 408/429), because both submit layers record it as a conflict and dequeue it before throwing. A replay answered 408 or 429 (a host or relay rate limit, a proxy timeout), a 5xx or a transport failure stays queued and stops the pass, so the next drain retries it in order. `state/drainOfflineQueue.integration.test.ts` runs both drains through the real submit layer to pin that coupling. Before replaying a record this tab was still sending when the drain read its snapshot (or any record, if a live send finished while the snapshot loaded), the drain re-reads the queue if a live send has finished since its last read (`hostSendsFinished`) and skips a record that send already removed. Live sends use fresh command ids, so live edits made during a long replay never force a re-read, and a long replay reads the payloads once. If that re-read fails, the pass stops but still removes the records it already replayed. The registry is per tab: when the queue head is another tab's command, the live command stays `queued` and requests a drain, which replays in order (the replay keeps the record's original `client_id` / `client_seq` / `command_id`, and the server is idempotent on `(client_id, client_seq)`, so a record the other tab is still posting is applied once). The wait covers every earlier live send from this tab for the project (the host queue is one FIFO, so they sit ahead anyway) and then the host drain run in progress, if any (`trackHostDrain` / `activeHostDrain`: drain replays are not registered as live sends, and replayed records leave the queue only when the pass ends). It is capped at `HOST_SEND_WAIT_MS` (5 s) in total; past that the command stays queued for the drain. Approve and Reject (Pending edit inspector, Impact panel bulk actions, and the Tighten Apply / Skip / Apply all commands, which announce it and keep the selection) report a `queued` result as a **Still sending** status rather than as done. The status (`inspector/useQueuedReviewNotice.tsx`) re-checks the project's command queue every second and clears once it is empty: the drain sent the command, or the host refused it and it moved to **Needs attention**. Successful host replays remove completed records in one batch. The attention count derives from the admitted host queue; old cached count entries are unused. Offline structural guest commands demote to `structural_mode=propose` (suggestion branch). Transport failures remain queued when storage is available. HTTP 5xx responses remain queued for host commands and guest replay; a live guest refusal is removed and reported to its caller. If storage fails, a host command is sent directly only when the readable queue proves no older edit is waiting; otherwise it reports an ordering error. A host or guest cleanup failure after a committed server response does not report that edit as failed, and its existing identity makes later replay idempotent. Validation/auth failures are removed rather than silently retried; a host replay rejected with a permanent 4xx (for example a `SetEnvelope` queued before `expected_points` existed, which now gets a 422) is also recorded as a host conflict so the drop is visible. Both drains keep replaying later commands past such a refusal; transport errors, 408/429 and 5xx stop them to preserve order. A host or guest document-command POST whose response (headers and body) has not arrived after `DOCUMENT_COMMAND_TIMEOUT_MS` (60 s, `api/documentTransport.ts`) is aborted and handled as a transport failure, so a hung request or a stalled relay tunnel cannot hold this tab's host or guest drain indefinitely; the record stays queued, and its replay is idempotent because the server checks for a retry of the same `(client_id, client_seq)` under the workspace lock, so a replay racing a still-running original waits for it and applies once. HTTP 409 conflicts are persisted in the matching `conflicts:{token}` or `host-conflicts:{projectPath}` bucket and shown in the **Needs attention** banner (`GuestAttentionBanner`); a transcript correction that lands (not queued) removes earlier `CorrectTranscriptWord` / `CorrectTranscriptPhrase` conflicts for the same track and start index (`removeHostConflictsWhere` / `removeConflictsWhere`); host conflict upserts use one transaction so simultaneous conflicts survive. Host Comments actions that need a returned comment accept a queued result and wait for document sync before selecting the new row. **Queued envelope edits:** a queued host `SetEnvelope` is applied to the local store immediately (the point stays where it was dropped), and enqueueing chains its `expected_points` to the previous queued `SetEnvelope` for the same track, so back-to-back offline edits replay in order instead of the second conflicting. After a live envelope or transcript 409, the client loads a sequenced full state through the same authority. Its actual state head and project generation prevent a delayed refresh from overwriting newer work. Replay requires the original `client_id`, `command_id`, and `client_seq` and never allocates a replacement identity. Current live calls may omit identity options to use fresh tab defaults. All four queue and conflict loaders, and every transactional update, admit only complete current records. A malformed root or mixed list rejects the whole read or update and keeps the raw saved rows unchanged. Conflicts preserve the original identity, effective structural mode, and actual submitted payload. An unreadable queue or conflict list retains the previous verified attention values and shows "Could not read saved edits on this device. Your saved edits have been kept." Dismiss all is unavailable until both reads succeed. Timing notices keep their queued or checking state rather than infer settlement from an unreadable list. Successful project + proxy manifest loads merge into `snap:{token}` so a later offline boot can hydrate from IndexedDB when bootstrap fetch fails. `DocumentSyncService.submit` serializes apply+append per workspace so same-seq retries cannot double-apply.

## Multi-user (Phase 3 hooks)

Phases 1–2 run the authority inside `podcast gui` (localhost). Remote humans are the same `viewer` clients on WebSocket — **no new command types** for scrub/seek/mode. Share guests use the dual-plane guest WS above (not the host `/api/host/ws` path).

| Hook | Status |
|------|--------|
| `FollowUser` command | Shipped — presence meta `following`; GUI follow slaves viewport + tab + transcript + monitor state (when the follower is capable) |
| Account-scoped presence | Deferred — person id vs connection id when an optional account provider is installed |
| `authorize_client` | Default allow; `PODCAST_SESSION_AUTHZ=strict` + `PODCAST_SESSION_TOKEN` for non-loopback; denies relayed traffic (host role). Owner REST routes use the host role directly, `authorize_host` (#393). |
| Guest share WS | Shipped — inbound **Presence** only (`view`); unique `guest-{token[:8]}-…` ids |
| Shared host / relay | Shipped MVP — see [host-online-relay.md](host-online-relay.md) |

## Document plane

`DocumentSyncService` + `document.db` + handler registry. Each `submit` is one `ProjectWorkspace.transaction()` (#213): a command a crash saved without its journal row is first journaled in its own committed document.db transaction (`journal_saved_command`, #575); then the retry check, the apply, and the journal row plus snapshot run inside one document.db write transaction (BEGIN IMMEDIATE), which is taken before the apply. No writer in any process commits between them. A busy journal or a rejected command fails before the project changes. The apply's commit also saves the command as `document_sync.last_command`, so after a crash or an I/O failure of the journal INSERT or COMMIT after the apply, the next `submit` journals it first instead of leaving it unjournaled. `Applied` is published while the transaction is held, so in-process subscribers receive events in `server_seq` order. Hub fanout is in-process only, but `publish_document_changed` (`notify_document_changed` / `notify_comments_changed`) journals its `ExternalMutate` row through the same critical section as `submit` (`_journal_write_lock`) — project lock, then `journal_saved_command`, then one `document.db` write transaction for the row, the snapshot and the hub publish — so the row lands in the shared `document.db` even when the hub publish itself reaches an empty (out-of-process) hub. The GUI process's cross-process watcher then pushes that row to its own open tabs within about `CROSS_PROCESS_POLL_S` while a socket is open, and their next sanity poll of `/api/project/meta` (every 30 s, or at once when the tab regains focus) is the fallback (#661, #662, #695). Broader OT/CRDT concurrent cut editing remains out of scope. Passes 0–8 shipped history through markers, full-project WS fanout, agent selection, MCP notify, blade/delete, and track/media ingest — see [daw-editing.md](daw-editing.md) and [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up) for remaining polish.

## Recording session

Record rooms reuse this sqlite file — **no new DB, no sidecar JSON.** Spec:
[recording-session.md § Where state lives](recording-session.md#where-state-lives).

| Data | How |
|------|-----|
| Roster, consent, take clock, `pauses[]`, `host_offline_since_wall_ms`, live `pause_reason` | Prefixed tables `record_commands` / `record_snapshot` / `record_clients` plus `record_participants` (lease hashes). Envelope `{type:"Record"}` / `{plane:"record"}`. Hub key `record:{workspace}`. No playhead heartbeats on the record plane. `Join` is stored as `record-join:{connection_id}:{client_id}` so a tab reload is not an idempotent no-op. A `Join` that would mint a new identity is refused with `invite_closed` when any participant minted through the same token was removed. Last host Leave while REC/PAUSED stamps `host_offline_since_wall_ms`; host Join after ≥ 10 s forces `paused` with `pause_reason: "host_reconnect"`. Each `TakeState` also stores `consented_participant_ids` (set at Start, updated by mid-take Accept/Decline), which the upload route uses to gate that take's guest keeper uploads independent of the participant's live `consented` flag. |
| WebRTC Signal | Ephemeral hub event `{type:"Signal"}`. Not stored. |
| Local keeper WAV | Guest/host origin-private OPFS (`Sharecut Recordings/…`). Not sqlite. Settled upload polling runs bounded origin-wide expiry cleanup for metadata-free WAVs older than seven days; `.keeper-cleanup.json` stores the resumable cursor/retry queue, and pruned segment markers reserve identities. Shared capture/download locks protect audio from exclusive deletion; see [Recording session](recording-session.md#where-state-lives). |
| Chunk ACK | `record_upload_parts` / `record_upload_files` in this DB (`join_offset_ms`, `clipping_regions` JSON `[[start_ms,end_ms],...]` and `clipping_truncated` from the final part, `landed_ns`); part files under `artifacts/record/`; landing copies ACK'd WAV into `raw/` + clips. |
| Deferred land rollbacks | `record_land_rollbacks` in this DB (`raw_rel`, `raw_revision` JSON, `prior_json`, `deferred_ns`, `attempts`, `retry_after_ns`; keyed by session, take, participant, segment, stale `file_sha256`) | A stale-ACK rollback is stored here after the land commit and before the rollback runs, and retried at the start of the next `land()` / `delete_take` (a failed retry backs off exponentially); rows are cleared once it commits or is moot, and purged when their take is discarded or the room is revoked (the revoke purge holds the room's land lock, so an in-flight land defers first). |
| Live comments | `record_live_comments` in this DB (PK `session_id, comment_id`); snapshot attaches unlanded rows; landing writes `review.comments[]` |
| Write atomicity | Append, apply, snapshot write and the `Comment` live-comment row run in one `BEGIN IMMEDIATE` on the record store's connection, so independent connections (other processes) serialize and a failed apply leaves no command row |

Do not mix playhead heartbeats into record ops. Share registry + `shares.json`
hold token `kind` / `session_id` / role; this DB holds the live room.

## References

- [How Figma’s multiplayer technology works](https://madebyevan.com/figma/how-figmas-multiplayer-technology-works/)
- [Understanding sync engines (Liveblocks)](https://liveblocks.io/blog/understanding-sync-engines-how-figma-linear-and-google-docs-work)
- [Local-first software (Ink & Switch)](https://www.inkandswitch.com/local-first/)
- [OT vs CRDT 2026](https://www.taskade.com/blog/ot-vs-crdt)

### Slow WebSocket consumers

`GuestWsGuard` uses `util/ws_delivery.py`'s serialized writer. Its five-second
send deadline includes lock wait. Revocation closes without waiting for a
blocked write lock and cancels the active writer. Close itself has a separate
five-second deadline. Close intent rejects later writes immediately; completion
is signalled after the close attempt finishes, fails, or times out. Concurrent
close callers share that completion. Host teardown awaits an initiated close
before cancelling its pumps, including when startup is still awaiting room
discovery. A timed-out send closes with `1013` and propagates the
failure to its pump, so the connection can reconnect and restore state.
Existing document/roster overflow markers and progress coalescing still apply
inside their application hubs. Relay stream and shared tunnel queue limits are
specified in [host-online-relay.md](host-online-relay.md#websocket-backpressure).

### Deferred fanout optimizations

Shared JSON encoding, per-token relay fanout, and replacement of the presence coalescer's threading timer remain deferred after the #601 delivery and worker changes. A production-sanitizer microbenchmark with 50 recipients measured about 0.39 ms per presence event versus 0.21 ms with shared sanitization (about 1.8 ms CPU saved per second at 10 Hz), and 0.88 ms versus 0.02 ms for a compact document event with shared encoding. These are CPU measurements for compact frames, not network throughput or large-snapshot results. Current payload sizes do not justify another delivery cache or relay audience owner.

The current coalescer retains one pending latest builder per project and builds events on delivery, but still uses a new threading timer for each trailing tick. Per-connection authorization, recipient identity, serialized writes, and compression remain independent. Revisit prepared immutable event values or relay fanout when production profiling shows material CPU or network cost; neither optimization is shipped.

The record-plane snapshot's derived `timeline_start_sec` is nullable outside an
open take and uses the same take offsets and upload tombstones as Land. It is
not stored in project JSON or the record model. The host pairs accepted record
samples with `performance.now()` for a visual-only timeline band/needle;
per-frame updates do not enter the document or playback planes. Stop/null clears
the preview; existing Land document refresh supplies the committed media.

## Exact selected ranges

`EditSelectedRange` accepts `action` (`cut` or `mute`) and an exact target. The server compares selected geometry and media revisions under the workspace lock. Host interactive submission and any Editor submission (DAW, transcript or guest MCP) apply immediately. A Commenter and the host's own agents create one pending decision. The interactive host or an Editor can approve or reject that exact decision (`policy.may_decide_exact_range`); the host's own MCP agents cannot. Payload roles and apply fields cannot elevate it. Owner HTTP credentials currently do not distinguish a human from an agent deliberately using those same credentials.

Ordered timeline islands, explicit lanes, overlapping clip geometry and media
seals form the target. A stale target remains pending; no partial group applies.
Bulk approval validates the starting snapshot and combines effects per original
clip, so an internal split cannot invalidate another proposal in that batch.
Source/mixed approval retains narrative refinement. Trusted CLI/host adapters and `edit`
guests can approve and reject exact proposals; host MCP agent calls cannot. IDs are
validated before authority lookup.

Selection, gesture drafts, range arming and Bounce targets stay local. A remote
region requires explicit adoption with lanes. Guest range Play checks the live
target and published mix freshness under a workspace transaction, returns full
mix only, and grants no render or export authority.
