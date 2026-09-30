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
| `align_tracks` | Deterministic scorer | Locks first (`hold` when every dialogue stem is equal length, manifest `manual`); bleed phrase Δt when at least 5 weighted matches agree; moves above `align.large_move_sec` need waveform confirmation else `unconfirmed_hold`; else own-speech/VAD gaps; else late-join = first speech into a host silence (clear win vs identity); N speakers; whole-file clips re-placed, split/trimmed tracks slip source by the delta (edit points kept; ambiguous → track skipped with `skipped_reason`) |
| `require_align_accept` | Gate | Blocks until done/waived; `--unattended` auto-waives small moves when `align.accept.mode=waive_unattended` but stops on any move above `align.large_move_sec` |

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

Reading the brief: `hold` / `manual` stems are locked (equal length or manifest-pinned) and keep their placement; set `align.realign` to re-score: CLI `podcast pipeline run --realign`; MCP `pipeline_run(..., config_json='{"align": {"realign": true}}')` or `pipeline_set_config_tool(config_json=...)` (GUI: Pipeline pane "Re-align locked stems"). `unconfirmed_hold` rows keep the scorer's `candidate_offset_sec` at offset 0 because waveform xcorr did not confirm it; `align brief` lists `large_moves`. Listen, nudge with `move_clips_tool` if the candidate is real, then `align done`. Export QC flags an unaccepted `unconfirmed_hold` candidate until `align done`.

Upgrading: bleed now needs 5 clustered n-grams (was 2) plus `align.bleed_min_share`, so re-running align on an older project can give different offsets. `config_json='{"align": {"min_bleed_matches": 2, "bleed_min_share": 0}}'` restores the old bleed trust.

Artifact: `artifacts/alignment/conversation_align.json`.

## Pre-pipeline ingest (optional)

Still useful before a project exists, or for VAD-only packs:

1. **`podcast ingest import DIR`** (or `ingest_import_folder_tool`) drafts `ingest.yaml` from a recorder export folder (audio-only; vendor hint is informational). Review labels; `--speaker file=Name` to override. Does not copy audio or mint record URLs.
2. Or author `ingest.yaml` by hand with `session.reference_speaker` (several whole files per speaker OK — each stays one unsplit clip).
3. `podcast ingest suggest` → merge offsets → `ingest consolidate` → `ingest verify` → `play --compare`. Consolidate places each untrimmed clip on the session clock (guest `source_start` = lead-in, `timeline_start` 0); the reference speaker is `session.reference_speaker`. Pipeline `align_tracks` keeps that placement (guest offsets are rebased onto the reference clip).

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

1. **Recorder clock alignment** keeps each raw file as one clip; several files for one speaker move independently. After reconcile, use [podcast-mute-bleed](../podcast-mute-bleed/SKILL.md) for scoped retained-bleed corrections. That workflow may isolate complete direct phrases while preserving speech, unrelated audio, and manual placement locks on surviving fragments.
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

- Local retained-bleed alignment: `.agents/skills/podcast-mute-bleed/SKILL.md`
- Session clock concepts: `.agents/skills/podcast-ingest-align/SKILL.md`
- Pipeline order: `.agents/skills/podcast-pipeline-run/SKILL.md`
- Reference: `docs/multitrack-ingest.md`, `docs/pipeline.md`
