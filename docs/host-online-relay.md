# Host-online relay

> **Packaging:** the edge lives in the `podcast_relay` package (`podcast-relay` CLI). Share/record/remote-MCP/guest surfaces (HTTP, MCP mint, `podcast review share*` CLI) mount through the FOSS `collaboration` [Sharecut Studio Extension](extensions.md) (`PODCAST_EXTENSIONS=` disables them). An independently installed `online` provider can mount account/auth surfaces. Document/session APIs stay in FOSS core. See [extension-seams.md](extension-seams.md).

Share your podcast project with guests or remote MCP clients while your laptop is
online — no port-forwarding required.

```
Guest browser / MCP client
        │  HTTPS / WSS
        ▼
  Caddy + podcast-relay (operator host or local Compose)
        │  proxy via tunnel
        ▼
  podcast tunnel (your laptop, outbound only)
        │
        ▼
  podcast gui  ←→  episode.project.json + artifacts
```

**Source of truth stays on your machine.**  The relay is a pass-through proxy;
it never stores audio or project data, but share audio and media may transit
while a share is active.  When you quit `podcast tunnel`, the relay
returns a stable "host offline" page to guests.

`podcast tunnel` reconnects automatically after relay or network blips (exponential
backoff, re-hello + re-register shares). Guests see offline only while the tunnel
is down; once it reconnects, share URLs work again without restarting the CLI.
Each reconnect prints a status line; see § Tunnel status.
Each disconnected session closes its stream queues and waits for its local HTTP
and WebSocket proxy tasks to stop before the local HTTP client closes.
Malformed relay HTTP headers or encoded bodies receive a small 400 response
without reaching the local GUI.

---

## Tunnel status

`podcast tunnel` reports every connection state change on **stderr**, one timestamped
line each, so a host or agent can tell what happened and for how long. The lines
never contain a host token or share token (see § Redaction).

| Phase | Line | GUI `state` |
|-------|------|-------------|
| `connecting` | `Tunnel connecting to relay.example.com:8443` (relay host only) | `connecting` |
| `connected` | `Tunnel connected: https://share.example.com (3 shares)` (public base URL, shares the relay accepted) | `online` |
| `disconnected` | `Tunnel disconnected (network: connection lost)` | `reconnecting` |
| `reconnecting` | `Tunnel reconnecting in 2.3s (attempt 2)` | `reconnecting` |
| `failed` | `Tunnel failed (auth: relay rejected the host token or host id). Check the host token …` | `offline` |
| `stopped` | `Tunnel stopped` (Ctrl-C, SIGTERM, or any exit that is not a failure) | `off` |

```text
15:29:41 Tunnel connecting to relay.example.com:8443
15:29:41 Tunnel connected: https://share.example.com (3 shares)
15:29:42 Tunnel disconnected (relay closed: close code 1012)
15:29:42 Tunnel reconnecting in 1.2s (attempt 1)
15:29:44 Tunnel disconnected (network: relay refused the connection)
15:29:44 Tunnel reconnecting in 2.3s (attempt 2)
15:29:51 Tunnel connected: https://share.example.com (3 shares)
```

Every failed try is a `disconnected` line (with the reason) followed by a
`reconnecting` line. Backoff starts at 1 s, doubles to 60 s, adds jitter, and honors
a relay `retry_after_sec` when the relay rate limits registration. A session that
reached `connected` resets the attempt count and the backoff. Reasons are
classified by `services/collaboration/tunnel_failure.py`:

| Reason | Meaning | Retried |
|--------|---------|---------|
| `network` | Connection lost or reset, relay refused, network unreachable, DNS failure (the usual shape of a host network change) | yes |
| `timeout` | Connect timed out, or keepalive pings went unanswered | yes |
| `relay closed` | The relay closed the socket (`close code N`), restarted, or answered HTTP 5xx | yes |
| `rate limited` | The relay rate limited tunnel registration | yes |
| `auth` | Close code `4403`, an `invalid host_token for host_id` reply, or HTTP 401/403 | **no** |
| `config` | Close code `4400`, HTTP 404 (no `/tunnel` endpoint), or an invalid relay URL | **no** |

An `auth` or `config` failure prints the `failed` line with its fix and exits `1`;
retrying cannot fix a wrong token or URL. `TunnelClient.run(max_attempts=N)` (library use) gives up after N
consecutive failures with `Tunnel gave up after N attempts (…)`. The relay `ping`
frame (logger `podcast_mcp.services.collaboration.tunnel`) and the 15 s status heartbeat
(`…collaboration.tunnel_status`) are debug-level logs only, never status lines.

**Host GUI.** The tunnel is a separate process from `podcast gui`, so
`TunnelStatusTracker` also persists the current phase to one JSON file per tunnel under
the machine cache: `~/.cache/podcast_mcp/tunnel/<key>.json` (`PODCAST_MCP_CACHE` moves
the cache). `<key>` hashes the tunnel's `host_id` and relay URL, so the path does not
depend on `--config` or `PODCAST_RELAY_CONFIG`, and two tunnels for different hosts or
relays never overwrite each other (two with the same identity share a file, as they
would share a registration on the relay). Each file refreshes `updated_at` every 15 s
and holds the phase, relay host, public base URL, share count, redacted reason, the
next retry time (`retry_at`), timestamps and the writing process id (`pid`). SIGINT and
SIGTERM cancel the tunnel, so the file ends in the `stopped` phase before the process
exits; only a failure keeps its `failed` phase, so the host still sees why. A killed
process (SIGKILL, a crash, a closed terminal) cannot write, which is why the reader
checks the `pid` and the age too.

The `tunnel.status` feature serves `GET /api/tunnel/status` (host role only; the tunnel
never maps `/api/tunnel`). It reads every file and reports one `state`:

| `state` | When | Share dialog line |
|---------|------|-------------------|
| `online` | A tunnel is connected | Guests can open your links |
| `connecting` | Starting up | Connecting… guests can open your links once you're online |
| `reconnecting` | Dropped and retrying | Reconnecting… guests may see a brief interruption, then "Trying again in N s" (a still "Next try at" clock time under reduced motion) |
| `offline` | Failed (auth, config, gave up), or a live snapshot not refreshed for 45 s to 10 minutes whose process is not known to be gone (a frozen process, a sleeping laptop) | Not reachable online: guests can't open links until you're back online, with a "How to fix" disclosure and a link to this section |
| `off` | Stopped (Ctrl-C, SIGTERM, or any exit but a failure), a live snapshot whose process is gone (killed, crashed), a file nothing has written for 10 minutes, or no snapshot yet while relay settings exist (`relay.yaml` at the default path, `PODCAST_RELAY_URL` or `PODCAST_RELAY_HOST_TOKEN`) | Online sharing is off, with "How to turn it on" |
| `not_set_up` | No snapshot and no relay settings: a local-only host | No line |

**One table derives the state of each file.** A file outlives its tunnel, so the phase
it holds is only a claim. `read_tunnel_status` checks the phase kind (live, failed or
stopped), whether the recorded `pid` still runs, and the age of `updated_at`, then takes
the first matching row (`_RULES` in `tunnel_status.py`):

| Phase kind | Process | Age of `updated_at` | `state` |
|------------|---------|---------------------|---------|
| stopped | any | any | `off` |
| live (connecting, connected, disconnected, reconnecting) | gone | any | `off` |
| any | any | over 10 minutes | `off`, and the file is deleted |
| live | running or unknown | over 45 s | `offline` ("stopped responding") |
| any | any | any | the phase's own state |

Failed is the one kind a missing process does not touch: `podcast tunnel` exits on an
auth or config failure, so its process is gone by design and the fix stays on screen
until the file is abandoned. "Unknown" is a file with no usable `pid`, or a platform
that cannot be probed (Windows); the age rows decide. A reused pid reads as running and
falls to the age rows too.

