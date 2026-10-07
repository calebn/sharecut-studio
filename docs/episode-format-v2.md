# Episode Project Format v2

Canonical file: `episode.project.json` in the episode workspace.

Version `2.0` is the **single source of truth** for editable project state. CLI, MCP, pipeline, and history all load and commit through `ProjectStore`.

## Workspace layout

```
my_episode/
├── episode.project.json    # v2 project (required)
├── raw/                    # Source / consolidated audio (never overwritten by edits)
├── transcripts/            # Optional write-through caches (not authoritative)
├── history/
│   ├── index.json          # Mirror of project.history (optional)
│   └── snapshots/          # Full editable-state snapshots for undo/redo
├── artifacts/              # Rendered intermediates (premix, per-track WAVs)
└── export/                 # Final deliverables (WAV, MP3, SRT, MD)
```

## Top-level sections

| Section | Purpose |
|---------|---------|
| `meta` | `name`, `workspace_dir`, `created_at`, `schema_id`. On disk, `workspace_dir` is always `"."`; `load_project` remaps to the directory containing `episode.project.json`. Media and source paths are workspace-relative (never absolute host paths). |
| `sources` | Raw ingest files, alignment offsets (pre- or post-consolidation). Recorded keepers also carry `clipping_regions[]` (`start_s`/`end_s`, source seconds): sample-peak clipping the browser encoder detected (-1 dBFS), written at landing; `clipping_truncated` (the encoder hit its region cap); `list_clips` reports each clip's share as `clipping_regions` and `clipping_truncated`. Consolidated sources carry none |
| `timeline` | `tracks`, `clips` (placement on session clock), `duration_sec` |
| `editorial` | Non-destructive `edit_decisions` (remove/mute ranges; `split` blade proposals use timeline clock via `timebase`); `edit_log` (committed-cut provenance); `speaker_splits` (one recording split into a lane per speaker) |
| `transcripts` | `per_track[]` word-level ASR; `combined` utterances for NL editing |
| `mix` | `processing_chains` (per-track `effects[]` with `effect`, `params`, optional `bypass`), `automation_envelopes` |
| `render` | `last_completed_step`, `pipeline_runs`, `artifacts` paths; `reconciliation_stale` / `last_reconciliation_hash`; `invalidations[]` (diagnostic cause journal since last fresh stem) |
| `social` | Social clip candidates |
| `review` | Timeline comments and action items (session-clock feedback) |
| `history` | Undo/redo cursor and snapshot index |
| `document_sync` | `last_command`: the document-plane command saved on the same commit as its apply, for crash recovery (#575, [session-sync.md § Command identity and retries](session-sync.md#command-identity-and-retries)). Not an editable layer; undo/redo never restore it |

`history` is always an object: a project with no recorded snapshots saves an empty `ProjectHistory` (`{"cursor": -1, "entries": []}`), and a legacy `"history": null` loads as that empty history. An empty saved history adopts `history/index.json` only when the index's current entry matches the saved editable state ([history.md § Storage layout](history.md#storage-layout)). A track's optional `room_tone`, `gate_fill` and `proxy` are saved as `null` when absent; `schemas/episode.project.schema.json` accepts that, so a file written by `save_project` validates as-is.

Each saved automation envelope point requires an immutable `id` plus its mutable
`time` and `value`. Creation boundaries allocate IDs before persistence. Editors
preserve the ID when points move or reorder, so an index shift cannot attach a
DOM node or selection to the wrong point. Saved records without point IDs are
rejected.

Changing only point IDs leaves audio render and reconciliation fingerprints
unchanged. Volume-point times, values, and saved order contribute to those
fingerprints.

## Transcripts (canonical in project file)

After transcription, **`transcripts.per_track`** must be present in `episode.project.json`. Each entry:

```json
{
  "track_id": "host",
  "language": "en",
  "words": [
    { "text": "hello", "start": 0.5, "end": 0.9, "confidence": 0.95 }
  ]
}
```

Word `start`/`end` (and combined utterance times) are **source-media seconds** on that track's raw file — never the edited timeline. Edits move clips, not word times.

`transcripts.per_track[].archived_words` retains words removed by audio cuts. Each entry stores an `ordinal` and the complete `word` object, including source times, confidence, ignored/suppressed flags, alignment evidence, and suppression locks. The containing transcript supplies its `(track_id, source_id)` identity. Older projects default to an empty archive. The archive is part of the project and history snapshots, not a new sidecar.

Cuts remove overlapping words from the active `words` list and retain them in this archive. Boundary expansion restores a word only when matching source clips cover its entire source span. Partial restoration keeps it archived. Archived words stay out of combined text, search, and export until restored. Existing cuts made before archival have no automatic word recovery; History undo can recover the original transcript snapshot.

`transcripts.combined` holds time-ordered utterances for search, NL cuts, and SRT export. Exports map these to the timeline clock at write time.

Files under `transcripts/*.json` are **caches only**; `ProjectStore.commit()` may refresh them from the project.

`transcripts.per_track[].audio_sha256` is the full SHA-256 of the media the words were transcribed from (stamped by the ASR step; legacy or seeded transcripts have none and are adopted on the next run unless ASR cache names show they came from other audio). Each word may carry `suspect_hallucination: true` when the own-track audio under it is digital silence (peak below `transcribe.silence_filter.peak_dbfs`); a flag only, the word is kept. Words re-timed by the forced aligner carry `alignment_score` (the mean CTC posterior of the frames used, 0..1; unset for Whisper's own times). A word whose span `transcribe_tracks` trimmed as implausible for its token class carries `trimmed_from: [start, end]`, its span before the trim (#979, [transcript-workflow.md § Word-span plausibility](transcript-workflow.md)); unset otherwise. A word over its class cap that holds more of its speaker's voice than the cap carries `overlong: true` instead: its times are untouched and the refine queue carries it as `anomalous_word_duration`. `audio_size` and `audio_mtime_ns` record the media's size and mtime when the hash was taken; when both still match, the next run reuses the hash instead of re-reading the file (a file replaced with the same size and mtime counts as unchanged; force re-transcribes it). `transcripts.per_track[].user_edited` becomes true when a person or agent corrects, suppresses, unlocks suppression, ignores or verifies words; re-transcription refuses to replace such a transcript in unattended runs. `transcripts.per_track[].word_aligner` names the forced aligner (`onnx-base`) that re-timed the words when `transcribe.forced_alignment.enabled` placed at least one of them; it is unset for Whisper's own times, and `transcribe_tracks` counts reused transcripts without it as "not re-timed" when they have words in a language the aligner supports (English) (run-only `retime_words` re-times them from the ASR cache without Whisper; see [transcript-workflow.md](transcript-workflow.md)). `transcripts.per_track[].alignment_score_method` records the per-word score definition that produced `alignment_score` (currently `mean_emitting_posterior_v1`); a transcript whose value differs from the current one, including one re-timed before scores existed (unset), also counts as "not re-timed", so Re-time words re-scores it.

A word's `ignored: true` (#633) is a text-and-audio hide: it stays struck through in the transcript and combined text, but its span is muted at render time. Unlike `suppressed` (text-only — dropped from the combined transcript; a bleed or wrong-mic word, audio unchanged), `ignored` never touches `Clip.mute_regions`; every render path that honours `mute_regions` also mutes ignored-word spans computed from the transcript, so undo/redo and restore stay in lockstep with the flag. Reconcile and speaker attribution never flip `ignored` automatically. On a multi-source track the flag lives on the track-level transcript (the one the GUI shows); its spans mute only clips whose `source_id` resolves to that transcript (`transcript_for_source`), never an extra source's clip.

A word's `audibility_locked: true` (#768) records that a person or agent set `suppressed` directly — `set_word_suppressed_tool`, `apply_bleed_suppression_tool` / `podcast edit suppress-bleed` **called with an explicit word list**, or `apply_low_audibility_suppression_tool` called with an explicit `words` list: a named word list is a decision, not a heuristic pick (#781). A heuristic `suppress-bleed` or low-audibility apply (no explicit list) does not lock — it recomputes reconcile's own verdict, and locking a heuristic guess would pin it forever. Reconcile treats a locked word the same way it treats an `ignored` one: it skips it entirely, leaving `suppressed`, `audibility_status` and `dominant_track` exactly as the person or agent set them, so a later reconcile pass (pipeline pass 2, a preview render, or a manual re-run) can't silently revert the decision. Every automatic writer that can flip `suppressed` — the low-audibility and bleed heuristic scans, and speaker attribution's bleed/home-speaker suppression (`engines/speaker_id.py`) — routes through `TranscriptWord.resolve_auto_suppression` so a locked word's `suppressed` value survives that pass too (#781). Toggling suppression again on the same word simply re-sets the lock at the new value. Sharecut Studio shows a lock affordance on a word's transcript chip when `audibility_locked` is set (`docs/gui-integration.md`).

**Clearing the lock (#824).** `set_word_automatic_tool`, the `SetTranscriptWordAutomatic` document command, `podcast transcript suppress-word --automatic`, and Studio's word inspector "Return to automatic" button clear `audibility_locked` back to `false` without touching `suppressed`. The word is not reclassified by the unlock itself; it stays exactly as it was until the next reconcile pass computes and writes its target, the same as any word that was never locked. See [transcript-reconcile.md](transcript-reconcile.md).

`transcripts.per_track[].vocabulary_revision` records the `transcript_context.yaml` vocabulary revision whose Whisper prompt produced that transcript. Studio asks for re-transcription when any stored transcript has a different revision than the context; a project with no transcripts never asks. Single-track runs stamp only that track, and a failed or empty transcription leaves existing stamps unchanged.

## Timebase invariant

`editorial.retained_bleed_alignments` stores local direct-phrase timing decisions.
Each `RetainedBleedAlignmentDecision` names the direct and retained-bleed track,
selected `source_id`, and source-clock phrase bounds `start_s` / `end_s`. It records
`mode` (`auto`, `manual`, or `declined`), signed `offset_sec`, the isolated clip's
previous/current timeline start, provenance (`automatic` or
`requested_scoped_override`), and evidence revision. Declining a preview records
zero applied offset and leaves clip geometry unchanged. Manual/declined choices
protect that direct source phrase across peers until explicitly reset to auto.
Applied corrections alter ordinary clip placement, not source samples or word
times; there is no voiced time warp. Full editorial snapshots include the choices.
Applied move records add
`params.quiet_trim`: reason `verified_quiet_destination_overlap` and selected
source ranges for the geometry-only quiet overlap trim; transcript metadata is
preserved and any reduction of retained-word source coverage blocks planning.
The comparison uses the transcript selected by each clip's `source_id`. An exact
source transcript takes priority. Track-level words apply only to primary media
and equivalent explicit source aliases, including relative/absolute references
to that file. Another recording's coincident timestamps cannot supply phrase or
gate authorization. A quiet trim touching an untranscribed source abstains.
Conflicting correction footprints abstain before clip edits are published.
Manual per-clip `meta.ingest_alignment` entries are copied to new surviving
same-source subclips when project-aware clip replacement splits or trims them.
Those entries use the existing `track_id:clip_id` keys and editable snapshots.
Optional `media_key` is a `sha256:` digest of the normalized selected recording
path, relative to the workspace where possible. It contains no host path and
keeps a choice stable when primary media is pinned to an equivalent explicit
source, including relative/absolute aliases. An unrelated selected recording
does not inherit a newly saved choice. Legacy records without the digest use
their existing source or primary-media reference for comparison.

**All stored times (`TranscriptWord`, `EditDecision` remove/mute, `CombinedUtterance`) are source-media seconds; blade `EditDecision` with `type: split` and `timebase: timeline` stores the cut as timeline seconds (`start == end`); `timeline.clips` is the only bridge; anything that touches rendered audio (stems, premix, mastered, export) must map through `SessionTimeline`.**

Two clocks exist:

| Clock | Unit | Where it lives |
|-------|------|----------------|
| **Source** (`SourceSec`) | Seconds into a track's raw media file | `TranscriptWord.start/end`, `EditDecision.start/end`, `CombinedUtterance.start/end` |
| **Timeline** (`TimelineSec`) | Seconds on the edited session/deliverable clock | Rendered stems, `artifacts/premix.wav`, mastered WAV, SRT/VTT captions, social clips, chapters, `review.comments` |

`engines/session_timeline.py` (`SessionTimeline`) is the single hub that maps between them, driven by `timeline.clips`. Its `lane_clip_spans` mapping keeps each clip's selected source recording attached to the paired bounds. Raw audibility and directed bleed-path measurement use these current-lane placements when a rendered stem is absent. They omit a lane whose selected source file or required samples are unavailable. Consumers never do clip arithmetic inline — see [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock).
`map_selected_source_span` and its batch form map a named recording only through
placements on the requested lane with the matching `source_id`. Local retained-bleed
phrase planning and retained-word guards use this source-specific mapping.

## Timeline and render

- **`timeline.tracks`** — ordered list of tracks (array order is Arrange lane order / display order; reorder with `ReorderTrack`). Per-track `gain_db` (staging gain the pipeline's balance step writes), optional `balance_basis` (`digest`, `measured_lufs`, and `speech_gated` from the last successful measurement), `fader_db` (the user's saved volume, −60 to +12 dB; the mix plays `gain_db + fader_db` and balance never touches it), `muted` (saved mix mute: the mix, play and bounce leave the track out; edits, stems and analysis such as the audio audit still cover it, so a muted track stays in sync and unmutes cleanly), and `transcript_gate` (when true, rendered stems and segments attenuate verified foreign copies while protecting owner phrases and uncertain activity). `balance_basis` is unknown until the track is measured. Its digest covers the primary media file revision, ordered FX chain, exact kept speech intervals, and measurement semantics revision. It excludes mix controls, transcript wording, and timeline-only clip placement. Render status reports whether the digest still matches; the digest does not persist or compare the run's LUFS target. Optional `room_tone` (`MediaAsset`, typically `raw/room-tone/{session}/{participant}.wav` from the record lobby; the older `raw/room-tone/{participant}.wav` path still works for existing projects): filler pads with `filler_pad_mode: room_tone` prefer this bed (abutting tiles with fade-in on the first tile and fade-out on the last when longer than the bed) over stolen stem air. A near-silent bed is ignored. Optional `gate_fill` (`GateFill`, written by the `fill_gate_holes` pipeline step): `source` (`room_tone_bed` or `comfort_noise`), `path` (workspace-relative FLAC on the media's clock: the fill inside each source-gate hole, digital silence elsewhere), `media_size` and `media_mtime_ns` (the media it was measured on; render ignores the fill once they change), `holes`, `filled_sec`, `level_db`, `noise_db` (the track's own noise under its speech, null for a bed) and `fade_ms`. Render sums the file under each segment of the track's own media, before fades and mutes, so own audio is byte-identical outside the holes ([audio-engineering.md § Gate fill](audio-engineering.md#gate-fill-fill_gate_holes)). Optional `proxy` (`TrackProxy`): FX source-clock guest proxy fingerprint (`hash`), chunk grid (`chunk_sec`, `overlap_ms`, `chunk_count`), and object storage prefix when uploaded. Proxies exclude timeline edits — guests schedule clips client-side.
- **`timeline.tracks[].transcript_gate_scope`** is an optional list of `{start_s, end_s, source_id}` selections in source-media seconds. Null means the whole lane, including older projects with only an enabled flag. Scoped applies union their selections. Full apply clears the scope to null. Mapping the stored source spans through current clip placements retains the selected audio after ripple cuts and moves. An empty list selects no audio.
- **`timeline.clips`** define what is heard and when: `source_start`/`source_end` in media time, `timeline_start` on the session clock. `Clip.timeline_end` is the one clip-geometry property. Optional `mute_regions[]` (`{start_s, end_s, fade_out_ms, fade_in_ms, fill?}` source-media seconds) mute the clip in place: the gain falls to zero over the region's first `fade_out_ms` and rises back over its last `fade_in_ms` (both default to 5 ms; a region shorter than both fades is muted outright). An approved tighten mute widens the region by the padded cut's fades, so the cut itself is silent. Only muting and unmuting move a region's edges: a clip cut through a region (split, trim, roll, ripple delete, partial copy and paste) keeps it whole, so `start_s`/`end_s` may lie outside the clip's source range, each piece stays silent up to the cut, and fades sound only at the region's own edges. A trim never drops a region, even one the clip no longer overlaps: render ignores the part outside the clip, and extending the edge back restores the mute. A roll gives both clips over one recording the union of their regions, so a mute the join crosses stays silent on whichever clip plays it. They do not change clip offsets or session duration. A region's optional `fill` (`{source_id, start_s, end_s}`) is the room tone tiled under it: that stretch of `sources[source_id]`, or of the track's own media when `source_id` is null. Without `fill` the region renders as digital silence.
- **`editorial.speaker_splits[]`** records each recording split into a lane per speaker ([multitrack-ingest.md § Split one recording by speaker](multitrack-ingest.md#split-one-recording-by-speaker)): `media_path`, `lanes` (the speakers' track ids, in order), `crosstalk_mode` (where flagged crosstalk plays: `owner`, the most likely speaker's lane only; `both`, every talking speaker's lane; `lane`, only `crosstalk_lane`), `crosstalk_lane` (the shared lane, set exactly in `lane` mode), `backend`, `method` (`enroll` or `cluster`) and `turns[]` (`{start_s, end_s, speakers, confidence}` in source seconds, covering the recording without gaps; `speakers` lists the lanes most likely first, and two or more flags crosstalk). Each lane plays `media_path` through its own copies of the clips, muted with `mute_regions` where another lane owns the audio. The stacked-copy check (`same_source_timeline_overlaps`) skips time a clip mutes, so it reports the crosstalk a `both` split plays on two lanes.
- **`editorial.edit_decisions`** apply in **source media time** (overlap with each clip).
- **`editorial.edit_log`** archives committed cuts after `approve_edits`, `apply_auto_edits`, or direct timeline ops (`ripple_delete`, etc.). Each `AppliedEditRecord` retains `reason`, source/timeline ranges, `operation`, and echoed tool `params`. `ripple_delete` and `punch_delete` (and the `approve_edits` / `apply_prefix_edits` removals that run them) echo `params.per_track_source` (`{track_id: [pre, post]}`: on each track, the pre-edit source clock at the cut's start on the clip running into it and at the cut's end on the clip running out of it, read in timeline order so a cut across a moved clip still names the join it makes) — `revert_applied_edit` restores `[pre, post]` only when it spans the record's timeline hole and otherwise asks for History undo (a track-scope punch, `params.scope: "track"`, is refilled in place without rippling); `split_clips_at` and `approve_split` echo `params.split_source_by_track` (`{track_id: src_sec}`, the left clip's `source_end` at the split). The GUI uses both, plus a record's own `source_start`/`source_end`, to place applied-edit seam/edge ticks against the track's current clips (#527), rather than the record's stored `timeline_*`. Undo restores the log with other editorial state. A ripple that cut another track's speech after the person confirmed it also echoes `params.cut_speech` (the confirmed `CutSpeech`: removed `spans`, then per track its `words` on the timeline clock and `sound_spans`), and `trim_clip_edge`, `delete_clips`, `ripple_delete_clips` and `paste_segment` echo `params.mode` (`ripple` | `gap`; see [daw-editing.md § Edit modes](daw-editing.md#edit-modes-ripple-and-gap)).
- **`editorial.edit_decisions[].cut_speech`** (optional `CutSpeech`) is set on a suggested session ripple (a Commenter's ripple delete) that would cut other speakers' speech, recorded when it was suggested. Approval checks every pending session remove against the current transcript whether or not this is set, so a decision that would cut other speech then needs `confirm_cut_speech`; once confirmed, a decision with `cut_speech` ripples as suggested rather than falling back to a track-local punch. Null otherwise.
- **`render.invalidations[]`** records why stems are dirty since the last fresh render (`reason`: cut/clip/envelope/fx/gain/mute/other; optional `timeline_start`/`timeline_end`). Cleared per track when that stem’s hash is rewritten. Freshness itself stays derived from artifact hashes — invalidations are for UI/agents, not a second source of truth for `needs_rerender`.
- Render path: clips → per-track WAV → mix → `artifacts/premix.wav` → master → `export/`. Stems don't bake the track gain; the mix applies each track's output gain. `artifacts/premix.hash` fingerprints the mix itself: which tracks it played (media, not muted) and each one's output gain, in any order. It also holds the premix peak ceiling on a second line; render status and review publish judge the premix against that recorded ceiling, and a pipeline run against its configured one. A third line holds the headroom trim the whole mix got; while the premix is fresh, both pending preview sides mix their window at that trim, and after a mix change they measure the same trim from the current stems instead of re-mixing. A volume or mute change reports `render_status.premix.stale_vs_mix` and `needs_rerender` without staling any stem; a premix from before the hash counts as stale once any fader is off 0 dB or any track is muted. `artifacts/mastered.hash` fingerprints the premix `mastered.wav` was mastered from (its mix hash plus file size/mtime). Export re-masters when it doesn't match, and first re-renders and re-mixes a premix that's stale (saved mix changed, a mixed stem newer than it, or a rendered mixed stem behind its edits). Publishing a review version refuses a stale premix, or, while `premix.wav` exists, a master not mastered from the current premix (including one with no `mastered.hash`, until export re-masters it); with only `mastered.wav` and no premix, publish ships that master as-is.

Untrimmed `podcast ingest consolidate` places each speaker's primary clip on the session clock: a recorder that started before session t=0 gets `source_start` = its lead-in and `timeline_start` 0; one that started after gets `source_start` 0 and `timeline_start` > 0 (see [multitrack-ingest.md](multitrack-ingest.md) § Placement). Trimmed extracts and clips with no placement start at 0/0. If no clips exist, ingest/pipeline creates one full-span clip per dialogue track.

## History

Each undo point stores a **full snapshot** of editable sections (not a diff): `sources`, `timeline`, `editorial`, `transcripts`, `mix`, `social`, `review`, `render_last_completed_step`, and `meta.ingest_alignment` when present.

## Review comments

`review.comments[]` holds human/agent feedback on the **timeline** clock (what listeners hear on premix/review). Each comment may be an instant (`timeline_end` null or equal to start) or a contiguous span, optionally scoped to one or more `track_ids` (empty = session-wide). Nested `action_items` track checkable work with `completed_by` / `completed_at`; `replies[]` is a flat thread. Optional `edit_decision_id` binds **one** comment thread to a pending `editorial.edit_decisions[]` row (unique among comments; lazy-created on first Ask). Optional `review.versions[]` / `active_version_id` freeze review mixes (`audio_relpath` WAV + optional `mp3_relpath` / `object_store_key` for link previews and agents; both relpaths must resolve inside `artifacts/review/` — see timeline-comments.md); comments may stamp `review_version_id`. See [timeline-comments.md](timeline-comments.md).

Undo/redo restores snapshot → `ProjectStore.commit()` updates `episode.project.json`.

## Version policy

Only **`version: "2.0"`** is supported. Older flat layouts are rejected at load time. The format may change freely until the first public release.

## Prior art

Influenced by OpenTimelineIO (tracks/clips), Descript (transcript-first edits), and REAPER-style declarative session + render—without reading DAW project files.

## Exact selected ranges

`EditDecision.author` names the share guest whose document command created the decision: `share:` plus the share's opaque registry id, random and never derived from the token. A recreated or recycled link is a new share with a new id. It is null for host and agent edits and for edits saved before authorship. The gate lets a Commenter retime only its own (see [share-tokens.md](share-tokens.md)); guest projections never carry it.

`EditDecision.exact_range` stores an `exact_range` target with ordered disjoint timeline intervals, explicit destination `track_ids`, observed clips, and opaque `media_seals`. Its flat timing fields are a display envelope. Source Snap and timing updates reject this variant. `Track.timeline_empty` records an intentionally empty lane. Render and mapping preserve silence until new material is added.

Approved range mutes become occurrence-local, source-clock `mute_regions`. Rendering a shorter window preserves the original envelope endpoints so playback does not restart a fade inside an existing mute. Reviewed bleed proposals use this same exact-range contract. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

`timeline.duration_sec` retains the pre-punch extent when a range Cut removes the
last clips; duration and default Bounce still include the resulting silence.
`TimelineComment.timeline_spans` optionally carries ordered selected islands;
`timeline_start`/`timeline_end` remain their display envelope and `track_ids`
preserves selected lanes.
