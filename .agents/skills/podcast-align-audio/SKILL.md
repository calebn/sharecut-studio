---
name: podcast-align-audio
description: >-
  Conversation-clock alignment for multitrack podcasts: pipeline align_tracks
  (bleed/gaps scorer) plus require_align_accept gate; listen with play --compare,
  nudge clips, then `podcast align done`. Also covers pre-pipeline ingest suggest/verify.
  For session-clock concepts and anchor fine-tune only, see podcast-ingest-align.
---

# Align multitrack audio (conversation clock)

Use for **any** episode where speakers share one conversation but recorders
started/stopped at different times. Do **not** use file length as a sync signal
(except near-exact equal duration). Uncheck pipeline **Align tracks** when clips
are unrelated segments to arrange by hand.

Agents must **not** set `--unattended` / `PODCAST_BATCH` to skip the gate — clear
it with listen + `podcast align done` (or explicit waive).

## Pipeline path (preferred after ASR)

Order: `transcribe_tracks` → **`align_tracks`** → **`require_align_accept`** →
`merge_transcript` → stems → reconcile.

| Step | Who | Behavior |
|------|-----|----------|
| `align_tracks` | Deterministic scorer | Bleed phrase Δt when matches agree; else own-speech/VAD gaps; else late-join = first speech into a host silence (clear win vs identity); N speakers; whole-file clips only |
| `require_align_accept` | Gate | Blocks until done/waived; `--unattended` auto-waives when `align.accept.mode=waive_unattended` |

### Gate (interactive / MCP)

| Command / tool | Purpose |
|----------------|---------|
| `podcast align status` / `align_status_tool` | pending / done / waived + fingerprint |
| `podcast align brief` / `align_brief_tool` | Offsets, methods, clip geometry |
| `podcast align done` / `align_done_tool` | Clear gate after listen |
| `podcast align waive --reason …` / `align_waive_tool` | Explicit skip |

1. If pipeline stopped on the gate, read **`align brief`**.
2. **`play --compare --start 0 --end 90`** (and opening windows).
3. Nudge clips in Sharecut Studio (select-tool body drag, or `move_clips_tool` / `podcast edit move-clips`) if the rough clock is wrong. Do **not** use `move_segment_tool` for that — it shuffles a time range on every dialogue track.
4. **`align done`** (or waive with reason). Re-running `align_tracks` resets pending.

Artifact: `artifacts/alignment/conversation_align.json`.

## Pre-pipeline ingest (optional)

Still useful before a project exists, or for VAD-only packs:

1. **`podcast ingest import DIR`** (or `ingest_import_folder_tool`) drafts `ingest.yaml` from a recorder export folder (audio-only; vendor hint is informational). Review labels; `--speaker file=Name` to override. Does not copy audio or mint record URLs.
2. Or author `ingest.yaml` by hand with `session.reference_speaker` (several whole files per speaker OK — each stays one unsplit clip).
3. `podcast ingest suggest` → merge offsets → `ingest consolidate` → `ingest verify` → `play --compare`.

Suggest is VAD-primary; pipeline align prefers **bleed phrases**, then **own-speech gaps**,
then **late-join occupancy** (first real island into a host silence that fits it).
Sparse one-off bleed bigrams are for listen diagnosis — not the default clock.

```bash
podcast ingest suggest \
  --audio-dir "/path/to/raw" \
  --manifest ingest.yaml \
  --analysis-start 0 \
  --analysis-duration 90 \
  --sweep-min 0 --sweep-max 240 --sweep-step 5 \
  --waveform-top 3
```

## Rules

1. **One raw file = one clip** — never blade/split for alignment; several files for one speaker move independently.
2. **Bleed is a clock** — same phrase on two tracks ⇒ same moment (before reconcile suppresses it).
3. **Bleed is not occupancy** — gap scoring uses own-speech / VAD, not raw ASR that includes the other mic.
4. **Never mark “aligned” from JSON alone** — listen with `play --compare`.
5. **Equal duration** — near-exact lengths soft-hold offset 0 when gaps/late-join are not confident; late joins use first-speech-into-host-silence occupancy.
6. **Never treat sparse bleed as gospel** — a single misheard bigram can help an agent listen-check; only agreed multi-match bleed is a scorer clock.

## MCP tools

| Tool | Purpose |
|------|---------|
| `align_status_tool` / `align_brief_tool` / `align_done_tool` / `align_waive_tool` | Accept gate |
| `ingest_import_folder_tool` | Draft `ingest.yaml` from a recorder export folder |
| `ingest_suggest_alignment_tool` | Pre-consolidate offset sweep + waveform PNGs |
| `ingest_verify_alignment_tool` | Post-consolidate VAD audit + `play_commands` |
| `play_compare_tool` | Sequential dialogue + premix audition |
| `play_audio_tool` (`compare=true`) | Same compare via play tool |
| `move_clips_tool` | Nudge clip `timeline_start` / `track_id` without a range shuffle |

## Related

- Session clock concepts: `.agents/skills/podcast-ingest-align/SKILL.md`
- Pipeline order: `.agents/skills/podcast-pipeline-run/SKILL.md`
- Reference: `docs/multitrack-ingest.md`, `docs/pipeline.md`