**Why 45 s and 10 minutes.** A running tunnel rewrites its file every 15 s, also while
it backs off, so three missed beats (45 s) means something is wrong: that is an outage
and it keeps the alarm. A file nothing has written for 10 minutes is not an outage a
host is watching but a tunnel they left behind. Ten minutes is long enough to fix a
real problem with the alarm still up, and short enough that an abandoned host sees the
calm "Online sharing is off" in the same sitting, not forever. Every read deletes the
files past 10 minutes (`unlink` that tolerates a file another reader already removed
and a cache it cannot write), so the directory stays small. A live tunnel that was only
frozen recreates its file on the next heartbeat.

With several tunnels, the best state wins (online, reconnecting, connecting, offline,
off), then the most recently updated, so a tunnel that is up outranks stopped or
abandoned ones, and a real outage outranks both. The dialog copy follows the
[communication philosophy](communication-philosophy.md#terminology): it names what
guests can do and never says tunnel, relay or host token. To fix a `Not reachable
online` line: for an `auth` failure, get a new host token from the relay operator and
rerun `podcast tunnel`; for `config`, correct `relay_url`; otherwise check the network
and restart `podcast tunnel` if it exited.

**Redaction.** The tracker redacts the host token and every advertised share token
(literal match) plus any `/r/…`, `/rec/…`, `/api/review/…`, `/mcp/…` path segment
and `token=` value from each line, the snapshot and the tunnel's proxy log messages
(`util.redact.redact_secrets`). The relay URL carries no user info or query, so the
connecting line prints only `host[:port]`.

---

## Quick start (local Compose)

No hosted account required to develop or test.

```bash
# 1. Start the relay + Caddy stack
docker compose -f deploy/relay/docker-compose.yml up --build

# 2. Start the local GUI authority
podcast gui --project /path/to/episode.project.json --no-open

# 3. Open the tunnel (advertises your project's share tokens)
podcast tunnel \
  --project /path/to/episode.project.json \
  --relay-url ws://127.0.0.1:8080/tunnel \
  --host-token dev-host-token

# 4. Create a share (in a third terminal or via MCP)
podcast review share create \
  --project /path/to/episode.project.json \
  --version-id <version_id> \
  --public-base-url http://127.0.0.1:8080

# Guest opens:  http://127.0.0.1:8080/r/<token>
```

---

## Config file (optional)

`~/.config/podcast_mcp/relay.yaml`:

```yaml
relay_url: ws://127.0.0.1:8080/tunnel   # or wss://share.example.com/tunnel
host_token: <from relay admin>
public_base_url: http://127.0.0.1:8080
local_gui_url: http://127.0.0.1:8765
# Optional stable tunnel identity (env: PODCAST_RELAY_HOST_ID). Must equal the
# `host_id:` prefix when the relay pins this host's secret in PODCAST_RELAY_HOST_TOKENS.
# When unset, a uuid is minted once and persisted next to this file (`relay_host_id`).
host_id: host-1

# Optional: pin the host share-token registry so GUI/CLI/tunnel share one DB.
# Env equivalent: PODCAST_SHARE_REGISTRY=~/.podcast_mcp/share_registry.sqlite
# (relay.yaml does not load this key yet — export the env in your shell/launchd.)

# Optional: any S3-compatible object store for review-mix audio bypass.
# Credentials stay on the host — never on the relay configuration committed to git.
# Install: pip install 'podcast-mcp[object-store]' (also pulled in by [gui]).
object_store:
  endpoint_url: https://s3.example.test
  region: region-1
  bucket: review-media
  access_key_id: <object-store-key>
  secret_access_key: <object-store-secret>
  # optional: cdn_endpoint: https://media.example.test
```

Relay env overrides: `PODCAST_RELAY_URL`, `PODCAST_RELAY_HOST_TOKEN`, `PODCAST_RELAY_PUBLIC_BASE_URL`,
`PODCAST_RELAY_LOCAL_GUI_URL`, `PODCAST_RELAY_HOST_ID` (letters, digits, `.`, `_`, `-`; no `:` or `,`).

Object-store env overrides (same fields): `PODCAST_OBJECT_STORE_ENDPOINT_URL`, `PODCAST_OBJECT_STORE_REGION`,
`PODCAST_OBJECT_STORE_BUCKET`, `PODCAST_OBJECT_STORE_ACCESS_KEY_ID`, `PODCAST_OBJECT_STORE_SECRET_ACCESS_KEY`,
`PODCAST_OBJECT_STORE_CDN_ENDPOINT`.

CLI flags (`--relay-url`, `--host-token`, `--public-base-url`, `--local-gui`) override
environment variables, which override this file. Missing fields use loopback defaults.
`public_base_url` must be an exact origin (for example, `https://share.example.com` or
`https://share.example.com:8443`), with no path, query, or fragment. Unknown YAML keys are
rejected.

---

## Share capabilities

Two axes (Google Docs–shaped):

1. **General access** — default **Anyone with the link** (coolname bearer; login-free comments). Optional **Restricted** requires a signed-in principal on the ACL ([share-tokens.md](share-tokens.md) § Identity).
2. **Role** — Viewer, Commenter or Editor, as in Google Docs. Each role expands to the capability bits below (`REVIEW_ROLE_CAPABILITIES` in `edits/share_capabilities.py`). Browser `/r/{token}` and share MCP `/mcp/{token}` always expose the **same** capability set.

### Review roles → caps

| Role | Caps | Guest UI |
|------|------|----------|
| **Viewer** | `play`, `view` | Sharecut Studio, read-only |
| **Commenter** (default) | Viewer + `comment`, `reply`, `action`, `suggest` | Sharecut Studio with comments and Suggest cut. Suggestions wait for an Editor or the host. **No login** on link shares |
| **Editor** | Commenter + `edit` | Sharecut Studio; edits directly and approves or rejects suggestions |
| **Owner** | Host laptop only | full stdio MCP **or** GUI `http://127.0.0.1:8765/mcp` (not a guest share) |

`mcp` is not part of any role. `--with-mcp` adds it to the chosen role. The role decides which document commands a guest runs (`ROLE_DOCUMENT_COMMANDS` in `services/document_sync/capabilities.py`), so a capability set that holds no role in full runs none. There is no `--capabilities` flag.

```bash
podcast review share --role viewer --project … --version <id> --base-url https://sharecut.studio
podcast review share --role commenter --with-mcp …
podcast review share --role editor --with-mcp …
podcast review share --kind record --project … --base-url https://sharecut.studio
podcast review share --kind record --session-id <id> --role producer --expires-at …
```

### Capability bits

| Capability | Meaning |
|------------|---------|
| `play`     | Stream review-mix / guest DAW audio |
| `view`     | Read-only **Sharecut Studio** (timeline, tracks, waveform pyramid tiles, premix) |
| `comment`  | Add timeline comments |
| `reply`    | Reply to existing comments |
| `join`     | Be recorded in a record room (no MCP) |
| `monitor`  | Hear a record room (producer or guest; no MCP) |
| `suggest`  | Commenter and Editor. Propose pending edits (`SuggestPendingEdit`), retime only its own suggestions (`UpdatePendingEdit` on edits whose `author` is this share; other guests', host and agent edits are refused), and **propose** structural ops (`SplitAtTime`, `DeleteClip` in either edit mode; a ripple suggestion that cuts another speaker records it, so approving asks to confirm) and selected ranges (`EditSelectedRange`, incl. transcript Select) — cannot approve/apply |
| `edit`     | Editor only. Apply Pass 1–2 document commands (approve/reject any pending edit including exact range proposals, restore, fades, join, clip body move / `MoveClips`, undo/redo) **and apply** structural ops and selected ranges (`EditSelectedRange`) on the guest document route and guest MCP alike |
| `mcp`      | Allow **capability-scoped** remote MCP at `{base}/mcp/{token}/mcp` (same powers as the other caps on this token — not the full host MCP surface) |

Default for new shares: **Commenter**, Anyone with the link. Every role holds `view`, so `/r/{token}` opens Sharecut Studio for all three. There is no separate listen page: a share without `view` has no page, and no role, CLI flag, MCP tool or Share dialog option mints one.

```bash
# Read-only full DAW (timeline + playback)
podcast review share --role viewer \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Comments + Suggest cut (the default role)
podcast review share --role commenter \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Edit directly and approve suggestions
podcast review share --role editor \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Remote MCP (capability-scoped; trusted collaborators)
podcast review share --role commenter --with-mcp \
  --project episode.project.json --version <id> \
  --base-url https://share.example.com
```

The share URL is `{public_base_url}/r/{token}` where `{token}` is a coolname
slug (e.g. `fantastic-acoustic-whale`). Token minting, active + cooldown pools,
and uniqueness: **[share-tokens.md](share-tokens.md)**.
`GET /r/{token}` injects the episode `<title>` plus Open Graph / Twitter audio meta
(`og:audio` / `twitter:player:stream`) so iOS Messages and similar can show the
episode name and offer inline playback when `play` is granted.
Hashed `/assets/*` responses set `Cache-Control: public, max-age=31536000, immutable`
on the host GUI; the tunnel forwards those headers so guests get long-lived caches.
The relay also serves `/llms.txt` for agentic-browsing discoverability.
The MCP URL (when `mcp` is granted) is `{public_base_url}/mcp/{token}/mcp`
(Streamable HTTP JSON-RPC; `GET /mcp/{token}` is info-only). The host GUI and
relay both use that path (relay tunnels to the same host route).
**Alias:** `{public_base_url}/r/{token}/mcp` is the same bridge (share URL + `/mcp`)
so Claude/custom connectors that append `/mcp` to the share URL still work.
Configure agents with the printed `/mcp/…/mcp` URL.

### Claude.ai custom connectors (authless)

Link shares with `mcp` are **authless**: paste the MCP URL into Claude → Connectors,
leave OAuth Client ID blank. Do **not** use the browser Share URL alone. Restricted
shares need a user-bound agent Bearer (or future MCP OAuth) — not Claude `none`.

### Remote MCP transport note

**Deferred:** replacing the custom JSON-RPC remote MCP bridge with MCP SDK Streamable HTTP
+ MCP OAuth. Role/ACL still come from share caps (+ Restricted identity); MCP OAuth would only
authenticate which MCP client is calling — not the Docs-like document ACL. Claude directory /
DCR is not required for link-share authless connectors.

### Guest Sharecut Studio APIs (token-scoped)

All under `/api/review/{token}/…` (proxied by the relay; **no** `?project=` paths):

| Route | Cap | Notes |
|-------|-----|--------|
| `GET …/daw/project` | `view` | Sanitized ProjectView (no host filesystem paths) |
| `GET …/daw/meta` | `view` | mtime/size + document `server_seq` for poll reload (`server_seq` omitted when `document.db` is unreadable) |
| `GET …/daw/waveform/status` | `view` | Waveform pyramid status for **raw** media only (`track:` / `source:` refs; stems stay host-only); `no-store`; read rate class. Same shape as host `GET /api/waveform/status` ([waveform.md § API](waveform.md#api)) |
| `GET …/daw/waveform/tiles/{key}?ref=&level=&start=&count=` | `view` | Binary min/max/RMS pyramid tiles; `track:`/`source:` refs only and only the ref's live key (else 404). `Cache-Control: private, max-age=31536000, immutable`. **Audio** rate class (no RPM, holds an audio concurrency slot). There is no guest PCM route: raw samples never go to guests |
| `GET …/daw/waveform-snap` | Commenter or Editor (the gate allows `EditSelectedRange`) | Windowed snap ticks for the DAW overlay; Viewers get the quiet wash only |
| `GET …/daw/pending-edits/{edit_id}/cut-suggestion` | Commenter or Editor (the gate allows `UpdatePendingEdit`) | Read-only silence-boundary suggestion for a complete pending source cut or mute. No-store; read rate class. Missing, applied, split, or non-source decisions are refused. |
| `POST …/daw/boundary/context` | Editor (`edit_commands_allowed`) | Validate visible clip geometry and return source-safe trim/roll limits plus the revision required by the edit command; guest rendered boundary audition is unavailable. |
| `GET …/daw/audio?kind=` | `play` | Whitelist: `premix`, `stem`, `processed`, `review`. Rejects `raw` and `rerender=true` |
| `GET …/daw/pending-preview` | `play` + `view` | Listen-first Current / Suggested / A/B WAV (Suggested renders the approved edit; not host speakers). First hit is FFmpeg (mutate RPM); cached GET uses audio concurrency. |
| `GET …/daw/pending-preview-image` | `play` + `view` | Waveform (`kind=wave`) or spectrogram (`kind=spec`) of that extract |
| `POST …/daw/document/command` | `view` + role command set | Commenter → SuggestPendingEdit, UpdatePendingEdit on its own suggestions only (`EditDecision.author`, `policy.authorize_pending_update`), structural and selected-range propose; Editor → Pass 1–2 apply + structural and selected-range (`EditSelectedRange`) apply + track ingest (`AddTrack` / `SetTrackMedia` / `SetTrackMeta` / `RemoveTrack` / `ReorderTrack`) + saved mix (`SetTrackFader` / `SetTrackMute`) via `document_command_types_for_caps` / `authorize_document_command` + `policy.resolve_structural_mode` / `policy.resolve_range_mode`. A guest's review role decides apply vs propose on every surface: an Editor applies a range on this route and through the guest MCP `guest_submit_document_command`, a Commenter proposes on both, and `structural_mode: "propose"` (offline replay) still demotes to a proposal. Editors approve and reject any pending edit, exact range proposals included (`policy.may_decide_exact_range`); only the host's own MCP/CLI agents are refused exact decisions. Typed payloads: `schemas/document-commands.schema.json`. |
| `POST …/daw/media/upload` | Editor (`edit_commands_allowed`) | Chunked audio into host `raw/` (allowlist + assembled size cap); then guest submits `SetTrackMedia` / `AddTrack`. Not for Commenters or Viewers. Not the record full-quality recording route. |
| `GET /api/rec/{token}/upload` | record `join` | Own full-quality recording chunk ACK status (lease required; host removal revokes it and returns 403 `invalid lease`) |
| `POST /api/rec/{token}/upload` | record `join` | Full-quality recording PCM parts (5 MB / 30 s); resume on the same token. Full-quality recording parts only for takes the participant consented to; `kind=room_tone` only while consented (403 `consent required`). Host removal revokes the lease (403 `invalid lease`). Not `…/daw/media/upload`. |
| `DELETE /api/rec/{token}/upload` | record `join` | Revoke an ACK'd room-tone bed (`kind=room_tone`) |
| `POST …/daw/render-preview` | Editor (`edit_commands_allowed`) | Start a stem/premix render via the host `PipelineJobManager` lock. Returns **202** with a job ID immediately; **409** if the slot is busy. |
| `GET …/daw/render-preview/{job_id}` | Editor (`edit_commands_allowed`) | Read a job's status for this share's project. Response includes only safe progress fields, with no host paths. |
| `GET …/audio` | `play` | Frozen review mix for link previews and agents — prefers `mix.mp3`; **302** to an object-store presigned URL when configured |
| `POST …/comments` | `comment` | Timeline comment (body max **8000** chars) |
| `POST …/comments/{id}/replies` | `reply` | Reply (same body max) |
| `POST …/comments/{id}/actions/{aid}/done` | `action` | HTTP twin for MCP `guest_set_action_done` |
| `WS …/daw/ws` | `view` | Dual-plane session+document fanout; also carries `plane: "progress"` for work this token started |
| `WS /api/rec/{token}/ws` | record `monitor` | Record room / live comments / WebRTC signal; no MCP by design |

### Review audio (MP3 + object-store bypass)

Publishing a review version writes both `artifacts/review/{id}/mix.wav` and `mix.mp3`
(~128 kbps). `GET /api/review/{token}/audio` serves the MP3 by default.

When an S3-compatible object store is configured on the **host**:

1. Share create (and lazy first `/audio`) uploads `mix.mp3` to a private bucket.
2. `/audio` returns **302** to a short-lived presigned GET URL (TTL clamped 1h–24h,
   also bounded by share `expires_at`).
3. The guest browser fetches audio **directly from object storage** — bytes do not traverse
   the WebSocket tunnel.

If object storage is unset or upload fails, the host streams local `mix.mp3` through the
tunnel (still much smaller than WAV).

### Proxy media (Sharecut Studio `view`)

Guests with `play`+`view` prefer **FX source-clock proxy chunks** (64 kbps mono MP3,
60 s windows with 200 ms overlap) instead of live WAV stems/premix:

1. Host renders `artifacts/proxy/{track_id}/{proxy_render_hash}/{i:05d}.mp3` (processing
   chain + optional transcript gate; **no** timeline edits — those are scheduled client-side).
2. Share create / lazy `GET /api/review/{token}/daw/proxy/manifest` uploads chunks to object storage
   when configured and returns per-chunk URLs (presigned or local fallback
   `/api/review/{token}/daw/proxy/{track_id}/{hash}/{i}`).
3. Guest Sharecut Studio (`useProxyTransport`) decodes a sliding window via Web Audio and
   schedules clips from the project file. Host lossless WAV remains the only mixdown/export path.

When object storage is unset or proxy ensure fails, guests fall back to the existing HTMLAudio
WAV transport through the tunnel.

**Object-store bucket setup (once):**

1. Create a private S3-compatible bucket and access key; put credentials in host `relay.yaml`.
2. CORS (allow the public relay origin, Range requests):

```json
[
  {
    "AllowedOrigins": ["https://share.example.test"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

3. Optional lifecycle rule: expire the `review/` prefix after 30 days.
4. Smoke: open a review-only share; Network tab should show media from
   your object-store or CDN origin, not multi-MB tunnel frames.

Revoke deletes the object when no other active shares reference that version.

### Security notes

- Guests never receive absolute host paths (`project_path`, `workspace_dir`, `media_path` stripped; history reduced to the opaque `head_id` a guest undo must send). Session-plane snapshots do not store host `wav` paths; guest WS still drops leftover path fields. Episode JSON persists `workspace_dir` as `"."` and workspace-relative media paths only.
- The share API is a **token-scoped facade** over `ShareService` + `DocumentSyncService` — guests never supply a project path. MCP and HTTP use the same document sanitizer.
- Local review and DAW media streams open the authorized resolved file with no-follow directory descriptors and retain that descriptor through HTTP byte-range and HEAD handling. Object-store review and proxy uploads likewise send pinned file objects, and retry encoding gives FFmpeg a private, separate-inode WAV clone or copy from the pinned descriptor. This prevents a symlink replacement after path validation from redirecting those reads and an in-place source write from changing FFmpeg's retry input; platforms lacking descriptor-relative no-follow opens fail closed, except that on Windows these media reads (`open_pinned_media`) take a weaker path-based fallback with link and descriptor/path identity checks ([share-tokens.md](share-tokens.md)). Review-version publishing and its staging cleanup still need POSIX descriptors and are unavailable on Windows ([persistence.md § Inventory](persistence.md#inventory)).
- Capability checks are enforced on the **host**; the relay is a pass-through. Tunnel registration never defaults missing caps to all capabilities. The relay refuses to remap a live token owned by another host and allowlists response headers (drops `Set-Cookie`).
- Guest `render_preview` (HTTP + MCP) is **opt-in** (`PODCAST_GUEST_RENDER=1`); default off so Editor links cannot burn host FFmpeg silently. Starts use the shared job lock and mutate rate class; status reads use the read rate class. MCP `guest_render_preview_job` polls by job ID.
- Guest uploads are probed with FFmpeg `-protocol_whitelist file,crypto,data`. Chunk uploads cap `total_chunks`, sweep stale `.uploads/`, and enforce a pending-bytes quota.
- Restricted / guest accounts are **fail-closed**: `/auth` is not mounted and Restricted minting is refused unless `PODCAST_SHARE_ACCOUNTS=1` (stub testing only). Leftover Restricted tokens stay 401 via `ShareIdentityMiddleware`; Restricted share HTML never embeds object-store/OG audio.
- `PODCAST_REVIEW_CORS_ORIGINS` is parsed once at GUI startup by the same exact-origin normalizer as `public_base_url` (`runtime_config.normalize_exact_origin`). The GUI sets `allow_credentials`, so the list must never reflect arbitrary origins: `*`, wildcards, paths, query, fragment, user info, and non-loopback `http://` fail startup with an error that names the variable and never echoes the value. A trailing `/` is normalized away. See [setup.md](setup.md#public-review-share-optional).
- Loopback GUI is a **privileged local RPC**. Host/Origin binding rejects DNS-rebind forged `Host` headers on host APIs (`/api/project/*`, pipeline, media, document, session, comments).
- **Host role on owner routes** (#393): owner GUI routes — project, pipeline, export, diagnostics, bootstrap, record, shares, media, transcript, and the `GET /` project-mismatch recovery page (`require_host` from `gui/routes/deps.py`) and the session/document sync REST + WS surfaces (`authorize_client`) — are gated by the **host role** (`authorize_host` in `services/session_sync/authz.py`). The tunnel stamps `x-sharecut-relayed: 1` on every proxied HTTP request and WS dial into the local GUI (`services/collaboration/tunnel.py`), dropping any guest-supplied copy of that header first. The host role refuses a request carrying that marker even from a loopback peer or in non-strict mode (`403`, or WebSocket close `4403`), as defense in depth behind the tunnel's path allowlist and the client-side `isShareProjectKey` check.
- Token lifecycle (usable vs cooldown 404, revoke, host-chosen `expires_at`; idle time never ends a link): [share-tokens.md](share-tokens.md).
- Review links do not expire unless the host chose a date ([decision](share-tokens.md#decision-share-links-never-expire-unless-the-host-chooses-an-expiry)); end one with `podcast review revoke-share`.
- Do not put `/?project=/abs/path` on the public relay.
- Guest media upload (`…/daw/media/upload`) requires the **Editor** role (the document-command gate's `edit_commands_allowed`), streams into workspace `raw/` only (extension allowlist + assembled size cap). Chunk each request under the relay JSON body limit ([`body_limits.py`](../src/podcast_mcp/util/body_limits.py)); never create/open a different project from a share.
- Object-store credentials stay on the host (`relay.yaml` / `PODCAST_OBJECT_STORE_*`); the relay
  relay never needs them. Bucket stays private; only presigned URLs are handed out.

The host tunnel strips `X-Forwarded-*` when calling the local GUI (so Starlette
does not redirect to HTTPS on plain HTTP) and stamps `x-sharecut-relayed: 1` on the
forwarded request (dropping any guest-supplied copy first), so owner routes can
refuse relayed traffic (see § Security notes). It also rewrites share HTML so root-absolute
`/assets/…` URLs become `/r/{token}/assets/…` on the public origin. It also injects
`<base href="/r/{token}/">` so Vite's relative lazy chunks (`base: './'`) resolve under
the share path when the document URL has no trailing slash.

Tunnel and relay stream large responses (e.g. fallback review MP3 / Sharecut Studio WAV) as
chunked ``http_response`` frames with ``eof`` so WebSocket keepalive stays healthy.
The tunnel strips ``Content-Encoding`` / ``Content-Length`` on streamed bodies after
httpx decompresses them — keeping a compressed length with a decoded body resets
HTTP/2 at Caddy. Share HTML is rewritten for `/assets` and re-lengthened without
``Content-Encoding``.

---

## Remote MCP

Share-linked remote MCP lets an external agent (e.g. Cursor) call **guest tools** over
HTTPS while the host tunnel is up. Powers match the **other** capabilities on the same
token (web guest parity) — not the full local `podcast-mcp` stdio tool surface
(or the owner GUI URL `http://127.0.0.1:8765/mcp`).

**Share agent = share user:** a collaborator with any role who connects
MCP to that share should be able to take the same actions they can in Sharecut Studio
with that role. `play` means both can hear: humans use in-browser transport; agents use
share HTTP URLs plus a windowed hear-context bundle (captions, waveform/spectrogram)
— not host `afplay`. HTTP is the source of truth (same routes the GUI uses);
remote MCP is a thin façade (`guest_submit_document_command`, `guest_pending_preview`,
`guest_audition_context`, …). Named MCP exists only for agent-shaped jobs. Peaks, proxy
chunks, and guest session WS stay HTTP (no named MCP). Record room WS
(`WS /api/rec/{token}/ws`) is the same: **http-only by design**. Parity CI
(`check_share_http_mcp_parity` / `make schema-check`) discovers guest WebSockets
and fails if any `/api/rec/` or `/api/review/` route lacks a curated note.
Host agents stay richer (local MCP + CLI + skills + filesystem); guest agents
never get host CLI, pipeline, ingest, or `afplay` on the host laptop.

**Catalogs (do not merge):**

| Catalog | Job | Runtime? |
|---------|-----|----------|
| [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json) | Host adapter coverage (Sharecut Studio / **host** MCP / CLI / skills). `omit.guest` is the docs Host-only column only. | No |
| [`edits/share_capabilities.py`](../src/podcast_mcp/edits/share_capabilities.py) | Token ACL bits (`play` / `view` / `comment` / …) | Yes |
| [`document_sync/capabilities.py`](../src/podcast_mcp/services/document_sync/capabilities.py) | Document-command types a share may submit | Yes |
| [`remote_mcp/allowlist.py`](../src/podcast_mcp/services/remote_mcp/allowlist.py) | Which `guest_*` tools those bits unlock | Yes (agent transport) |
| Guest OpenAPI (`make schema-export`) | Share HTTP contract | Docs + parity CI |

Do not put `guest_*` names in the host manifest MCP column. Share agents never call host tool names (`split_clip_tool`); they call guest HTTP / `guest_submit_document_command`.

### Routing

1. Host serves `/mcp/{token}/mcp` (printed MCP URL) and `/r/{token}/mcp` (share+/mcp alias)
2. Relay proxies `/mcp/{token}/…` → tunnel → host `/mcp/{token}/…`
3. Alias via tunnel: `/r/{token}/mcp` → rewrite → `/mcp/{token}/mcp` (no HTTP redirect)
4. Host requires share `mcp` capability; returns **501** unless `PODCAST_REMOTE_MCP=1`
5. `POST …/mcp` speaks **Streamable HTTP JSON-RPC** (`initialize`, `tools/list`, `tools/call`, `ping`); negotiates protocol `2024-11-05` / `2025-03-26` / `2025-06-18`
6. Tools are filtered by [`services/remote_mcp/allowlist.py`](../src/podcast_mcp/services/remote_mcp/allowlist.py); project is bound from the token (clients never pass `project_path`)
7. `tools/call` reads `params._meta.progressToken` and emits MCP `notifications/progress` on that token (no second protocol) as Streamable HTTP SSE (`event: message` frames, then the JSON-RPC result) when the token is set; requests without a token stay JSON. The relay `/mcp/{token}` proxy forwards the upstream body in chunks (event-stream uses unbuffered `aiter_bytes`) so those frames pass the tunnel. Long work also fans `plane: "progress"` on this share’s guest WS only — never host jobs or other tokens. The progress WS is token-scoped and does not require `view`, so any holder of that share (including commenters) can observe tool ids / status / messages from concurrent remote MCP on the same token. See [progress.md](progress.md). Both the JSON and SSE paths run `handle_mcp_jsonrpc` on one dedicated guest pool ([`services/remote_mcp/executor.py`](../src/podcast_mcp/services/remote_mcp/executor.py), `GUEST_MCP_MAX_WORKERS` = 8 threads named `guest-mcp-*`), never on the event loop and never on the AnyIO worker pool that FastAPI's synchronous host routes share. A tool call waiting up to 30 s on `project_commit_lock` / `render_lock` therefore stalls neither other requests nor the host GUI; once all 8 workers are busy, further guest calls (across all share tokens, which the per-token `check_host_bucket` does not cap) queue on that pool.
8. A failed guest tool call follows the owner MCP server's rule, shared in [`util/tool_refusal.py`](../src/podcast_mcp/util/tool_refusal.py) (#1182), and is a tool result, not a JSON-RPC error: a refusal returns `isError: true` with its message as text and `structuredContent {ok: false, error, error_code}`, the shape the owner server returns. A refusal is a `CodedError` (its own code, such as `comment_not_found`, `edit_not_found`, `job_not_found`, `job_running`, `upload_too_large` or `invalid_audio`) or a `project_commit_lock` / `render_lock` timeout (`ProjectBusyError` / `RenderBusyError`, or a raw `filelock.Timeout`), which returns `error_code: "project_busy"`, the code the host GUI's 503s and the owner's MCP tool results use, so a caller can branch on one string everywhere (#488). Any other exception is a crash: the guest gets `isError: true` with only `Error executing tool <name>`, and the host logs the traceback. JSON-RPC errors are for the protocol: `-32601` an unknown method, `-32602` an unknown tool or arguments that do not fit the tool's schema (checked before it runs; `data.error_code: "invalid_arguments"`), `-32003` a share capability denial, `-32004` a share that no longer resolves (`share not found`), and `-32603` a failure outside any tool (`internal error`). See § Security notes.

### Cap → tool matrix

| Share caps | Guest MCP tools |
|------------|-----------------|
| `play` | `guest_get_review_summary`, `guest_audio_info`, `guest_list_comments` |
| `play` + `view` | `guest_pending_preview` (HTTP twin: `GET …/daw/pending-preview` + optional PNG); `guest_audition_context` (HTTP twin: `GET …/daw/audition-context` + image URLs) |
| `+view` | `guest_get_project`, clips / pending / applied edits, transcript search, render status, `guest_get_session_presence` (live roster; agent twin of the DAW WS, no extra HTTP) |
| `+comment` / `reply` | `guest_add_comment`, `guest_add_reply` |
| `+action` | `guest_set_action_done` |
| Commenter or Editor | `guest_submit_document_command` (offered only when `document_command_types_for_caps` allows a command, so a Viewer or a share that holds no role in full gets none, as on the browser route) |
| Editor | `guest_render_preview` (start render job), `guest_render_preview_job` (read status); `guest_upload_media` (HTTP twin: `POST …/daw/media/upload`). Offered only when `edit_commands_allowed` (the document-command gate) allows every Editor command |
| without `mcp` | Relay/host **403** |
| record `join` / `monitor` | **no MCP** — `/rec/{token}` lobby; `join` also unlocks `GET`/`POST`/`DELETE /api/rec/{token}/upload` |
| record `monitor` WS | **no MCP by design** — `WS /api/rec/{token}/ws` (record room / live comments / WebRTC signal). Record MCP twins remain a product decision, not a missing-twin bug. Parity CI (`check_share_http_mcp_parity`) requires a curated `http-only:` note. |

**Denied even when `mcp` is set:** pipeline run, full ingest consolidate, episode create (never on guest), host-speaker `play`, FX/envelope/transcript host-only mutations, absolute paths / history dumps, **comment resolve** (host-only: no share HTTP or guest MCP). An **Editor** link may still use `guest_submit_document_command` for track CRUD (`AddTrack` / `SetTrackMedia` / …) and `guest_upload_media` / the HTTP chunked media upload route; that is not the host `ingest_*` / `episode_create` surface. Owner GUI REST/WS routes (project, pipeline, export, diagnostics, bootstrap, record, shares, transcript, comments, session/document sync) require the **host role** (`require_host` / `authorize_host`, #393): relay-tunneled requests never satisfy it, even on loopback or in non-strict mode. See § Security notes.

**Audio:** `guest_audio_info` (full-file stream URLs), `guest_pending_preview` (pending cut), and `guest_audition_context` (arbitrary timeline window: captions + windowed hum/clip in `warnings`; per-track `prosody` + top-level `prosody_notes` read from the host's cached `analyze_prosody` profile, where guests get an allowlisted copy: a `missing`/`stale` window carries only its `status`, an `unavailable` one adds the generic `error: "prosody unavailable"`, and never the host rerun hint or exception text; optional wave/spec PNG) return relative share URLs (`/api/review/{token}/…`). Agents must stream via HTTP — remote MCP does **not** play on the host laptop. Sharecut Studio plays the same share-route render for a human guest's Suggested; `guest_pending_preview` is its agent twin (optional `visual` waveform/spectrogram PNGs). The hear-context contract is additive (new fields later without a new cap bit). Host `audition_context_tool` puts the same DSP in typed `hypotheses[]`.

### Enable on the host

```bash
PODCAST_REMOTE_MCP=1 podcast gui --project /path/to/episode.project.json --no-open
podcast tunnel --project /path/to/episode.project.json \
  --relay-url wss://share.example.com/tunnel --host-token <token>
```

Create a share that includes `mcp` plus the caps the agent should have; CLI prints `MCP URL`.

### Configure a remote MCP client (e.g. Cursor)

```json
{
  "mcpServers": {
    "podcast-remote": {
      "url": "https://share.example.com/mcp/<token>/mcp"
    }
  }
}
```

POST JSON-RPC with `Accept: application/json` (Claude also sends `text/event-stream`).

**Claude.ai:** Settings → Connectors → add the printed MCP URL; leave OAuth Client ID blank (link-share authless). Do not paste only `/r/{token}` — use `/mcp/{token}/mcp` (or the `/r/{token}/mcp` alias).

### Rate limiting

Generous defaults (tighten via env if you see abuse). Philosophy: false 429s hurt guests/agents more than early scrapers hurt a small relay.

| Layer | Bucket | Default | Key |
|-------|--------|---------|-----|
| Relay | HTTP RPM | 600/min, burst 80 | share token |
| Relay | HTTP RPM | 1200/min, burst 120 | client IP |
| Relay | Concurrent proxy | 24 / token, 96 / host, 8 audio | token / host_id |
| Relay | Guest WS concurrent | 8 / token | share token |
| Relay | Guest WS inbound msg RPM | 120/min, burst 30 | share token |
| Relay | Tunnel register | 60/min, burst 20 | host token |
| Host | Read RPM | 300/min, burst 60 | share token |
| Host | Mutate RPM | 60/min, burst 20 | share token |
| Host | Audio concurrent | 8 | share token |
| Host | Guest WS concurrent | 8 | share token |

Audio paths skip RPM and use concurrency limits. The host and relay use
`util.rate_limit.is_review_audio_path`, which strips the query and case-folds
before matching `/audio`, `/pending-preview`, `/audition-context`, or
`/daw/waveform/tiles/` as substrings. This preserves image variants and the host's
broad `/audio` rule rather than requiring `/audio` at the path end. Query values
cannot make a read path audio. Waveform status remains a read request, and host
`POST` requests take mutation precedence. Guest audio slots stay held through
response streaming. A file that disappears before pinning returns 404 and releases
its slot immediately; response setup failures release the slot as well.

Guest WS fanout (host→guest) is unlimited; only inbound guest→host text frames hit
`PODCAST_RELAY_WS_MSG_RPM`. Responses: HTTP **429** + `Retry-After`; WS close
**4429**; MCP JSON-RPC error **`-32029`**.

| Env | Role |
|-----|------|
| `PODCAST_RELAY_RATE_LIMIT` | `0` disables relay limits (default on) |
| `PODCAST_RELAY_TOKEN_RPM` / `_BURST` | Per-token relay HTTP |
| `PODCAST_RELAY_IP_RPM` / `_BURST` | Per-IP relay HTTP |
| `PODCAST_RELAY_TOKEN_CONCURRENT` / `_HOST_CONCURRENT` / `_AUDIO_CONCURRENT` | In-flight caps |
| `PODCAST_RELAY_WS_CONCURRENT` | Max guest Sharecut Studio WS per share token (default 8) |
| `PODCAST_RELAY_WS_MSG_RPM` / `_BURST` | Inbound guest→host WS text frames (non-presence) |
| `PODCAST_RELAY_WS_PRESENCE_RPM` / `_BURST` | Inbound guest→host Presence frames (coarse pre-filter; host limiter is authoritative) |
| `PODCAST_RELAY_REGISTER_RPM` / `_BURST` | Tunnel hello/register |
| `PODCAST_RATE_LIMIT` | `0` disables host limits (default on) |
| `PODCAST_RATE_LIMIT_READ_RPM` / `_BURST` | Host JSON reads + MCP reads |
| `PODCAST_RATE_LIMIT_MUTATE_RPM` / `_BURST` | Host POSTs + MCP mutations |
| `PODCAST_RATE_LIMIT_AUDIO_CONCURRENT` | Host audio streams |
| `PODCAST_GUEST_WS_CONCURRENT` | Host-side max guest Sharecut Studio WS per token (default 8) |
| `PODCAST_GUEST_WS_PRESENCE_RPM` / `_BURST` | Host per-connection guest Presence frames (900/min burst 60) |
| `PODCAST_GUEST_WS_PRESENCE_TOKEN_RPM` / `_BURST` | Host per-token guest Presence frames (3600/min burst 200) |
| `PODCAST_WS_ROSTER_REQUEST_RPM` / `_BURST` | Per-client-id `RosterRequest` replies on the host and guest session sockets (60/min burst 1; the budget survives a reconnect) |

Modules: `util/rate_limit.py`, `podcast_relay/limits.py`, `services/remote_mcp/limits.py`.

### Manual verification (capability matrix)

Against a live host (local bridge; same code path as the public relay MCP URL):

```bash
PODCAST_REMOTE_MCP=1 podcast gui \
  --project /path/to/episode.project.json --no-open

uv run python scripts/verify_remote_mcp_shares.py \
  --project /path/to/episode.project.json
```

The script creates short-lived shares for the tiers `viewer`, `commenter` and `editor` (each with `mcp`) plus `viewer_no_mcp`, checks
`tools/list` exact allowlists, exercises allowed `tools/call`s (path-sanitized payloads),
asserts denied tools return capability errors, and revokes tokens on success (use
`--keep-shares` to leave them). Exit non-zero on any matrix failure.

`--project` runs in place: the script publishes a review version (writing
`artifacts/review/<id>/mix.wav`) and share sidecars into that workspace. Omit
`--project` to verify against the committed `aligned_dialogue` fixture: the script
copies it into a temporary relocated workspace (`copy_relocated_workspace`) and
publishes there, so `tests/fixtures/` is never written. The host resolves those
share tokens through the share registry, so it can keep serving any project.

Optional: with `podcast tunnel` up, recreate one `--role viewer --with-mcp` share with
`--base-url https://<relay>` and repeat `tools/list` against the printed `mcp_url`.

Modules: `gui/routes/remote_mcp.py`, `services/remote_mcp/`, `mcp/tools/guest/`.

---

## Self-host a relay

The relay is FOSS and can run on an operator-controlled machine or service.
Provide a public HTTPS domain, a strong host token, and a relay image or local
build appropriate to your environment. Keep tunnel credentials on the host and
use the supplied Compose and Caddy examples as a starting point.

```bash
# On the operator-managed relay host
export RELAY_DOMAIN=share.example.com
export RELAY_IMAGE=podcast-relay:local
HOST_SECRET="$(openssl rand -hex 32)"   # hand this to the host operator out of band
export PODCAST_RELAY_HOST_TOKENS="host-1:${HOST_SECRET}"
docker compose \
  -f deploy/relay/docker-compose.prod.yml \
  -f deploy/relay/docker-compose.build.yml \
  up -d --build
```

The `host_id:` prefix pins that secret to one host identity. On the host, present the
same `host_id` (env `PODCAST_RELAY_HOST_ID` or `host_id:` in `relay.yaml`) together with
the secret:

```bash
# On the episode host (the half that pairs with host-1:<secret> above)
export PODCAST_RELAY_HOST_ID=host-1
podcast tunnel --project /path/to/episode.project.json \
  --relay-url wss://share.example.com/tunnel --host-token "<secret>"
```

A bare secret in `PODCAST_RELAY_HOST_TOKENS` (no `host_id:` prefix) is shared and
authenticates any `host_id`.

Verify the public endpoint after configuring TLS and DNS for your chosen domain:

```bash
curl --fail --show-error --silent --retry 12 --retry-connrefused \
  --retry-delay 5 https://share.example.com/healthz
```

Image publication, deployment automation, DNS, registries, cloud accounts, and
capacity management are operator responsibilities and are not maintained in this
public repository.

---

## Repo layout

```
deploy/relay/
  Dockerfile              # podcast-relay image (relay + util rate/body/proxy/WebSocket helpers)
  VERSION                 # semver source of truth (e.g. 0.3.0); bump manually for releases
  docker-compose.yml      # caddy + relay (local dev / Compose smoke)
  docker-compose.prod.yml # optional production-shaped Compose example
  Caddyfile.local         # HTTP :8080 development reverse proxy
  Caddyfile.prod          # HTTPS reverse-proxy example; logs redact share paths
.github/workflows/
  deploy-config.yml       # caddy validate + docker compose config over deploy/ (scripts/check_deploy_config.sh)
  desktop.yml             # FOSS Tauri scaffold + web dist
  release-desktop-build.yml # reusable installer-artifact builder
src/podcast_relay/         # FOSS relay server (FastAPI + WebSocket tunnel)
src/podcast_mcp/
  services/collaboration/tunnel.py      # TunnelClient + run_tunnel_sync
  services/collaboration/tunnel_status.py   # phases, status lines, snapshot
  services/collaboration/tunnel_failure.py  # failure classification
  gui/routes/tunnel.py    # GET /api/tunnel/status (tunnel.status)
  runtime_config.py       # validated relay/object-store configuration
  cli/tunnel.py           # podcast tunnel CLI
  edits/share_capabilities.py  # CAP_* constants, REVIEW_ROLE_CAPABILITIES, guest_mode
  gui/routes/remote_mcp.py     # /mcp/{token} info + JSON-RPC bridge
  services/remote_mcp/         # context, allowlist, guest tools, protocol
  mcp/tools/guest/             # re-exports guest tool registry
```

---

## Security notes

- **Tunnel auth**: `PODCAST_RELAY_HOST_TOKENS` required (empty set rejects tunnels unless
  `PODCAST_RELAY_ALLOW_OPEN_TUNNEL=1` for local/dev). Relay process exits on startup if
  tokens are empty without the open-tunnel flag. Entries may be bare secrets or
  `host_id:secret` per-host pairs. A `host_id:secret` pair only authenticates a tunnel
  whose hello presents that exact `host_id`; the same secret under any other (or a
  missing) `host_id` is rejected with close code `4403`. The host must therefore set
  `PODCAST_RELAY_HOST_ID` / `relay.yaml` `host_id` to match the prefix, or keep its
  persisted default (`relay_host_id` next to `relay.yaml`, minted once per install) and
  use that value as the prefix. The stable id also lets a restarted host re-advertise
  tokens still bound to it. Production Compose rejects every effective secret
  shorter than 32 characters. Hosts attach HMAC share claims when registering;
  `token → host_id` bindings persist across disconnect so another host cannot steal
  an offline coolname (beyond live refuse-remap).
- **Proxy path allowlist**: relay rejects `..` / encoded traversal; tunnel maps only to
  `/assets`, `/r/{token}`, `/rec/{token}`, `/api/review/{token}`, `/api/rec/{token}`, `/mcp/{token}` (see `util/proxy_paths.py`).
  The seeded invariant test in `tests/test_proxy_paths.py` checks mixed encodings,
  separators, and repeated slashes through the tunnel mapper, including that
  no mapped path reaches host-only APIs.
- **Body / WS size**: `PODCAST_RELAY_MAX_BODY_BYTES` (4 MiB), `PODCAST_RELAY_WS_MAX_SIZE`
  (16 MiB), GUI `PODCAST_GUI_MAX_BODY_BYTES` (pure ASGI `MaxBodySizeMiddleware` on the host),
  MCP `PODCAST_REMOTE_MCP_MAX_BODY_BYTES` (1 MiB). Record full-quality recording `POST …/upload`
  skips the 4 MiB GUI cap and uses `max(relay cap, PODCAST_RECORD_UPLOAD_MAX_PART_BYTES)`
  (default 5 MiB) on the relay so a full part is not 413'd. See [testing.md](testing.md) § Body limit middleware.
- **Share tokens**: capability-scoped, expiry enforced, revoke list on both relay and host.
  Comment/reply bodies capped at **8000** characters. Producer `/rec/` tokens are
  a silent mix-minus monitor and are not recorded (`build.monitor: true`). Share
  them only with the producer. GUI mints have
  no expiry; prefer `--expires-at` on the CLI. Record shares are link-access only
  in this PR.
- **TLS**: Caddy handles HTTPS on the public edge.  The relay never sees plaintext from
  the public internet in production. Access logs redact `/r/{token}`, `/rec/{token}`, `/mcp/{token}`,
  `/api/reports/{id}`, and `/api/reports/bundles/{id}`
  path segments in both local and production Caddy configurations (see `deploy/relay/Caddyfile*`).
- **No filesystem paths in URLs**: tokens map to workspaces internally; guests never
  see absolute paths.
- **Diagnostics bundle**: host-only (`POST /api/diagnostics/bundle`). Guests cannot
  reach it via the proxy allowlist. Creating the zip writes it locally; uploading requires separate host consent in Help.
- **Host export jobs**: `POST /api/export/bounce` and `POST /api/export/deliverables` are
  host-only. The tunnel never maps `/api/export/*` (proxy allowlist), and a direct remote
  request under strict authz must present `PODCAST_SESSION_TOKEN`. A share token in
  `?token=` / `X-Podcast-Token` is never accepted as that credential (403, no job started).
  Strict authz is auto-enabled on a non-loopback bind only when `PODCAST_SESSION_AUTHZ`
  is unset. An explicit non-strict value (e.g. `PODCAST_SESSION_AUTHZ=off`) with
  `--host 0.0.0.0` removes this gate, and any LAN peer can start export jobs.
  Relay-tunneled requests are refused regardless (host role, #393).
- **Host GUI**: defaults to loopback. Non-loopback bind auto-enables `PODCAST_SESSION_AUTHZ=strict`
  and injects `session_token` into the viewer URL. Prefer the public relay over LAN bind.
- **Remote MCP**: disabled by default; requires `PODCAST_REMOTE_MCP=1` on the host and
  explicit `mcp` capability on the share token. Tools are **capability-filtered** (guest
  parity), not the full host stdio MCP registry.
- **Remote MCP errors** (#1182): a guest sees an exception's text only for a refusal (a
  `CodedError` or a busy lock), with every host filesystem path in it replaced by `[path]`
  (`util.redact.redact_host_paths`, the redaction guest progress already used). A crash,
  a plain `ValueError` / `KeyError` / `TypeError`, an OS `PermissionError`, or a share whose
  project moved returns fixed text (`Error executing tool <name>`, `share not found`,
  `internal error`) and is logged on the host. Refusal messages never embed another
  exception's text (`HistoryRerenderError`'s render error, ffprobe's error on an upload
  stay in the log). See § Remote MCP › Routing.
- **Rate limiting**: see § Rate limiting above. Optional **Caddy `rate_limit` module** (edge IP limits) is later ops polish if that Caddy plugin is installed; the relay IP bucket already covers MVP.
- **Presence**: guests with `view` see other participants' cursors, selection, playhead, and viewport, fanned out server-side as per-client `PresenceDelta`s rather than a full-roster resend on every tick, with a `RosterRequest` frame for the guest to resync on a version gap (`docs/session-sync.md` § Server → client: `Presence` / `PresenceDelta` / `RosterRequest`). Session-plane WS messages echo the assigned `guest-{token}-…` `client_id` (the query string keeps the tab’s original id) so the guest never draws their own ghost. The guest DAW WebSocket accepts `Presence` and `RosterRequest` frames only, with a 4 KiB size cap, per-connection and per-token rate limits, a malformed-frame close (`4400` after 20), mid-session share revocation re-check, and an Origin allow-list check for restricted shares. A `RosterRequest` reply is additionally throttled to one per second per assigned guest client id, which survives a reconnect (the `ws_roster_request` host limiter, `PODCAST_WS_ROSTER_REQUEST_RPM` / `_BURST`). The relay `ws_presence` bucket is a coarse prefix pre-filter (`is_presence_ws_text` classifies both `Presence` and `RosterRequest` into it); the host limiter is authoritative. An invalid guest `playhead_sec` (negative, NaN, infinite, or not a JSON number) is dropped by the host and the last good one is kept; the frame is not counted as malformed.

---

## Self-hosting

The relay and tunnel client are FOSS and self-hostable.  Fork the repo, set the same
GitHub secret names on your fork, and run `docker compose up` on your own VPS.  No
dependency on any commercial service.

---

## Roadmap (not in this release)

Product follow-up: [ROADMAP.md](../ROADMAP.md). Provider product details are maintained separately.

- **Recording session (beta)** — recording links + full-session audio (Riverside/Zencastr-style); design: [recording-session.md](recording-session.md). See [ROADMAP.md § Recording session](../ROADMAP.md#recording-session).
- Destructive-tool policy hardening beyond the current guest allowlists

### Guest WebSocket (shipped)

Guests with `view` connect to `WS /api/review/{token}/daw/ws` on the host (and the same path on the public relay). Record guests with `monitor` connect to `WS /api/rec/{token}/ws`. The relay multiplexes guest sockets over the host tunnel with:

| Frame | Direction | Fields |
|-------|-----------|--------|
| `ws_open` | relay → host | `id`, `path` (`api/review/daw/ws` or `api/rec/ws`), `share_token` |
| `ws_data` | both | `id`, `text` (JSON text frame) |
| `ws_close` | both | `id`, `code`, `reason` |

The host rechecks an existing record socket against participant removal on
each inbound command, outbound room event, and while idle. A removed guest's
socket closes with 4403 without disconnecting other room participants; the
relay forwards the host's close. A relayed `Join` without a valid lease on a
token whose participant was removed gets `invite_closed` and then a 4403 close (same handler as direct; the relay keeps that order, which the guest UI relies on, and `tests/test_relay_ws.py::test_record_ws_relays_invite_closed_error_before_4403` checks it).

Old tunnel clients ignore unknown frame types (guest socket stays silent; HTTP poll still works). See [session-sync.md](session-sync.md) § Guest dual-plane WebSocket. Record rate buckets: host `guest_ws_record` / `guest_ws_record_token` for room commands, plus `guest_ws_record_signal` / `guest_ws_record_signal_token` for WebRTC `Signal` ICE/SDP (Heartbeat and HeadphonesAck stay exempt).

## Public diagnostics report intake

A self-hosted relay can accept consented bug reports at `POST /api/reports`. Configure
`PODCAST_REPORT_STORE` on a persistent volume, `PODCAST_REPORT_PUBLIC_BASE_URL`
(the public HTTPS origin), and server-only `PODCAST_REPORT_GITHUB_TOKEN` with issue
write access. Create the repository's `beta-report` issue label before enabling
intake. The Studio host uses `PODCAST_REPORT_RELAY_URL` (HTTPS, or loopback
HTTP for local development). No account is required. The relay validates a bounded
diagnostics ZIP, stores it before queueing publication, and creates a GitHub issue
with the `beta-report` label. GitHub issues cannot accept ZIP attachments via its
API, so the public issue links to the ZIP on this relay. Both the description and
ZIP are publicly accessible. The ZIP and status expire after 30 days.

The JSON POST has a 7 MiB body cap to accommodate the base64 encoding of a 5 MiB
ZIP; expanded ZIP content is capped at 8 MiB and 34 members. The host uses
flat, printable ZIP names, normalizing long, duplicate, or control-character
log basenames before writing a bundle. Public intake
allows three reports per source IP and 100 globally per UTC day. SQLite serializes
these counters across relay workers and retains a bounded queue of 1,000 reports.
The publisher retries failures before GitHub issue creation with capped
exponential backoff. A per-store lock serializes publishers through reconciliation
and publication, even when GitHub pagination is slow. A persisted claim token
fences local completion. After a crash or ambiguous network result after POST
begins, the worker reconciles by a stable report marker; if no issue appears it
holds the row as `publish_uncertain` for operator review rather than submitting
another issue. Definitive rate-limit rejections (429 or a rate-limited 403)
clear the post marker and retry with backoff; other definitive client errors become `failed`.
`GET /api/reports/{id}` shows queued, published, `publish_uncertain`, or failed status;
`GET /api/reports/bundles/{id}` serves the opaque ZIP link during retention. The
optional `proof_of_work` request field is accepted but unused by default.

In production Caddy is the only ingress to the relay container. The production
Compose file trusts Caddy's forwarded client IP so per-IP limits use the real
source. Do not expose the relay container directly when
`PODCAST_RELAY_FORWARDED_ALLOW_IPS=*` is set. Without a configured intake, Studio
Help keeps the local-download/Open support path.

## WebSocket backpressure

Relay guest streams and host-side proxy streams retain at most 256 queued text
frames and at most `PODCAST_RELAY_WS_MAX_SIZE` encoded UTF-8 bytes per stream.
The default byte budget is 16 MiB. The shared relay-to-host queue retains at
most 256 frames and twice that byte budget. Queue admission fails immediately
when either limit is reached. Normal stream close drains accepted frames;
overflow discards the backlog and closes the affected stream with `1013` so
clients reconnect and recover their application state. Generic relay streams
never receive a fabricated document resync frame.

A shared tunnel backlog closes that tunnel with `1013`. Every guest using it
then reconnects through the existing host-online flow. A full individual guest
queue closes that guest without blocking another guest's output. A replacement
tunnel retires the old connection and releases its queues. Late advertisements
and teardown from that old connection cannot change the replacement's routing.
Stream close codes and UTF-8-bounded reasons propagate in both directions.

`util/ws_delivery.py` owns the shared queue accounting and serialized writer.
Writes have a five-second deadline that includes waiting for another write.
Terminal close cancels the active write and has its own five-second deadline.
Host tunnel control replies and HTTP request dispatch use the same writer as
proxied data. A failed HTTP dispatch releases its pending request and returns
`504`; a closed tunnel returns `503`. Guest GUI sockets also use this writer
through `GuestWsGuard`; authorization gates still
run inside the serialized write. Host-side local stream sends have the same
five-second deadline. These are delivery limits, not a claim that every
application event fits in one small frame.
