---
name: podcast-record-session
description: >-
  Host a live recording room: mint guest/producer links, watch the lobby roster
  and consent, then Start / Pause / Resume / Stop. Consented talent records a
  full-quality recording on their own device, hears mix-minus, and saves it to
  the project ("Saving to project…", then "Saved to project"). Once saved,
  the recordings land as timeline clips — not review shares (`/r/` tokens).
---

# Record session (lobby + full-quality recording + mix-minus + saving + landing + live comments)

A record room is share **kind** `record` at `/rec/{token}`. Guest and producer
are two tokens on one `session_id`. Consented recorded clients (guest + host)
record an uncompressed 48 kHz / 16-bit mono WAV on their own device (the
full-quality recording; "keeper" in code and schema only), hear remote peers
only (mix-minus), and save it to the host's project in chunks until the file
ACK. Say "Saving to project…" while a segment is in flight and "Saved to
project" once the host holds the verified file, per participant and segment.
After that the host copies each segment into `raw/` and registers one clip at
`take_offset_s + join_offset_ms / 1000` (2 s gap between takes). During REC or
PAUSED, everyone can add a live comment (`M` → `body` `"Marker"`; typed notes
use the same path). Comments land as ordinary `review.comments[]` at
`take_offset_s + recording_ms / 1000`. Producers never capture, send, or save a recording.

## Harness

**MCP (preferred):**

| Tool | When |
|------|------|
| `create_record_room_tool` | Mint guest + producer links; revokes the previous room's links. Optional `target` (default `end`) |
| `record_state_tool` | Roster, take clock, `start_blockers`, consent |
| `record_start_tool` | Host Start (a solo take works; blocked while a joined guest has not consented) |
| `record_pause_tool` / `record_resume_tool` | Freeze / unfreeze the recording clock (and full-quality recording segments) |
| `record_stop_tool` | End the current take |
| `record_room_tone_tool` | Ask every recorded device to capture 3 s of room tone now (lobby or stopped; refused while a take is open or when nobody has joined). Sets `room_tone` and `countdown_left_ms` in the snapshot; Start stays legal during the countdown |
| `record_target_tool` | Set where this room's session lands (`end`, the default; `start` lands the session at the front of the episode and moves everything already there later by its length; `insert` with `{"kind": "insert", "at_sec": 12.5}` or `replace` with `{"kind": "replace", "from_sec": 12.5, "to_sec": 20, "track_ids": ["p_host"]}` stage the session as a suggestion instead of landing it). Refused once any take exists. The first land numbers the session and its undo step reads "Added Session N" ("Added Session N at the start" for `start`, "Staged Session N" for insert and replace) |
| `list_session_suggestions_tool` | List staged insert and replace sessions (`status` pending, skipped or accepted). Staged recordings are registered sources with nothing on the timeline until the session is accepted |
| `skip_session_suggestion_tool` | Skip a pending staged session (one undo step "Skipped Session N") |
| `hear_session_suggestion_tool` | Hear a pending session before accepting it: `mode` current (the place as it is), suggested (the same window after Accept, `take_index` chosen as there) or ab (current, a gap, then suggested). `pad_sec` (default 1.5) is the audio kept each side of the change; `dry_run` renders the WAVs without playing. Changes nothing and needs no `override_audio_checks`: a replace that would cut another track's speech still plays, and `speech` names the words so you can tell the person before they accept. Refuses what accepting refuses, with the same codes (`session_suggestion_not_pending`, `stale_anchor`, `take_not_found`, `take_not_applicable`, `track_not_recorded`, `pending_edits_in_range`) |
| `accept_session_suggestion_tool` | Place a pending session on the timeline (one undo step "Added Session N"). An insert opens its length at the insert point on every dialogue track and places the takes, room-tone beds and live comments. A replace (`take_index`, else the selected or last take) removes its exact range on every dialogue track and puts that one take there, so later audio moves by the take's length minus the range's; comments, chapters and pending edits after the range move with it, ones inside are kept at the range start (pending edits inside refuse: `pending_edits_in_range`). A replace that also cuts another track's speech returns `needs_confirmation` and changes nothing until repeated with `override_audio_checks=true`. Refuses one that is not pending (`session_suggestion_not_pending`), one whose audio anchor is gone or whose range changed (`stale_anchor`: record again), an unknown take (`take_not_found`), a `take_index` on an insert (`take_not_applicable`) and a track the take did not record (`track_not_recorded`). Music and other non-dialogue tracks do not move; the result lists them in `unmoved_track_ids`. A staged session takes no more recordings once accepted or skipped (`session_suggestion_closed`) |
| `record_marker_tool` | Stamp the open take now (`body` default `"Marker"`); lands as a timeline comment |
| `record_land_tool` | Land saved full-quality recordings into `raw/` + clips (idempotent; also runs on file ACK). Refused with "Stop the take to land it on the timeline." while a take is recording or paused |
| `record_discard_take_tool` | Delete a terminal take (refused while its recordings are still saving) |
| `revoke_record_room_tool` | End both links |

**CLI:**

```bash
podcast review share --kind record --project episode.project.json   # optional: --target end
podcast record state --project episode.project.json
podcast record roster --project episode.project.json
podcast record start --project episode.project.json
podcast record pause --project episode.project.json
podcast record resume --project episode.project.json
podcast record stop --project episode.project.json
podcast record room-tone --project episode.project.json
podcast record target end --project episode.project.json
podcast review session-suggestions --project episode.project.json   # optional: --status pending
podcast review skip-session-suggestion --project episode.project.json --id ss-<session_id>
podcast review preview-session-suggestion --project episode.project.json --id ss-<session_id>   # hear it first: --mode current|suggested|ab, --take N, --pad S, --dry-run
podcast review accept-session-suggestion --project episode.project.json --id ss-<session_id>   # replace: --take N, --override-audio-checks
podcast record marker --project episode.project.json --body "Retake intro"
podcast record land --project episode.project.json
podcast record discard-take --project episode.project.json --take-index 0
```

