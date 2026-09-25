# Share HTTP

> **Requires** the built-in FOSS `collaboration` extension (share routes are not
> mounted with `PODCAST_EXTENSIONS=`). Public internet URLs also need
> `podcast tunnel` + a FOSS relay. Document commands on the **host** GUI work without either.

Token-scoped guest / review APIs under `/api/review/{token}/…` (proxied by the
relay). Guests never pass a host project path.

Full narrative: [docs/host-online-relay.md](https://github.com/calebn/sharecut-studio/blob/main/docs/host-online-relay.md).

## Capabilities

| Cap | Meaning |
|-----|---------|
| `play` | Stream review-mix / guest DAW audio |
| `view` | Read-only Sharecut Studio (timeline, tracks, peaks, premix) |
| `comment` | Add timeline comments (body max **8000** chars) |
| `reply` | Reply to existing comments |
| `action` | Toggle comment action items |
| `suggest` | Propose/nudge pending edits and **propose** structural ops |
| `edit` | Apply document commands and structural ops; media upload; render preview |
| `mcp` | Capability-scoped remote MCP at `/mcp/{token}/mcp` |

Comments: prefer [document commands](#/document-commands) (`AddComment`, …) when also
using MCP/WS; REST `/comments*` remains for ReviewApp-style clients.

<!-- share-http-routes:generated -->

> **Auto-generated** from FastAPI guest routes + curated cap notes. Run `make schema-export`.

### Guest Sharecut Studio / review routes

| Method | Route | Cap | Notes |
|--------|-------|-----|-------|
| `GET` | `…/audio` | `play` | ReviewApp frozen mix |
| `POST` | `…/comments` | `comment` | Timeline comment (REST) |
| `POST` | `…/comments/{comment_id}/actions/{action_id}/done` | `action` | HTTP twin for MCP guest_set_action_done |
| `POST` | `…/comments/{comment_id}/replies` | `reply` | Reply (REST) |
| `GET` | `…/daw/audio` | `play` | Whitelist: premix, stem, processed, review |
| `GET` | `…/daw/audition-context` | `play + view` | Windowed captions + PNG URLs (agent hear channel v1) |
| `GET` | `…/daw/audition-context-image` | `play + view` | Waveform or spectrogram of a timeline window |
| `POST` | `…/daw/document/command` | `view + command allowlist` | Typed body — see Document commands |
| `POST` | `…/daw/media/upload` | `edit` | Chunked audio into host raw/ |
| `GET` | `…/daw/meta` | `view` | mtime/size for poll reload |
| `GET` | `…/daw/peaks/{track_id}` | `view` | Uint8 overview waveform |
| `GET` | `…/daw/pending-preview` | `play + view` | Listen-first Current/Suggested/A/B WAV (not host speakers) |
| `GET` | `…/daw/pending-preview-image` | `play + view` | Waveform or spectrogram of the listen-first extract |
| `GET` | `…/daw/project` | `view` | Sanitized ProjectView (no host paths) |
| `GET` | `…/daw/proxy/manifest` | `play` | Proxy chunk manifest |
| `GET` | `…/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}` | `play` | Content-addressed proxy media |
| `POST` | `…/daw/render-preview` | `edit` | Rebuild stems/premix (opt-in PODCAST_GUEST_RENDER) |
| `GET` | `…/daw/waveform-snap` | `suggest or edit` | Windowed snap ticks; view-only gets wash only |
| `GET` | `…/daw/waveform/status` | `view` | Waveform pyramid status (raw media) |
| `GET` | `…/daw/waveform/tiles/{key}` | `view` | Binary min/max/RMS pyramid tiles |
| `WEBSOCKET` | `…/daw/ws` | `view` | Receive-only session+document fanout (progress plane too) |
| `GET` | `…/features` | `view` | Extension / feature manifest |
| `WEBSOCKET` | `…/progress/ws` | `token` | Guest-initiated progress plane for ReviewApp (no view cap, no host paths) |
| `GET` | `…/project` | `view` | Legacy ReviewApp project JSON |
| `GET` | `…rec/bootstrap` | `kind=record` | Record lobby bootstrap JSON (no review mix) |
| `GET` | `…rec/features` | `kind=record` | Extension / feature manifest |
| `DELETE` | `…rec/upload` | `join` | Revoke an ACK'd room-tone bed (kind=room_tone) |
| `GET` | `…rec/upload` | `join` | Record keeper chunk ACK status (own participant) |
| `POST` | `…rec/upload` | `join` | Record keeper chunk upload (sha256 + resume) |
| `WEBSOCKET` | `…rec/ws` | `monitor` | Record room / live comments / WebRTC signal |

<!-- /share-http-routes:generated -->

Local proxy media URLs are content-addressed:
`/api/review/{token}/daw/proxy/{track_id}/{hash}/{i}`.

Invalid document-command payloads return **422** at the HTTP boundary.
See [Errors & limits](#/errors).
