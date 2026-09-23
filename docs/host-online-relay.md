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

# Optional: any S3-compatible object store for ReviewApp audio bypass.
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
2. **Role** — Docs-like presets expand to the capability bits below. Browser `/r/{token}` and share MCP `/mcp/{token}` always expose the **same** capability set.

### Docs-like roles → caps

| Role | Caps (approx.) | Guest UI |
|------|----------------|----------|
| **Viewer** | `play` + `view` | Sharecut Studio read-only |
| **Commenter** (default) | `play` + `comment`/`reply`/`action` | ReviewApp (or Sharecut Studio + comments if `view` added) — **no login** on link shares |
| **Editor** | `EDITOR_CAPABILITIES` (`play`/`view`/comments + `suggest`/`edit`) | suggest/edit; add `--with-mcp` for agents |
| **Owner** | Host laptop only | full stdio MCP **or** GUI `http://127.0.0.1:8765/mcp` (not a guest share) |

```bash
podcast review share --role viewer --project … --version <id> --base-url https://sharecut.studio
podcast review share --role commenter --with-mcp …
podcast review share --role editor --with-mcp …
# Raw caps still work when --role is omitted:
podcast review share --capabilities play,view,comment,mcp …
podcast review share --kind record --project … --base-url https://sharecut.studio
podcast review share --kind record --session-id <id> --role producer --expires-at …
```

### Capability bits

| Capability | Meaning |
|------------|---------|
| `play`     | Stream review-mix / guest DAW audio |
| `view`     | Read-only **Sharecut Studio** (timeline, tracks, peaks, premix) |
| `comment`  | Add timeline comments |
| `reply`    | Reply to existing comments |
| `join`     | Be recorded in a record room (no MCP) |
| `monitor`  | Hear a record room (producer or guest; no MCP) |
| `suggest`  | Propose/nudge pending edits (`SuggestPendingEdit`, `UpdatePendingEdit`) and **propose** structural ops (`SplitAtTime`, `DeleteClip`, `RippleDeleteClip`) — cannot approve/apply |
| `edit`     | Apply Pass 1–2 document commands (approve/reject/restore, fades, join, clip body move / `MoveClips`, undo/redo) **and apply** structural ops via guest document route |
| `mcp`      | Allow **capability-scoped** remote MCP at `{base}/mcp/{token}/mcp` (same powers as the other caps on this token — not the full host MCP surface) |

Default for new shares: **commenter** (`play` + `comment` + reply/action) → **ReviewApp** (audio + comments), Anyone with the link.

When `view` is granted, `/r/{token}` loads the **read-only Sharecut Studio** instead of ReviewApp.
Add `comment`/`reply` to allow posting from the Comments tab inside Sharecut Studio.