## Workflow

1. Mint a room (`create_record_room_tool` or Share dialog **Create record links**).
   Minting ends the previous room: its links show the dead-link cover.
   Send the **guest** `/rec/` URL to talent and the **producer** URL only to the
   silent listener.
2. Open the host **Record room** panel (Menu → Record room…, or Share →
   **Open room panel**). The host browser will ask for a mic; that dry tap is
   the host's full-quality recording (`p_host`).
3. Guests enter a name, check headphones, click **Allow microphone**, preview
   the mic, optionally record 3 s of room tone (or Skip), then **Accept**
   consent. Accept stays disabled until the mic is granted. Room tone stays on
   this device until Accept; the recorder is armed on Accept and writes **zero
   bytes** until Start. Producers enter a name and
   **Join** (no mic, no room tone, no consent, no full-quality recording).
4. `record_state_tool` / the panel: Start stays disabled while `start_blockers`
   is non-empty. Each row has a `code`:
   - `{"code": "no_recorder"}` — nobody recorded yet (the host's Join
     fixes it). The host alone can start a solo take.
   - `{"code": "consent_pending", "participant_id", "display_name"}` — that
     person has not accepted yet (`consented` is `null`). A **declined** guest
     (`consented: false`) does **not** block Start.
   Producers never appear in `start_blockers`. A refused Start reads
   `cannot start: nobody has joined the room` or `cannot start: Ava has not
   accepted recording`. With no room, the panel's **Create record room** mints one in
   place (same as `create_record_room_tool`).
5. Start → every client shows **REC** and a recording clock; recorded clients
   show **Recording in full quality on this device.** Everyone who is connected hears
   the room (**Hearing the room.**). Pause freezes the clock (PAUSED)
   and the current full-quality recording segment; the monitor stays live. Resume opens a new
   segment. Stop (the panel asks once: **Stop take** or **Keep recording**) ends
   the take (Stopped) and keeps a **blocking saving panel**
   ("Saving to project… N of M chunks", then "Saved to project") until the
   file ACK; the host panel lists the same status per participant and segment. Mute writes zeros (file stays continuous) and stops that
   person's send. **M** (or the Marker button) posts a live comment with body
   `"Marker"`; typed notes use the same path. Guests see only their own comments
   in the room (other guests never see them there). Host DAW `daw.record.marker`
   is `omit.guest` because guests use RecordApp, not the host catalog. Host and
   producer see all live comments. After land they become ordinary timeline
   comments on the host.
6. Once saved, the recordings land on the host timeline (`raw/` + one clip per
   segment). Same `participant_id` is one track. Takes stack with a 2 s gap.
   Happy path skips `ingest suggest`. Land reports sample-count vs
   recording-clock `drift_ms` (`null` if unknown); `|drift| > 50 ms` or a
   missing `session_start` sets `align_fallback` so pipeline `align_tracks`
   can run after transcribe — land does not invoke it. A nonzero
   `deferred_rollbacks_pending` means a stale-ACK rollback is still waiting
   to be retried; a later land retries it once its backoff (30 s, doubling up
   to 30 min) has passed, or undo the `record_land` step through history.
   Optional room-tone WAVs
   land atomically at `raw/room-tone/{session}/{participant}.wav` on
   `track.room_tone` (the older shared `raw/room-tone/{participant}.wav`
   path still works for existing projects). Each landed source carries
   `clipping_regions` (sample peak at or above -1 dBFS from the encoder;
   recovered crash segments and older clients have none), and `list_clips`
   reports `clipping_regions` per clip: the source spans inside that clip's
   window. `clipping_truncated` on a source and clip row means clipping after
   the last region was not recorded. The timeline shows them as flags in the marker lane and a red tint
   on the clip. Reloading
   the same `/rec/` link reuses
   the host-minted `participant_id` + lease (7-day recovery window). A second
   tab is rejected (`lease_in_use`).
   If the tunnel drops during REC, guests keep recording on their device ("Host offline —
   still recording locally."). After ≥ 10 s the host return **pauses** the take
   (`pause_reason: host_reconnect`); Resume starts a new segment. Do not mint a
   second room while REC/PAUSED — Stop first. Land the take before minting a
   new room: a new room supersedes the old one and kills its links (guest and
   producer), and landing reads only the active room.

## Rules

- Roles come from the token. Guests cannot Start/Pause/Stop. Producers cannot
  Consent or mute, and never call `getUserMedia`.
- Full-quality recordings save over `POST /api/rec/{token}/upload` (`join` only) with resume
  on the same token. Once "Saved to project" and landed, tell the user the tracks are on the host
  timeline (`podcast record land` / `record_land_tool` if a retry is needed).
  Mix-minus is live (`build.monitor: true`). `build.upload` follows `join`
  (producers stay `false`).
- Full room (4 recorded / 2 producers) is a page, not a silent failure.
- Host admit / waiting-room approval is **not** implemented (ROADMAP Follow-up).
- Tauri native mic (cpal) is deferred; host capture uses the same Worklet as
  the browser guest.

See [docs/recording-session.md](../../../docs/recording-session.md).
