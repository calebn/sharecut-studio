# Speaker attribution

Recommended FOSS speaker embedding for standalone recognition and same-room bleed cleanup.

Bleed reconcile tags words by **RMS dominance** (which mic is louder). Same-room recording often needs **speaker identity** (whose voice is this?) via enrolled ECAPA profiles. This is verification, not unsupervised diarization.

## Install

There is one speaker model: the ECAPA ONNX export (`podcast bootstrap --component speaker-ecapa`, ~80 MB, or Try again on the Split prompt of a Prepare Source card after it says the model is not downloaded; #1998). It runs on `onnxruntime`, which is a core dependency, so there is no speaker extra. Without the downloaded model, the commands that embed audio (`enroll`, `score`, `compare`, `label`, `gate-track`, `attribute` and `split`) and the Split prompt refuse instead of running. A missing or stale ONNX model is `model_needed` (HTTP 409; the message names `podcast bootstrap --component speaker-ecapa`, with `--upgrade` for a stale file). `speaker_backend_unavailable` stays for what a download cannot fix: a `PODCAST_MCP_SPEAKER_ECAPA_MODEL` override that is missing or does not load. Its message names the override variable. `doctor` still lists the ONNX backend as unavailable in both cases; `doctor`, `profiles`, `set-speaker-count` and `move-lane-span` do not need the default backend and still run. A developer or test run opts in with `PODCAST_SPEAKER_BACKEND=mock` or `backend="mock"`; Split speakers still refuses the mock. `podcast speaker doctor` lists the mock only under that opt-in (#1999).

**Profiles from the Resemblyzer era must be enrolled again.** The Resemblyzer backend is gone. Its embeddings have 256 values and ECAPA's have 192, so a profile enrolled with it does not match: scoring stops with `speaker_profile_outdated`, naming the profile, until you enroll that speaker again (`podcast speaker enroll`, or the enrollment spans of Split speakers). Profiles enrolled with SpeechBrain ECAPA keep working, because the ONNX model gives the same embeddings (cosine 1.0).

## Standalone CLI

```bash
podcast speaker doctor
podcast speaker enroll --project episode.sharecut
podcast speaker enroll --project PATH --speaker NAME --track T --start 10 --end 40
podcast speaker profiles --project episode.sharecut
podcast speaker score --project PATH --track host --start 10 --end 12
podcast speaker compare --project PATH --start 978.65 --end 979.49
podcast speaker compare --project PATH --track-a host --start-a 10 --end-a 12 \
  --track-b guest --start-b 20 --end-b 22
podcast speaker label --project PATH --track host --start 10 --end 12 --dry-run
podcast speaker label --project PATH --track host --start 10 --end 12 --apply
podcast speaker gate-track --project PATH --dry-run
podcast speaker gate-track --project PATH --apply
podcast speaker set-speaker-count --project PATH --speakers 2
podcast speaker attribute --project episode.sharecut --dry-run
podcast speaker attribute --project episode.sharecut --apply
podcast speaker split --project PATH --track room --speakers 3 --dry-run
podcast speaker split --project PATH --track room --enroll "Ana=12:20" --enroll "Ben=31:40" --apply
```

`compare --start/--end` scores every dialogue stem at the same source window and returns `own` / `bleed` / `uncertain` roles. Pair mode (`--track-a` / `--track-b`) compares two windows A/B.

`gate-track` slides windows over speech regions and suppresses non-home speaker spans (primary path for same-room bleed). Then run bleed-mute to gate stems acoustically.

Long runs support `--json-progress` (`speaker-enroll`, `speaker-attribute`, `speaker-gate` task IDs). Parent contract: [progress.md](progress.md).

## Enrollment audio source

Enrollment and scoring prefer processed stems `artifacts/tracks/{id}.wav` when present (same audio bleed-mute gates). Otherwise raw `track.media.path`. Re-enroll after FX or stem edits; stale profiles are skipped automatically. A profile records two keys for its stem. `stem_hash` is the file revision (device, inode, size, mtime) and is the fast check. `stem_content` is `<size>:<sha256 of the whole file>`, and is compared only when the revision no longer matches, so a profile survives copying, moving or restoring the project from backup, while a stem rewritten in place (its modification time changes) still invalidates it, even at the same size. The digest is computed once per process for each revision of a stem, and no profile file is rewritten when profiles are read. After a copy the first load in each process hashes the whole stem, which takes seconds for a multi-gigabyte file until the profiles are re-enrolled. A raw source with several audio streams is read on its first stream and both keys carry the `:a0` marker (#2110), so profiles enrolled before are skipped the same way, including by `load_profile`'s identity fallback. Profiles enrolled before `stem_content` existed cannot be matched after a copy and must be re-enrolled with `podcast speaker enroll`. When profiles exist on disk but some do not validate, loading logs one warning per workspace and set of stale ids (a track whose stem is missing is not counted, and a multi-stream source needs `ffprobe` to read the `:a0` marker, so a profile can also read as out of date where it is missing) (`N speaker profile(s) are out of date (ids); re-enroll with ...`) instead of silently running without them.

`podcast speaker profiles` (and `speaker_profiles_tool`) lists every profile on disk with `stem_hash`, `stem_content`, `valid` and `status`. `status` is `ok`, `stem_missing` (no stem for the track), `stem_changed` (the stem differs from the enrolled one) or `legacy_key` (no content key and the revision differs); `valid` is true only for `ok`.

Prefer segment enroll from clean owner-only spans when auto-enroll would bake bleed into the profile.

## Known speaker count

Store `analysis.speaker_id.expected_speaker_count` in `transcript_context.yaml` (or `podcast speaker set-speaker-count`). Agents should ask the user when reachable; batch pipeline infers from dialogue track count when unset. Home-gate warns when distinct winning identities exceed the expected count.

## Multi-speaker on one track

To give each person their own lane, split the track: `podcast speaker split --project PATH --track T --speakers N` (`--dry-run` by default; `--apply` to split), or `speaker_split_tool`. It needs the speaker count and a real embedding backend; `--enroll NAME=START:END` names a speaker and seeds their cluster; enroll some or all speakers (recommended, so similar voices are not merged), and the rest are clustered. Lanes share the media, muted where another speaker owns the audio. Hand-overs land in pauses measured on the recording's own levels; a short reply keeps its whole voiced run, and a hand-over that stays inside a voiced run is flagged as crosstalk. Flagged crosstalk plays on its likeliest speaker's lane (default `--crosstalk owner`), on both lanes (`--crosstalk both`, twice in the mix) or on a shared lane (`--crosstalk lane`). One undo step. ShareCut Studio's **Split speakers…** (track inspector and command palette, which open the Source card in Prepare) runs the same service as a job with a speaker count only (no names and no enrollment; each new track's name is typed on its Source card); it always uses the owner crosstalk mode (never `both` or `lane`), and does not report overlap, with one Undo. The MCP and CLI result carries `crosstalk_sec`. Design, lab accuracy and failure modes: [multitrack-ingest.md § Split one recording by speaker](multitrack-ingest.md#split-one-recording-by-speaker).

To keep one lane and only label words, enroll segment profiles with distinct `speaker_id` values and optional `--home-track` for bleed attribution. `label` applies `speaker_match_*` on overlapping words (and, for another speaker's voice, suppression when `auto_suppress` is on). `--apply` (or `speaker_label_tool` with `dry_run` off) saves through the `LabelSpeakerWindow` document command: one undo step, and an open Studio sees the change (#1849).

## When the pipeline runs it

Inside `precorrect_transcript` when `analysis.speaker_id.mode` is `auto` (product default) or `always` and bleed thresholds are met. `never` skips entirely (CI / no speaker model).

```yaml
analysis:
  speaker_id:
    mode: auto
    bleed_word_threshold: 50
    bleed_ratio_threshold: 0.02
    max_speaker_gap_sec: 0.55
    gate_window_sec: 0.75
    gate_hop_sec: 0.25
```

Bleed mute uses enrolled profiles to keep owner speech open across short inter-word gaps when `max_speaker_gap_sec` > 0. Filler/NL cuts skip bleed-labelled spans and force track-local scope when speaker role is `bleed`.

## Same-room workflow

1. `podcast speaker enroll` (segment enroll from clean owner spans when possible)
2. `podcast speaker gate-track --dry-run` then `--apply`
3. `podcast edit apply-bleed-mute` — gate stems to non-suppressed intervals
4. Solo-audition with `play --source processed:TRACK`

## MCP

- `speaker_doctor_tool`
- `speaker_enroll_tool` (optional `speaker_id`, `start_sec`, `end_sec`, `home_track_id`)
- `speaker_profiles_tool`
- `speaker_score_tool`
- `speaker_compare_window_tool`
- `speaker_compare_pair_tool`
- `speaker_label_tool`
- `speaker_gate_track_tool`
- `speaker_set_count_tool`
- `speaker_attribute_tool`
- `speaker_split_tool` (`track_id`, `speaker_count`, optional `names`, `enrollment` `{name: [[start, end], …]}` source seconds for some or all speakers, `crosstalk_mode` `owner` (default)/`both`/`lane`, `room_tone_fill`, `dry_run`; on apply returns `crosstalk_sec`, `low_confidence_sec` and `history_head_id`)
- `speaker_move_lane_span_tool` (`from_lane`, `to_lane`, `source_start`, `source_end` source seconds on sibling split lanes; one undo; returns `history_head_id`)

`audition_context` (`detail=full` or `visual`) adds `speaker_roles` when profiles exist (uses the real speaker backend when installed).

## Prove-out

Real-model checks set `PODCAST_TEST_ECAPA_ONNX` to the downloaded ONNX file. On real fixtures, verify `compare` discriminates known bleed windows before claiming cleanup success.