```bash
# Read-only full DAW (timeline + playback)
podcast review share --role viewer \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Sharecut Studio + comments (raw caps)
podcast review share --capabilities play,view,comment,reply \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# ReviewApp only (no timeline) — default commenter
podcast review share --role commenter \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Sharecut Studio + suggest (propose/nudge pending only)
podcast review share --capabilities play,view,suggest \
  --project episode.project.json --version <id> \
  --base-url https://sharecut.studio

# Sharecut Studio + edit (Pass 1–2 apply)
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
| `GET …/daw/meta` | `view` | mtime/size for poll reload |
| `GET …/daw/peaks/{track_id}` | `view` | Uint8 overview waveform (same file as host; no extra coarsen) |
| `GET …/daw/waveform-snap` | `suggest` / `edit` | Windowed snap ticks for the DAW overlay; view-only guests get the quiet wash only |
| `GET …/daw/audio?kind=` | `play` | Whitelist: `premix`, `stem`, `processed`, `review`. Rejects `raw` and `rerender=true` |
| `GET …/daw/pending-preview` | `play` + `view` | Listen-first Current / Suggested / A/B WAV (concat; not host speakers). First hit is FFmpeg (mutate RPM); cached GET uses audio concurrency. |
| `GET …/daw/pending-preview-image` | `play` + `view` | Waveform (`kind=wave`) or spectrogram (`kind=spec`) of that extract |
| `POST …/daw/document/command` | `view` + command allowlist | `suggest` → Suggest/UpdatePending + structural propose; `edit` → Pass 1–2 apply + structural apply + track ingest (`AddTrack` / `SetTrackMedia` / `SetTrackMeta` / `RemoveTrack` / `ReorderTrack`) via `document_command_types_for_caps` / `authorize_document_command` + `policy.resolve_structural_mode`. Typed payloads: `schemas/document-commands.schema.json`. |
| `POST …/daw/media/upload` | `edit` | Chunked audio into host `raw/` (allowlist + assembled size cap); then guest submits `SetTrackMedia` / `AddTrack`. Not for `suggest`/`view`. Not the record keeper route. |
| `GET /api/rec/{token}/upload` | record `join` | Own keeper chunk ACK status (lease required) |
| `POST /api/rec/{token}/upload` | record `join` | Keeper PCM parts (5 MB / 30 s); resume on the same token. Keeper parts only for takes the participant consented to; `kind=room_tone` only while consented (403 `consent required`). Not `…/daw/media/upload`. |
| `DELETE /api/rec/{token}/upload` | record `join` | Revoke an ACK'd room-tone bed (`kind=room_tone`) |
| `POST …/daw/render-preview` | `edit` | Rebuild stems/premix via the same `PipelineJobManager` lock as the host GUI (waits for the job; **409** if another pipeline/render job is already running). Response strips host filesystem paths. |
| `GET …/audio` | `play` | ReviewApp frozen mix — prefers `mix.mp3`; **302** to an object-store presigned URL when configured |
| `POST …/comments` | `comment` | Timeline comment (body max **8000** chars) |
| `POST …/comments/{id}/replies` | `reply` | Reply (same body max) |
| `POST …/comments/{id}/actions/{aid}/done` | `action` | HTTP twin for MCP `guest_set_action_done` |
| `WS …/daw/ws` | `view` | Dual-plane session+document fanout; also carries `plane: "progress"` for work this token started |
| `WS …/progress/ws` | review token (no `view`) | ReviewApp progress chip; same payload as the daw/ws progress plane |
| `WS /api/rec/{token}/ws` | record `monitor` | Record room / live comments / WebRTC signal; no MCP by design |

### ReviewApp audio (MP3 + object-store bypass)

Publishing a review version writes both `artifacts/review/{id}/mix.wav` and `mix.mp3`
(~128 kbps). ReviewApp (`GET /api/review/{token}/audio`) serves the MP3 by default.

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

- Guests never receive absolute host paths (`project_path`, `workspace_dir`, `media_path` stripped; history omitted). Session-plane snapshots do not store host `wav` paths; guest WS still drops leftover path fields. Episode JSON persists `workspace_dir` as `"."` and workspace-relative media paths only.
- The share API is a **token-scoped facade** over `ShareService` + `DocumentSyncService` — guests never supply a project path. MCP and HTTP use the same document sanitizer.
- Capability checks are enforced on the **host**; the relay is a pass-through. Tunnel registration never defaults missing caps to all capabilities. The relay refuses to remap a live token owned by another host and allowlists response headers (drops `Set-Cookie`).
- Guest `render_preview` (HTTP + MCP) is **opt-in** (`PODCAST_GUEST_RENDER=1`); default off so editor shares cannot burn host FFmpeg silently. MCP render uses the shared job lock and mutate rate class.
- Guest uploads are probed with FFmpeg `-protocol_whitelist file,crypto,data`. Chunk uploads cap `total_chunks`, sweep stale `.uploads/`, and enforce a pending-bytes quota.
- Restricted / guest accounts are **fail-closed**: `/auth` is not mounted and Restricted minting is refused unless `PODCAST_SHARE_ACCOUNTS=1` (stub testing only). Leftover Restricted tokens stay 401 via `ShareIdentityMiddleware`; Restricted share HTML never embeds object-store/OG audio.
- Loopback GUI is a **privileged local RPC**. Host/Origin binding rejects DNS-rebind forged `Host` headers on host APIs (`/api/project/*`, pipeline, media, document, session, comments).
- Token lifecycle (usable vs cooldown 404, revoke, hard `expires_at`, inactivity): [share-tokens.md](share-tokens.md).
- Prefer short `expires_at` for public demos; revoke with `podcast review revoke-share`.
- Do not put `/?project=/abs/path` on the public relay.
- Guest media upload (`…/daw/media/upload`) requires **`edit`**, streams into workspace `raw/` only (extension allowlist + assembled size cap). Chunk each request under the relay JSON body limit ([`body_limits.py`](../src/podcast_mcp/util/body_limits.py)); never create/open a different project from a share.
- Object-store credentials stay on the host (`relay.yaml` / `PODCAST_OBJECT_STORE_*`); the relay
  relay never needs them. Bucket stays private; only presigned URLs are handed out.

The host tunnel strips `X-Forwarded-*` when calling the local GUI (so Starlette
does not redirect to HTTPS on plain HTTP) and rewrites share HTML so root-absolute
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

**Share agent = share user:** a collaborator with `edit` (or any cap set) who connects
MCP to that share should be able to take the same actions they can in Sharecut Studio/ReviewApp
at those caps. `play` means both can hear: humans use in-browser transport; agents use
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
7. `tools/call` reads `params._meta.progressToken` and emits MCP `notifications/progress` on that token (no second protocol) as Streamable HTTP SSE (`event: message` frames, then the JSON-RPC result) when the token is set; requests without a token stay JSON. The relay `/mcp/{token}` proxy forwards the upstream body in chunks (event-stream uses unbuffered `aiter_bytes`) so those frames pass the tunnel. Long work also fans `plane: "progress"` on this share’s guest WS only — never host jobs or other tokens. The progress WS is token-scoped and does not require `view`, so any holder of that share (including commenters) can observe tool ids / status / messages from concurrent remote MCP on the same token. See [progress.md](progress.md).

### Cap → tool matrix

| Share caps | Guest MCP tools |
|------------|-----------------|
| `play` | `guest_get_review_summary`, `guest_audio_info`, `guest_list_comments` |
| `play` + `view` | `guest_pending_preview` (HTTP twin: `GET …/daw/pending-preview` + optional PNG); `guest_audition_context` (HTTP twin: `GET …/daw/audition-context` + image URLs) |
| `+view` | `guest_get_project`, clips / pending / applied edits, transcript search, render status, `guest_get_session_presence` (live roster; agent twin of the DAW WS, no extra HTTP) |
| `+comment` / `reply` | `guest_add_comment`, `guest_add_reply` |
| `+action` | `guest_set_action_done` |
| `+suggest` / `+edit` | `guest_submit_document_command` (same allowlists as `authorize_document_command`) |
| `+edit` only | `guest_render_preview` (rebuild stems/mix preview on host); `guest_upload_media` (HTTP twin: `POST …/daw/media/upload`) |
| without `mcp` | Relay/host **403** |
| record `join` / `monitor` | **no MCP** — `/rec/{token}` lobby; `join` also unlocks `GET`/`POST`/`DELETE /api/rec/{token}/upload` |
| record `monitor` WS | **no MCP by design** — `WS /api/rec/{token}/ws` (record room / live comments / WebRTC signal). Record MCP twins remain a product decision, not a missing-twin bug. Parity CI (`check_share_http_mcp_parity`) requires a curated `http-only:` note. |

**Denied even when `mcp` is set:** pipeline run, full ingest consolidate, episode create (never on guest), host-speaker `play`, FX/envelope/transcript host-only mutations, absolute paths / history dumps, **comment resolve** (host-only: no share HTTP or guest MCP). Share **`edit`** may still use `guest_submit_document_command` for track CRUD (`AddTrack` / `SetTrackMedia` / …) and `guest_upload_media` / the HTTP chunked media upload route; that is not the host `ingest_*` / `episode_create` surface.

**Audio:** `guest_audio_info` (full-file stream URLs), `guest_pending_preview` (pending cut), and `guest_audition_context` (arbitrary timeline window: captions + windowed hum/clip in `warnings`; optional wave/spec PNG) return relative share URLs (`/api/review/{token}/…`). Agents must stream via HTTP — remote MCP does **not** play on the host laptop. Sharecut Studio Suggested for a human is a transport skip; the share HTTP concat is the agent-usable twin (optional `visual` waveform/spectrogram PNGs). The hear-context contract is additive (new fields later without a new cap bit). Host `audition_context_tool` puts the same DSP in typed `hypotheses[]`.

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

Audio paths skip RPM (concurrency only). Guest WS fanout (host→guest) is unlimited; only inbound guest→host text frames hit `PODCAST_RELAY_WS_MSG_RPM`. Responses: HTTP **429** + `Retry-After`; WS close **4429**; MCP JSON-RPC error **`-32029`**.

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

Modules: `util/rate_limit.py`, `podcast_relay/limits.py`, `services/remote_mcp/limits.py`.

### Manual verification (capability matrix)

Against a live host (local bridge; same code path as the public relay MCP URL):

```bash
PODCAST_REMOTE_MCP=1 podcast gui \
  --project /path/to/episode.project.json --no-open

uv run python scripts/verify_remote_mcp_shares.py \
  --project /path/to/episode.project.json
```

The script creates short-lived shares for tiers A–G (play → edit, plus no-`mcp`), checks
`tools/list` exact allowlists, exercises allowed `tools/call`s (path-sanitized payloads),
asserts denied tools return capability errors, and revokes tokens on success (use
`--keep-shares` to leave them). Exit non-zero on any matrix failure.

`--project` runs in place: the script publishes a review version (writing
`artifacts/review/<id>/mix.wav`) and share sidecars into that workspace. Omit
`--project` to verify against the committed `aligned_dialogue` fixture: the script
copies it into a temporary relocated workspace (`copy_relocated_workspace`) and
publishes there, so `tests/fixtures/` is never written. The host resolves those
share tokens through the share registry, so it can keep serving any project.

Optional: with `podcast tunnel` up, recreate one `play,view,mcp` share with
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
  desktop.yml             # FOSS Tauri scaffold + web dist
  release-desktop-build.yml # reusable installer-artifact builder
src/podcast_relay/         # FOSS relay server (FastAPI + WebSocket tunnel)
src/podcast_mcp/
  services/tunnel.py      # TunnelClient + run_tunnel_sync
  runtime_config.py       # validated relay/object-store configuration
  cli/tunnel.py           # podcast tunnel CLI
  edits/share_capabilities.py  # CAP_* constants, normalize_capabilities, guest_mode
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
- **Body / WS size**: `PODCAST_RELAY_MAX_BODY_BYTES` (4 MiB), `PODCAST_RELAY_WS_MAX_SIZE`
  (16 MiB), GUI `PODCAST_GUI_MAX_BODY_BYTES` (pure ASGI `MaxBodySizeMiddleware` on the host),
  MCP `PODCAST_REMOTE_MCP_MAX_BODY_BYTES` (1 MiB). Record keeper `POST …/upload`
  skips the 4 MiB GUI cap and uses `max(relay cap, PODCAST_RECORD_UPLOAD_MAX_PART_BYTES)`
  (default 5 MiB) on the relay so a full part is not 413'd. See [testing.md](testing.md) § Body limit middleware.
- **Share tokens**: capability-scoped, expiry enforced, revoke list on both relay and host.
  Comment/reply bodies capped at **8000** characters. Producer `/rec/` tokens are
  a silent mix-minus monitor and are not recorded (`build.monitor: true`). Share
  them only with the producer. GUI mints have
  no expiry; prefer `--expires-at` on the CLI. Record shares are link-access only
  in this PR.
- **TLS**: Caddy handles HTTPS on the public edge.  The relay never sees plaintext from
  the public internet in production. Access logs redact `/r/{token}`, `/rec/{token}`, and `/mcp/{token}`
  path segments (see `deploy/relay/Caddyfile*`).
- **No filesystem paths in URLs**: tokens map to workspaces internally; guests never
  see absolute paths.
- **Diagnostics bundle**: host-only (`POST /api/diagnostics/bundle`). Guests cannot
  reach it via the proxy allowlist. The zip is written locally and never uploaded.
- **Host export jobs**: `POST /api/export/bounce` and `POST /api/export/deliverables` are
  host-only. The tunnel never maps `/api/export/*` (proxy allowlist), and a direct remote
  request under strict authz must present `PODCAST_SESSION_TOKEN`. A share token in
  `?token=` / `X-Podcast-Token` is never accepted as that credential (403, no job started).
  Strict authz is auto-enabled on a non-loopback bind only when `PODCAST_SESSION_AUTHZ`
  is unset. An explicit non-strict value (e.g. `PODCAST_SESSION_AUTHZ=off`) with
  `--host 0.0.0.0` removes this gate, and any LAN peer can start export jobs.
- **Host GUI**: defaults to loopback. Non-loopback bind auto-enables `PODCAST_SESSION_AUTHZ=strict`
  and injects `session_token` into the viewer URL. Prefer the public relay over LAN bind.
- **Remote MCP**: disabled by default; requires `PODCAST_REMOTE_MCP=1` on the host and
  explicit `mcp` capability on the share token. Tools are **capability-filtered** (guest
  parity), not the full host stdio MCP registry.
- **Rate limiting**: see § Rate limiting above. Optional **Caddy `rate_limit` module** (edge IP limits) is later ops polish if that Caddy plugin is installed; the relay IP bucket already covers MVP.
- **Presence**: guests with `view` see other participants' cursors, selection, playhead, and viewport. Session-plane WS messages echo the assigned `guest-{token}-…` `client_id` (the query string keeps the tab’s original id) so the guest never draws their own ghost. The guest DAW WebSocket accepts Presence frames only, with a 4 KiB size cap, per-connection and per-token rate limits, a malformed-frame close (`4400` after 20), mid-session share revocation re-check, and an Origin allow-list check for restricted shares. The relay `ws_presence` bucket is a coarse prefix pre-filter; the host limiter is authoritative.

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

Guests with `view` connect to `WS /api/review/{token}/daw/ws` on the host (and the same path on the public relay). ReviewApp / commenters without `view` connect to `WS /api/review/{token}/progress/ws` for guest-initiated progress only. Record guests with `monitor` connect to `WS /api/rec/{token}/ws`. The relay multiplexes guest sockets over the host tunnel with:

| Frame | Direction | Fields |
|-------|-----------|--------|
| `ws_open` | relay → host | `id`, `path` (`api/review/daw/ws`, `api/review/progress/ws`, or `api/rec/ws`), `share_token` |
| `ws_data` | both | `id`, `text` (JSON text frame) |
| `ws_close` | both | `id`, `code`, `reason` |

Old tunnel clients ignore unknown frame types (guest socket stays silent; HTTP poll still works). See [session-sync.md](session-sync.md) § Guest dual-plane WebSocket. Record rate buckets: host `guest_ws_record` / `guest_ws_record_token` for room commands, plus `guest_ws_record_signal` / `guest_ws_record_signal_token` for WebRTC `Signal` ICE/SDP (Heartbeat and HeadphonesAck stay exempt).
