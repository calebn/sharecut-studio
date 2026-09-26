---
name: podcast-record-session
description: >-
  Host a live recording room: mint guest/producer links, watch the lobby roster
  and consent, then Start / Pause / Resume / Stop. Consented talent writes a
  local dry WAV keeper (OPFS), hears mix-minus, and chunk-uploads to the host
  until ACK. After ACK, keepers land as timeline clips — not review shares
  (`/r/` tokens).
---

# Record session (lobby + keepers + mix-minus + upload + landing + live comments)

A record room is share **kind** `record` at `/rec/{token}`. Guest and producer
are two tokens on one `session_id`. Consented recorded clients (guest + host)
write uncompressed 48 kHz / 16-bit mono WAV keepers on device, hear remote
peers only (mix-minus), and chunk-upload keepers to the host until ACK.
After ACK the host copies each segment into `raw/` and registers one clip at
`take_offset_s + join_offset_ms / 1000` (2 s gap between takes). During REC or
PAUSED, everyone can add a live comment (`M` → `body` `"Marker"`; typed notes
use the same path). Comments land as ordinary `review.comments[]` at
`take_offset_s + recording_ms / 1000`. Producers never capture, send, or upload.

## Harness

**MCP (preferred):**

| Tool | When |
|------|------|
| `create_record_room_tool` | Mint guest + producer links |
| `record_state_tool` | Roster, take clock, `start_blockers`, consent |
| `record_start_tool` | Host Start (blocked until connected guests consent) |
| `record_pause_tool` / `record_resume_tool` | Freeze / unfreeze the recording clock (and keeper segments) |
| `record_stop_tool` | End the current take |
| `record_land_tool` | Copy ACK'd keepers into `raw/` + clips (idempotent; also runs on file ACK) |
| `record_discard_take_tool` | Delete a terminal take (refused while upload is in flight) |
| `revoke_record_room_tool` | End both links |

**CLI:**

```bash
podcast review share --kind record --project episode.project.json
podcast record state --project episode.project.json
podcast record roster --project episode.project.json
podcast record start --project episode.project.json
podcast record pause --project episode.project.json
podcast record resume --project episode.project.json
podcast record stop --project episode.project.json
podcast record land --project episode.project.json
podcast record discard-take --project episode.project.json --take-index 0
```

## Workflow

1. Mint a room (`create_record_room_tool` or Share dialog **Create record links**).
   Send the **guest** `/rec/` URL to talent and the **producer** URL only to the
   silent listener.
2. Open the host **Record room** panel (Menu → Record room…, or Share →
   **Open room panel**). The host browser will ask for a mic; that dry tap is
   the host keeper (`p_host`).
3. Guests enter a name, check headphones, click **Allow microphone**, preview
   the mic, optionally record 3 s of room tone (or Skip), then **Accept**
   consent. Accept stays disabled until the mic is granted. Room tone stays on
   this device until Accept; the encoder is armed on Accept and writes **zero
   bytes** until Start. Producers enter a name and
   **Join** (no mic, no room tone, no consent, no keeper).
4. `record_state_tool` / the panel: Start stays disabled while `start_blockers`
   is non-empty.
   - `"No one has joined"` — no connected guest yet (host alone does not count).
   - Guest display names — those people have not accepted yet (`consented` is
     `null`). A **declined** guest (`consented: false`) does **not** block Start.
   Producers never appear in `start_blockers`.
5. Start → every client shows **REC** and a recording clock; recorded clients
   show **Recording locally on this device.** Everyone who is connected hears
   the room (**Hearing the room.**). Pause freezes the clock (PAUSED)
   and the current keeper segment; the monitor stays live. Resume opens a new
   segment. Stop ends the take (Stopped) and keeps a **blocking upload panel**
   until chunk ACK. Mute writes zeros (file stays continuous) and stops that
   person's send. **M** (or the Marker button) posts a live comment with body
   `"Marker"`; typed notes use the same path. Guests see only their own comments
   in the room (other guests never see them there). Host DAW `daw.record.marker`
   is `omit.guest` because guests use RecordApp, not the host catalog. Host and
   producer see all live comments. After land they become ordinary timeline
   comments on the host.
6. After ACK, keepers land on the host timeline (`raw/` + one clip per
   segment). Same `participant_id` is one track. Takes stack with a 2 s gap.
   Happy path skips `ingest suggest`. Land reports sample-count vs
   recording-clock `drift_ms` (`null` if unknown); `|drift| > 50 ms` or a
   missing `session_start` sets `align_fallback` so pipeline `align_tracks`
   can run after transcribe — land does not invoke it. Optional room-tone WAVs
   land atomically at `raw/room-tone/{session}/{participant}.wav` on
   `track.room_tone` (the older shared `raw/room-tone/{participant}.wav`
   path still works for existing projects). Each landed source carries
   `clipping_regions` (sample peak at or above -1 dBFS from the encoder;
   recovered crash segments and older clients have none), and `list_clips`
   reports `clipping_regions` per clip: the source spans inside that clip's
   window. The timeline shows them as flags in the marker lane and a red tint
   on the clip. Reloading
   the same `/rec/` link reuses
   the host-minted `participant_id` + lease (7-day recovery window). A second
   tab is rejected (`lease_in_use`).
   If the tunnel drops during REC, guests keep writing locally ("Host offline —
   still recording locally."). After ≥ 10 s the host return **pauses** the take
   (`pause_reason: host_reconnect`); Resume starts a new segment. Do not mint a
   second room while REC/PAUSED — Stop first.

## Rules

- Roles come from the token. Guests cannot Start/Pause/Stop. Producers cannot
  Consent or mute, and never call `getUserMedia`.
- Keepers upload over `POST /api/rec/{token}/upload` (`join` only) with resume
  on the same token. After ACK, tell the user the tracks are on the host
  timeline (`podcast record land` / `record_land_tool` if a retry is needed).
  Mix-minus is live (`build.monitor: true`). `build.upload` follows `join`
  (producers stay `false`).
- Full room (4 recorded / 2 producers) is a page, not a silent failure.
- Host admit / waiting-room approval is **not** implemented (ROADMAP Follow-up).
- Tauri native mic (cpal) is deferred; host capture uses the same Worklet as
  the browser guest.

See [docs/recording-session.md](../../../docs/recording-session.md).
